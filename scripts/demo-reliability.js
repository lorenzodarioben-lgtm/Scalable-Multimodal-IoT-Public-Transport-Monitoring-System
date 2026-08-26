#!/usr/bin/env node
/**
 * Reliability demonstration (evidence item E12).
 *
 * WHAT IT DOES
 * Runs four controlled reliability scenarios against the real local queue, the
 * real store and the real service code, printing one clearly labelled block per
 * scenario:
 *
 *   1. DUPLICATE EVENT     the same eventId twice produces one fan-out, not two
 *   2. STALE TELEMETRY     an older reading cannot overwrite newer state
 *   3. RETRY               a failing handler leaves the message for redelivery
 *   4. DLQ REDRIVE         a message that keeps failing is dead-lettered, while
 *                          a healthy message alongside it is not
 *
 * WHY IT EXISTS
 * SQS is at-least-once: redelivery WILL happen, and it happens most often
 * during scale-in, exactly when the system is busiest. These four behaviours
 * are what make that safe. The unit tests assert them; this script makes them
 * visible in a terminal for the report.
 *
 * SAFETY
 * Creates no AWS resources and costs nothing. It works in its own scratch
 * directory under local-data/reliability-demo and removes it afterwards, so it
 * cannot disturb pipeline state or committed evidence.
 *
 * Usage: npm run demo:reliability
 */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_DATA_DIR, TABLES } from '@sit314/shared/config';
import { banner, createLogger } from '@sit314/shared/logging';
import { getQueue } from '@sit314/shared/queues';
import { getStore } from '@sit314/shared/store';
import { normalize } from '@sit314/shared/validation';
import { createWorker } from '@sit314/shared/worker';
import { TelemetryProcessor } from '../services/telemetry-processor/src/processor.js';

const SCRATCH = path.join(LOCAL_DATA_DIR, 'reliability-demo');
const line = (s = '') => process.stdout.write(`${s}\n`);
const rule = () => line('-'.repeat(60));

function heading(n, title, why) {
  line();
  line('='.repeat(60));
  line(`SCENARIO ${n}: ${title}`);
  line('='.repeat(60));
  line(why);
  rule();
}

/** Collects fan-out without needing a queue consumer. */
function recordingQueue() {
  const sent = [];
  return {
    sent,
    async sendMessageBatch(bodies) { sent.push(...bodies); return { successful: bodies.length, failed: 0 }; },
    async sendMessage(body) { sent.push(body); return { messageId: 'm' }; },
    async getAttributes() { return { approximateNumberOfMessages: sent.length }; },
  };
}

const rawBus = (patch = {}) => ({
  eventId: 'evt-demo-breakdown-0001',
  eventType: 'telemetry',
  transportMode: 'bus',
  vehicleId: 'BUS-007',
  serviceId: 'SERVICE-703',
  routeId: '703',
  locationId: 'BUS-STOP-104',
  timestamp: '2026-09-04T10:00:00.000Z',
  latitude: -37.818,
  longitude: 145.119,
  speedKph: 0,
  occupancy: 38,
  capacity: 60,
  delaySeconds: 1500,
  health: 'breakdown',
  modeData: { roadSegmentId: 'ROAD-SEG-12', nextStopId: 'BUS-STOP-105' },
  ...patch,
});

const busEvent = (patch) => normalize(rawBus(patch), { receivedAt: '2026-09-04T10:00:01.000Z' });

