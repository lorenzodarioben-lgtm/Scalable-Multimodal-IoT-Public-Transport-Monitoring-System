import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnalysisArrivalSignal,
} from '../../shared/hd/arrival-signal.js';
import { HD_METRIC_NAMES, HD_METRIC_NAMESPACE, processAnalysisArrival } from '../hd/aws/signal-processor.js';
import { createHdAwsPorts } from '../hd/aws/ports.js';
import { runHdHandler } from '../hd/aws/handler.js';
import { createHdArrivalObserver } from '../../services/telemetry-processor/src/hd-arrival-observer.js';

function fakePorts({ desiredTasks = 1, runningTasks = 1, visibleBacklog = 0 } = {}) {
  const states = new Map();
  const calls = [];
  const metrics = [];
  let failNextScale = false;
  let failNextStore = false;
  return {
    calls, metrics, states,
    failScaleOnce() { failNextScale = true; },
    failStoreOnce() { failNextStore = true; },
    getState: async (runId) => states.has(runId) ? structuredClone(states.get(runId)) : null,
    putState: async (state, expectedVersion) => {
      if (failNextStore) { failNextStore = false; throw new Error('conditional state fault'); }
      const current = states.get(state.runId);
      if ((current?.version ?? 0) !== expectedVersion) throw new Error('version conflict');
      states.set(state.runId, structuredClone({ ...state, version: expectedVersion + 1 }));
    },
    serviceSnapshot: async () => ({ desiredTasks, runningTasks }),
    queueSnapshot: async () => ({ visibleBacklog }),
    requestScaleOut: async (target, context) => {
      if (failNextScale) { failNextScale = false; throw new Error('ECS fault'); }
      if (target <= desiredTasks) throw new Error('attempted scale-in or duplicate update');
      desiredTasks = target;
      calls.push({ target, context });
    },
    publishMetrics: async (points) => { metrics.push(...points); },
    current() { return { desiredTasks, runningTasks, visibleBacklog }; },
  };
}

function signal(index, count = 100, runId = 'hd-test-run') {
  return createAnalysisArrivalSignal({ runId, signalId: `incident-${index}`,
    publishedJobCount: count, atMs: index * 10_000 });
}

const controllerConfig = {
  historySize: 4, predictionHorizonSeconds: 80,
  requiredConsecutiveRecommendations: 2,
};

test('arrival signal counting is persisted, deduplicated, and aggregated into 10-second rates', async () => {
  const ports = fakePorts();
  const first = await processAnalysisArrival({ signal: signal(0, 50), mode: 'hybrid', ports,
    serviceName: 'sit314-hd-transport-route-impact', controllerConfig });
  const duplicate = await processAnalysisArrival({ signal: signal(0, 50), mode: 'hybrid', ports,
    serviceName: 'sit314-hd-transport-route-impact', controllerConfig });
  assert.equal(first.acceptedJobs, 50);
  assert.equal(duplicate.acceptedJobs, 0);
  assert.equal(duplicate.duplicate, true);
  await processAnalysisArrival({ signal: signal(1, 100), mode: 'hybrid', ports,
    serviceName: 'sit314-hd-transport-route-impact', controllerConfig });
  assert.equal(ports.states.get('hd-test-run').binJobs, 100);
  assert.equal(ports.metrics.find((point) => point.name === 'AnalysisArrivalRate').value, 5);
  assert.ok(ports.metrics.every((point) => point.namespace === HD_METRIC_NAMESPACE
    && HD_METRIC_NAMES.includes(point.name)
    && point.dimensions.ServiceName === 'sit314-hd-transport-route-impact'
    && point.dimensions.RunId === 'hd-test-run'));
});

test('application observer publishes the stable post-fanout count to the FIFO signal queue', async () => {
  const sent = [];
  const observer = createHdArrivalObserver({ queueUrl: 'https://example.invalid/hd.fifo',
    runId: 'production', now: () => 12345, send: async (input) => { sent.push(input); } });
  await observer.publish({ signalId: 'source-event-1', publishedJobCount: 50 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].MessageGroupId, 'production');
  assert.equal(sent[0].MessageDeduplicationId, 'source-event-1');
  assert.equal(JSON.parse(sent[0].MessageBody).publishedJobCount, 50);
  assert.equal(JSON.parse(sent[0].MessageBody).atMs, 12345);
});

test('a rising rate requests only bounded scale-out; retry does not double-count after ECS failure', async () => {
  const ports = fakePorts();
  ports.failScaleOnce();
  let failedSignal;
  for (let index = 0; index < 8; index += 1) {
    const input = signal(index, (10 + index * 5) * 10);
    try {
      await processAnalysisArrival({ signal: input, mode: 'hybrid', ports,
        serviceName: 'sit314-hd-transport-route-impact', controllerConfig });
    } catch (error) {
      assert.match(error.message, /ECS fault/);
      failedSignal = input;
      break;
    }
  }
  assert.ok(failedSignal, 'rising traffic must reach a scale recommendation');
  const before = ports.states.get('hd-test-run');
  assert.ok(before.pendingScaleRequest);
  const jobsBefore = before.binJobs;
  const replay = await processAnalysisArrival({ signal: failedSignal, mode: 'hybrid', ports,
    serviceName: 'sit314-hd-transport-route-impact', controllerConfig });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.acceptedJobs, 0);
  assert.equal(replay.scaleRequested, true);
  assert.equal(ports.states.get('hd-test-run').binJobs, jobsBefore);
  assert.equal(ports.states.get('hd-test-run').pendingScaleRequest, null);
  assert.equal(ports.calls.length, 1);
  assert.ok(ports.calls[0].target >= 2 && ports.calls[0].target <= 5);
  await processAnalysisArrival({ signal: failedSignal, mode: 'hybrid', ports,
    serviceName: 'sit314-hd-transport-route-impact', controllerConfig });
  assert.equal(ports.calls.length, 1);
});

