import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AwsControlPlane, capacityForMode } from '../aws/control-plane.js';
import { runAwsExperiment } from '../aws/runner.js';
import { buildAwsSummary } from '../aws/summary.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const runnerSource = fs.readFileSync(path.join(here, '..', 'aws', 'runner.js'), 'utf8');
const controlPlaneSource = fs.readFileSync(path.join(here, '..', 'aws', 'control-plane.js'), 'utf8');
const sqsQueueSource = fs.readFileSync(path.join(here, '..', '..', 'shared', 'aws', 'queues.js'), 'utf8');
const scalingTemplate = fs.readFileSync(path.join(here, '..', '..', 'infrastructure', 'cloudformation', 'scaling.yaml'), 'utf8');

function stage() {
  return {
    name: 'aws-unit-stage', type: 'incident', seed: 17, repeatCount: 3,
    warmupSeconds: 0, durationSeconds: 20, drainDeadlineSeconds: 30, sampleIntervalSeconds: 10,
    arrival: { mode: 'count-bounded', incidentIntervalSeconds: 10, incidents: 2 },
    incident: {
      scenario: 'bus-breakdown', transportMode: 'bus', reason: 'breakdown', severity: 'high',
      vehicleId: 'BUS-001', routeId: '703', affectedLocations: 1, jobsPerIncident: 2,
      notificationsPerIncident: 4,
    },
    worker: { processingDelayMs: 50, processingCpuIterations: 0 },
  };
}

function fakeController(clock, calls) {
  return {
    async configureCapacity(mode) { calls.push(['configureCapacity', mode]); },
    async verifyQueuesClean() { calls.push(['verifyQueuesClean']); },
    async verifyProcessingCost(cost) { calls.push(['verifyProcessingCost', cost]); return { ...cost, source: 'test' }; },
    async waitForStartingState(mode) { calls.push(['waitForStartingState', mode]); return { desiredCount: 1, runningCount: 1 }; },
    async waitForWorkerReady() { calls.push(['waitForWorkerReady']); return { workers: [{ taskId: 'ecs-unit' }] }; },
    async sample() {
      calls.push(['sample']);
      return {
        timestamp: new Date(clock.value).toISOString(),
        queue: { visibleMessages: 0, inFlightMessages: 0, oldestMessageAgeSeconds: 0 },
        service: { desiredCount: 1, runningCount: 1 },
      };
    },
    async injectJobs(jobs) { calls.push(['injectJobs', jobs.length]); return jobs.length; },
    async scalingActivities() { return []; },
    async resultsForSources(ids, expectedJobs) { return { resultsProduced: expectedJobs, duplicateResults: 0, queueRemaining: 0, dlqDepth: 0, ids }; },
    async workerLogs() { return [{ timestamp: new Date(clock.value).toISOString(), message: '[WORKER_READY] taskId=unit' }]; },
    logReferences() { return { logGroupName: '/unit', query: 'unit test' }; },
  };
}

async function run(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-aws-run-'));
  const clock = { value: Date.UTC(2026, 0, 1) };
  const calls = [];
  const result = await runAwsExperiment({
    stage: stage(), mode, repeatNumber: 1, outputDir: root, executionNamespace: `${mode}-unit`,
    controller: fakeController(clock, calls),
    now: () => new Date(clock.value), sleep: async (milliseconds) => { clock.value += milliseconds; },
  });
  return { root, calls, result };
}

test('capacity modes are exactly fixed one or autoscale one-to-five', () => {
  assert.deepEqual(capacityForMode('fixed'), { minCapacity: 1, maxCapacity: 1, desiredCount: 1 });
  assert.deepEqual(capacityForMode('autoscale'), { minCapacity: 1, maxCapacity: 5, desiredCount: 1 });
});

test('AWS SQS queue reads never request the CloudWatch-only oldest-age metric as an attribute', () => {
  for (const source of [controlPlaneSource, sqsQueueSource, scalingTemplate]) {
    assert.doesNotMatch(source, /AttributeNames\s*:\s*\[[^\]]*ApproximateAgeOfOldestMessage/s);
  }
});

