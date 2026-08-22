import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNormalized } from '@sit314/shared/validation';
import { FlowRunner, loadFlows } from './flow-runner.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const ACCEPTED = 'MQTT out: transport/normalized/<mode>';
const REJECTED = 'MQTT out: transport/rejected/<mode>';

const bus = () => ({
  eventId: 'evt-11111111', eventType: 'telemetry', transportMode: 'bus', vehicleId: 'BUS-001',
  serviceId: 'SERVICE-703', routeId: '703', locationId: 'BUS-STOP-101',
  timestamp: '2026-09-04T00:00:00.000Z', latitude: -37.818, longitude: 145.119,
  speedKph: 42, occupancy: 38, capacity: 60, delaySeconds: 120, health: 'normal',
  modeData: { roadSegmentId: 'ROAD-SEG-12', nextStopId: 'BUS-STOP-102' },
});
const tram = () => ({
  eventId: 'evt-22222222', eventType: 'telemetry', transportMode: 'tram', vehicleId: 'TRAM-003',
  serviceId: 'TRAM-SERVICE-75', routeId: '75', locationId: 'TRAM-STOP-204',
  timestamp: '2026-09-04T00:00:00.000Z', latitude: -37.81, longitude: 145.12,
  speedKph: 22, occupancy: 90, capacity: 180, delaySeconds: 45, health: 'blocked',
  modeData: { trackSegmentId: 'TRAM-SEG-12', direction: 'outbound', nextStopId: 'TRAM-STOP-205' },
});
const train = () => ({
  eventId: 'evt-33333333', eventType: 'telemetry', transportMode: 'train', vehicleId: 'TRAIN-002',
  serviceId: 'TRAIN-SERVICE-BELGRAVE', routeId: 'BELGRAVE', locationId: 'BOX-HILL',
  timestamp: '2026-09-04T00:00:00.000Z', latitude: -37.82, longitude: 145.12,
  speedKph: 80, occupancy: 400, capacity: 780, delaySeconds: 30, health: 'cancelled',
  modeData: { stationId: 'BOX-HILL', platform: 2, carriageCount: 6, nextStationId: 'LABURNUM' },
});
const demand = () => ({
  eventId: 'evt-demand-44444444', eventType: 'locationDemand', locationType: 'station',
  locationId: 'BOX-HILL', routeIds: ['BELGRAVE', 'LILYDALE'],
  timestamp: '2026-09-04T00:00:00.000Z', passengerCount: 87, demandLevel: 'high',
  waitingTimeSeconds: 300,
});

test('flows.json is in sync with node-red/functions/', () => {
  // If this fails, run: node node-red/build-flows.js
  const out = execFileSync(process.execPath, ['node-red/build-flows.js', '--check'], {
    cwd: REPO, encoding: 'utf8',
  });
  assert.match(out, /up to date/);
});

test('the flow contains a visible, separate branch per transport mode', () => {
  const flows = loadFlows();
  const names = flows.filter((n) => n.type === 'function').map((n) => n.name);
  for (const branch of ['validate bus', 'validate tram', 'validate train', 'validate demand']) {
    assert.ok(names.includes(branch), `missing branch: ${branch}`);
  }
  const identify = flows.find((n) => n.name === 'identify mode');
  assert.equal(identify.outputs, 5, 'identify mode must fan out to four modes plus rejection');
  assert.deepEqual(identify.wires, [
    ['validate-bus'], ['validate-tram'], ['validate-train'], ['validate-demand'], ['reject'],
  ]);
});

test('the flow ingests raw MQTT and republishes normalised MQTT', () => {
  const flows = loadFlows();
  const input = flows.find((n) => n.type === 'mqtt in');
  assert.equal(input.topic, 'transport/raw/#');
  const outs = flows.filter((n) => n.type === 'mqtt out').map((n) => n.name);
  assert.ok(outs.some((n) => n.includes('normalized')));
  assert.ok(outs.some((n) => n.includes('rejected')));
});

for (const [mode, factory, topic] of [
  ['bus', bus, 'transport/raw/bus/BUS-001'],
  ['tram', tram, 'transport/raw/tram/TRAM-003'],
  ['train', train, 'transport/raw/train/TRAIN-002'],
  ['demand', demand, 'transport/raw/demand/BOX-HILL'],
]) {
  test(`valid ${mode} event is accepted, normalised and published`, () => {
    const runner = new FlowRunner();
    const { terminals, visited } = runner.ingest(factory(), topic);
    assert.ok(!terminals[REJECTED], `${mode} was rejected`);
    assert.equal(terminals[ACCEPTED].length, 1);

    const msg = terminals[ACCEPTED][0];
    assert.equal(msg.topic, `transport/normalized/${mode}`);
    const check = validateNormalized(msg.payload);
    assert.ok(check.valid, `normalised ${mode} invalid: ${check.errors.join('; ')}`);
    assert.equal(msg.payload.validation.branch, mode);
    assert.equal(msg.payload.validation.validatedBy, `node-red:validate-${mode}`);
    assert.ok(visited.includes(`validate ${mode}`), 'the mode-specific branch was not used');
    assert.ok(runner.warnings.some((w) => w.startsWith('[ACCEPTED]')), 'no accepted evidence line');
  });
}

