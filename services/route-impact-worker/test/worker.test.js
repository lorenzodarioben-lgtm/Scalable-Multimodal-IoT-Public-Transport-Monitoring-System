import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TABLES } from '@sit314/shared/config';
import { getStore } from '@sit314/shared/store';
import { createLogger } from '@sit314/shared/logging';
import { validateAlert } from '@sit314/shared/validation';
import { RouteImpactWorker, audiencesFor } from '../src/worker.js';
import { calculateRouteImpact, impactLevelFor } from '../src/eta.js';

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
  };
}

function harness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-eta-'));
  const store = getStore({ fresh: true, backend: 'local', baseDir: dir });
  const notificationQueue = fakeQueue(options.queue);
  const logger = createLogger('test', { quiet: true });
  const worker = new RouteImpactWorker({ store, notificationQueue, logger, ...options.worker });
  return {
    worker, store, notificationQueue,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const job = (patch = {}) => ({
  jobId: 'job-aaaaaaaa0001',
  incidentId: 'incident-aaaaaaaa',
  sourceEventId: 'evt-aaaaaaaa0001',
  transportMode: 'bus',
  vehicleId: 'BUS-007',
  routeId: '703',
  affectedLocationId: 'BUS-STOP-104',
  hopsFromIncident: 1,
  taskType: 'routeImpactEta',
  priority: 'high',
  reason: 'breakdown',
  severity: 'high',
  context: {
    delaySeconds: 1200, occupancyRatio: 0.7, crowdingLevel: 'moderate',
    direction: null, segmentId: 'ROAD-SEG-12',
  },
  notificationFanout: 4,
  createdAt: '2026-09-04T00:00:00.000Z',
  ...patch,
});

// ------------------------------------------------------------- ETA model

test('the ETA calculation is deterministic', () => {
  const a = calculateRouteImpact(job());
  const b = calculateRouteImpact(job());
  assert.deepEqual(a, b);
  // And it depends only on the job, not on the clock.
  assert.equal(typeof a.etaMinutes, 'number');
  assert.ok(Number.isFinite(a.etaMinutes));
});

test('the ETA is the sum of its documented components', () => {
  const result = calculateRouteImpact(job());
  const c = result.components;
  const sum = (c.baseEta + c.delayPenalty + c.disruptionPenalty + c.crowdingPenalty)
    * c.directionFactor;
  assert.equal(result.etaMinutes, Number(sum.toFixed(1)));
});

test('impact grows with distance from the incident', () => {
  const near = calculateRouteImpact(job({ hopsFromIncident: 0 }));
  const far = calculateRouteImpact(job({ hopsFromIncident: 6 }));
  assert.ok(far.etaMinutes > near.etaMinutes);
});

test('mode-specific behaviour: a train cancellation outweighs a bus breakdown', () => {
  const bus = calculateRouteImpact(job({ transportMode: 'bus', reason: 'breakdown' }));
  const train = calculateRouteImpact(job({ transportMode: 'train', reason: 'cancelled' }));
  assert.ok(train.etaMinutes > bus.etaMinutes,
    'a cancelled train removes a whole service and must hurt more');
});

test('mode-specific behaviour: a tram blockage is directional', () => {
  const outbound = calculateRouteImpact(job({
    transportMode: 'tram', reason: 'blocked', context: { ...job().context, direction: 'outbound' },
  }));
  const inbound = calculateRouteImpact(job({
    transportMode: 'tram', reason: 'blocked', context: { ...job().context, direction: 'inbound' },
  }));
  assert.ok(inbound.etaMinutes < outbound.etaMinutes,
    'the unaffected direction should recover faster');
});

test('mode-specific behaviour: breakdown impact grows down the route, blockage impact is uniform', () => {
  // A bus breakdown makes each successive downstream stop worse (passengers
  // there wait for the following service). A tram blockage affects the whole
  // track segment about equally because the tram cannot be diverted.
  const busNear = calculateRouteImpact(job({ transportMode: 'bus', reason: 'breakdown', hopsFromIncident: 0 }));
  const busFar = calculateRouteImpact(job({ transportMode: 'bus', reason: 'breakdown', hopsFromIncident: 10 }));
  const tramNear = calculateRouteImpact(job({ transportMode: 'tram', reason: 'blocked', hopsFromIncident: 0 }));
  const tramFar = calculateRouteImpact(job({ transportMode: 'tram', reason: 'blocked', hopsFromIncident: 10 }));

  const busGrowth = busFar.components.disruptionPenalty - busNear.components.disruptionPenalty;
  const tramGrowth = tramFar.components.disruptionPenalty - tramNear.components.disruptionPenalty;

  assert.ok(busGrowth > 0, 'downstream bus stops must be affected more, not less');
  assert.ok(busGrowth > tramGrowth * 2,
    'a road breakdown must vary along the route far more than a rail blockage');
  assert.ok(tramNear.components.disruptionPenalty > busNear.components.disruptionPenalty,
    'at the scene, an undivertable rail blockage is the worse of the two');
});

test('crowding contributes and crush loading contributes more', () => {
  const normal = calculateRouteImpact(job({ context: { ...job().context, crowdingLevel: 'normal', occupancyRatio: 0.4 } }));
  const critical = calculateRouteImpact(job({ context: { ...job().context, crowdingLevel: 'critical', occupancyRatio: 1.3 } }));
  assert.equal(normal.components.crowdingPenalty, 0);
  assert.ok(critical.components.crowdingPenalty > 4.5);
});

test('impact levels follow the documented thresholds', () => {
  assert.equal(impactLevelFor(3), 'low');
  assert.equal(impactLevelFor(10), 'medium');
  assert.equal(impactLevelFor(20), 'high');
  assert.equal(impactLevelFor(40), 'critical');
});

// --------------------------------------------------------------- worker

test('a job produces a stored result', async () => {
  const h = harness();
  const outcome = await h.worker.handle(job());
  assert.equal(outcome.duplicate, false);

  const stored = await h.store.get(TABLES.analysisResults, 'job-aaaaaaaa0001');
  assert.equal(stored.status, 'complete');
  assert.equal(stored.qualityIndicator, 'simulated');
  assert.equal(stored.etaMinutes, outcome.result.etaMinutes);
  assert.equal(stored.locationId, 'BUS-STOP-104');
  assert.ok(stored.calculationId.startsWith('calc-'));
  assert.ok(Number.isFinite(stored.processingMs));
  h.cleanup();
});

test('a duplicate job is skipped and produces no second result or alert', async () => {
  const h = harness();
  const first = await h.worker.handle(job());
  const alertsAfterFirst = h.notificationQueue.sent.length;
  assert.ok(alertsAfterFirst > 0);

  const second = await h.worker.handle(job());
  assert.deepEqual(second, { duplicate: true });
  assert.equal(h.notificationQueue.sent.length, alertsAfterFirst,
    'a redelivered job must not notify anybody twice');
  assert.equal(h.worker.counters.duplicates, 1);
  assert.equal(h.worker.counters.processed, 1);

  const stored = await h.store.get(TABLES.analysisResults, 'job-aaaaaaaa0001');
  assert.equal(stored.etaMinutes, first.result.etaMinutes);
  h.cleanup();
});

test('concurrent delivery of the same job is processed exactly once', async () => {
  const h = harness();
  const results = await Promise.all(Array.from({ length: 6 }, () => h.worker.handle(job())));
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  h.cleanup();
});

test('alerts are generated for significant impact only', async () => {
  const h = harness();
  // Low impact: short delay, no crowding, at the incident itself.
  const low = job({
    jobId: 'job-low-000001', reason: 'crowding', hopsFromIncident: 0,
    context: { delaySeconds: 0, occupancyRatio: 0.3, crowdingLevel: 'normal' },
  });
  const outcome = await h.worker.handle(low);
  assert.equal(outcome.result.impactLevel, 'low');
  assert.equal(outcome.alerts, 0, 'a low impact must not page anybody');
  h.cleanup();
});

test('alert audiences widen with severity', () => {
  assert.deepEqual(audiencesFor('low'), []);
  assert.deepEqual(audiencesFor('medium'), ['operators', 'controlRoom']);
  assert.ok(audiencesFor('critical').includes('passengers'));
  assert.ok(audiencesFor('critical').includes('authority'));
});

test('generated alerts are schema valid and carry the recipient fan-out', async () => {
  const h = harness();
  await h.worker.handle(job({ notificationFanout: 7 }));
  const alerts = h.notificationQueue.sent;
  assert.ok(alerts.length > 0);
  for (const alert of alerts) {
    const check = validateAlert(alert);
    assert.ok(check.valid, `invalid alert: ${check.errors.join('; ')}`);
    assert.ok(alert.message.length > 10);
  }
  assert.equal(alerts.reduce((s, a) => s + a.recipientCount, 0), 7,
    'the full notification fan-out must be preserved');
  h.cleanup();
});

test('alert ids are derived, so a retry regenerates the same alert ids', async () => {
  const a = harness();
  const b = harness();
  await a.worker.handle(job());
  await b.worker.handle(job());
  assert.deepEqual(
    a.notificationQueue.sent.map((x) => x.alertId),
    b.notificationQueue.sent.map((x) => x.alertId),
  );
  a.cleanup();
  b.cleanup();
});

test('a failed alert publish throws so the queue message is retried', async () => {
  const h = harness({ queue: { failBatch: true } });
  await assert.rejects(() => h.worker.handle(job()), /alerts failed to enqueue/);
  h.cleanup();
});

test('an invalid job is rejected as non-retryable', async () => {
  const h = harness();
  await assert.rejects(() => h.worker.handle({ jobId: 'short' }), /failed validation/);
  assert.equal(h.worker.counters.invalid, 1);
  h.cleanup();
});

test('the configurable processing cost is off by default and applied when set', async () => {
  // "Off by default" is asserted structurally rather than by timing. Comparing
  // an un-delayed run against a delayed one is unreliable when the test files
  // run in parallel, because scheduling delay on the baseline can exceed the
  // injected delay itself.
  const off = harness();
  assert.equal(off.worker.settings.processingDelayMs, 0);
  assert.equal(off.worker.settings.processingCpuIterations, 0);
  await off.worker.handle(job({ jobId: 'job-fast-00001' }));
  off.cleanup();

  // The delayed direction is safe to assert on the clock: an injected sleep can
  // only ever make the run slower, never faster.
  const on = harness({ worker: { settings: { processingDelayMs: 60 } } });
  const t1 = Date.now();
  const outcome = await on.worker.handle(job({ jobId: 'job-slow-00001' }));
  const slowMs = Date.now() - t1;
  on.cleanup();

  assert.equal(on.worker.settings.processingDelayMs, 60);
  assert.ok(slowMs >= 55, `expected the injected cost to apply, took ${slowMs}ms`);
  // The test parameter must not change the calculated answer.
  assert.equal(
    outcome.result.etaMinutes,
    calculateRouteImpact(job({ jobId: 'job-slow-00001' })).etaMinutes,
  );
});

test('failure injection is off by default', async () => {
  const h = harness();
  for (let i = 0; i < 15; i += 1) {
    await h.worker.handle(job({ jobId: `job-clean-${String(i).padStart(6, '0')}` }));
  }
  assert.equal(h.worker.counters.processed, 15);
  h.cleanup();
});

test('failure injection, when enabled, produces retryable errors', async () => {
  const h = harness({
    worker: { failureInjection: { enabled: true, rate: 1 }, random: () => 0 },
  });
  await assert.rejects(() => h.worker.handle(job()), /injected failure/);
  h.cleanup();
});
