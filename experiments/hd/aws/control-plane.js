/** HD-only AWS adapter. Importing it makes no AWS call. */
import { AwsControlPlane } from '../../aws/control-plane.js';
import { createAnalysisArrivalSignal } from '../../../shared/hd/arrival-signal.js';

export function verifyHdScalingSnapshot({ target, policies, alarm, mode, lambdaMode }) {
  if (!['reactive', 'hybrid'].includes(mode)) throw new Error('unknown HD arm');
  if (target?.MinCapacity !== 1 || target?.MaxCapacity !== 5) throw new Error('HD scalable target is not 1–5');
  const tracking = policies.find((item) => item.PolicyType === 'TargetTrackingScaling');
  const fast = policies.find((item) => item.PolicyType === 'StepScaling');
  const trackingConfig = tracking?.TargetTrackingScalingPolicyConfiguration;
  const trackingMetric = trackingConfig?.CustomizedMetricSpecification;
  if (trackingConfig?.TargetValue !== 75
    || trackingMetric?.Namespace !== 'SIT314/HDTransport'
    || trackingMetric?.MetricName !== 'BacklogPerTask') {
    throw new Error('HD target tracking is not BacklogPerTask 75');
  }
  if (fast?.StepScalingPolicyConfiguration?.StepAdjustments?.[0]?.ScalingAdjustment !== 4) {
    throw new Error('HD fast reactive step policy is not +4');
  }
  if (alarm?.StateValue !== 'OK' || alarm.Namespace !== 'SIT314/HDTransport'
    || alarm.MetricName !== 'BacklogPerTask' || alarm.Threshold !== 75 || alarm.Period !== 60
    || alarm.EvaluationPeriods !== 1 || alarm.DatapointsToAlarm !== 1) {
    throw new Error('HD fast reactive alarm is not ready at the frozen settings');
  }
  if (fast.PolicyARN && !alarm.AlarmActions?.includes(fast.PolicyARN)) {
    throw new Error('HD fast alarm is not connected to step scaling');
  }
  if (lambdaMode !== mode) throw new Error(`HD predictor mode ${lambdaMode} does not match ${mode}`);
  return { minTasks: 1, maxTasks: 5, targetBacklogPerTask: 75,
    fastStepIncrease: 4, alarmState: 'OK', controllerMode: mode };
}

export class HdAwsControlPlane {
  static async create({ region, prefix }) {
    if (!prefix?.startsWith('sit314-hd-')) throw new Error('HD prefix required');
    const [base, lambdaSdk, cwSdk] = await Promise.all([
      AwsControlPlane.create({ region, prefix }),
      import('@aws-sdk/client-lambda'),
      import('@aws-sdk/client-cloudwatch'),
    ]);
    return new HdAwsControlPlane({ base, lambdaSdk, cwSdk, region, prefix });
  }

  constructor({ base, lambdaSdk, cwSdk, region, prefix }) {
    this.base = base;
    this.lambdaSdk = lambdaSdk;
    this.cwSdk = cwSdk;
    this.region = region;
    this.prefix = prefix;
    this.lambda = new lambdaSdk.LambdaClient({ region });
    this.cloudwatch = new cwSdk.CloudWatchClient({ region });
    this.signalUrl = null;
  }

  async queueByName(name) {
    const output = await this.base.sqs.send(new this.base.sdk.sqs.GetQueueUrlCommand({ QueueName: name }));
    if (!output.QueueUrl) throw new Error(`HD queue ${name} not found`);
    return output.QueueUrl;
  }

  async signalQueueUrl() {
    this.signalUrl ??= await this.queueByName(`${this.prefix}-arrival.fifo`);
    return this.signalUrl;
  }

