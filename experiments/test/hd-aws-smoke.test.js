import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPredictiveSmokePlan, parsePredictorEvents,
  reviewPredictorLogEvidence, summariseSmokeEvidence } from '../hd/aws/smoke-hd-aws.js';

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

test('smoke review parses Lambda-prefixed JSON without re-running the workload', () => {
  const runId = 'hd-predictive-smoke-test';
  const event = (signalId, result) => ({ timestamp: '2026-09-24T00:00:00.000Z',
    message: `2026-09-24T00:00:00.000Z\t469a5a77-7d64-5d0b-ab30-395966c0e5cf\tINFO\t${JSON.stringify({ runId, signalId, result })}\n` });
  const logs = Array.from({ length: 11 }, (_, index) => event(`signal-${index}`, {
    acceptedJobs: index < 7 ? 50 : index < 10 ? 250 : 50,
    duplicate: false, scaleRequested: index === 9, target: index === 9 ? 2 : null,
  }));
  logs.push(event('signal-0', { acceptedJobs: 0, duplicate: true, scaleRequested: false }));
  logs.push(event('signal-10', { acceptedJobs: 0, duplicate: true, scaleRequested: false }));
  logs.push({ timestamp: '2026-09-24T00:00:00.000Z', message: 'START RequestId: other\n' });
  assert.equal(parsePredictorEvents(logs, runId).length, 13);
  const initial = { runId, checks: { acceptedSignals: false, duplicateDeliveriesSuppressed: false,
    onePredictiveRequest: false, noPredictiveScaleIn: true, jobsReconciled: true }, passed: false };
  const reviewed = reviewPredictorLogEvidence(initial, logs);
  assert.equal(reviewed.passed, true);
  assert.equal(reviewed.scaleRequests.length, 1);
  assert.equal(reviewed.scaleRequests[0].result.target, 2);
  assert.equal(initial.passed, false);
});

test('automatic smoke summary accepts deployed Lambda prefix and fails closed on missing logs', () => {
  const runId = 'hd-predictive-smoke-fixture';
  const line = (signalId, result) => ({ timestamp: '2026-09-24T00:00:00.000Z',
    message: `2026-09-24T00:00:00.000Z\t469a5a77-7d64-5d0b-ab30-395966c0e5cf\tINFO\t${JSON.stringify({ runId, signalId, result })}\n` });
  const evidence = { manifest: { runId, startedAt: '2026-09-23T23:59:00Z',
    classification: 'LIVE HD SMOKE ONLY', expectedJobs: 2, signalCount: 2,
    duplicateDeliveryCount: 1 },
  dispatches: [{ jobs: 1 }, { jobs: 1 }],
  preflight: { scaling: { targetBacklogPerTask: 75, fastStepIncrease: 4 } },
  state: { seenSignalIds: ['a', 'b'] },
  accounting: { resultsProduced: 2, duplicateResults: 0, queueRemaining: 0, dlqDepth: 0 },
  samples: [{ tasks: [{ taskId: 'ecs-new', lastStatus: 'RUNNING',
    startedAt: '2026-09-24T00:00:01Z' }] }],
  workerLogs: [{ message: '[WORKER_READY] taskId=ecs-new', logStreamName: 'worker/new' }],
  predictorLogs: [line('a', { acceptedJobs: 1 }), line('b', { acceptedJobs: 1,
    scaleRequested: true, target: 2 }), line('a', { acceptedJobs: 0, duplicate: true })],
  history: { source: 'genuine historical CloudWatch GetMetricStatistics',
    predictive: { AnalysisArrivalRate: [{ value: 0.1 }],
      PredictedArrivalRate: [{ value: 0.2 }], PredictiveRecommendedTasks: [{ value: 2 }],
      PredictiveScaleRequest: [{ value: 2 }] } }, signalQueuesClean: true };
  assert.equal(summariseSmokeEvidence(evidence).passed, true);
  assert.equal(summariseSmokeEvidence({ ...evidence, predictorLogs: [] }).passed, false);
  assert.equal(summariseSmokeEvidence({ ...evidence, workerLogs: [] }).passed, false);
  assert.equal(summariseSmokeEvidence({ ...evidence, signalQueuesClean: undefined }).passed, false);
  assert.equal(summariseSmokeEvidence({ ...evidence,
    predictorLogs: [line('wrong-run', { acceptedJobs: 1 })] }).passed, false);
});
