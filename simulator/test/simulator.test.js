import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRaw } from '@sit314/shared/validation';
import { resolveConfig } from '../src/config.js';
import { Simulator } from '../src/simulator.js';
import { StdoutPublisher } from '../src/mqtt-client.js';
import { CORRUPTIONS, corruptEvent } from '../src/corruption.js';
import { Rng } from '../src/rng.js';

/** Collects everything a run publishes without touching the network. */
function capturingPublisher() {
  const captured = [];
  const publisher = new StdoutPublisher();
  publisher.publish = async (topic, payload) => {
    captured.push({ topic, payload });
    publisher.published += 1;
    return true;
  };
  return { publisher, captured };
}

const baseCfg = {
  buses: 6, trams: 3, trains: 2, locations: 4,
  'interval-ms': 50, 'duration-ms': 260, 'summary-interval-ms': 100000, quiet: true,
};

async function runOnce(overrides = {}) {
  const cfg = resolveConfig({ ...baseCfg, ...overrides });
  const { publisher, captured } = capturingPublisher();
  const sim = new Simulator(cfg, { publisher });
  const summary = await sim.run();
  return { summary, captured, sim };
}

/** The workload minus the values that are intentionally unique per run. */
const logicalShape = (captured) => captured.map(({ topic, payload }) => {
  const { eventId, timestamp, ...rest } = payload;
  return { topic, ...rest };
});

test('the same seed reproduces the same logical workload', async () => {
  const a = await runOnce({ seed: 3142026 });
  const b = await runOnce({ seed: 3142026 });
  assert.equal(a.captured.length, b.captured.length);
  assert.deepEqual(logicalShape(a.captured), logicalShape(b.captured));
});

test('a different seed produces a different workload', async () => {
  const a = await runOnce({ seed: 1 });
  const b = await runOnce({ seed: 2 });
  assert.notDeepEqual(logicalShape(a.captured), logicalShape(b.captured));
});

