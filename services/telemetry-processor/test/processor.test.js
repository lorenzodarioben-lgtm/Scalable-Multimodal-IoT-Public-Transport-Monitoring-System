import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TABLES, THRESHOLDS } from '@sit314/shared/config';
import { getStore } from '@sit314/shared/store';
import { validateAnalysisJob, normalize } from '@sit314/shared/validation';
import { createLogger } from '@sit314/shared/logging';
import { TelemetryProcessor } from '../src/processor.js';
import { distribute, evaluateEvent } from '../src/disruption.js';

/** Records everything sent, so fan-out can be asserted without a real queue. */
function fakeQueue({ failBatch = false } = {}) {
  const sent = [];
  return {
    sent,
    async sendMessageBatch(bodies) {
      if (failBatch) return { successful: 0, failed: bodies.length };
      sent.push(...bodies);
      return { successful: bodies.length, failed: 0 };
    },
    async sendMessage(body) { sent.push(body); return { messageId: 'm' }; },
    async getAttributes() { return { approximateNumberOfMessages: sent.length }; },
  };
}

function harness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-proc-'));
  const store = getStore({ fresh: true, backend: 'local', baseDir: dir });
  const analysisQueue = fakeQueue(options.queue);
  const logger = createLogger('test', { quiet: true });
  const processor = new TelemetryProcessor({ store, analysisQueue, logger, ...options.processor });
  return {
    processor,
    store,
    analysisQueue,
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const rawBus = (patch = {}) => ({
  eventId: 'evt-bus-00000001', eventType: 'telemetry', transportMode: 'bus', vehicleId: 'BUS-007',
  serviceId: 'SERVICE-703', routeId: '703', locationId: 'BUS-STOP-104',
  timestamp: '2026-09-04T00:00:00.000Z', latitude: -37.818, longitude: 145.119,
  speedKph: 40, occupancy: 30, capacity: 60, delaySeconds: 60, health: 'normal',
  modeData: { roadSegmentId: 'ROAD-SEG-12', nextStopId: 'BUS-STOP-105' },
  ...patch,
});
const busEvent = (patch) => normalize(rawBus(patch), { receivedAt: '2026-09-04T00:00:01.000Z' });

const tramEvent = (patch = {}) => normalize({
  eventId: 'evt-tram-00000001', eventType: 'telemetry', transportMode: 'tram', vehicleId: 'TRAM-003',
  serviceId: 'TS-75', routeId: '75', locationId: 'TRAM-STOP-204',
  timestamp: '2026-09-04T00:00:00.000Z', latitude: -37.81, longitude: 145.12,
  speedKph: 0, occupancy: 90, capacity: 180, delaySeconds: 120, health: 'blocked',
  modeData: { trackSegmentId: 'TRAM-SEG-12', direction: 'outbound', nextStopId: 'TRAM-STOP-205' },
  ...patch,
}, { receivedAt: '2026-09-04T00:00:01.000Z' });

const trainEvent = (patch = {}) => normalize({
  eventId: 'evt-train-00000001', eventType: 'telemetry', transportMode: 'train', vehicleId: 'TRAIN-002',
  serviceId: 'TS-BEL', routeId: 'BELGRAVE', locationId: 'BOX-HILL',
  timestamp: '2026-09-04T00:00:00.000Z', latitude: -37.82, longitude: 145.12,
  speedKph: 0, occupancy: 400, capacity: 780, delaySeconds: 300, health: 'cancelled',
  modeData: { stationId: 'BOX-HILL', platform: 2, carriageCount: 6, nextStationId: 'LABURNUM' },
  ...patch,
}, { receivedAt: '2026-09-04T00:00:01.000Z' });

// ---------------------------------------------------------------- detection

test('healthy telemetry is stored and raises no incident', async () => {
  const h = harness();
  const result = await h.processor.handle(busEvent());
  assert.deepEqual(result, { duplicate: false, incident: false, jobs: 0 });
  const state = await h.store.get(TABLES.currentState, 'BUS-007');
  assert.equal(state.health, 'normal');
  assert.equal(state.lastEventId, 'evt-bus-00000001');
  assert.equal(h.analysisQueue.sent.length, 0);
  h.cleanup();
});

test('crowding is computed and stored', async () => {
  const h = harness();
  await h.processor.handle(busEvent({ eventId: 'evt-crowd-1', occupancy: 54, capacity: 60 }));
  const state = await h.store.get(TABLES.currentState, 'BUS-007');
  assert.equal(state.crowdingLevel, 'high');
  assert.equal(state.occupancyRatio, 0.9);
  h.cleanup();
});

test('crowding below the incident level does not raise an incident', () => {
  const evaluation = evaluateEvent(busEvent({ occupancy: 54, capacity: 60 }));
  assert.equal(evaluation.crowding, 'high');
  assert.equal(evaluation.isIncident, false, 'a merely busy bus must not create an incident');
});

test('critical crowding does raise an incident', () => {
  const evaluation = evaluateEvent(busEvent({ occupancy: 66, capacity: 60 }));
  assert.equal(evaluation.crowding, 'critical');
  assert.equal(evaluation.isIncident, true);
  assert.equal(evaluation.reason, 'crowding');
});

test('mode-specific failure states are detected', () => {
  assert.equal(evaluateEvent(busEvent({ health: 'breakdown' })).reason, 'breakdown');
  assert.equal(evaluateEvent(tramEvent()).reason, 'blocked');
  assert.equal(evaluateEvent(trainEvent()).reason, 'cancelled');
  assert.equal(evaluateEvent(trainEvent()).severity, 'critical', 'a cancellation is the most severe');
});

test('severe delay is an incident regardless of health', () => {
  const evaluation = evaluateEvent(busEvent({ delaySeconds: THRESHOLDS.severeDelaySeconds }));
  assert.equal(evaluation.isIncident, true);
  assert.equal(evaluation.reason, 'severeDelay');
  const below = evaluateEvent(busEvent({ delaySeconds: THRESHOLDS.severeDelaySeconds - 1 }));
  assert.equal(below.isIncident, false);
});

// ------------------------------------------------------------------ fan-out

test('a bus breakdown fans out into the configured number of jobs', async () => {
  const h = harness();
  const result = await h.processor.handle(busEvent({ health: 'breakdown', delaySeconds: 1500 }));
  assert.equal(result.incident, true);
  assert.equal(result.jobs, 50, 'stage 1 expects 50 analysis jobs');
  assert.equal(h.analysisQueue.sent.length, 50);

  const locations = new Set(h.analysisQueue.sent.map((j) => j.affectedLocationId));
  assert.equal(locations.size, 5, 'stage 1 expects 5 affected bus stops');

  const notifications = h.analysisQueue.sent.reduce((s, j) => s + j.notificationFanout, 0);
  assert.equal(notifications, 200, 'stage 1 expects 200 notifications');
  h.cleanup();
});

test('tram, train and multimodal fan-outs match the approved experiment stages', async () => {
  const tram = harness();
  assert.equal((await tram.processor.handle(tramEvent())).jobs, 250);
  assert.equal(new Set(tram.analysisQueue.sent.map((j) => j.affectedLocationId)).size, 15);
  assert.equal(tram.analysisQueue.sent.reduce((s, j) => s + j.notificationFanout, 0), 1000);
  tram.cleanup();

  const train = harness();
  assert.equal((await train.processor.handle(trainEvent())).jobs, 750);
  assert.equal(new Set(train.analysisQueue.sent.map((j) => j.affectedLocationId)).size, 20);
  assert.equal(train.analysisQueue.sent.reduce((s, j) => s + j.notificationFanout, 0), 5000);
  train.cleanup();
});

test('every generated analysis job is schema valid', async () => {
  const h = harness();
  await h.processor.handle(busEvent({ health: 'breakdown' }));
  for (const job of h.analysisQueue.sent) {
    const check = validateAnalysisJob(job);
    assert.ok(check.valid, `invalid job: ${check.errors.join('; ')}`);
  }
  h.cleanup();
});

test('analysis jobs are independent units of work', async () => {
  const h = harness();
  await h.processor.handle(busEvent({ health: 'breakdown' }));
  const ids = h.analysisQueue.sent.map((j) => j.jobId);
  assert.equal(new Set(ids).size, ids.length, 'job ids must be unique');
  for (const job of h.analysisQueue.sent) {
    // Each job carries everything a worker needs; nothing references another job.
    assert.ok(job.affectedLocationId && job.sourceEventId && job.incidentId);
    assert.equal(job.taskType, 'routeImpactEta');
  }
  h.cleanup();
});

test('distribute spreads a total exactly across buckets', () => {
  assert.deepEqual(distribute(10, 3), [4, 3, 3]);
  assert.equal(distribute(5000, 750).reduce((a, b) => a + b, 0), 5000);
  assert.equal(distribute(1500, 40).reduce((a, b) => a + b, 0), 1500);
  assert.deepEqual(distribute(0, 3), [0, 0, 0]);
});

// -------------------------------------------------------------- idempotency

test('a duplicate event does not create duplicate analysis jobs', async () => {
  const h = harness();
  const event = busEvent({ health: 'breakdown' });

  const first = await h.processor.handle(event);
  assert.equal(first.jobs, 50);

  const second = await h.processor.handle(event);
  assert.deepEqual(second, { duplicate: true });
  assert.equal(h.analysisQueue.sent.length, 50, 'redelivery must not double the workload');
  assert.equal(h.processor.counters.duplicates, 1);
  h.cleanup();
});

test('job ids are derived, so a retry regenerates the same job set', async () => {
  const a = harness();
  const b = harness();
  await a.processor.handle(busEvent({ health: 'breakdown' }));
  await b.processor.handle(busEvent({ health: 'breakdown' }));
  assert.deepEqual(
    a.analysisQueue.sent.map((j) => j.jobId),
    b.analysisQueue.sent.map((j) => j.jobId),
  );
  a.cleanup();
  b.cleanup();
});

test('an older event does not overwrite newer state', async () => {
  const h = harness();
  await h.processor.handle(busEvent({
    eventId: 'evt-newer-000001', timestamp: '2026-09-04T00:10:00.000Z', speedKph: 55,
  }));
  const stale = await h.processor.handle(busEvent({
    eventId: 'evt-older-000001', timestamp: '2026-09-04T00:05:00.000Z', speedKph: 5,
  }));

  assert.equal(stale.duplicate, false, 'a distinct eventId is not a duplicate');
  const state = await h.store.get(TABLES.currentState, 'BUS-007');
  assert.equal(state.metrics.speedKph, 55, 'stale telemetry overwrote newer state');
  assert.equal(state.lastEventId, 'evt-newer-000001');
  assert.equal(h.processor.counters.staleSkipped, 1);
  h.cleanup();
});

test('concurrent delivery of the same event yields exactly one fan-out', async () => {
  const h = harness();
  const event = busEvent({ health: 'breakdown' });
  const results = await Promise.all(Array.from({ length: 8 }, () => h.processor.handle(event)));
  const winners = results.filter((r) => !r.duplicate);
  assert.equal(winners.length, 1, 'only one concurrent delivery may do the work');
  assert.equal(h.analysisQueue.sent.length, 50);
  h.cleanup();
});

// -------------------------------------------------------- failure behaviour

test('a structurally invalid event is rejected as non-retryable', async () => {
  const h = harness();
  await assert.rejects(
    () => h.processor.handle({ eventId: 'evt-bad', transportMode: 'bus' }),
    /failed validation/,
  );
  assert.equal(h.processor.counters.invalid, 1);
  h.cleanup();
});

test('a failed job publish throws so the source message is retried', async () => {
  const h = harness({ queue: { failBatch: true } });
  await assert.rejects(
    () => h.processor.handle(busEvent({ health: 'breakdown' })),
    /failed to enqueue/,
  );
  h.cleanup();
});

test('failure injection is off unless explicitly enabled', async () => {
  const h = harness();
  // Default configuration must never inject failures.
  for (let i = 0; i < 20; i += 1) {
    // Distinct ids AND increasing timestamps, so neither the duplicate guard
    // nor the stale-state guard interferes with what this test is checking.
    await h.processor.handle(busEvent({
      eventId: `evt-clean-00000${i}`,
      timestamp: new Date(Date.UTC(2026, 8, 4, 0, i)).toISOString(),
    }));
  }
  assert.equal(h.processor.counters.stored, 20);
  h.cleanup();
});

test('failure injection, when enabled, produces retryable errors', async () => {
  const h = harness({
    processor: {
      failureInjection: { enabled: true, rate: 1, duplicateRate: 0 },
      random: () => 0,
    },
  });
  await assert.rejects(() => h.processor.handle(busEvent()), /injected failure/);
  h.cleanup();
});

test('demand events are stored without raising vehicle incidents', async () => {
  const h = harness();
  const demand = normalize({
    eventId: 'evt-demand-1', eventType: 'locationDemand', locationType: 'station',
    locationId: 'BOX-HILL', routeIds: ['BELGRAVE'], timestamp: '2026-09-04T00:00:00.000Z',
    passengerCount: 87, demandLevel: 'high',
  }, { receivedAt: '2026-09-04T00:00:01.000Z' });
  const result = await h.processor.handle(demand);
  assert.equal(result.incident, false);
  const state = await h.store.get(TABLES.currentState, 'BOX-HILL');
  assert.equal(state.demandLevel, 'high');
  assert.equal(state.metrics.passengerCount, 87);
  h.cleanup();
});