test('AWS injector submits the five SQS batches for one fifty-job incident concurrently', async () => {
  const pending = [];
  let active = 0;
  let peakActive = 0;
  const requests = [];
  class SendMessageBatchCommand { constructor(input) { this.input = input; } }
  class SqsClient {
    send(command) {
      assert.ok(command instanceof SendMessageBatchCommand);
      requests.push(command.input);
      active += 1;
      peakActive = Math.max(peakActive, active);
      return new Promise((resolve) => pending.push(() => {
        active -= 1;
        resolve({ Successful: command.input.Entries.map(({ Id }) => ({ Id })) });
      }));
    }
  }
  class EmptyClient { async send() { throw new Error('unexpected AWS client call'); } }
  const sdk = {
    ecs: { ECSClient: EmptyClient },
    autoscaling: { ApplicationAutoScalingClient: EmptyClient },
    sqs: { SQSClient: SqsClient, SendMessageBatchCommand },
    dynamodb: { DynamoDBClient: EmptyClient },
    dynamodbDocument: { DynamoDBDocumentClient: { from: () => new EmptyClient() } },
    logs: { CloudWatchLogsClient: EmptyClient },
  };
  const controller = new AwsControlPlane({ region: 'us-east-1', prefix: 'sit314-transport', sdk });
  controller.queueUrls.set('sit314-transport-analysis', 'https://queue.example/analysis');
  const jobs = Array.from({ length: 50 }, (_, index) => ({ jobId: `job-${index}` }));

  const submitted = controller.injectJobs(jobs);
  await Promise.resolve();
  assert.equal(requests.length, 5);
  assert.equal(peakActive, 5);
  assert.deepEqual(requests.map((request) => request.Entries.length), [10, 10, 10, 10, 10]);
  assert.equal(new Set(requests.flatMap((request) => request.Entries.map((entry) => entry.MessageBody))).size, 50);
  pending.forEach((resolve) => resolve());
  assert.equal(await submitted, 50);
});

test('AWS worker readiness uses the known ECS task stream, never log-stream recency', async () => {
  const taskArn = 'arn:aws:ecs:us-east-1:123456789012:task/sit314-transport-cluster/task-abc';
  const logRequests = [];
  class ListTasksCommand { constructor(input) { this.input = input; } }
  class DescribeTasksCommand { constructor(input) { this.input = input; } }
  class GetLogEventsCommand { constructor(input) { this.input = input; } }
  class EcsClient {
    async send(command) {
      if (command instanceof ListTasksCommand) return { taskArns: [taskArn] };
      if (command instanceof DescribeTasksCommand) return { tasks: [{ taskArn }] };
      throw new Error(`unexpected ECS command ${command.constructor.name}`);
    }
  }
  class LogsClient {
    async send(command) {
      logRequests.push(command.input);
      return { events: [{ timestamp: Date.UTC(2026, 0, 1), message: '[WORKER_READY] taskId=ecs-task-abc' }] };
    }
  }
  class EmptyClient { async send() { throw new Error('unexpected AWS client call'); } }
  const sdk = {
    ecs: { ECSClient: EcsClient, ListTasksCommand, DescribeTasksCommand },
    logs: { CloudWatchLogsClient: LogsClient, GetLogEventsCommand },
    autoscaling: { ApplicationAutoScalingClient: EmptyClient },
    sqs: { SQSClient: EmptyClient },
    dynamodb: { DynamoDBClient: EmptyClient },
    dynamodbDocument: { DynamoDBDocumentClient: { from: () => new EmptyClient() } },
  };
  const controller = new AwsControlPlane({ region: 'us-east-1', prefix: 'sit314-transport', sdk, sleep: async () => {} });

  const ready = await controller.waitForWorkerReady({ timeoutSeconds: 1 });

  assert.equal(ready.workers[0].taskId, 'ecs-task-abc');
  assert.deepEqual(logRequests, [{
    logGroupName: '/ecs/sit314-transport-route-impact',
    logStreamName: 'route-impact/route-impact-worker/task-abc',
    startFromHead: true,
    limit: 100,
  }]);
});

