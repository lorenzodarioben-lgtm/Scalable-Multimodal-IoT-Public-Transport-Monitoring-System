/**
 * Shared SQS worker runtime.
 *
 * What: the polling loop every service uses - long poll, process messages with
 *       bounded concurrency, delete only on success, publish metrics, and shut
 *       down cleanly on SIGTERM.
 * Why:  three services need identical delivery semantics, and getting those
 *       semantics right is what makes the system reliable under retry:
 *
 *       - A message is deleted ONLY after the handler resolves successfully.
 *         If the handler throws, the message is left alone, becomes visible
 *         again after the visibility timeout, and is retried. After
 *         maxReceiveCount attempts the redrive policy moves it to the DLQ.
 *         Nothing is ever silently dropped.
 *
 *       - SIGTERM matters because ECS Fargate sends SIGTERM when a scale-in
 *         event terminates a task. The worker stops asking for new messages,
 *         lets in-flight work finish, and exits. Messages it had claimed but
 *         not finished simply become visible again for another task.
 *
 *       - Concurrency lets one task process several jobs at once, so "one task"
 *         is a meaningful, measurable unit of capacity in the scaling
 *         experiment.
 *
 * How it contributes to scalability: this loop is stateless. Running N copies
 * of it against the same queue multiplies throughput, which is exactly what
 * Application Auto Scaling does when backlog per task rises.
 */
import process from 'node:process';
import { WORKER } from '../config/index.js';
import { createMetrics } from '../aws/metrics.js';
import { createLogger } from '../logging/index.js';
import { percentile, mean, round } from '../util/index.js';

/**
 * @param {object} options
 * @param {string} options.name service name (used for logs and metrics)
 * @param {object} options.queue queue handle from getQueue()
 * @param {(body: object, message: object) => Promise<object|void>} options.handler
 *        Must throw to trigger a retry. Returning normally deletes the message.
 * @param {object} [options.logger]
 * @param {object} [options.metrics]
 * @param {object} [options.settings] overrides for WORKER config
 */
export function createWorker({
  name,
  queue,
  handler,
  logger = createLogger(name),
  metrics = createMetrics(name),
  settings = {},
  onSummary = null,
}) {
  const cfg = { ...WORKER, ...settings };
  const state = {
    running: false,
    draining: false,
    inFlight: 0,
    processed: 0,
    failed: 0,
    duplicates: 0,
    received: 0,
    deleted: 0,
    latencies: [],
    startedAt: null,
    lastMessageAt: null,
  };

  const snapshot = () => {
    const elapsed = (Date.now() - state.startedAt) / 1000;
    return {
      received: state.received,
      processed: state.processed,
      duplicates: state.duplicates,
      failed: state.failed,
      inFlight: state.inFlight,
      perSecond: round(state.processed / Math.max(elapsed, 0.001)),
      meanMs: round(mean(state.latencies)),
      p95Ms: round(percentile(state.latencies, 95)),
      elapsedSeconds: round(elapsed, 1),
    };
  };

  async function processMessage(message) {
    state.inFlight += 1;
    const started = process.hrtime.bigint();
    try {
      let body;
      try {
        body = JSON.parse(message.body);
      } catch (err) {
        // A message that can never be parsed must not be retried forever.
        // Leaving it undeleted would loop until the DLQ absorbs it, which is
        // the correct destination for genuinely malformed input.
        logger.error('UNPARSEABLE', {
          messageId: message.messageId,
          receiveCount: message.receiveCount,
          error: err.message,
        });
        metrics.counter('MessagesUnparseable', 1);
        throw err;
      }

      const result = await handler(body, message);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      state.latencies.push(ms);
      if (state.latencies.length > 5000) state.latencies.splice(0, 2500);

      if (result && result.duplicate) {
        state.duplicates += 1;
        metrics.counter('DuplicatesSkipped', 1);
      } else {
        state.processed += 1;
        metrics.counter('MessagesProcessed', 1);
      }
      metrics.timing('ProcessingLatency', ms);

      // Success: the message may now be removed from the queue.
      await queue.deleteMessage(message.receiptHandle);
      state.deleted += 1;
      return result;
    } catch (err) {
      state.failed += 1;
      metrics.counter('ProcessingErrors', 1);
      logger.error('PROCESSING-FAILED', {
        messageId: message.messageId,
        receiveCount: message.receiveCount,
        error: err.message,
      }, `[PROCESSING-FAILED] messageId=${message.messageId} `
        + `attempt=${message.receiveCount}/${cfg.maxReceiveCount} error=${err.message}`);
      // Deliberately NOT deleting: let the visibility timeout redeliver it,
      // and let the redrive policy dead-letter it if it keeps failing.
      return null;
    } finally {
      state.inFlight -= 1;
    }
  }

  /** Processes a batch with bounded concurrency. */
  async function processBatch(messages) {
    const queueOfWork = [...messages];
    const runners = Array.from({ length: Math.min(cfg.concurrency, queueOfWork.length) },
      async () => {
        while (queueOfWork.length) {
          const message = queueOfWork.shift();
          await processMessage(message);
        }
      });
    await Promise.all(runners);
  }

  async function loop() {
    while (state.running) {
      let messages = [];
      try {
        messages = await queue.receiveMessages({
          maxMessages: cfg.batchSize,
          waitTimeSeconds: cfg.waitTimeSeconds,
          visibilityTimeoutSeconds: cfg.visibilityTimeoutSeconds,
        });
      } catch (err) {
        logger.error('RECEIVE-FAILED', { error: err.message });
        await new Promise((r) => { setTimeout(r, 1000); });
        continue;
      }

      if (!messages.length) {
        if (cfg.idleExitAfterMs > 0 && state.lastMessageAt
          && Date.now() - state.lastMessageAt > cfg.idleExitAfterMs) {
          logger.info('IDLE-EXIT', { idleMs: cfg.idleExitAfterMs });
          state.running = false;
        }
        continue;
      }

      state.received += messages.length;
      state.lastMessageAt = Date.now();
      await processBatch(messages);
    }
  }

  const api = {
    name,
    state,
    snapshot,
    logger,
    metrics,

    async start() {
      state.running = true;
      state.startedAt = Date.now();
      state.lastMessageAt = Date.now();

      const summaryTimer = setInterval(async () => {
        const s = snapshot();
        logger.block(`${name.toUpperCase()}-SUMMARY`, s);
        metrics.gauge('InFlight', state.inFlight);
        if (onSummary) await onSummary(s);
        await metrics.flush().catch(() => {});
      }, cfg.metricsIntervalMs);
      summaryTimer.unref();

      const stop = (signal) => {
        if (state.draining) return;
        state.draining = true;
        logger.info('SHUTDOWN', { signal, inFlight: state.inFlight },
          `[SHUTDOWN] ${signal} received - no new messages will be claimed `
          + `(inFlight=${state.inFlight})`);
        state.running = false;
      };
      process.on('SIGTERM', () => stop('SIGTERM'));
      process.on('SIGINT', () => stop('SIGINT'));

      await loop();

      // Allow in-flight work to finish within the grace period.
      const graceDeadline = Date.now() + cfg.shutdownGraceMs;
      while (state.inFlight > 0 && Date.now() < graceDeadline) {
        await new Promise((r) => { setTimeout(r, 100); });
      }

      clearInterval(summaryTimer);
      const final = snapshot();
      logger.block(`${name.toUpperCase()}-FINAL`, final);
      await metrics.close().catch(() => {});
      await logger.close?.();
      return final;
    },

    stop() {
      state.running = false;
    },
  };

  return api;
}

export default createWorker;