test('event ids are unique within a run', async () => {
  const { captured } = await runOnce({ seed: 77 });
  const ids = captured.map((c) => c.payload.eventId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate eventId generated');
});

test('every published event is schema valid when invalid-rate is 0', async () => {
  const { captured } = await runOnce({ seed: 9 });
  const bad = captured.map((c) => validateRaw(c.payload)).filter((r) => !r.valid);
  assert.equal(bad.length, 0, `invalid payloads: ${JSON.stringify(bad.slice(0, 3))}`);
});

test('topics follow the configured hierarchy for all four types', async () => {
  const { captured } = await runOnce({ seed: 3 });
  const topics = new Set(captured.map((c) => c.topic));
  assert.ok([...topics].some((t) => /^transport\/raw\/bus\/BUS-\d+$/.test(t)));
  assert.ok([...topics].some((t) => /^transport\/raw\/tram\/TRAM-\d+$/.test(t)));
  assert.ok([...topics].some((t) => /^transport\/raw\/train\/TRAIN-\d+$/.test(t)));
  assert.ok([...topics].some((t) => /^transport\/raw\/demand\/.+$/.test(t)));
});

test('Variety: all four event types appear in one run', async () => {
  const { summary } = await runOnce({ seed: 4 });
  for (const mode of ['bus', 'tram', 'train', 'demand']) {
    assert.ok(summary.byMode[mode] > 0, `no ${mode} events published`);
  }
});

test('load statistics report attempted, published, failed, rate and elapsed', async () => {
  const { summary } = await runOnce({ seed: 5 });
  for (const key of ['attemptedEvents', 'publishedEvents', 'failedEvents', 'eventsPerSecond', 'elapsedSeconds']) {
    assert.ok(key in summary, `missing ${key}`);
  }
  assert.equal(summary.failedEvents, 0);
  assert.equal(summary.attemptedEvents, summary.publishedEvents);
  assert.ok(summary.eventsPerSecond > 0);
});

test('max-events caps the run', async () => {
  const { summary } = await runOnce({ seed: 6, 'max-events': 12, 'duration-ms': 5000 });
  assert.equal(summary.publishedEvents, 12);
});

test('scenario injects the requested disruption on the pinned vehicle', async () => {
  const { captured } = await runOnce({
    seed: 3142026, scenario: 'bus-breakdown', 'disrupt-vehicle': 'BUS-002', 'disrupt-after-ticks': 1,
  });
  const brokenEvents = captured.filter((c) => c.payload.vehicleId === 'BUS-002' && c.payload.health === 'breakdown');
  assert.ok(brokenEvents.length > 0, 'no breakdown telemetry produced');
  assert.ok(brokenEvents.every((e) => e.payload.speedKph === 0));
});

test('multimodal scenario disrupts all three modes', async () => {
  const { captured, sim } = await runOnce({
    seed: 3142026, scenario: 'multimodal-disruption', 'disrupt-after-ticks': 1,
  });
  assert.equal(sim.scenario.targets.length, 3);
  const states = new Set(captured.map((c) => c.payload.health).filter(Boolean));
  for (const failure of ['breakdown', 'blocked', 'cancelled']) {
    assert.ok(states.has(failure), `${failure} never observed`);
  }
});

test('normal scenario injects no hard failure', async () => {
  const { captured } = await runOnce({ seed: 3142026, scenario: 'normal' });
  const failures = captured.filter((c) => ['breakdown', 'blocked', 'cancelled'].includes(c.payload.health));
  assert.equal(failures.length, 0);
});

test('invalid-rate produces genuinely invalid events that the validator rejects', async () => {
  const { captured, summary } = await runOnce({ seed: 8, 'invalid-rate': 1 });
  assert.ok(summary.corruptedEvents > 0);
  const results = captured.map((c) => validateRaw(c.payload));
  assert.ok(results.every((r) => !r.valid), 'a corrupted event still passed validation');
});

test('every corruption produces a rejection with a reason', () => {
  const validBus = {
    eventId: 'evt-aaaaaaaa', eventType: 'telemetry', transportMode: 'bus', vehicleId: 'BUS-001',
    serviceId: 'SERVICE-703', routeId: '703', locationId: 'BUS-STOP-101',
    timestamp: '2026-09-04T00:00:00.000Z', latitude: -37.8, longitude: 145.1, speedKph: 40,
    occupancy: 30, capacity: 60, delaySeconds: 60, health: 'normal',
    modeData: { roadSegmentId: 'ROAD-SEG-1', nextStopId: 'BUS-STOP-102' },
  };
  const validDemand = {
    eventId: 'evt-bbbbbbbb', eventType: 'locationDemand', locationType: 'station',
    locationId: 'BOX-HILL', routeIds: ['BELGRAVE'], timestamp: '2026-09-04T00:00:00.000Z',
    passengerCount: 87, demandLevel: 'high',
  };
  assert.ok(validateRaw(validBus).valid && validateRaw(validDemand).valid, 'fixtures must start valid');

  for (const corruption of CORRUPTIONS) {
    const source = corruption.applies(validBus) ? validBus : validDemand;
    if (!corruption.applies(source)) continue;
    const broken = corruption.apply(source);
    const result = validateRaw(broken);
    assert.ok(!result.valid, `corruption ${corruption.id} was not detected`);
    assert.ok(result.errors.length > 0, `corruption ${corruption.id} produced no reason`);
  }
});

test('corruption choice is deterministic for a given seed', () => {
  const event = {
    eventId: 'evt-cccccccc', eventType: 'telemetry', transportMode: 'tram', vehicleId: 'TRAM-001',
    serviceId: 'S', routeId: '75', timestamp: '2026-09-04T00:00:00.000Z', latitude: -37.8,
    longitude: 145.1, speedKph: 20, occupancy: 10, capacity: 120, delaySeconds: 0, health: 'normal',
    modeData: { trackSegmentId: 'TRAM-SEG-1', direction: 'inbound', nextStopId: 'TRAM-STOP-201' },
  };
  const a = corruptEvent(event, new Rng(11).child('x'));
  const b = corruptEvent(event, new Rng(11).child('x'));
  assert.equal(a.__injectedFault, b.__injectedFault);
});

test('duplicate-rate republishes the same eventId for idempotency testing', async () => {
  const { captured, summary } = await runOnce({ seed: 10, 'duplicate-rate': 1 });
  assert.ok(summary.duplicatedEvents > 0);
  const ids = captured.map((c) => c.payload.eventId);
  assert.ok(new Set(ids).size < ids.length, 'no repeated eventId was published');
});
