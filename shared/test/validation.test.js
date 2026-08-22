import test from 'node:test';
import assert from 'node:assert/strict';
import {
  crowdingLevel, identifyMode, normalize, occupancyRatio,
  validateNormalized, validateRaw,
} from '../validation/index.js';

const busEvent = () => ({
  eventId: 'evt-11111111', eventType: 'telemetry', transportMode: 'bus', vehicleId: 'BUS-001',
  serviceId: 'SERVICE-703', routeId: '703', locationId: 'BUS-STOP-101',
  timestamp: '2026-09-04T00:00:00.000Z', latitude: -37.818, longitude: 145.119,
  speedKph: 42, occupancy: 38, capacity: 60, delaySeconds: 120, health: 'normal',
  modeData: { roadSegmentId: 'ROAD-SEG-12', nextStopId: 'BUS-STOP-102' },
});

const tramEvent = () => ({
  eventId: 'evt-22222222', eventType: 'telemetry', transportMode: 'tram', vehicleId: 'TRAM-003',
  serviceId: 'TRAM-SERVICE-75', routeId: '75', locationId: 'TRAM-STOP-204',
  timestamp: '2026-09-04T00:00:00.000Z', latitude: -37.81, longitude: 145.12,
  speedKph: 22, occupancy: 90, capacity: 180, delaySeconds: 45, health: 'normal',
  modeData: { trackSegmentId: 'TRAM-SEG-12', direction: 'outbound', nextStopId: 'TRAM-STOP-205' },
});

const trainEvent = () => ({
  eventId: 'evt-33333333', eventType: 'telemetry', transportMode: 'train', vehicleId: 'TRAIN-002',
  serviceId: 'TRAIN-SERVICE-BELGRAVE', routeId: 'BELGRAVE', locationId: 'BOX-HILL',
  timestamp: '2026-09-04T00:00:00.000Z', latitude: -37.82, longitude: 145.12,
  speedKph: 80, occupancy: 400, capacity: 780, delaySeconds: 30, health: 'normal',
  modeData: { stationId: 'BOX-HILL', platform: 2, carriageCount: 6, nextStationId: 'LABURNUM' },
});

const demandEvent = () => ({
  eventId: 'evt-demand-44444444', eventType: 'locationDemand', locationType: 'station',
  locationId: 'BOX-HILL', routeIds: ['BELGRAVE', 'LILYDALE'],
  timestamp: '2026-09-04T00:00:00.000Z', passengerCount: 87, demandLevel: 'high',
});

test('mode identification routes each payload to its own branch', () => {
  assert.equal(identifyMode(busEvent()), 'bus');
  assert.equal(identifyMode(tramEvent()), 'tram');
  assert.equal(identifyMode(trainEvent()), 'train');
  assert.equal(identifyMode(demandEvent()), 'demand');
  assert.equal(identifyMode({ eventType: 'telemetry', transportMode: 'hovercraft' }), null);
  assert.equal(identifyMode(null), null);
  assert.equal(identifyMode('not an object'), null);
  assert.equal(identifyMode([1, 2, 3]), null);
});

test('valid events of every mode are accepted', () => {
  for (const [mode, event] of Object.entries({
    bus: busEvent(), tram: tramEvent(), train: trainEvent(), demand: demandEvent(),
  })) {
    const result = validateRaw(event);
    assert.ok(result.valid, `${mode} rejected: ${result.errors.join('; ')}`);
    assert.equal(result.mode, mode);
  }
});

test('bus: impossible values are rejected with a stated reason', () => {
  const cases = [
    [{ occupancy: -5 }, /occupancy must be >= 0/],
    [{ capacity: 0 }, /capacity/],
    [{ speedKph: -3 }, /speedKph must be >= 0/],
    [{ timestamp: 'yesterday' }, /timestamp/],
    [{ health: 'on-fire' }, /health/],
    [{ occupancy: 500 }, /exceeds/],
  ];
  for (const [patch, pattern] of cases) {
    const result = validateRaw({ ...busEvent(), ...patch });
    assert.ok(!result.valid, `expected rejection for ${JSON.stringify(patch)}`);
    assert.match(result.errors.join('; '), pattern);
  }
});

test('bus: missing identifiers are rejected', () => {
  for (const field of ['vehicleId', 'routeId', 'serviceId', 'modeData', 'eventId']) {
    const event = busEvent();
    delete event[field];
    const result = validateRaw(event);
    assert.ok(!result.valid, `missing ${field} should be rejected`);
  }
});