// --------------------------------------------------------------------------
// 1 + 2: idempotency and out-of-order protection, through the real processor
// --------------------------------------------------------------------------
async function duplicateAndStale() {
  const store = getStore({ fresh: true, backend: 'local', baseDir: path.join(SCRATCH, 'tables') });
  const analysisQueue = recordingQueue();
  const logger = createLogger('telemetry-processor', { quiet: false });
  const processor = new TelemetryProcessor({ store, analysisQueue, logger });

  heading(1, 'DUPLICATE EVENT',
    'The same eventId is delivered twice, as SQS at-least-once delivery allows.\n'
    + 'The second delivery must not create a second set of analysis jobs.');

  const first = await processor.handle(busEvent());
  const jobsAfterFirst = analysisQueue.sent.length;
  line();
  line(`   -> first delivery:  incident=${first.incident} analysisJobs=${first.jobs}`);

  const second = await processor.handle(busEvent());
  const jobsAfterSecond = analysisQueue.sent.length;
  line(`   -> second delivery: duplicate=${second.duplicate} analysisJobs=${second.jobs ?? 0}`);
  rule();
  line(`RESULT  jobs after 1st delivery = ${jobsAfterFirst}`);
  line(`RESULT  jobs after 2nd delivery = ${jobsAfterSecond}`);
  const dupOk = second.duplicate === true && jobsAfterFirst === jobsAfterSecond;
  line(`VERDICT ${dupOk ? 'PASS' : 'FAIL'} - duplicate suppressed by conditional write on eventId`);

  heading(2, 'STALE TELEMETRY',
    'A newer reading is stored, then an OLDER reading for the same vehicle\n'
    + 'arrives late. The older reading must not overwrite the newer state.');

  await processor.handle(busEvent({
    eventId: 'evt-demo-newer-0001', timestamp: '2026-09-04T10:05:00.000Z',
    health: 'normal', speedKph: 41, delaySeconds: 60,
  }));
  const newer = await store.get(TABLES.currentState, 'BUS-007');
  line();
  line(`   -> stored newer state:  timestamp=${newer.timestamp} health=${newer.health}`);

  // Delay is kept below the severe-delay threshold so this scenario shows only
  // the stale-state refusal, without also raising an unrelated incident.
  await processor.handle(busEvent({
    eventId: 'evt-demo-older-0001', timestamp: '2026-09-04T09:55:00.000Z',
    health: 'degraded', speedKph: 12, delaySeconds: 120,
  }));
  const after = await store.get(TABLES.currentState, 'BUS-007');
  line(`   -> late older event:    timestamp=2026-09-04T09:55:00.000Z health=degraded`);
  rule();
  line(`RESULT  current state timestamp = ${after.timestamp}`);
  line(`RESULT  current state health    = ${after.health}`);
  const staleOk = after.timestamp === newer.timestamp && after.health === newer.health;
  line(`VERDICT ${staleOk ? 'PASS' : 'FAIL'} - stale write refused by conditional timestamp check`);

  return dupOk && staleOk;
}

// --------------------------------------------------------------------------
// 3 + 4: retry and DLQ redrive, through the real worker loop and local queue
// --------------------------------------------------------------------------
function makeQueues(sub, maxReceiveCount) {
  const baseDir = path.join(SCRATCH, sub);
  const common = { backend: 'local', baseDir, maxReceiveCount, visibilityTimeoutSeconds: 1 };
  return {
    queue: getQueue(`${sub}-work`, { ...common, dlqName: `${sub}-work-dlq` }),
    dlq: getQueue(`${sub}-work-dlq`, { ...common, dlqName: null }),
  };
}

const workerSettings = (maxReceiveCount) => ({
  batchSize: 10,
  waitTimeSeconds: 1,
  visibilityTimeoutSeconds: 1,
  maxReceiveCount,
  concurrency: 2,
  metricsIntervalMs: 3600000,
  idleExitAfterMs: 1800,
  shutdownGraceMs: 3000,
});

const stubMetrics = () => ({
  counter() {}, timing() {}, gauge() {}, async flush() { return 0; }, async close() {},
});

async function retryScenario() {
  heading(3, 'WORKER FAILURE AND RETRY',
    'A handler throws on its first attempt. The message must NOT be deleted;\n'
    + 'it becomes visible again after the visibility timeout and is retried.');

  const { queue, dlq } = makeQueues('retry', 5);
  const logger = createLogger('route-impact-worker', { quiet: false });
  let attempts = 0;

  const worker = createWorker({
    name: 'retry-demo',
    queue,
    logger,
    metrics: stubMetrics(),
    settings: workerSettings(5),
    handler: async (body) => {
      attempts += 1;
      if (attempts === 1) {
        line(`   -> attempt 1 for job=${body.jobId}: throwing a transient error`);
        throw new Error('simulated downstream failure');
      }
      line(`   -> attempt ${attempts} for job=${body.jobId}: succeeded`);
    },
  });

  await queue.sendMessage({ jobId: 'job-demo-retry-0001' });
  line();
  await worker.start();

  const depth = (await queue.getAttributes()).approximateNumberOfMessages;
  const dlqDepth = (await dlq.getAttributes()).approximateNumberOfMessages;
  rule();
  line(`RESULT  handler attempts     = ${attempts}`);
  line(`RESULT  failed / processed   = ${worker.state.failed} / ${worker.state.processed}`);
  line(`RESULT  queue depth          = ${depth}`);
  line(`RESULT  DLQ depth            = ${dlqDepth}`);
  const ok = attempts >= 2 && worker.state.processed === 1 && depth === 0 && dlqDepth === 0;
  line(`VERDICT ${ok ? 'PASS' : 'FAIL'} - message retained on failure, redelivered, then completed`);
  return ok;
}

