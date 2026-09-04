#!/usr/bin/env node
/**
 * Route-impact / ETA worker service entry point.
 *
 * This is the PRIMARY AUTOSCALING TARGET. It is deployed to ECS Fargate with
 * Application Auto Scaling (min 1, max 5) driven by analysis-queue backlog per
 * running task.
 *
 * Usage: npm run route-worker
 */
import process from 'node:process';
import {
  BACKENDS, FAILURE_INJECTION, QUEUES, SCALING, WORKER,
} from '@sit314/shared/config';
import { banner, createLogger } from '@sit314/shared/logging';
import { getQueue } from '@sit314/shared/queues';
import { getStore } from '@sit314/shared/store';
import { createMetrics } from '@sit314/shared/metrics';
import { createWorker, resolveWorkerIdentity } from '@sit314/shared/worker';
import { RouteImpactWorker } from './worker.js';

const identity = await resolveWorkerIdentity();
const taskId = identity.taskId;

const logger = createLogger('route-impact-worker', {
  jsonFile: process.env.LOG_JSON_FILE || null,
});
const analysisQueue = getQueue(QUEUES.analysis);
const notificationQueue = getQueue(QUEUES.notifications);
const store = getStore();
const metrics = createMetrics('route-impact-worker', { dimensions: { TaskId: taskId } });

const impactWorker = new RouteImpactWorker({ store, notificationQueue, logger });

process.stdout.write(`${banner('SIT314 route impact / ETA worker', {
  'Task id': taskId,
  'Input queue': analysisQueue.name,
  'Output queue': notificationQueue.name,
  'Queue backend': BACKENDS.queue,
  'Store backend': BACKENDS.store,
  'Metrics backend': BACKENDS.metrics,
  Concurrency: WORKER.concurrency,
  'Batch size': WORKER.batchSize,
  'Visibility timeout': `${WORKER.visibilityTimeoutSeconds}s`,
  'Processing delay': `${WORKER.processingDelayMs} ms (test parameter)`,
  'Processing CPU': `${WORKER.processingCpuIterations} iterations (test parameter)`,
  'Scaling target': `${SCALING.targetBacklogPerTask} jobs per task `
    + `(min ${SCALING.minTasks}, max ${SCALING.maxTasks})`,
  'Failure injection': FAILURE_INJECTION.enabled ? `ON rate=${FAILURE_INJECTION.rate}` : 'off',
})}\n`);

const worker = createWorker({
  name: 'route-impact-worker',
  queue: analysisQueue,
  logger,
  metrics,
  handler: (job) => impactWorker.handle(job),
  onSummary: async () => {
    const attrs = await analysisQueue.getAttributes().catch(() => null);
    if (attrs) {
      // These three series are what the scalability chapter is built on.
      metrics.gauge('AnalysisQueueDepth', attrs.approximateNumberOfMessages);
      metrics.gauge('AnalysisQueueOldestAgeSeconds', attrs.approximateAgeOfOldestMessageSeconds);
      metrics.gauge('AnalysisQueueInFlight', attrs.approximateNumberOfMessagesNotVisible);
    }
    metrics.gauge('AlertsEmitted', impactWorker.counters.alertsEmitted);
  },
});

async function main() {
  // Queue access is the smallest useful readiness probe: it confirms the
  // worker can contact its input dependency before it claims work. Store
  // writes remain verified by the first normal job, preserving least privilege.
  await analysisQueue.getAttributes();
  logger.info('WORKER_READY', {
    taskId,
    containerId: identity.containerId,
    identitySource: identity.source,
    queue: analysisQueue.name,
  }, `[WORKER_READY] taskId=${taskId} source=${identity.source}`);
  return worker.start();
}

main()
  .then((final) => {
    process.stdout.write(`\n[ROUTE-WORKER-COMPLETE] ${JSON.stringify({
      taskId, ...final, ...impactWorker.counters,
    })}\n`);
    process.exit(0);
  })
  .catch((err) => {
    logger.error('FATAL', { error: err.message });
    process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
