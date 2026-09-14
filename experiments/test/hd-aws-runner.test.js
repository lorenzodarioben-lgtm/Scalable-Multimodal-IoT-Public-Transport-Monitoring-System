import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHdAwsExperiment } from '../hd/aws/runner.js';
import { loadHdAwsConfiguration } from '../hd/aws/workload.js';
import { verifyHdScalingSnapshot } from '../hd/aws/control-plane.js';

const loaded = loadHdAwsConfiguration(new URL('../hd/aws-ramp.json', import.meta.url));
const config = { ...loaded.config, repeatCount: 1, drainDeadlineSeconds: 5 };
const profile = { ...loaded.profile, name: 'hd-tiny-run', warmupSeconds: 1,
  measurementSeconds: 2, arrival: { segments: [{ startOffsetSeconds: 0,
    endOffsetSeconds: 3, incidentIntervalSeconds: 1 }] } };

function fakeController() {
  const signals = [];
  return {
    signals,
    verifyHdPreflight: async (mode) => ({ mode, startingState: '1/1/0' }),
    verifyProcessingCost: async (cost) => cost,
    sample: async () => ({ timestamp: new Date(1000).toISOString(),
      queue: { visibleMessages: 0, inFlightMessages: 0 },
      service: { desiredCount: 1, runningCount: 1, pendingCount: 0 } }),
    injectJobsWithSignal: async (jobs, signal) => { signals.push(signal); return jobs.length; },
    scalingActivities: async () => [],
    resultsForSources: async (_sources, expected) => ({ resultsProduced: expected,
      duplicateResults: 0, queueRemaining: 0, dlqDepth: 0 }),
    workerLogs: async () => [],
    predictorLogs: async () => [],
    logReferences: () => ({}),
    collectHistory: async () => ({ source: 'fake historical CloudWatch',
      bpt: [{ timestamp: new Date(1000).toISOString(), value: 0 }],
      oldestMessageAge: [], predictive: {} }),
  };
}

test('HD runner executes a count-bounded piecewise schedule through fake ports only', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-hd-runner-'));
  let clock = Date.parse('2026-09-23T00:00:00Z');
  const controller = fakeController();
  try {
    const result = await runHdAwsExperiment({ config, profile, arm: 'reactive',
      repeatNumber: 1, executionNamespace: 'fake-reactive-r1', controller,
      outputDir, now: () => new Date(clock), sleep: async (ms) => { clock += ms; },
      setIntervalFn: () => 1, clearIntervalFn: () => {}, metricsGraceMs: 0 });
    assert.equal(result.summary.injectionTiming.status, 'VALID');
    assert.equal(result.summary.injectionTiming.submittedJobs, 150);
    assert.equal(result.summary.validity, 'PENDING_MANUAL_TIMELINE_REVIEW');
    assert.equal(controller.signals.length, 3);
    assert.ok(fs.existsSync(path.join(result.runDir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(result.runDir, 'cloudwatch-history.json')));
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test('HD runner stops injection on the unchanged interval-based timing guard', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-hd-guard-'));
  let clock = Date.parse('2026-09-23T01:00:00Z');
  const controller = fakeController();
  try {
    const result = await runHdAwsExperiment({ config, profile, arm: 'hybrid',
      repeatNumber: 1, executionNamespace: 'fake-hybrid-r1', controller,
      outputDir, now: () => new Date(clock),
      sleep: async (ms) => { clock += ms + (ms === 1000 ? 1000 : 0); },
      setIntervalFn: () => 1, clearIntervalFn: () => {}, metricsGraceMs: 0 });
    assert.equal(result.summary.injectionTiming.status, 'TIMING-INVALID');
    assert.ok(result.summary.injectionTiming.submittedJobs < 150);
    assert.equal(result.summary.validity, 'TIMING-INVALID');
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test('HD preflight requires the frozen target, fast alarm, and selected controller mode', () => {
  const input = {
    target: { MinCapacity: 1, MaxCapacity: 5 },
    policies: [
      { PolicyType: 'TargetTrackingScaling', TargetTrackingScalingPolicyConfiguration: {
        TargetValue: 75, CustomizedMetricSpecification: {
          Namespace: 'SIT314/HDTransport', MetricName: 'BacklogPerTask',
        },
      } },
      { PolicyType: 'StepScaling', PolicyARN: 'fast-arn', StepScalingPolicyConfiguration: {
        StepAdjustments: [{ ScalingAdjustment: 4 }],
      } },
    ],
    alarm: { StateValue: 'OK', Namespace: 'SIT314/HDTransport', MetricName: 'BacklogPerTask',
      Threshold: 75, Period: 60, EvaluationPeriods: 1, DatapointsToAlarm: 1,
      AlarmActions: ['fast-arn'] },
    mode: 'hybrid', lambdaMode: 'hybrid',
  };
  assert.equal(verifyHdScalingSnapshot(input).targetBacklogPerTask, 75);
  assert.throws(() => verifyHdScalingSnapshot({ ...input, lambdaMode: 'reactive' }), /does not match/);
  assert.throws(() => verifyHdScalingSnapshot({ ...input,
    alarm: { ...input.alarm, StateValue: 'ALARM' } }), /not ready/);
  assert.throws(() => verifyHdScalingSnapshot({ ...input,
    target: { MinCapacity: 1, MaxCapacity: 1 } }), /not 1–5/);
});
