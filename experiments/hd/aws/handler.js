/** HD predictor Lambda entry point. Importing this file does not contact AWS. */
import { createHdAwsPorts } from './ports.js';
import { processAnalysisArrival } from './signal-processor.js';

export async function runHdHandler(event, {
  env = process.env, portsFactory = createHdAwsPorts, requestId = null,
} = {}) {
  const prefix = env.HD_RESOURCE_PREFIX;
  const mode = env.HD_CONTROLLER_MODE;
  if (!prefix?.startsWith('sit314-hd-') || !['reactive', 'hybrid'].includes(mode)) {
    throw new Error('HD prefix or controller mode is not configured safely');
  }
  if (!Array.isArray(event?.Records) || event.Records.length !== 1) {
    throw new Error('HD FIFO arrival mapping requires batch size one');
  }
  const ports = await portsFactory({
    region: env.AWS_REGION,
    prefix,
    stateTableName: env.HD_STATE_TABLE_NAME,
    analysisQueueUrl: env.HD_ANALYSIS_QUEUE_URL,
  });
  const controllerConfig = {
    historySize: Number(env.HD_HISTORY_SIZE),
    predictionHorizonSeconds: Number(env.HD_FORECAST_HORIZON_SECONDS),
    perTaskSustainableJobsPerSecond: Number(env.HD_PER_TASK_JOBS_PER_SECOND),
    minRisingSlopeJobsPerSecondSquared: Number(env.HD_RISING_SLOPE_THRESHOLD),
    requiredConsecutiveRecommendations: Number(env.HD_HYSTERESIS_COUNT),
    duplicateRequestCooldownSeconds: Number(env.HD_DUPLICATE_COOLDOWN_SECONDS),
    minTasks: 1, maxTasks: 5, targetBacklogPerTask: 75,
  };
  const result = await processAnalysisArrival({
    signal: event.Records[0].body,
    mode, ports,
    serviceName: `${prefix}-route-impact`,
    controllerConfig,
    observationIntervalSeconds: 10,
  });
  console.log(JSON.stringify({ requestId, mode,
    signalId: JSON.parse(event.Records[0].body).signalId, result }));
  return result;
}

export async function handler(event, context = {}) {
  return runHdHandler(event, { requestId: context.awsRequestId });
}
