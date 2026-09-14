import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HybridPredictiveController,
  fitLinearRateModel,
  predictionMae,
} from '../hd/predictive-controller.js';
import {
  createHdArrivalSchedule,
  profileArrivalRates,
  validateHdWorkloadProfile,
} from '../hd/workload-profile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

function controller(options = {}) {
  return new HybridPredictiveController({
    historySize: 6,
    requiredConsecutiveRecommendations: 2,
    minRisingSlopeJobsPerSecondSquared: 0.02,
    predictionHorizonSeconds: 110,
    duplicateRequestCooldownSeconds: 60,
    ...options,
  });
}

function observe(instance, second, rate, extra = {}) {
  return instance.observe({
    atMs: second * 1000,
    arrivalRateJobsPerSecond: rate,
    visibleBacklog: 0,
    backlogPerTask: 0,
    runningTasks: 1,
    desiredTasks: 1,
    reactiveRequiredTasks: 1,
    ...extra,
  });
}

test('HD controller remains local-only and does not import an AWS SDK', () => {
  const source = fs.readFileSync(path.join(root, 'experiments', 'hd', 'predictive-controller.js'), 'utf8');
  assert.doesNotMatch(source, /@aws-sdk|AwsControlPlane|UpdateServiceCommand/);
});

test('insufficient history safely holds at the reactive capacity floor', () => {
  const instance = controller();
  const result = observe(instance, 0, 10, { reactiveRequiredTasks: 3, desiredTasks: 2, runningTasks: 2 });
  assert.equal(result.reason, 'insufficient-history');
  assert.equal(result.recommendedTasks, 3);
  assert.equal(result.shouldRequestScaleOut, false);
});

test('an injected clock keeps omitted observation times deterministic', () => {
  let time = 0;
  const instance = controller({ now: () => time });
  const first = instance.observe({
    arrivalRateJobsPerSecond: 10,
    runningTasks: 1,
    desiredTasks: 1,
  });
  time = 10_000;
  const second = instance.observe({
    arrivalRateJobsPerSecond: 10,
    runningTasks: 1,
    desiredTasks: 1,
  });
  assert.equal(first.observedAtMs, 0);
  assert.equal(second.observedAtMs, 10_000);
});

test('flat and noisy traffic never produces a predictive scale-out', () => {
  const instance = controller();
  let result;
  for (const [second, rate] of [[0, 10], [10, 10.2], [20, 9.8], [30, 10.1], [40, 9.9], [50, 10]]) {
    result = observe(instance, second, rate);
  }
  assert.equal(result.reason, 'hold-flat-or-noisy-traffic');
  assert.equal(result.shouldRequestScaleOut, false);
});

test('a rising rate predicts pressure and requests bounded proactive scale-out after hysteresis', () => {
  const instance = controller();
  let result;
  for (const [second, rate] of [[0, 10], [10, 15], [20, 20], [30, 25], [40, 30], [50, 35]]) {
    result = observe(instance, second, rate);
  }
  assert.equal(result.reason, 'hold-hysteresis');
  result = observe(instance, 60, 40);
  assert.equal(result.reason, 'predictive-scale-out');
  assert.equal(result.shouldRequestScaleOut, true);
  assert.equal(result.recommendedTasks, 5);
  assert.ok(result.predictedArrivalRateJobsPerSecond > 40);
  assert.ok(result.predictedVisibleBacklog > 0);
});

test('falling traffic never initiates predictive scale-in or scale-out', () => {
  const instance = controller();
  let result;
  for (const [second, rate] of [[0, 50], [10, 45], [20, 40], [30, 35], [40, 30], [50, 25]]) {
    result = observe(instance, second, rate, { runningTasks: 3, desiredTasks: 3, reactiveRequiredTasks: 3 });
  }
  assert.equal(result.reason, 'hold-falling-traffic');
  assert.equal(result.recommendedTasks, 3);
  assert.equal(result.shouldRequestScaleOut, false);
});