test('AWS worker readiness rejects an old event for a different ECS task ID', async () => {
  const taskArn = 'arn:aws:ecs:us-east-1:123456789012:task/sit314-transport-cluster/task-current';
  class ListTasksCommand { constructor(input) { this.input = input; } }
  class DescribeTasksCommand { constructor(input) { this.input = input; } }
  class GetLogEventsCommand { constructor(input) { this.input = input; } }
  class EcsClient {
    async send(command) {
      if (command instanceof ListTasksCommand) return { taskArns: [taskArn] };
      if (command instanceof DescribeTasksCommand) return { tasks: [{ taskArn }] };
      throw new Error(`unexpected ECS command ${command.constructor.name}`);
    }
  }
  class LogsClient {
    async send() {
      return { events: [{ timestamp: Date.UTC(2026, 0, 1), message: '[WORKER_READY] taskId=ecs-task-old' }] };
    }
  }
  class EmptyClient { async send() { throw new Error('unexpected AWS client call'); } }
  const sdk = {
    ecs: { ECSClient: EcsClient, ListTasksCommand, DescribeTasksCommand },
    logs: { CloudWatchLogsClient: LogsClient, GetLogEventsCommand },
    autoscaling: { ApplicationAutoScalingClient: EmptyClient },
    sqs: { SQSClient: EmptyClient },
    dynamodb: { DynamoDBClient: EmptyClient },
    dynamodbDocument: { DynamoDBDocumentClient: { from: () => new EmptyClient() } },
  };
  const controller = new AwsControlPlane({
    region: 'us-east-1', prefix: 'sit314-transport', sdk, sleep: async () => {},
  });

  await assert.rejects(
    controller.waitForWorkerReady({ timeoutSeconds: 0 }),
    /did not emit WORKER_READY/,
  );
});

