import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPredictiveSmokePlan } from '../hd/aws/smoke-hd-aws.js';

test('bounded HD smoke fills predictor history without changing frozen formal profiles', () => {
  const workload = { incidents: Array.from({ length: 23 }, (_, index) => ({
    sourceEventId: `event-${index}`,
    jobs: Array.from({ length: 50 }, (_, job) => ({ jobId: `job-${index}-${job}` })),
  })) };
  const plan = buildPredictiveSmokePlan(workload);
  assert.equal(plan.length, 11);
  assert.deepEqual(plan.map((group) => group.jobs.length),
    [50, 50, 50, 50, 50, 50, 50, 250, 250, 250, 50]);
  assert.equal(plan.at(-1).offsetMs, 105_000);
  assert.equal(plan.reduce((sum, group) => sum + group.jobs.length, 0), 1150);
  assert.equal(new Set(plan.flatMap((group) => group.sourceEventIds)).size, 23);
  assert.equal(new Set(plan.map((group) => group.signalId)).size, 11);
});