test('tram: mode-specific rules are enforced', () => {
  assert.ok(!validateRaw({ ...tramEvent(), health: 'breakdown' }).valid,
    'breakdown is a bus state, not a tram state');
  assert.ok(validateRaw({ ...tramEvent(), health: 'blocked' }).valid);
  const badDirection = tramEvent();
  badDirection.modeData.direction = 'sideways';
  assert.ok(!validateRaw(badDirection).valid);
  const missingSegment = tramEvent();
  delete missingSegment.modeData.trackSegmentId;
  assert.ok(!validateRaw(missingSegment).valid);
});

test('train: mode-specific rules are enforced', () => {
  assert.ok(!validateRaw({ ...trainEvent(), health: 'blocked' }).valid,
    'blocked is a tram state, not a train state');
  assert.ok(validateRaw({ ...trainEvent(), health: 'cancelled' }).valid);
  const badPlatform = trainEvent();
  badPlatform.modeData.platform = 0;
  assert.ok(!validateRaw(badPlatform).valid);
  const badCarriages = trainEvent();
  badCarriages.modeData.carriageCount = 40;
  assert.ok(!validateRaw(badCarriages).valid);
});

test('bus mode-data cannot be swapped for tram mode-data', () => {
  const hybrid = { ...busEvent(), modeData: tramEvent().modeData };
  assert.ok(!validateRaw(hybrid).valid, 'mode-specific branches must not accept each other');
});

test('demand: invalid values are rejected', () => {
  assert.ok(!validateRaw({ ...demandEvent(), passengerCount: -7 }).valid);
  assert.ok(!validateRaw({ ...demandEvent(), demandLevel: 'extreme' }).valid);
  assert.ok(!validateRaw({ ...demandEvent(), locationType: 'airport' }).valid);
  assert.ok(!validateRaw({ ...demandEvent(), routeIds: [] }).valid);
});

test('malformed payloads are rejected rather than throwing', () => {
  for (const payload of [null, undefined, 'plain string', 42, [], {}]) {
    const result = validateRaw(payload);
    assert.ok(!result.valid);
    assert.ok(result.errors.length > 0);
  }
});

test('normalisation preserves mode-specific data', () => {
  for (const event of [busEvent(), tramEvent(), trainEvent()]) {
    const normalized = normalize(event, { receivedAt: '2026-09-04T00:00:01.000Z' });
    const check = validateNormalized(normalized);
    assert.ok(check.valid, `normalised ${event.transportMode} invalid: ${check.errors.join('; ')}`);
    assert.deepEqual(normalized.modeData, event.modeData, 'mode-specific fields must survive');
    assert.equal(normalized.entityId, event.vehicleId);
    assert.equal(normalized.metrics.occupancy, event.occupancy);
    assert.equal(normalized.metrics.delaySeconds, event.delaySeconds);
    assert.equal(normalized.health, event.health);
    assert.equal(normalized.sourceEventType, 'telemetry');
  }
});

test('demand normalises into the same envelope with demand fields', () => {
  const normalized = normalize(demandEvent(), { receivedAt: '2026-09-04T00:00:01.000Z' });
  assert.ok(validateNormalized(normalized).valid);
  assert.equal(normalized.transportMode, 'demand');
  assert.equal(normalized.entityId, 'BOX-HILL');
  assert.equal(normalized.metrics.passengerCount, 87);
  assert.equal(normalized.demandLevel, 'high');
  assert.deepEqual(normalized.routeIds, ['BELGRAVE', 'LILYDALE']);
});

test('crowding thresholds classify occupancy ratio', () => {
  assert.equal(crowdingLevel(30, 60), 'normal'); // 0.50
  assert.equal(crowdingLevel(40, 60), 'moderate'); // 0.67
  assert.equal(crowdingLevel(54, 60), 'high'); // 0.90
  assert.equal(crowdingLevel(60, 60), 'critical'); // 1.00
  assert.equal(crowdingLevel(70, 60), 'critical');
  assert.equal(crowdingLevel(10, 0), null, 'capacity 0 must not divide by zero');
  assert.equal(crowdingLevel(null, 60), null);
  assert.equal(occupancyRatio(30, 60), 0.5);
});
