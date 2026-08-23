#!/usr/bin/env node
/**
 * Notification worker service entry point.
 *
 * Secondary autoscaling candidate. Deliveries are SIMULATED - see worker.js.
 *
 * Usage: npm run notification-worker
 */
import process from 'node:process';
import { BACKENDS, FAILURE_INJECTION, QUEUES, WORKER } from '@sit314/shared/config';
import { banner, createLogger } from '@sit314/shared/logging';
import { getQueue } from '@sit314/shared/queues';
import { getStore } from '@sit314/shared/store';
import { createMetrics } from '@sit314/shared/metrics';
import { createWorker } from '@sit314/shared/worker';
import { NotificationWorker } from './worker.js';

const taskId = process.env.WORKER_TASK_ID || `local-${process.pid}`;
const logger = createLogger('notification-worker', { jsonFile: process.env.LOG_JSON_FILE || null });
const notificationQueue = getQueue(QUEUES.notifications);
const store = getStore();
const metrics = createMetrics('notification-worker', { dimensions: { TaskId: taskId } });

const notifier = new NotificationWorker({ store, logger });

process.stdout.write(`${banner('SIT314 notification worker', {
  'Task id': taskId,
  'Input queue': notificationQueue.name,
  'Queue backend': BACKENDS.queue,
  'Store backend': BACKENDS.store,
  Concurrency: WORKER.concurrency,
  Delivery: 'SIMULATED ONLY - no SMS, email or paid service is contacted',
  'Failure injection': FAILURE_INJECTION.enabled ? `ON rate=${FAILURE_INJECTION.rate}` : 'off',
})}\n`);

const worker = createWorker({
  name: 'notification-worker',
  queue: notificationQueue,
  logger,
  metrics,
  handler: (alert) => notifier.handle(alert),
  onSummary: async () => {
    const attrs = await notificationQueue.getAttributes().catch(() => null);
    if (attrs) {
      metrics.gauge('NotificationQueueDepth', attrs.approximateNumberOfMessages);
      metrics.gauge('NotificationQueueOldestAgeSeconds', attrs.approximateAgeOfOldestMessageSeconds);
    }
    metrics.gauge('SimulatedRecipients', notifier.counters.recipients);
  },
});

worker.start()
  .then((final) => {
    process.stdout.write(`\n[NOTIFICATION-COMPLETE] ${JSON.stringify({
      taskId, ...final, ...notifier.counters,
    })}\n`);
    process.exit(0);
  })
  .catch((err) => {
    logger.error('FATAL', { error: err.message });
    process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
