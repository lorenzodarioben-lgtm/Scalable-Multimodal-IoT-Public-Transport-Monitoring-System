import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRaw } from '@sit314/shared/validation';
import { buildNetwork } from '../src/network.js';
import { Rng } from '../src/rng.js';
import {
  demandLevelFor,
  generateBusTelemetry,
  generateDemandEvent,
  generateTrainTelemetry,
  generateTramTelemetry,
} from '../src/generators/index.js';

const network = buildNetwork({ seed: 3142026, buses: 12, trams: 8, trains: 6, locations: 15 });
const TS = '2026-09-04T00:00:00.000Z';
const rng = (label) => new Rng(3142026).child(label);

test('bus telemetry is schema valid across many ticks and health states', () => {
  for (const health of ['normal', 'degraded', 'breakdown']) {
    for (let tick = 0; tick < 40; tick += 1) {
      const entity = network.fleet.bus[tick % network.fleet.bus.length];
      const event = generateBusTelemetry({ entity, rng: rng(`b${tick}`), tick, timestamp: TS, health });
      const result = validateRaw(event);
      assert.ok(result.valid, `bus invalid (${health}, tick ${tick}): ${result.errors.join('; ')}`);
      assert.equal(result.mode, 'bus');
    }
  }
});

test('tram telemetry is schema valid across many ticks and health states', () => {
  for (const health of ['normal', 'degraded', 'blocked']) {
    for (let tick = 0; tick < 40; tick += 1) {
      const entity = network.fleet.tram[tick % network.fleet.tram.length];
      const event = generateTramTelemetry({ entity, rng: rng(`t${tick}`), tick, timestamp: TS, health });
      const result = validateRaw(event);
      assert.ok(result.valid, `tram invalid (${health}, tick ${tick}): ${result.errors.join('; ')}`);
      assert.equal(result.mode, 'tram');
    }
  }
});

test('train telemetry is schema valid across many ticks and health states', () => {
  for (const health of ['normal', 'degraded', 'cancelled']) {
    for (let tick = 0; tick < 40; tick += 1) {
      const entity = network.fleet.train[tick % network.fleet.train.length];
      const event = generateTrainTelemetry({ entity, rng: rng(`r${tick}`), tick, timestamp: TS, health });
      const result = validateRaw(event);
      assert.ok(result.valid, `train invalid (${health}, tick ${tick}): ${result.errors.join('; ')}`);
      assert.equal(result.mode, 'train');
    }
  }
});

test('location demand events are schema valid, including under surge', () => {
  for (const surge of [1, 2.5, 6]) {
    for (let tick = 0; tick < 30; tick += 1) {
      const entity = network.demandLocations[tick % network.demandLocations.length];
      const event = generateDemandEvent({
        entity, rng: rng(`d${tick}${surge}`), tick, timestamp: TS, surgeMultiplier: surge,
      });
      const result = validateRaw(event);
      assert.ok(result.valid, `demand invalid: ${result.errors.join('; ')}`);
      assert.equal(result.mode, 'demand');
    }
  }
});

test('Variety: each mode carries genuinely different mode-specific fields', () => {
  const bus = generateBusTelemetry({ entity: network.fleet.bus[0], rng: rng('b'), tick: 1, timestamp: TS });
  const tram = generateTramTelemetry({ entity: network.fleet.tram[0], rng: rng('t'), tick: 1, timestamp: TS });
  const train = generateTrainTelemetry({ entity: network.fleet.train[0], rng: rng('r'), tick: 1, timestamp: TS });
  const demand = generateDemandEvent({ entity: network.demandLocations[0], rng: rng('d'), tick: 1, timestamp: TS });

  assert.deepEqual(Object.keys(bus.modeData).sort(), ['doorsOpen', 'nextStopId', 'roadSegmentId', 'wheelchairRampOk']);
  assert.deepEqual(Object.keys(tram.modeData).sort(), ['couplingCount', 'direction', 'nextStopId', 'trackSegmentId']);
  assert.deepEqual(Object.keys(train.modeData).sort(), ['carriageCount', 'expressService', 'nextStationId', 'platform', 'stationId']);

  // The demand event has a structurally different shape: no vehicle, no capacity.
  assert.equal(demand.vehicleId, undefined);
  assert.equal(demand.capacity, undefined);
  assert.ok(Array.isArray(demand.routeIds));
  assert.equal(demand.eventType, 'locationDemand');

  // The three vehicle modes share a common core so normalisation is meaningful.
  for (const key of ['vehicleId', 'routeId', 'occupancy', 'capacity', 'delaySeconds', 'health']) {
    for (const e of [bus, tram, train]) assert.ok(key in e, `${key} missing from ${e.transportMode}`);
  }
});

test('failure states stop the vehicle and inflate delay', () => {
  const entity = network.fleet.bus[0];
  const healthy = generateBusTelemetry({ entity, rng: rng('h'), tick: 5, timestamp: TS, health: 'normal' });
  const broken = generateBusTelemetry({ entity, rng: rng('h'), tick: 5, timestamp: TS, health: 'breakdown' });
  assert.equal(broken.speedKph, 0);
  assert.ok(broken.delaySeconds > healthy.delaySeconds);
  assert.equal(broken.modeData.wheelchairRampOk, false);
});

test('cancelled trains report zero speed', () => {
  const event = generateTrainTelemetry({
    entity: network.fleet.train[0], rng: rng('c'), tick: 2, timestamp: TS, health: 'cancelled',
  });
  assert.equal(event.speedKph, 0);
});

test('demand level is derived from the passenger count, not random', () => {
  assert.equal(demandLevelFor(10, 30), 'low');
  assert.equal(demandLevelFor(30, 30), 'moderate');
  assert.equal(demandLevelFor(60, 30), 'high');
  assert.equal(demandLevelFor(120, 30), 'critical');
});

test('network fan-out candidates exist for every route', () => {
  for (const route of network.busRoutes) {
    assert.ok(network.locationsForRoute('bus', route.routeId).length >= 10);
  }
  for (const line of network.trainLines) {
    assert.ok(network.locationsForRoute('train', line.routeId).length >= 4);
  }
});