test('a sudden burst is safe while the independent reactive fallback remains active', () => {
  const instance = controller();
  for (const second of [0, 10, 20, 30, 40, 50]) observe(instance, second, 10);
  const result = observe(instance, 60, 60, { backlogPerTask: 90 });
  assert.equal(result.reactiveFallbackActive, true);
  assert.equal(result.shouldRequestScaleOut, false, 'hysteresis prevents one noisy observation becoming a duplicate request');
  assert.ok(['hold-hysteresis', 'hold-duplicate-request'].includes(result.reason));
});

test('repeated unchanged recommendations do not issue duplicate requests inside cooldown', () => {
  const instance = controller();
  for (const [second, rate] of [[0, 10], [10, 15], [20, 20], [30, 25], [40, 30], [50, 35], [60, 40]]) {
    observe(instance, second, rate);
  }
  const duplicate = observe(instance, 70, 45);
  assert.equal(duplicate.reason, 'hold-duplicate-request');
  assert.equal(duplicate.shouldRequestScaleOut, false);
});

test('linear prediction and MAE are deterministic and explainable', () => {
  const model = fitLinearRateModel([
    { atMs: 0, arrivalRateJobsPerSecond: 10 },
    { atMs: 10_000, arrivalRateJobsPerSecond: 20 },
    { atMs: 20_000, arrivalRateJobsPerSecond: 30 },
  ]);
  assert.equal(model.slopeJobsPerSecondSquared, 1);
  assert.equal(model.predictAt(30_000), 40);
  assert.equal(predictionMae([
    { predictedJobsPerSecond: 40, actualJobsPerSecond: 42 },
    { predictedJobsPerSecond: 20, actualJobsPerSecond: 18 },
  ]), 2);
});

test('state round trip preserves cooldown and a repeated observation is harmless', () => {
  const original = controller();
  for (const [second, rate] of [[0, 10], [10, 15], [20, 20], [30, 25], [40, 30], [50, 35], [60, 40]]) {
    observe(original, second, rate);
  }
  const state = JSON.parse(JSON.stringify(original.exportState()));
  const restored = controller({ state });
  assert.deepEqual(restored.exportState(), state);
  const repeated = observe(restored, 60, 40);
  assert.equal(repeated.reason, 'duplicate-observation');
  assert.equal(repeated.shouldRequestScaleOut, false);
  assert.deepEqual(restored.exportState(), state);
  assert.equal(observe(restored, 70, 45).reason, 'hold-duplicate-request');
});

test('invalid, conflicting and zero-running observations are handled explicitly', () => {
  const instance = controller();
  assert.throws(() => observe(instance, 0, null), /finite/);
  assert.throws(() => observe(instance, 0, -1), /negative/);
  assert.equal(observe(instance, 0, 10, { runningTasks: 0 }).observedFloorTasks, 1);
  assert.throws(() => observe(instance, 0, 11), /conflicting duplicate/);
  assert.throws(() => observe(instance, -1, 10), /chronological/);
});

test('HD workload profiles are deterministic, complete, and marked as planned rather than evidence', () => {
  for (const file of ['predictable-ramp.json', 'sudden-burst.json']) {
    const profile = JSON.parse(fs.readFileSync(path.join(root, 'experiments', 'hd', file), 'utf8'));
    assert.equal(profile.evidenceClassification.status, 'HD PLANNED EXPERIMENT');
    const validated = validateHdWorkloadProfile(profile);
    const first = createHdArrivalSchedule(profile);
    const second = createHdArrivalSchedule(profile);
    assert.deepEqual(first, second);
    assert.equal(first.scheduledArrivalSeconds, validated.totalSeconds);
    assert.equal(first.expectedJobs, first.incidents.length * profile.incident.jobsPerIncident);
    assert.equal(first.incidents[0].phase, 'warmup');
    assert.equal(first.incidents.at(-1).phase, 'measurement');
    assert.ok(profileArrivalRates(profile).every((segment) => segment.jobsPerSecond > 0));
  }
});
