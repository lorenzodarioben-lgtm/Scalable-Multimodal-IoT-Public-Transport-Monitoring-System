#!/usr/bin/env node
/**
 * Telemetry processor service entry point.
 *
 * Consumes the telemetry queue, maintains DynamoDB state, detects disruption
 * and fans incidents out into independent analysis jobs.
 *
 * Usage: npm run processor
 */
import process from 'node:process';
import {
  BACKENDS, FAILURE_INJECTION, QUEUES, TABLES, THRESHOLDS, WORKER,
} from '@sit314/shared/config';
import { banner, createLogger } from '@sit314/shared/logging';
import { getQueue } from '@sit314/shared/queues';
import { getStore } from '@sit314/shared/store';
import { createMetrics } from '@sit314/shared/metrics';
import { createWorker } from '@sit314/shared/worker';
import { TelemetryProcessor } from './processor.js';
import { createHdAwsArrivalObserver } from './hd-arrival-observer.js';

const logger = createLogger('telemetry-processor', {
  jsonFile: process.env.LOG_JSON_FILE || null,
});
const telemetryQueue = getQueue(QUEUES.telemetry);
const analysisQueue = getQueue(QUEUES.analysis);
const store = getStore();
const metrics = createMetrics('telemetry-processor');

const hdArrivalObserver = process.env.HD_ARRIVAL_SIGNAL_QUEUE_URL
  ? await createHdAwsArrivalObserver({
    queueUrl: process.env.HD_ARRIVAL_SIGNAL_QUEUE_URL,
    runId: process.env.HD_ARRIVAL_RUN_ID || 'production',
    region: process.env.AWS_REGION,
  }) : null;
const processor = new TelemetryProcessor({ store, analysisQueue, logger, hdArrivalObserver });

process.stdout.write(`${banner('SIT314 telemetry processor', {
  'Input queue': telemetryQueue.name,
  'Output queue': analysisQueue.name,
  'Queue backend': BACKENDS.queue,
  'Store backend': BACKENDS.store,
  'Metrics backend': BACKENDS.metrics,
  Tables: Object.values(TABLES).join(', '),
  'Severe delay': `${THRESHOLDS.severeDelaySeconds}s`,
  'Crowding incident at': THRESHOLDS.crowdingIncidentLevel,
  Concurrency: WORKER.concurrency,
  'Batch size': WORKER.batchSize,
  'Failure injection': FAILURE_INJECTION.enabled ? `ON rate=${FAILURE_INJECTION.rate}` : 'off',
})}\n`);

const worker = createWorker({
  name: 'telemetry-processor',
  queue: telemetryQueue,
  logger,
  metrics,
  handler: (event) => processor.handle(event),
  onSummary: async () => {
    // Queue depth is the signal the report uses to show buffering at work.
    const attrs = await telemetryQueue.getAttributes().catch(() => null);
    if (attrs) {
      metrics.gauge('TelemetryQueueDepth', attrs.approximateNumberOfMessages);
      metrics.gauge('TelemetryQueueOldestAgeSeconds', attrs.approximateAgeOfOldestMessageSeconds);
    }
    const analysisAttrs = await analysisQueue.getAttributes().catch(() => null);
    if (analysisAttrs) {
      metrics.gauge('AnalysisQueueDepth', analysisAttrs.approximateNumberOfMessages);
    }
    metrics.gauge('IncidentsDetected', processor.counters.incidents);
    metrics.gauge('AnalysisJobsPublished', processor.counters.jobsPublished);
  },
});

worker.start()
  .then((final) => {
    process.stdout.write(`\n[PROCESSOR-COMPLETE] ${JSON.stringify({
      ...final, ...processor.counters,
    })}\n`);
    process.exit(0);
  })
  .catch((err) => {
    logger.error('FATAL', { error: err.message });
    process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