  async signalQueuesClean() {
    const result = {};
    for (const name of [`${this.prefix}-arrival.fifo`, `${this.prefix}-arrival-dlq.fifo`]) {
      const url = await this.queueByName(name);
      const output = await this.base.sqs.send(new this.base.sdk.sqs.GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }));
      const visible = Number(output.Attributes?.ApproximateNumberOfMessages ?? 0);
      const inFlight = Number(output.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
      if (visible || inFlight) throw new Error(`HD signal queue is not clean: ${name} ${visible}/${inFlight}`);
      result[name] = { visible, inFlight };
    }
    return result;
  }

  async historicalMetric({ namespace, metricName, dimensions, startAt, endAt, periodSeconds, statistic = 'Maximum' }) {
    const output = await this.cloudwatch.send(new this.cwSdk.GetMetricStatisticsCommand({
      Namespace: namespace, MetricName: metricName,
      Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value })),
      StartTime: new Date(startAt), EndTime: new Date(endAt),
      Period: periodSeconds, Statistics: [statistic],
    }));
    return (output.Datapoints || []).map((point) => ({
      timestamp: new Date(point.Timestamp).toISOString(),
      value: Number(point[statistic]), unit: point.Unit,
    })).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async collectHistory({ runId, startedAt, finishedAt }) {
    const startAt = new Date(Date.parse(startedAt) - 60_000);
    const endAt = new Date(Date.parse(finishedAt) + 60_000);
    const bpt = await this.historicalMetric({
      namespace: 'SIT314/HDTransport', metricName: 'BacklogPerTask',
      dimensions: { ServiceName: this.base.service }, startAt, endAt,
      periodSeconds: 60,
    });
    const oldestMessageAge = await this.historicalMetric({
      namespace: 'AWS/SQS', metricName: 'ApproximateAgeOfOldestMessage',
      dimensions: { QueueName: this.base.analysisQueueName }, startAt, endAt,
      periodSeconds: 60,
    });
    const predictive = {};
    for (const metricName of ['AnalysisArrivalRate', 'PredictedArrivalRate',
      'PredictiveRecommendedTasks', 'PredictiveScaleRequest', 'PredictionError',
      'RunningTaskCount', 'AnalysisQueueVisible', 'PredictorObservedBacklogPerTask']) {
      predictive[metricName] = await this.historicalMetric({
        namespace: 'SIT314/HDTransport', metricName,
        dimensions: { ServiceName: this.base.service, RunId: runId },
        startAt, endAt, periodSeconds: 10,
      });
    }
    return {
      source: 'genuine historical CloudWatch GetMetricStatistics',
      metricWindow: { startAt: startAt.toISOString(), endAt: endAt.toISOString() },
      bpt, oldestMessageAge, predictive,
    };
  }

  async predictorLogs({ startedAt, finishedAt }) {
    const events = [];
    let nextToken;
    do {
      const output = await this.base.logs.send(new this.base.sdk.logs.FilterLogEventsCommand({
        logGroupName: `/aws/lambda/${this.prefix}-predictor`,
        startTime: Date.parse(startedAt), endTime: Date.parse(finishedAt) + 60_000,
        ...(nextToken ? { nextToken } : {}),
      }));
      events.push(...(output.events || []).map((item) => ({
        timestamp: new Date(item.timestamp).toISOString(), message: item.message,
        logStreamName: item.logStreamName,
      })));
      nextToken = output.nextToken;
    } while (nextToken);
    return events;
  }

  async verifyHdPreflight(mode) {
    await this.base.verifyQueuesClean();
    const signals = await this.signalQueuesClean();
    const service = await this.base.serviceSnapshot();
    if (service.desiredCount !== 1 || service.runningCount !== 1 || service.pendingCount !== 0) {
      throw new Error(`HD ECS starting capacity is not 1/1/0: ${JSON.stringify(service)}`);
    }
    const [targetOut, policyOut, alarmOut, lambdaOut] = await Promise.all([
      this.base.autoscaling.send(new this.base.sdk.autoscaling.DescribeScalableTargetsCommand({
        ServiceNamespace: 'ecs', ResourceIds: [this.base.resourceId],
        ScalableDimension: 'ecs:service:DesiredCount',
      })),
      this.base.autoscaling.send(new this.base.sdk.autoscaling.DescribeScalingPoliciesCommand({
        ServiceNamespace: 'ecs', ResourceId: this.base.resourceId,
        ScalableDimension: 'ecs:service:DesiredCount',
      })),
      this.cloudwatch.send(new this.cwSdk.DescribeAlarmsCommand({
        AlarmNames: [`${this.prefix}-fast-backlog-scale-out`],
      })),
      this.lambda.send(new this.lambdaSdk.GetFunctionConfigurationCommand({
        FunctionName: `${this.prefix}-predictor`,
      })),
    ]);
    const scaling = verifyHdScalingSnapshot({
      target: targetOut.ScalableTargets?.[0], policies: policyOut.ScalingPolicies || [],
      alarm: alarmOut.MetricAlarms?.[0], mode,
      lambdaMode: lambdaOut.Environment?.Variables?.HD_CONTROLLER_MODE,
    });
    if (lambdaOut.LastUpdateStatus && lambdaOut.LastUpdateStatus !== 'Successful') {
      throw new Error('HD predictor Lambda update has not succeeded');
    }
    const recentBpt = await this.historicalMetric({
      namespace: 'SIT314/HDTransport', metricName: 'BacklogPerTask',
      dimensions: { ServiceName: this.base.service },
      startAt: new Date(Date.now() - 180_000), endAt: new Date(), periodSeconds: 60,
    });
    if (!recentBpt.length || recentBpt.at(-1).value > 5) throw new Error('recent genuine HD BPT is not near zero');
    const workers = await this.base.waitForWorkerReady();
    return { service, signals, scaling, recentBpt, workers };
  }

  async injectJobsWithSignal(jobs, { runId, signalId }) {
    const sent = await this.base.injectJobs(jobs);
    if (sent !== jobs.length) throw new Error(`HD analysis enqueue incomplete: ${sent}/${jobs.length}`);
    const signal = createAnalysisArrivalSignal({
      runId, signalId, publishedJobCount: sent, atMs: Date.now(),
    });
    await this.base.sqs.send(new this.base.sdk.sqs.SendMessageCommand({
      QueueUrl: await this.signalQueueUrl(),
      MessageBody: JSON.stringify(signal),
      MessageGroupId: runId,
      MessageDeduplicationId: signalId,
    }));
    return sent;
  }

  async sample() {
    const sample = await this.base.sample();
    const listed = await this.base.ecs.send(new this.base.sdk.ecs.ListTasksCommand({
      cluster: this.base.cluster, serviceName: this.base.service, desiredStatus: 'RUNNING',
    }));
    const taskArns = listed.taskArns || [];
    const described = taskArns.length ? await this.base.ecs.send(new this.base.sdk.ecs.DescribeTasksCommand({
      cluster: this.base.cluster, tasks: taskArns,
    })) : { tasks: [] };
    return { ...sample, tasks: (described.tasks || []).map((task) => ({
      taskArn: task.taskArn, taskId: `ecs-${task.taskArn.split('/').at(-1)}`,
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
      lastStatus: task.lastStatus,
    })) };
  }
  async verifyProcessingCost(cost) { return this.base.verifyProcessingCost(cost); }
  async scalingActivities() { return this.base.scalingActivities(); }
  async resultsForSources(sources, expected) { return this.base.resultsForSources(sources, expected); }
  async workerLogs(window) { return this.base.workerLogs(window); }
  logReferences(window) { return this.base.logReferences(window); }
}
