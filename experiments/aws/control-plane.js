/**
 * AWS-only control plane for the formal experiment runner.
 *
 * This module deliberately has no SDK imports at module load time. Unit tests
 * use the runner's small controller interface, and simply importing it cannot
 * contact AWS. `AwsControlPlane.create()` is called only by the future CLI.
 */
import { chunk, sleep as defaultSleep } from '@sit314/shared/util';

export function capacityForMode(mode) {
  if (mode === 'fixed') return { minCapacity: 1, maxCapacity: 1, desiredCount: 1 };
  if (mode === 'autoscale') return { minCapacity: 1, maxCapacity: 5, desiredCount: 1 };
  throw new Error(`unknown AWS experiment mode: ${mode}`);
}

function queueAttributes(out = {}) {
  const attributes = out.Attributes || {};
  return {
    visibleMessages: Number(attributes.ApproximateNumberOfMessages ?? 0),
    inFlightMessages: Number(attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
    // ApproximateAgeOfOldestMessage is an AWS/SQS CloudWatch metric, not an
    // SQS GetQueueAttributes attribute. Preserve an honest unknown value here
    // rather than making the control plane's queue snapshot API call fail.
    oldestMessageAgeSeconds: null,
  };
}

export class AwsControlPlane {
  static async create({ region, prefix, sleep = defaultSleep } = {}) {
    const [ecs, autoscaling, sqs, dynamodb, dynamodbDocument, logs] = await Promise.all([
      import('@aws-sdk/client-ecs'),
      import('@aws-sdk/client-application-auto-scaling'),
      import('@aws-sdk/client-sqs'),
      import('@aws-sdk/client-dynamodb'),
      import('@aws-sdk/lib-dynamodb'),
      import('@aws-sdk/client-cloudwatch-logs'),
    ]);
    return new AwsControlPlane({
      region,
      prefix,
      sleep,
      sdk: { ecs, autoscaling, sqs, dynamodb, dynamodbDocument, logs },
    });
  }

  constructor({ region, prefix, sdk, sleep = defaultSleep }) {
    if (!region || !prefix || !sdk) throw new Error('region, prefix and SDK modules are required');
    this.region = region;
    this.prefix = prefix;
    this.sdk = sdk;
    this.sleep = sleep;
    this.cluster = `${prefix}-cluster`;
    this.service = `${prefix}-route-impact`;
    this.resourceId = `service/${this.cluster}/${this.service}`;
    this.analysisQueueName = `${prefix}-analysis`;
    this.analysisDlqName = `${prefix}-analysis-dlq`;
    this.analysisResultsTable = `${prefix}-analysis-results`;
    this.logGroupName = `/ecs/${prefix}-route-impact`;
    this.ecs = new sdk.ecs.ECSClient({ region });
    this.autoscaling = new sdk.autoscaling.ApplicationAutoScalingClient({ region });
    this.sqs = new sdk.sqs.SQSClient({ region });
    this.logs = new sdk.logs.CloudWatchLogsClient({ region });
    this.document = sdk.dynamodbDocument.DynamoDBDocumentClient.from(
      new sdk.dynamodb.DynamoDBClient({ region }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
    this.queueUrls = new Map();
  }

  async #queueUrl(queueName) {
    if (!this.queueUrls.has(queueName)) {
      const out = await this.sqs.send(new this.sdk.sqs.GetQueueUrlCommand({ QueueName: queueName }));
      if (!out.QueueUrl) throw new Error(`no QueueUrl returned for ${queueName}`);
      this.queueUrls.set(queueName, out.QueueUrl);
    }
    return this.queueUrls.get(queueName);
  }

  async #queueSnapshot(queueName) {
    const QueueUrl = await this.#queueUrl(queueName);
    const out = await this.sqs.send(new this.sdk.sqs.GetQueueAttributesCommand({
      QueueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
      ],
    }));
    return queueAttributes(out);
  }

  async #scalingState() {
    const [targetOut, policyOut] = await Promise.all([
      this.autoscaling.send(new this.sdk.autoscaling.DescribeScalableTargetsCommand({
        ServiceNamespace: 'ecs',
        ResourceIds: [this.resourceId],
        ScalableDimension: 'ecs:service:DesiredCount',
      })),
      this.autoscaling.send(new this.sdk.autoscaling.DescribeScalingPoliciesCommand({
        ServiceNamespace: 'ecs',
        ResourceId: this.resourceId,
        ScalableDimension: 'ecs:service:DesiredCount',
      })),
    ]);
    const target = targetOut.ScalableTargets?.[0] || null;
    return {
      minCapacity: target?.MinCapacity ?? null,
      maxCapacity: target?.MaxCapacity ?? null,
      policyCount: policyOut.ScalingPolicies?.length ?? 0,
    };
  }

  async serviceSnapshot() {
    const [services, scaling] = await Promise.all([
      this.ecs.send(new this.sdk.ecs.DescribeServicesCommand({
        cluster: this.cluster,
        services: [this.service],
      })),
      this.#scalingState(),
    ]);
    const service = services.services?.[0];
    if (!service || service.status !== 'ACTIVE') {
      throw new Error(`ECS service ${this.service} is not ACTIVE`);
    }
    return {
      desiredCount: service.desiredCount ?? 0,
      runningCount: service.runningCount ?? 0,
      pendingCount: service.pendingCount ?? 0,
      taskDefinition: service.taskDefinition,
      scaling,
    };
  }

  async configureCapacity(mode) {
    const capacity = capacityForMode(mode);
    await this.autoscaling.send(new this.sdk.autoscaling.RegisterScalableTargetCommand({
      ServiceNamespace: 'ecs',
      ResourceId: this.resourceId,
      ScalableDimension: 'ecs:service:DesiredCount',
      MinCapacity: capacity.minCapacity,
      MaxCapacity: capacity.maxCapacity,
    }));
    await this.ecs.send(new this.sdk.ecs.UpdateServiceCommand({
      cluster: this.cluster,
      service: this.service,
      desiredCount: capacity.desiredCount,
    }));
    return capacity;
  }

  async verifyQueuesClean() {
    const [analysis, dlq] = await Promise.all([
      this.#queueSnapshot(this.analysisQueueName),
      this.#queueSnapshot(this.analysisDlqName),
    ]);
    const dirty = Object.values(analysis).some((value) => value > 0)
      || Object.values(dlq).some((value) => value > 0);
    if (dirty) throw new Error(`analysis queue or DLQ is not clean: ${JSON.stringify({ analysis, dlq })}`);
    return { analysis, dlq };
  }

  async verifyProcessingCost(expected) {
    if (Number(expected.processingCpuIterations) !== 0) {
      throw new Error('formal AWS stage requires processingCpuIterations=0; ECS intentionally has no CPU-burn setting');
    }
    const service = await this.serviceSnapshot();
    const definition = await this.ecs.send(new this.sdk.ecs.DescribeTaskDefinitionCommand({
      taskDefinition: service.taskDefinition,
    }));
    const container = definition.taskDefinition?.containerDefinitions
      ?.find((item) => item.name === 'route-impact-worker');
    if (!container) throw new Error('route-impact-worker container was not found in the active task definition');
    const delay = Number(container.environment?.find((item) => item.name === 'WORKER_PROCESSING_DELAY_MS')?.value ?? 0);
    if (delay !== Number(expected.processingDelayMs)) {
      throw new Error(`active ECS delay is ${delay}ms; formal manifest requires ${expected.processingDelayMs}ms`);
    }
    return { processingDelayMs: delay, processingCpuIterations: 0, source: 'ECS task definition' };
  }

  async waitForStartingState(mode, { timeoutSeconds = 300 } = {}) {
    const expected = capacityForMode(mode);
    const deadline = Date.now() + timeoutSeconds * 1000;
    let latest;
    do {
      latest = await this.serviceSnapshot();
      const capacityMatches = latest.scaling.minCapacity === expected.minCapacity
        && latest.scaling.maxCapacity === expected.maxCapacity;
      const hasPolicy = mode === 'fixed' || latest.scaling.policyCount > 0;
      if (capacityMatches && hasPolicy && latest.desiredCount === 1 && latest.runningCount === 1) {
        return latest;
      }
      await this.sleep(5000);
    } while (Date.now() < deadline);
    throw new Error(`ECS did not reach ${mode} starting state: ${JSON.stringify(latest)}`);
  }

  async #runningTaskIdentities() {
    const listed = await this.ecs.send(new this.sdk.ecs.ListTasksCommand({
      cluster: this.cluster,
      serviceName: this.service,
      desiredStatus: 'RUNNING',
    }));
    const taskArns = listed.taskArns || [];
    if (taskArns.length !== 1) {
      throw new Error(`expected exactly one running route-impact task before injection, found ${taskArns.length}`);
    }
    const described = await this.ecs.send(new this.sdk.ecs.DescribeTasksCommand({
      cluster: this.cluster,
      tasks: taskArns,
    }));
    const task = described.tasks?.[0];
    const taskSuffix = task?.taskArn?.split('/').at(-1);
    if (!taskSuffix) throw new Error('ECS did not return a task ARN for the running worker');
    return [{
      taskArn: task.taskArn,
      taskId: `ecs-${taskSuffix}`,
      // awslogs naming is deterministic: prefix/container/task-id. Never use
      // LastEventTime to guess which worker stream belongs to this task.
      logStreamName: `route-impact/route-impact-worker/${taskSuffix}`,
    }];
  }

  async waitForWorkerReady({ timeoutSeconds = 180 } = {}) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let identities = [];
    do {
      identities = await this.#runningTaskIdentities();
      const readyEvents = [];
      for (const identity of identities) {
        const out = await this.logs.send(new this.sdk.logs.GetLogEventsCommand({
          logGroupName: this.logGroupName,
          logStreamName: identity.logStreamName,
          // WORKER_READY is a startup event. This worker emits summaries for
          // its whole lifetime, so reading the stream tail can omit readiness
          // after the task has been healthy for a while. The stream is already
          // deterministically derived from the current ECS task ID; read its
          // head and retain the exact task-ID match instead.
          startFromHead: true,
          limit: 100,
        }));
        const event = (out.events || []).find((item) => item.message?.includes('[WORKER_READY]')
          && item.message.includes(`taskId=${identity.taskId}`));
        if (event) readyEvents.push({
          ...identity,
          timestamp: new Date(event.timestamp).toISOString(),
          message: event.message,
        });
      }
      if (readyEvents.length === identities.length) return { workers: readyEvents };
      await this.sleep(5000);
    } while (Date.now() < deadline);
    throw new Error(`route-impact worker did not emit WORKER_READY for ${JSON.stringify(identities)}`);
  }

  async sample() {
    const [queue, service] = await Promise.all([
      this.#queueSnapshot(this.analysisQueueName),
      this.serviceSnapshot(),
    ]);
    return { timestamp: new Date().toISOString(), queue, service };
  }

  async injectJobs(jobs) {
    const QueueUrl = await this.#queueUrl(this.analysisQueueName);
    let sent = 0;
    for (const entries of chunk(jobs, 10)) {
      const out = await this.sqs.send(new this.sdk.sqs.SendMessageBatchCommand({
        QueueUrl,
        Entries: entries.map((job, index) => ({ Id: String(index), MessageBody: JSON.stringify(job) })),
      }));
      if (out.Failed?.length) throw new Error(`SQS rejected ${out.Failed.length} analysis job(s)`);
      sent += out.Successful?.length ?? 0;
    }
    return sent;
  }

  async scalingActivities() {
    const activities = [];
    let nextToken;
    do {
      const out = await this.autoscaling.send(new this.sdk.autoscaling.DescribeScalingActivitiesCommand({
        ServiceNamespace: 'ecs',
        ResourceId: this.resourceId,
        ScalableDimension: 'ecs:service:DesiredCount',
        ...(nextToken ? { NextToken: nextToken } : {}),
      }));
      activities.push(...(out.ScalingActivities || []));
      nextToken = out.NextToken;
    } while (nextToken);
    return activities;
  }

  async resultsForSources(sourceEventIds, expectedJobs) {
    let resultsProduced = 0;
    for (const sourceEventId of sourceEventIds) {
      let exclusiveStartKey;
      do {
        const out = await this.document.send(new this.sdk.dynamodbDocument.QueryCommand({
          TableName: this.analysisResultsTable,
          IndexName: 'SourceEventIdIndex',
          Select: 'COUNT',
          KeyConditionExpression: '#sourceEventId = :sourceEventId',
          ExpressionAttributeNames: { '#sourceEventId': 'sourceEventId' },
          ExpressionAttributeValues: { ':sourceEventId': sourceEventId },
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }));
        resultsProduced += out.Count ?? 0;
        exclusiveStartKey = out.LastEvaluatedKey;
      } while (exclusiveStartKey);
    }
    const [analysis, dlq] = await Promise.all([
      this.#queueSnapshot(this.analysisQueueName),
      this.#queueSnapshot(this.analysisDlqName),
    ]);
    return {
      resultsProduced,
      duplicateResults: Math.max(0, resultsProduced - expectedJobs),
      queueRemaining: analysis.visibleMessages + analysis.inFlightMessages,
      dlqDepth: dlq.visibleMessages + dlq.inFlightMessages,
    };
  }

  async workerLogs({ startedAt, finishedAt }) {
    const events = [];
    let nextToken;
    do {
      const out = await this.logs.send(new this.sdk.logs.FilterLogEventsCommand({
        logGroupName: this.logGroupName,
        startTime: Date.parse(startedAt),
        endTime: Date.parse(finishedAt) + 60_000,
        ...(nextToken ? { nextToken } : {}),
      }));
      events.push(...(out.events || []).map((event) => ({
        timestamp: new Date(event.timestamp).toISOString(),
        ingestionTime: event.ingestionTime ? new Date(event.ingestionTime).toISOString() : null,
        logStreamName: event.logStreamName,
        message: event.message,
      })));
      nextToken = out.nextToken;
    } while (nextToken);
    return events;
  }

  logReferences({ startedAt, finishedAt }) {
    return {
      logGroupName: this.logGroupName,
      query: 'FilterLogEvents retained for [WORKER_READY], [ANALYSIS], [DUPLICATE_SKIPPED], and [PROCESSING-FAILED]',
      startedAt,
      finishedAt,
    };
  }
}

export { queueAttributes };