test('normalisation preserves every mode-specific field', () => {
  for (const factory of [bus, tram, train]) {
    const source = factory();
    const { terminals } = new FlowRunner().ingest(source);
    assert.deepEqual(terminals[ACCEPTED][0].payload.modeData, source.modeData);
  }
  const d = demand();
  const { terminals } = new FlowRunner().ingest(d);
  assert.equal(terminals[ACCEPTED][0].payload.metrics.passengerCount, d.passengerCount);
  assert.equal(terminals[ACCEPTED][0].payload.demandLevel, 'high');
});

test('invalid events are rejected with a stated reason and never normalised', () => {
  const cases = [
    ['negative occupancy', { ...bus(), occupancy: -5 }, /occupancy must be >= 0/],
    ['zero capacity', { ...bus(), capacity: 0 }, /capacity must be > 0/],
    ['negative speed', { ...bus(), speedKph: -12 }, /speedKph must be >= 0/],
    ['occupancy far above capacity', { ...bus(), occupancy: 300 }, /exceeds 1.5x capacity/],
    ['invalid timestamp', { ...bus(), timestamp: 'not-a-timestamp' }, /timestamp must be a valid/],
    ['invalid health', { ...bus(), health: 'on-fire' }, /health must be one of normal, degraded, breakdown/],
    ['malformed mode', { ...bus(), transportMode: 'hovercraft' }, /unrecognised eventType/],
    ['negative passengers', { ...demand(), passengerCount: -7 }, /passengerCount must be >= 0/],
    ['invalid demand level', { ...demand(), demandLevel: 'extreme' }, /demandLevel must be one of/],
    ['empty routeIds', { ...demand(), routeIds: [] }, /routeIds must be a non-empty array/],
  ];
  for (const [label, payload, pattern] of cases) {
    const runner = new FlowRunner();
    const { terminals } = runner.ingest(payload);
    assert.ok(!terminals[ACCEPTED], `${label}: invalid event reached the normalised topic`);
    assert.equal(terminals[REJECTED].length, 1, `${label}: not rejected`);
    const record = terminals[REJECTED][0].payload;
    assert.match(record.reason, pattern, `${label}: unexpected reason "${record.reason}"`);
    assert.ok(terminals[REJECTED][0].topic.startsWith('transport/rejected/'));
    assert.ok(runner.warnings.some((w) => w.startsWith('[REJECTED]')), `${label}: no rejection evidence`);
  }
});

test('missing identifiers are rejected', () => {
  for (const field of ['vehicleId', 'routeId', 'serviceId', 'eventId', 'modeData']) {
    const payload = bus();
    delete payload[field];
    const { terminals } = new FlowRunner().ingest(payload);
    assert.ok(!terminals[ACCEPTED], `missing ${field} was accepted`);
    assert.ok(terminals[REJECTED][0].payload.reason.length > 0);
  }
});

test('a mode cannot be validated by another mode branch', () => {
  // A tram payload sent with transportMode 'bus' must fail the bus branch,
  // because bus modeData requirements differ from tram modeData requirements.
  const hybrid = { ...tram(), transportMode: 'bus', vehicleId: 'BUS-009' };
  const { terminals, visited } = new FlowRunner().ingest(hybrid);
  assert.ok(visited.includes('validate bus'));
  assert.ok(!terminals[ACCEPTED]);
  assert.match(terminals[REJECTED][0].payload.reason, /roadSegmentId is required for a bus/);
});

test('tram health states are not interchangeable with bus health states', () => {
  const t = { ...tram(), health: 'breakdown' };
  const { terminals } = new FlowRunner().ingest(t);
  assert.ok(!terminals[ACCEPTED]);
  assert.match(terminals[REJECTED][0].payload.reason, /normal, degraded, blocked/);

  const b = { ...bus(), health: 'cancelled' };
  const { terminals: bt } = new FlowRunner().ingest(b);
  assert.ok(!bt[ACCEPTED]);
  assert.match(bt[REJECTED][0].payload.reason, /normal, degraded, breakdown/);
});

test('non-JSON and non-object payloads are rejected without throwing', () => {
  for (const payload of ['{not json', 'plain text', 42, [1, 2, 3], null]) {
    const { terminals } = new FlowRunner().ingest(payload);
    assert.ok(!terminals[ACCEPTED]);
    assert.equal(terminals[REJECTED].length, 1);
  }
});

test('a JSON string payload is parsed rather than rejected', () => {
  const { terminals } = new FlowRunner().ingest(JSON.stringify(bus()));
  assert.ok(terminals[ACCEPTED], 'stringified JSON should be parsed by the flow');
});

test('the rejection record carries the injected fault label for cross-checking', () => {
  const payload = { ...bus(), occupancy: -1, __injectedFault: 'negativeOccupancy' };
  const { terminals } = new FlowRunner().ingest(payload);
  assert.equal(terminals[REJECTED][0].payload.injectedFault, 'negativeOccupancy');
});

test('the source topic is preserved on the rejection record', () => {
  const { terminals } = new FlowRunner().ingest(
    { ...bus(), occupancy: -1 }, 'transport/raw/bus/BUS-042',
  );
  assert.equal(terminals[REJECTED][0].payload.rawTopic, 'transport/raw/bus/BUS-042');
});
