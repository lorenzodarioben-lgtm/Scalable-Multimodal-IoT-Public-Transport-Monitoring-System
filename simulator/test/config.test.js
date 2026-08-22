import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULTS, expectedEventsPerSecond, expectedTotalEvents, resolveConfig,
} from '../src/config.js';

test('defaults resolve without any flags', () => {
  const cfg = resolveConfig({});
  assert.equal(cfg.buses, DEFAULTS.buses);
  assert.equal(cfg.scenario, 'normal');
  assert.equal(cfg.target, 'stdout', 'dry run must be the default - never publish by accident');
  assert.equal(cfg.invalidRate, 0, 'invalid events must never be the default');
  assert.equal(cfg.duplicateRate, 0);
});

test('Volume: entity counts come from the command line', () => {
  const cfg = resolveConfig({ buses: 100, trams: 25, trains: 15, locations: 100 });
  assert.equal(cfg.buses, 100);
  assert.equal(cfg.trams, 25);
  assert.equal(cfg.trains, 15);
  assert.equal(cfg.locations, 100);
});

test('Velocity: the reporting interval comes from the command line', () => {
  const slow = resolveConfig({ buses: 100, trams: 0, trains: 0, locations: 0, 'interval-ms': 10000 });
  const fast = resolveConfig({ buses: 100, trams: 0, trains: 0, locations: 0, 'interval-ms': 1000 });
  assert.equal(slow.intervalMs, 10000);
  assert.equal(fast.intervalMs, 1000);
  assert.equal(expectedEventsPerSecond(slow), 10);
  assert.equal(expectedEventsPerSecond(fast), 100);
  assert.ok(expectedEventsPerSecond(fast) === expectedEventsPerSecond(slow) * 10,
    'ten times the frequency must be ten times the event rate');
});

test('kebab-case flags map onto camelCase configuration', () => {
  const cfg = resolveConfig({ 'interval-ms': 250, 'invalid-rate': 0.05, 'disrupt-after-ticks': 3 });
  assert.equal(cfg.intervalMs, 250);
  assert.equal(cfg.invalidRate, 0.05);
  assert.equal(cfg.disruptAfterTicks, 3);
});

test('duration can be given in ms, seconds or minutes', () => {
  assert.equal(resolveConfig({ 'duration-ms': 5000 }).durationMs, 5000);
  assert.equal(resolveConfig({ 'duration-seconds': 30 }).durationMs, 30000);
  assert.equal(resolveConfig({ 'duration-minutes': 10 }).durationMs, 600000);
});

test('demand interval defaults to the vehicle interval', () => {
  assert.equal(resolveConfig({ 'interval-ms': 2000 }).demandIntervalMs, 2000);
  assert.equal(resolveConfig({ 'interval-ms': 2000, 'demand-interval-ms': 8000 }).demandIntervalMs, 8000);
});

test('invalid configuration is rejected with a useful message', () => {
  assert.throws(() => resolveConfig({ buses: -1 }), /buses must be a non-negative integer/);
  assert.throws(() => resolveConfig({ 'interval-ms': 0 }), /interval-ms must be greater than 0/);
  assert.throws(() => resolveConfig({ 'invalid-rate': 2 }), /invalid-rate must be between 0 and 1/);
  assert.throws(() => resolveConfig({ scenario: 'meteor-strike' }), /scenario must be one of/);
  assert.throws(
    () => resolveConfig({ buses: 0, trams: 0, trains: 0, locations: 0 }),
    /at least one entity is required/,
  );
});

test('a JSON stage file produces the same configuration as the equivalent flags', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-cfg-'));
  const file = path.join(dir, 'stage.json');
  fs.writeFileSync(file, JSON.stringify({
    name: 'telemetry-growth stage 3',
    simulator: {
      buses: 60, trams: 25, trains: 15, locations: 20, intervalMs: 1000, seed: 424242,
    },
  }));
  const fromFile = resolveConfig({ config: file });
  const fromFlags = resolveConfig({
    buses: 60, trams: 25, trains: 15, locations: 20, 'interval-ms': 1000, seed: 424242,
  });
  assert.deepEqual(fromFile, fromFlags);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('command line flags override the stage file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-cfg-'));
  const file = path.join(dir, 'stage.json');
  fs.writeFileSync(file, JSON.stringify({ simulator: { buses: 10, intervalMs: 5000 } }));
  const cfg = resolveConfig({ config: file, buses: 999 });
  assert.equal(cfg.buses, 999);
  assert.equal(cfg.intervalMs, 5000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing config file fails loudly', () => {
  assert.throws(() => resolveConfig({ config: 'no/such/stage.json' }), /config file not found/);
});

test('expected total events matches the Volume x Velocity model', () => {
  const cfg = resolveConfig({
    buses: 10, trams: 5, trains: 2, locations: 10, 'interval-ms': 1000, 'duration-seconds': 10,
  });
  // 17 vehicles x 10 ticks + 10 locations x 10 ticks
  assert.equal(expectedTotalEvents(cfg), 17 * 10 + 10 * 10);
});