test('AWS runner records a complete count-bounded manifest without local workers', async () => {
  assert.doesNotMatch(runnerSource, /LocalAutoscaler|defaultSpawner|child_process|route-impact-worker\/src/);
  const { root, calls, result } = await run('fixed');
  try {
    assert.deepEqual(calls.filter(([name]) => name === 'injectJobs').map(([, count]) => count), [2, 2]);
    assert.deepEqual(calls.slice(0, 5).map(([name, mode]) => [name, typeof mode === 'string' ? mode : null].filter(Boolean)), [
      ['configureCapacity', 'fixed'], ['verifyQueuesClean'], ['verifyProcessingCost'], ['waitForStartingState', 'fixed'], ['waitForWorkerReady'],
    ]);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.runDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.workload.expectedAnalysisJobs, 4);
    assert.equal(manifest.workload.incidentCount, 2);
    assert.equal(manifest.workload.processingCost.processingCpuIterations, 0);
    assert.deepEqual(manifest.methodology.evidenceClassification, { status: 'FORMAL EVIDENCE' });
    assert.equal(manifest.methodology.noLocalConsumer, true);
    assert.equal(manifest.workerStartup.workers[0].taskId, 'ecs-unit');
    assert.ok(fs.existsSync(path.join(result.runDir, 'samples.jsonl')));
    assert.ok(fs.existsSync(path.join(result.runDir, 'scaling-activities.json')));
    assert.ok(fs.existsSync(path.join(result.runDir, 'summary.json')));
    assert.ok(fs.existsSync(path.join(result.runDir, 'logs', 'references.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AWS workload timing begins after preflight and preserves scheduled warm-up', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-aws-timing-'));
  const clock = { value: Date.UTC(2026, 0, 1) };
  const injectionTimes = [];
  let readinessCompletedAt;
  const timedStage = {
    ...stage(),
    warmupSeconds: 30,
    durationSeconds: 30,
    arrival: { mode: 'count-bounded', incidentIntervalSeconds: 10, incidents: 6 },
  };
  const advance = (milliseconds) => { clock.value += milliseconds; };
  const controller = {
    async configureCapacity() { advance(5000); },
    async verifyQueuesClean() { advance(4000); },
    async verifyProcessingCost(cost) { advance(3000); return { ...cost, source: 'test' }; },
    async waitForStartingState() { advance(8000); return { desiredCount: 1, runningCount: 1 }; },
    async waitForWorkerReady() {
      advance(10_000);
      readinessCompletedAt = new Date(clock.value).toISOString();
      return { workers: [{ taskId: 'ecs-unit' }] };
    },
    async sample() {
      return {
        timestamp: new Date(clock.value).toISOString(),
        queue: { visibleMessages: 0, inFlightMessages: 0, oldestMessageAgeSeconds: 0 },
        service: { desiredCount: 1, runningCount: 1 },
      };
    },
    async injectJobs(jobs) {
      injectionTimes.push(new Date(clock.value).toISOString());
      return jobs.length;
    },
    async scalingActivities() { return []; },
    async resultsForSources(ids, expectedJobs) {
      return { resultsProduced: expectedJobs, duplicateResults: 0, queueRemaining: 0, dlqDepth: 0, ids };
    },
    async workerLogs() { return []; },
    logReferences() { return { logGroupName: '/unit', query: 'unit test' }; },
  };

  try {
    const result = await runAwsExperiment({
      stage: timedStage,
      mode: 'fixed',
      repeatNumber: 1,
      outputDir: root,
      executionNamespace: 'timing-unit',
      controller,
      now: () => new Date(clock.value),
      sleep: async (milliseconds) => { advance(milliseconds); },
    });
    const { manifest, summary } = result;
    assert.equal(manifest.orchestrationStartedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(manifest.preflightCompletedAt, '2026-01-01T00:00:30.000Z');
    assert.equal(manifest.workloadStartedAt, '2026-01-01T00:00:30.000Z');
    assert.equal(manifest.startedAt, manifest.workloadStartedAt);
    assert.equal(manifest.measurementStartedAt, '2026-01-01T00:01:00.000Z');
    assert.equal(manifest.workloadCompletedAt, '2026-01-01T00:01:30.000Z');
    assert.ok(Date.parse(injectionTimes[0]) >= Date.parse(readinessCompletedAt));
    assert.equal(injectionTimes[0], manifest.workloadStartedAt);
    assert.equal(injectionTimes[3], manifest.measurementStartedAt);
    assert.deepEqual(injectionTimes.map((time) => Date.parse(time) - Date.parse(manifest.workloadStartedAt)), [
      0, 10_000, 20_000, 30_000, 40_000, 50_000,
    ]);
    assert.equal(
      Date.parse(manifest.measurementStartedAt) - Date.parse(manifest.workloadStartedAt),
      30_000,
    );
    assert.equal(summary.startedAt, manifest.workloadStartedAt);
    assert.equal(summary.measurementStartedAt, manifest.measurementStartedAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AWS scheduler derives every incident time from the workload epoch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-aws-epoch-'));
  const clock = { value: Date.UTC(2026, 0, 1) };
  const dispatchStarts = [];
  const epochStage = {
    ...stage(),
    warmupSeconds: 0,
    durationSeconds: 30,
    arrival: { mode: 'count-bounded', incidentIntervalSeconds: 10, incidents: 3 },
  };
  const controller = {
    async configureCapacity() {}, async verifyQueuesClean() {},
    async verifyProcessingCost(cost) { return cost; },
    async waitForStartingState() { return { desiredCount: 1, runningCount: 1 }; },
    async waitForWorkerReady() { return { workers: [{ taskId: 'ecs-unit' }] }; },
    async sample() {
      return {
        timestamp: new Date(clock.value).toISOString(),
        queue: { visibleMessages: 0, inFlightMessages: 0, oldestMessageAgeSeconds: 0 },
        service: { desiredCount: 1, runningCount: 1 },
      };
    },
    async injectJobs(jobs) {
      dispatchStarts.push(clock.value);
      clock.value += 2_000;
      return jobs.length;
    },
    async scalingActivities() { return []; },
    async resultsForSources(ids, expectedJobs) { return { resultsProduced: expectedJobs, duplicateResults: 0, queueRemaining: 0, dlqDepth: 0, ids }; },
    async workerLogs() { return []; },
    logReferences() { return {}; },
  };
  try {
    const result = await runAwsExperiment({
      stage: epochStage, mode: 'fixed', repeatNumber: 1, outputDir: root,
      executionNamespace: 'epoch-unit', controller,
      now: () => new Date(clock.value), sleep: async (milliseconds) => { clock.value += milliseconds; },
    });
    assert.deepEqual(dispatchStarts.map((time) => time - Date.UTC(2026, 0, 1)), [0, 10_000, 20_000]);
    assert.equal(result.summary.injectionTiming.status, 'VALID');
    assert.equal(result.summary.injectionTiming.maxScheduleLagMs, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AWS sampling cannot delay the next scheduled incident', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-aws-sampling-'));
  const clock = { value: Date.UTC(2026, 0, 1) };
  const dispatchStarts = [];
  let intervalCallback;
  let resolveSlowSample;
  const slowSample = new Promise((resolve) => { resolveSlowSample = resolve; });
  let sampleCalls = 0;
  const samplingStage = {
    ...stage(),
    warmupSeconds: 0,
    durationSeconds: 20,
    arrival: { mode: 'count-bounded', incidentIntervalSeconds: 10, incidents: 2 },
  };
  const snapshot = () => ({
    timestamp: new Date(clock.value).toISOString(),
    queue: { visibleMessages: 0, inFlightMessages: 0, oldestMessageAgeSeconds: 0 },
    service: { desiredCount: 1, runningCount: 1 },
  });
  const controller = {
    async configureCapacity() {}, async verifyQueuesClean() {},
    async verifyProcessingCost(cost) { return cost; },
    async waitForStartingState() { return { desiredCount: 1, runningCount: 1 }; },
    async waitForWorkerReady() { return { workers: [{ taskId: 'ecs-unit' }] }; },
    async sample() {
      sampleCalls += 1;
      return sampleCalls === 2 ? slowSample : snapshot();
    },
    async injectJobs(jobs) {
      dispatchStarts.push(clock.value);
      if (dispatchStarts.length === 1) {
        intervalCallback();
        await Promise.resolve();
      } else {
        resolveSlowSample(snapshot());
      }
      return jobs.length;
    },
    async scalingActivities() { return []; },
    async resultsForSources(ids, expectedJobs) { return { resultsProduced: expectedJobs, duplicateResults: 0, queueRemaining: 0, dlqDepth: 0, ids }; },
    async workerLogs() { return []; },
    logReferences() { return {}; },
  };
  try {
    await runAwsExperiment({
      stage: samplingStage, mode: 'fixed', repeatNumber: 1, outputDir: root,
      executionNamespace: 'sampling-unit', controller,
      now: () => new Date(clock.value), sleep: async (milliseconds) => { clock.value += milliseconds; },
      setIntervalFn: (callback) => { intervalCallback = callback; return 'sampler'; },
      clearIntervalFn: () => {},
    });
    assert.deepEqual(dispatchStarts.map((time) => time - Date.UTC(2026, 0, 1)), [0, 10_000]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AWS scheduler launches the next epoch-derived incident without waiting for an earlier dispatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-aws-overlap-'));
  const clock = { value: Date.UTC(2026, 0, 1) };
  const dispatchStarts = [];
  const pending = [];
  const overlapStage = {
    ...stage(),
    warmupSeconds: 0,
    durationSeconds: 20,
    arrival: { mode: 'count-bounded', incidentIntervalSeconds: 10, incidents: 2 },
  };
  const snapshot = () => ({
    timestamp: new Date(clock.value).toISOString(),
    queue: { visibleMessages: 0, inFlightMessages: 0, oldestMessageAgeSeconds: 0 },
    service: { desiredCount: 1, runningCount: 1 },
  });
  const controller = {
    async configureCapacity() {}, async verifyQueuesClean() {},
    async verifyProcessingCost(cost) { return cost; },
    async waitForStartingState() { return { desiredCount: 1, runningCount: 1 }; },
    async waitForWorkerReady() { return { workers: [{ taskId: 'ecs-unit' }] }; },
    async sample() { return snapshot(); },
    injectJobs(jobs) {
      dispatchStarts.push(clock.value);
      const completion = new Promise((resolve) => pending.push(() => resolve(jobs.length)));
      if (dispatchStarts.length === 2) pending.forEach((resolve) => resolve());
      return completion;
    },
    async scalingActivities() { return []; },
    async resultsForSources(ids, expectedJobs) { return { resultsProduced: expectedJobs, duplicateResults: 0, queueRemaining: 0, dlqDepth: 0, ids }; },
    async workerLogs() { return []; },
    logReferences() { return {}; },
  };
  try {
    await runAwsExperiment({
      stage: overlapStage, mode: 'fixed', repeatNumber: 1, outputDir: root,
      executionNamespace: 'overlap-unit', controller,
      now: () => new Date(clock.value), sleep: async (milliseconds) => { clock.value += milliseconds; },
    });
    assert.deepEqual(dispatchStarts.map((time) => time - Date.UTC(2026, 0, 1)), [0, 10_000]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AWS runner stops injection and marks a run timing-invalid after one interval of dispatch-start lag', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-aws-lag-'));
  const clock = { value: Date.UTC(2026, 0, 1) };
  let injectCalls = 0;
  const guardStage = {
    ...stage(),
    warmupSeconds: 0,
    durationSeconds: 20,
    arrival: { mode: 'count-bounded', incidentIntervalSeconds: 10, incidents: 2 },
  };
  const controller = {
    async configureCapacity() {}, async verifyQueuesClean() {},
    async verifyProcessingCost(cost) { return cost; },
    async waitForStartingState() { return { desiredCount: 1, runningCount: 1 }; },
    async waitForWorkerReady() { return { workers: [{ taskId: 'ecs-unit' }] }; },
    async sample() {
      return {
        timestamp: new Date(clock.value).toISOString(),
        queue: { visibleMessages: 0, inFlightMessages: 0, oldestMessageAgeSeconds: 0 },
        service: { desiredCount: 1, runningCount: 1 },
      };
    },
    async injectJobs(jobs) { injectCalls += 1; clock.value += 20_001; return jobs.length; },
    async scalingActivities() { return []; },
    async resultsForSources(ids) { return { resultsProduced: 2, duplicateResults: 0, queueRemaining: 0, dlqDepth: 0, ids }; },
    async workerLogs() { return []; },
    logReferences() { return {}; },
  };
  try {
    const result = await runAwsExperiment({
      stage: guardStage, mode: 'fixed', repeatNumber: 1, outputDir: root,
      executionNamespace: 'lag-unit', controller,
      now: () => new Date(clock.value), sleep: async (milliseconds) => { clock.value += milliseconds; },
    });
    assert.equal(injectCalls, 1);
    assert.equal(result.summary.injectionTiming.status, 'TIMING-INVALID');
    assert.match(result.summary.injectionTiming.invalidReason, /dispatch started 10001ms late/);
    assert.equal(result.summary.injectionTiming.dispatchedIncidents, 1);
    assert.equal(result.summary.injectionTiming.submittedJobs, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AWS runner passes autoscale mode to the isolated control plane', async () => {
  const { root, calls } = await run('autoscale');
  try {
    assert.deepEqual(calls[0], ['configureCapacity', 'autoscale']);
    assert.deepEqual(calls.find(([name]) => name === 'waitForStartingState'), ['waitForStartingState', 'autoscale']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AWS summary derives time-series compute use, latency and scaling activity', () => {
  const summary = buildAwsSummary({
    manifest: { runId: 'run-1', mode: 'autoscale', startedAt: '2026-01-01T00:00:00.000Z', workload: { stage: 's', expectedAnalysisJobs: 4 } },
    samples: [
      { timestamp: '2026-01-01T00:00:00.000Z', service: { runningCount: 1 } },
      { timestamp: '2026-01-01T00:00:10.000Z', service: { runningCount: 2 } },
      { timestamp: '2026-01-01T00:00:20.000Z', service: { runningCount: 1 } },
    ],
    scalingActivities: [{ Description: 'increased capacity' }, { Description: 'decreased capacity' }],
    accounting: { resultsProduced: 4, queueRemaining: 0, dlqDepth: 0, drainTimeSeconds: 20 },
    workerLogs: [
      { message: '[WORKER_READY] taskId=ecs-a' },
      { message: '[ANALYSIS] processingMs=20' },
      { message: '[ANALYSIS] processingMs=40' },
      { message: '[PROCESSING-FAILED] messageId=one' },
    ],
    finishedAt: '2026-01-01T00:00:20.000Z',
  });
  assert.equal(summary.results.taskSeconds, 30);
  assert.equal(summary.results.processingLatencyP95Ms, 40);
  assert.equal(summary.results.errorCount, 1);
  assert.equal(summary.scaling.scaleOutEvents, 1);
  assert.equal(summary.scaling.scaleInEvents, 1);
});