async function dlqScenario() {
  heading(4, 'DLQ REDRIVE',
    'One poison message always fails; one healthy message alongside it always\n'
    + 'succeeds. Only the poison message may be dead-lettered.');

  const maxReceive = 2;
  const { queue, dlq } = makeQueues('dlq', maxReceive);
  const logger = createLogger('route-impact-worker', { quiet: false });
  let poisonAttempts = 0;

  const worker = createWorker({
    name: 'dlq-demo',
    queue,
    logger,
    metrics: stubMetrics(),
    settings: workerSettings(maxReceive),
    handler: async (body) => {
      if (body.jobId === 'job-demo-poison-0001') {
        poisonAttempts += 1;
        line(`   -> poison job attempt ${poisonAttempts}/${maxReceive}: failing`);
        throw new Error('permanent processing failure');
      }
      line(`   -> healthy job ${body.jobId}: processed normally`);
    },
  });

  await queue.sendMessage({ jobId: 'job-demo-poison-0001' });
  await queue.sendMessage({ jobId: 'job-demo-healthy-0001' });
  line();
  await worker.start();

  const depth = (await queue.getAttributes()).approximateNumberOfMessages;
  const dlqDepth = (await dlq.getAttributes()).approximateNumberOfMessages;
  const dead = await dlq.receiveMessages({ maxMessages: 10, waitTimeSeconds: 0 });
  rule();
  line(`RESULT  poison attempts      = ${poisonAttempts} (maxReceiveCount=${maxReceive})`);
  line(`RESULT  healthy processed    = ${worker.state.processed}`);
  line(`RESULT  main queue depth     = ${depth}`);
  line(`RESULT  DLQ depth            = ${dlqDepth}`);
  for (const m of dead) {
    const body = JSON.parse(m.body);
    line(`RESULT  in DLQ: jobId=${body.jobId} redrivenFrom=${m.attributes.redrivenFrom} `
      + `receiveCount=${m.attributes.receiveCount}`);
  }
  const onlyPoison = dead.length === 1 && JSON.parse(dead[0].body).jobId === 'job-demo-poison-0001';
  const ok = poisonAttempts === maxReceive && worker.state.processed === 1 && onlyPoison;
  line(`VERDICT ${ok ? 'PASS' : 'FAIL'} - poison dead-lettered, valid workload untouched`);
  return ok;
}

async function main() {
  line(banner('sit314 reliability demonstration', {
    Mode: 'fully local - no AWS resources are created and nothing is billed',
    Scratch: SCRATCH,
    Proves: 'idempotency, out-of-order protection, retry, DLQ redrive',
  }));

  fs.rmSync(SCRATCH, { recursive: true, force: true });

  const results = [];
  results.push(['1 duplicate event', await duplicateAndStale()]);
  results.push(['3 retry', await retryScenario()]);
  results.push(['4 DLQ redrive', await dlqScenario()]);

  line();
  // Keys stay short so the banner's column padding lines up.
  line(banner('reliability summary', {
    'Duplicate suppressed': results[0][1] ? 'PASS' : 'FAIL',
    'Stale write refused': results[0][1] ? 'PASS' : 'FAIL',
    'Retry after failure': results[1][1] ? 'PASS' : 'FAIL',
    'DLQ redrive': results[2][1] ? 'PASS' : 'FAIL',
    'Valid work safe': results[2][1] ? 'PASS' : 'FAIL',
    'Failure injection': 'OFF by default',
  }));

  fs.rmSync(SCRATCH, { recursive: true, force: true });
  line('\nScratch directory removed. Pipeline state and committed evidence untouched.');

  if (results.some(([, ok]) => !ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[ERROR] ${err.stack || err.message}`);
  process.exitCode = 1;
});
