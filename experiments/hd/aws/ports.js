/** Live AWS adapter. No SDK is loaded until createHdAwsPorts is explicitly called. */
export async function createHdAwsPorts({ region, prefix, stateTableName, analysisQueueUrl, sdk: suppliedSdk }) {
  if (!region || !prefix || !stateTableName || !analysisQueueUrl) throw new Error('HD AWS port configuration is incomplete');
  const [ecsSdk, sqsSdk, cwSdk, ddbSdk, documentSdk] = suppliedSdk || await Promise.all([
    import('@aws-sdk/client-ecs'),
    import('@aws-sdk/client-sqs'),
    import('@aws-sdk/client-cloudwatch'),
    import('@aws-sdk/client-dynamodb'),
    import('@aws-sdk/lib-dynamodb'),
  ]);
  const ecs = new ecsSdk.ECSClient({ region });
  const sqs = new sqsSdk.SQSClient({ region });
  const cloudwatch = new cwSdk.CloudWatchClient({ region });
  const document = documentSdk.DynamoDBDocumentClient.from(new ddbSdk.DynamoDBClient({ region }));
  const cluster = `${prefix}-cluster`;
  const service = `${prefix}-route-impact`;

  return {
    async getState(runId) {
      const output = await document.send(new documentSdk.GetCommand({
        TableName: stateTableName, Key: { RunId: runId }, ConsistentRead: true,
      }));
      return output.Item?.State ?? null;
    },
    async putState(state, expectedVersion) {
      const Item = {
        RunId: state.runId,
        Version: expectedVersion + 1,
        State: { ...state, version: expectedVersion + 1 },
        ExpiresAt: Math.floor(Date.now() / 1000) + 2 * 24 * 3600,
      };
      await document.send(new documentSdk.PutCommand({
        TableName: stateTableName, Item,
        ConditionExpression: expectedVersion === 0
          ? 'attribute_not_exists(#run)' : '#version = :expected',
        ExpressionAttributeNames: expectedVersion === 0
          ? { '#run': 'RunId' } : { '#version': 'Version' },
        ...(expectedVersion === 0 ? {} : { ExpressionAttributeValues: { ':expected': expectedVersion } }),
      }));
    },
    async serviceSnapshot() {
      const output = await ecs.send(new ecsSdk.DescribeServicesCommand({ cluster, services: [service] }));
      const item = output.services?.[0];
      if (!item || item.status !== 'ACTIVE') throw new Error(`HD ECS service ${service} is not ACTIVE`);
      return { desiredTasks: item.desiredCount, runningTasks: item.runningCount,
        pendingTasks: item.pendingCount };
    },
    async queueSnapshot() {
      const output = await sqs.send(new sqsSdk.GetQueueAttributesCommand({
        QueueUrl: analysisQueueUrl, AttributeNames: ['ApproximateNumberOfMessages'],
      }));
      return { visibleBacklog: Number(output.Attributes?.ApproximateNumberOfMessages ?? 0) };
    },
    async requestScaleOut(target) {
      if (!Number.isInteger(target) || target < 2 || target > 5) throw new Error('HD scale target outside 2–5');
      const live = await ecs.send(new ecsSdk.DescribeServicesCommand({ cluster, services: [service] }));
      const current = live.services?.[0]?.desiredCount;
      if (!Number.isInteger(current) || current < 1 || current > 5) throw new Error('HD ECS desired count invalid');
      if (target <= current) return { skipped: true, current };
      await ecs.send(new ecsSdk.UpdateServiceCommand({ cluster, service, desiredCount: target }));
      return { skipped: false, from: current, to: target };
    },
    async publishMetrics(points) {
      if (!points.length) return;
      for (let index = 0; index < points.length; index += 20) {
        const batch = points.slice(index, index + 20);
        await cloudwatch.send(new cwSdk.PutMetricDataCommand({
          Namespace: 'SIT314/HDTransport',
          MetricData: batch.map((point) => ({
            MetricName: point.name,
            Value: point.value,
            Timestamp: new Date(point.atMs),
            Unit: /Rate|Error/.test(point.name) ? 'Count/Second' : 'Count',
            Dimensions: Object.entries(point.dimensions).map(([Name, Value]) => ({ Name, Value })),
          })),
        }));
      }
    },
  };
}
