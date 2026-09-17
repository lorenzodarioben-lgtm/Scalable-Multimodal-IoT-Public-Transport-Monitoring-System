import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHdAwsExperiment } from '../hd/aws/runner.js';
import { loadHdAwsConfiguration } from '../hd/aws/workload.js';
import { HdAwsControlPlane, verifyHdScalingSnapshot } from '../hd/aws/control-plane.js';
import { integrateRunningTaskSeconds } from '../hd/aws/task-seconds.js';

const loaded = loadHdAwsConfiguration(new URL('../hd/aws-ramp.json', import.meta.url));
const config = { ...loaded.config, repeatCount: 1, drainDeadlineSeconds: 5 };
const profile = { ...loaded.profile, name: 'hd-tiny-run', warmupSeconds: 1,
  measurementSeconds: 2, arrival: { segments: [{ startOffsetSeconds: 0,
    endOffsetSeconds: 3, incidentIntervalSeconds: 1 }] } };

function fakeController(now = () => new Date(1000)) {
  const signals = [];
  return {
    signals,
    verifyHdPreflight: async (mode) => ({ mode, startingState: '1/1/0' }),
    verifyProcessingCost: async (cost) => cost,
    sample: async () => ({ timestamp: now().toISOString(),
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
      oldestMessageAge: [], predictive: {
        AnalysisArrivalRate: [{ timestamp: new Date(1000).toISOString(), value: 50 }],
      } }),
    signalQueuesClean: async () => ({ arrival: { visible: 0, inFlight: 0 },
      dlq: { visible: 0, inFlight: 0 } }),
  };
}

test('HD runner executes a count-bounded piecewise schedule through fake ports only', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-hd-runner-'));
  let clock = Date.parse('2026-09-23T00:00:00Z');
  const controller = fakeController(() => new Date(clock));
  try {
    const result = await runHdAwsExperiment({ config, profile, arm: 'reactive',
      repeatNumber: 1, executionNamespace: 'fake-reactive-r1', controller,
      outputDir, now: () => new Date(clock), sleep: async (ms) => { clock += ms; },
      setIntervalFn: () => 1, clearIntervalFn: () => {}, metricsGraceMs: 0 });
    assert.equal(result.summary.injectionTiming.status, 'VALID');
    assert.equal(result.summary.injectionTiming.submittedJobs, 150);
    assert.equal(result.summary.validity, 'PENDING_MANUAL_TIMELINE_REVIEW');
    assert.equal(result.summary.results.taskSeconds, 2);
    assert.equal(controller.signals.length, 3);
    assert.ok(fs.existsSync(path.join(result.runDir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(result.runDir, 'cloudwatch-history.json')));
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test('HD runner stops injection on the unchanged interval-based timing guard', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-hd-guard-'));
  let clock = Date.parse('2026-09-23T01:00:00Z');
  const controller = fakeController(() => new Date(clock));
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

test('HD runner withholds validity when required historical metrics are absent', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-hd-missing-metric-'));
  let clock = Date.parse('2026-09-23T02:00:00Z');
  const controller = fakeController(() => new Date(clock));
  controller.collectHistory = async () => ({ source: 'genuine historical CloudWatch GetMetricStatistics',
    bpt: [{ timestamp: new Date(clock).toISOString(), value: 0 }],
    oldestMessageAge: [], predictive: { AnalysisArrivalRate: [] } });
  try {
    const result = await runHdAwsExperiment({ config, profile, arm: 'reactive', repeatNumber: 1,
      executionNamespace: 'fake-missing-metric', controller, outputDir,
      now: () => new Date(clock), sleep: async (ms) => { clock += ms; },
      setIntervalFn: () => 1, clearIntervalFn: () => {}, metricsGraceMs: 0 });
    assert.equal(result.summary.validity, 'PENDING_REQUIRED_METRICS');
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test('measurement task-seconds clip piecewise capacity to the declared window', () => {
  const origin = Date.parse('2026-09-23T00:00:00Z');
  const sample = (second, runningCount) => ({ timestamp: new Date(origin + second * 1000).toISOString(),
    service: { runningCount } });
  // Window [10,50): 1 task for 20 s, 3 tasks for 10 s, 5 tasks for 10 s = 100 task-s.
  assert.equal(integrateRunningTaskSeconds([
    sample(0, 1), sample(30, 3), sample(40, 5), sample(60, 5),
  ], new Date(origin + 10_000).toISOString(), new Date(origin + 50_000).toISOString()), 100);
  assert.throws(() => integrateRunningTaskSeconds([sample(20, 1), sample(60, 1)],
    new Date(origin + 10_000).toISOString(), new Date(origin + 50_000).toISOString()), /cover/);
  assert.throws(() => integrateRunningTaskSeconds([sample(0, 1), sample(30, 3), sample(20, 1)],
    new Date(origin + 10_000).toISOString(), new Date(origin + 20_000).toISOString()), /increase/);
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

test('HD sampling retains exact ECS task identities and RUNNING timestamps', async () => {
  class ListTasksCommand { constructor(input) { this.input = input; } }
  class DescribeTasksCommand { constructor(input) { this.input = input; } }
  const base = {
    cluster: 'sit314-hd-test-cluster', service: 'sit314-hd-test-route-impact',
    sample: async () => ({ timestamp: '2026-09-23T00:01:00Z', service: { runningCount: 2 } }),
    sdk: { ecs: { ListTasksCommand, DescribeTasksCommand } },
    ecs: { send: async (command) => command instanceof ListTasksCommand
      ? { taskArns: ['arn:aws:ecs:us-east-1:123456789012:task/cluster/abc'] }
      : { tasks: [{ taskArn: command.input.tasks[0], lastStatus: 'RUNNING',
        startedAt: new Date('2026-09-23T00:00:45Z') }] } },
  };
  const plane = new HdAwsControlPlane({ base, lambdaSdk: { LambdaClient: class {} },
    cwSdk: { CloudWatchClient: class {} }, region: 'us-east-1', prefix: 'sit314-hd-test' });
  const sample = await plane.sample();
  assert.equal(sample.tasks[0].taskId, 'ecs-abc');
  assert.equal(sample.tasks[0].startedAt, '2026-09-23T00:00:45.000Z');
});

test('HD processing preflight records identical worker image and Fargate size evidence', async () => {
  class DescribeTaskDefinitionCommand { constructor(input) { this.input = input; } }
  const base = {
    verifyProcessingCost: async () => ({ processingDelayMs: 50, processingCpuIterations: 0 }),
    serviceSnapshot: async () => ({ taskDefinition: 'arn:hd-task' }),
    sdk: { ecs: { DescribeTaskDefinitionCommand } },
    ecs: { send: async () => ({ taskDefinition: { cpu: '256', memory: '512',
      containerDefinitions: [{ name: 'route-impact-worker',
        image: '123.dkr.ecr.us-east-1.amazonaws.com/sit314-hd-test-route-impact-worker:hd-frozen' }] } }) },
  };
  const plane = new HdAwsControlPlane({ base, lambdaSdk: { LambdaClient: class {} },
    cwSdk: { CloudWatchClient: class {} }, region: 'us-east-1', prefix: 'sit314-hd-test' });
  const verified = await plane.verifyProcessingCost({ processingDelayMs: 50 });
  assert.equal(verified.taskCpu, '256');
  assert.equal(verified.taskMemory, '512');
  assert.match(verified.workerImage, /sit314-hd-test-route-impact-worker/);
});