test('state write failure precedes every scale request and a retry safely recovers', async () => {
  const ports = fakePorts();
  ports.failStoreOnce();
  await assert.rejects(processAnalysisArrival({ signal: signal(0), mode: 'hybrid', ports,
    serviceName: 'sit314-hd-transport-route-impact', controllerConfig }), /state fault/);
  assert.equal(ports.states.size, 0);
  assert.equal(ports.calls.length, 0);
  const recovered = await processAnalysisArrival({ signal: signal(0), mode: 'hybrid', ports,
    serviceName: 'sit314-hd-transport-route-impact', controllerConfig });
  assert.equal(recovered.acceptedJobs, 100);
  assert.equal(ports.states.get('hd-test-run').binJobs, 100);
});

test('baseline mode reports arrivals without a predictive scale request', async () => {
  const ports = fakePorts({ desiredTasks: 3, runningTasks: 3, visibleBacklog: 200 });
  for (let index = 0; index < 10; index += 1) {
    await processAnalysisArrival({ signal: signal(index, 500), mode: 'reactive', ports,
      serviceName: 'sit314-hd-transport-route-impact' });
  }
  assert.equal(ports.calls.length, 0);
  assert.equal(ports.current().desiredTasks, 3);
  assert.ok(ports.metrics.some((point) => point.name === 'PredictorObservedBacklogPerTask'));
});

test('malformed signals are rejected before state or service calls', async () => {
  const ports = fakePorts();
  await assert.rejects(processAnalysisArrival({ signal: { signalId: 'x' }, mode: 'hybrid', ports,
    serviceName: 'service' }), /schema/);
  assert.equal(ports.states.size, 0);
});

test('AWS port commands are constructed through injected fake SDK clients only', async () => {
  const calls = [];
  const command = (name) => class { constructor(input) { this.name = name; this.input = input; } };
  class EcsClient {
    async send(item) {
      calls.push(item);
      return { services: [{ status: 'ACTIVE', desiredCount: 1, runningCount: 1, pendingCount: 0 }] };
    }
  }
  class SqsClient {
    async send(item) {
      calls.push(item);
      return { Attributes: { ApproximateNumberOfMessages: '42' } };
    }
  }
  class CwClient { async send(item) { calls.push(item); return {}; } }
  const doc = { async send(item) {
    calls.push(item);
    return item.name === 'GetCommand' ? { Item: { State: { runId: 'x', version: 1 } } } : {};
  } };
  const sdk = [
    { ECSClient: EcsClient, DescribeServicesCommand: command('DescribeServicesCommand'),
      UpdateServiceCommand: command('UpdateServiceCommand') },
    { SQSClient: SqsClient, GetQueueAttributesCommand: command('GetQueueAttributesCommand') },
    { CloudWatchClient: CwClient, PutMetricDataCommand: command('PutMetricDataCommand') },
    { DynamoDBClient: class {} },
    { DynamoDBDocumentClient: { from: () => doc }, GetCommand: command('GetCommand'),
      PutCommand: command('PutCommand') },
  ];
  const ports = await createHdAwsPorts({ region: 'us-east-1', prefix: 'sit314-hd-test',
    stateTableName: 'state', analysisQueueUrl: 'https://example.invalid/queue', sdk });
  assert.equal((await ports.getState('x')).version, 1);
  assert.equal((await ports.serviceSnapshot()).desiredTasks, 1);
  assert.equal((await ports.queueSnapshot()).visibleBacklog, 42);
  await ports.requestScaleOut(2);
  await ports.publishMetrics([{ name: 'AnalysisArrivalRate', value: 5, atMs: 1000,
    dimensions: { ServiceName: 'sit314-hd-test-route-impact', RunId: 'x' } }]);
  assert.ok(calls.some((item) => item.name === 'UpdateServiceCommand' && item.input.desiredCount === 2));
  assert.ok(calls.some((item) => item.name === 'PutMetricDataCommand'
    && item.input.Namespace === HD_METRIC_NAMESPACE));
  assert.ok(calls.every((item) => item.name !== 'DeleteServiceCommand'));
});

test('Lambda handler is injectable and rejects unsafe configuration before creating ports', async () => {
  const event = { Records: [{ body: JSON.stringify(signal(0, 50)) }] };
  let created = false;
  const env = { HD_RESOURCE_PREFIX: 'sit314-hd-test', HD_CONTROLLER_MODE: 'reactive',
    AWS_REGION: 'us-east-1', HD_STATE_TABLE_NAME: 'state', HD_ANALYSIS_QUEUE_URL: 'queue',
    HD_HISTORY_SIZE: '8', HD_FORECAST_HORIZON_SECONDS: '80',
    HD_PER_TASK_JOBS_PER_SECOND: '42.467', HD_RISING_SLOPE_THRESHOLD: '0.02',
    HD_HYSTERESIS_COUNT: '2', HD_DUPLICATE_COOLDOWN_SECONDS: '60' };
  const result = await runHdHandler(event, { env, portsFactory: async () => {
    created = true;
    return fakePorts();
  } });
  assert.equal(result.acceptedJobs, 50);
  assert.equal(created, true);
  created = false;
  await assert.rejects(runHdHandler(event, { env: { ...env, HD_RESOURCE_PREFIX: 'sit314-transport' },
    portsFactory: async () => { created = true; return fakePorts(); } }), /safely/);
  assert.equal(created, false);
});
