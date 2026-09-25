/** Read-only recovery snapshot. No AWS mutating commands are imported or called. */
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { SQSClient, GetQueueUrlCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { ECSClient, DescribeServicesCommand, ListTasksCommand, DescribeTasksCommand,
  DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs';
import { ApplicationAutoScalingClient, DescribeScalableTargetsCommand,
  DescribeScalingPoliciesCommand } from '@aws-sdk/client-application-auto-scaling';
import { CloudWatchClient, DescribeAlarmsCommand, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { LambdaClient, GetFunctionConfigurationCommand,
  ListEventSourceMappingsCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const region = 'us-east-1';
const hd = 'sit314-hd-transport';
const d = 'sit314-transport';
const credentials = fromIni({ profile: 'academy' });
const client = (Ctor) => new Ctor({ region, credentials });
const sqs = client(SQSClient);
const ecs = client(ECSClient);
const scaling = client(ApplicationAutoScalingClient);
const cloudwatch = client(CloudWatchClient);
const logs = client(CloudWatchLogsClient);
const lambda = client(LambdaClient);
const document = DynamoDBDocumentClient.from(client(DynamoDBClient));
const result = { observedAt: new Date().toISOString(), region, hd: {}, distinction: {}, errors: {} };

async function record(path, fn) {
  try {
    const value = await fn();
    let target = result;
    for (const segment of path.slice(0, -1)) target = target[segment];
    target[path.at(-1)] = value;
  } catch (error) {
    result.errors[path.join('.')] = `${error.name || 'Error'}: ${error.message}`;
  }
}

async function queue(name) {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  const { Attributes = {} } = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
  }));
  return {
    visible: Number(Attributes.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

async function service(prefix, name = 'route-impact') {
  const cluster = `${prefix}-cluster`;
  const serviceName = `${prefix}-${name}`;
  const output = await ecs.send(new DescribeServicesCommand({ cluster, services: [serviceName] }));
  const item = output.services?.[0];
  if (!item || item.status !== 'ACTIVE') throw new Error(`missing ACTIVE ECS service ${serviceName}`);
  const listed = await ecs.send(new ListTasksCommand({
    cluster, serviceName, desiredStatus: 'RUNNING',
  }));
  const described = listed.taskArns?.length ? await ecs.send(new DescribeTasksCommand({
    cluster, tasks: listed.taskArns,
  })) : { tasks: [] };
  const taskDefinition = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: item.taskDefinition }));
  const workerContainerName = name === 'route-impact' ? 'route-impact-worker' : name;
  const worker = taskDefinition.taskDefinition?.containerDefinitions?.find((container) =>
    container.name === workerContainerName);
  return {
    desired: item.desiredCount, running: item.runningCount, pending: item.pendingCount,
    status: item.status, taskDefinition: item.taskDefinition,
    cpu: taskDefinition.taskDefinition?.cpu, memory: taskDefinition.taskDefinition?.memory,
    image: worker?.image,
    processingDelayMs: worker?.environment?.find((variable) =>
      variable.name === 'WORKER_PROCESSING_DELAY_MS')?.value ?? null,
    tasks: (described.tasks || []).map((task) => ({
      taskArn: task.taskArn, id: task.taskArn?.split('/').at(-1),
      status: task.lastStatus, startedAt: task.startedAt?.toISOString?.() ?? null,
    })),
  };
}

async function policy(prefix) {
  const ResourceId = `service/${prefix}-cluster/${prefix}-route-impact`;
  const query = { ServiceNamespace: 'ecs', ResourceId,
    ScalableDimension: 'ecs:service:DesiredCount' };
  const [targetOut, policyOut] = await Promise.all([
    scaling.send(new DescribeScalableTargetsCommand({
      ServiceNamespace: query.ServiceNamespace, ResourceIds: [ResourceId],
      ScalableDimension: query.ScalableDimension,
    })),
    scaling.send(new DescribeScalingPoliciesCommand(query)),
  ]);
  const target = targetOut.ScalableTargets?.[0];
  return {
    min: target?.MinCapacity ?? null, max: target?.MaxCapacity ?? null,
    policies: (policyOut.ScalingPolicies || []).map((item) => ({
      name: item.PolicyName, type: item.PolicyType, arn: item.PolicyARN,
      target: item.TargetTrackingScalingPolicyConfiguration?.TargetValue,
      metric: item.TargetTrackingScalingPolicyConfiguration?.CustomizedMetricSpecification,
      scaleOutCooldown: item.TargetTrackingScalingPolicyConfiguration?.ScaleOutCooldown,
      scaleInCooldown: item.TargetTrackingScalingPolicyConfiguration?.ScaleInCooldown,
      stepAdjustment: item.StepScalingPolicyConfiguration?.StepAdjustments?.[0]?.ScalingAdjustment,
      stepCooldown: item.StepScalingPolicyConfiguration?.Cooldown,
    })),
  };
}

async function alarm(prefix) {
  const { MetricAlarms = [] } = await cloudwatch.send(new DescribeAlarmsCommand({
    AlarmNames: [`${prefix}-fast-backlog-scale-out`],
  }));
  const item = MetricAlarms[0];
  if (!item) throw new Error('fast backlog alarm missing');
  return {
    name: item.AlarmName, state: item.StateValue, namespace: item.Namespace,
    metric: item.MetricName, threshold: item.Threshold, period: item.Period,
    evaluationPeriods: item.EvaluationPeriods, datapointsToAlarm: item.DatapointsToAlarm,
    dimensions: item.Dimensions, actions: item.AlarmActions,
  };
}

async function bpt(prefix, namespace) {
  const end = new Date();
  const start = new Date(end.getTime() - 15 * 60_000);
  const output = await cloudwatch.send(new GetMetricStatisticsCommand({
    Namespace: namespace, MetricName: 'BacklogPerTask',
    Dimensions: [{ Name: 'ServiceName', Value: `${prefix}-route-impact` }],
    StartTime: start, EndTime: end, Period: 60, Statistics: ['Maximum'],
  }));
  return (output.Datapoints || []).map((point) => ({
    at: point.Timestamp.toISOString(), value: point.Maximum,
  })).sort((a, b) => a.at.localeCompare(b.at));
}

const hdQueues = [
  'analysis', 'analysis-dlq', 'arrival.fifo', 'arrival-dlq.fifo',
  'notifications', 'notifications-dlq', 'telemetry', 'telemetry-dlq',
];
result.hd.queues = {};
for (const suffix of hdQueues) {
  await record(['hd', 'queues', suffix], () => queue(`${hd}-${suffix}`));
}
await record(['hd', 'routeService'], () => service(hd));
await record(['hd', 'notificationService'], () => service(hd, 'notification-worker'));
await record(['hd', 'scaling'], () => policy(hd));
await record(['hd', 'alarm'], () => alarm(hd));
await record(['hd', 'recentBpt'], () => bpt(hd, 'SIT314/HDTransport'));
await record(['hd', 'predictor'], async () => {
  const output = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: `${hd}-predictor` }));
  const mappings = await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: `${hd}-predictor` }));
  const vars = output.Environment?.Variables || {};
  return {
    mode: vars.HD_CONTROLLER_MODE, updateStatus: output.LastUpdateStatus,
    history: vars.HD_HISTORY_SIZE, horizonSeconds: vars.HD_FORECAST_HORIZON_SECONDS,
    perTaskJobsPerSecond: vars.HD_PER_TASK_JOBS_PER_SECOND,
    slopeGate: vars.HD_RISING_SLOPE_THRESHOLD,
    hysteresis: vars.HD_HYSTERESIS_COUNT,
    cooldownSeconds: vars.HD_DUPLICATE_COOLDOWN_SECONDS,
    mappings: (mappings.EventSourceMappings || []).map((item) => ({
      state: item.State, eventSourceArn: item.EventSourceArn, batchSize: item.BatchSize,
    })),
  };
});
await record(['hd', 'predictorState'], async () => {
  const output = await document.send(new ScanCommand({
    TableName: `${hd}-predictor-state`,
    ProjectionExpression: 'RunId, #state',
    ExpressionAttributeNames: { '#state': 'State' },
  }));
  return {
    itemCount: output.Items?.length ?? 0,
    pending: (output.Items || []).filter((item) => item.State?.pendingScaleRequest)
      .map((item) => ({ runId: item.RunId, pendingScaleRequest: item.State.pendingScaleRequest })),
  };
});
await record(['hd', 'workerReady'], async () => {
  const tasks = result.hd.routeService?.tasks || [];
  const ready = [];
  for (const task of tasks) {
    const output = await logs.send(new GetLogEventsCommand({
      logGroupName: `/ecs/${hd}-route-impact`,
      logStreamName: `route-impact/route-impact-worker/${task.id}`,
      startFromHead: true, limit: 100,
    }));
    const event = (output.events || []).find((entry) =>
      entry.message?.includes('[WORKER_READY]')
      && entry.message.includes(`taskId=ecs-${task.id}`));
    ready.push({ taskId: task.id, readyAt: event ? new Date(event.timestamp).toISOString() : null });
  }
  return ready;
});

result.distinction.queues = {};
for (const suffix of ['analysis', 'analysis-dlq']) {
  await record(['distinction', 'queues', suffix], () => queue(`${d}-${suffix}`));
}
await record(['distinction', 'routeService'], () => service(d));
await record(['distinction', 'scaling'], () => policy(d));
await record(['distinction', 'alarm'], () => alarm(d));
await record(['distinction', 'recentBpt'], () => bpt(d, 'SIT314/Transport'));
console.log(JSON.stringify(result, null, 2));
if (Object.keys(result.errors).length) process.exitCode = 1;
