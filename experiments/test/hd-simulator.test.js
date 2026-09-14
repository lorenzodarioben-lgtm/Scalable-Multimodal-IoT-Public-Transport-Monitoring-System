import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LOCAL_CLASSIFICATION, simulateHdProfile } from '../hd/simulator/model.js';

const load = (name) => JSON.parse(fs.readFileSync(new URL(`../hd/${name}.json`, import.meta.url), 'utf8'));
const config = JSON.parse(fs.readFileSync(new URL('../hd/simulator/assumptions.json', import.meta.url), 'utf8'));

test('matched local arms account for identical jobs and use the same physical model', () => {
  for (const profile of [load('predictable-ramp'), load('sudden-burst')]) {
    const reactive = simulateHdProfile({ profile, mode: 'reactive', config });
    const hybrid = simulateHdProfile({ profile, mode: 'hybrid', config });
    assert.equal(reactive.classification, LOCAL_CLASSIFICATION);
    assert.equal(hybrid.classification, LOCAL_CLASSIFICATION);
    assert.equal(reactive.expectedJobs, hybrid.expectedJobs);
    assert.equal(reactive.arrivals, reactive.expectedJobs);
    assert.equal(hybrid.arrivals, hybrid.expectedJobs);
    assert.ok(Math.abs(reactive.unaccounted) < 1e-5);
    assert.ok(Math.abs(hybrid.unaccounted) < 1e-5);
    assert.ok(reactive.requests.every((request) => request.source === 'reactive'));
    assert.ok(hybrid.requests.every((request) => request.desiredTasks >= 2 && request.desiredTasks <= 5));
    assert.ok(hybrid.trace.every((point) => point.runningTasks >= 1 && point.runningTasks <= 5));
  }
});

test('the ramp offers predictive lead and no local result is labelled as AWS evidence', () => {
  const profile = load('predictable-ramp');
  const hybrid = simulateHdProfile({ profile, mode: 'hybrid', config });
  assert.ok(hybrid.firstPredictiveRequestAtSeconds !== null);
  assert.ok(hybrid.firstWorkerReadyAtSeconds > hybrid.firstPredictiveRequestAtSeconds);
  assert.match(hybrid.classification, /NOT FINAL AWS HD EVIDENCE/);
});

test('flat traffic does not trigger predictive scale-out', () => {
  const base = load('predictable-ramp');
  const profile = {
    ...base, name: 'hd-flat-diagnostic',
    arrival: { segments: [{ startOffsetSeconds: 0, endOffsetSeconds: 630, incidentIntervalSeconds: 5 }] },
  };
  const hybrid = simulateHdProfile({ profile, mode: 'hybrid', config });
  assert.equal(hybrid.firstPredictiveRequestAtSeconds, null);
  assert.equal(hybrid.peakVisibleBacklog, 50);
});
