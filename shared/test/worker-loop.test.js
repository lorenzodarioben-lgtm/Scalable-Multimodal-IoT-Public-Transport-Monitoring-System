/**
 * Integration tests for the shared SQS worker runtime.
 *
 * The individual pieces are already covered elsewhere: the handlers are tested
 * per service, and the queue's visibility/redrive mechanics are tested in
 * local-queue.test.js. What was untested is the loop that CONNECTS them - the
 * code that decides whether a message is deleted or left for retry.
 *
 * These tests run the real createWorker() loop against the real LocalQueue, so
 * they prove the delivery guarantees the project claims:
 *
 *   - a successful handler deletes the message, and nothing reaches the DLQ
 *   - a throwing handler does NOT delete the message, and it is redelivered
 *   - a message that keeps failing ends up in the DLQ after maxReceiveCount
 *   - an idempotent "duplicate" outcome still deletes, so retries terminate
 *   - an unparseable message is dead-lettered rather than looping forever
 *   - shutdown drains in-flight work instead of abandoning it
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorker } from '../worker/index.js';
import { getQueue } from '../aws/queues.js';
import { createLogger } from '../logging/index.js';

// Each start() registers SIGTERM/SIGINT handlers; several workers in one file
// would otherwise trip Node's default max-listener warning.
process.setMaxListeners(50);

/** Metrics stub - the real one writes CSV files we do not want in a test. */
const stubMetrics = () => ({
  counter() {}, timing() {}, gauge() {},
  async flush() { return 0; },
  async close() {},
});

/**
 * Builds an isolated queue + DLQ pair on a temp directory and a worker bound to
 * them. `settings` are merged over the shared WORKER config.
 */
function harness({ handler, settings = {}, maxReceiveCount = 2 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-loop-'));
  const queueName = 'test-work';
  const dlqName = 'test-work-dlq';
  const common = { backend: 'local', baseDir: dir, maxReceiveCount, visibilityTimeoutSeconds: 1 };
  const queue = getQueue(queueName, { ...common, dlqName });
  const dlq = getQueue(dlqName, { ...common, dlqName: null });

  const worker = createWorker({
    name: 'test-worker',
    queue,
    handler,
    logger: createLogger('test-worker', { quiet: true }),
    metrics: stubMetrics(),
    settings: {
      batchSize: 10,
      waitTimeSeconds: 1,
      visibilityTimeoutSeconds: 1,
      maxReceiveCount,
      concurrency: 4,
      metricsIntervalMs: 3600000, // never fires during a test
      idleExitAfterMs: 1500, // start() returns once the queue goes quiet
      shutdownGraceMs: 3000,
      processingDelayMs: 0,
      processingCpuIterations: 0,
      ...settings,
    },
  });

  return {
    worker,
    queue,
    dlq,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const depth = async (q) => (await q.getAttributes()).approximateNumberOfMessages;
const inFlight = async (q) => (await q.getAttributes()).approximateNumberOfMessagesNotVisible;

test('a successful handler deletes the message and nothing reaches the DLQ', async () => {
  const seen = [];
  const h = harness({ handler: async (body) => { seen.push(body.id); } });
  try {
    await h.queue.sendMessage({ id: 'a' });
    await h.queue.sendMessage({ id: 'b' });

    await h.worker.start();

    assert.deepEqual(seen.sort(), ['a', 'b']);
    assert.equal(h.worker.state.processed, 2);
    assert.equal(h.worker.state.failed, 0);
    assert.equal(h.worker.state.deleted, 2, 'both messages should have been deleted');
    assert.equal(await depth(h.queue), 0, 'queue should be empty');
    assert.equal(await inFlight(h.queue), 0, 'nothing should remain in flight');
    assert.equal(await depth(h.dlq), 0, 'a valid message must never reach the DLQ');
  } finally {
    h.cleanup();
  }
});

test('a throwing handler does not delete the message, so it is retried', async () => {
  let attempts = 0;
  // Fails the first time, succeeds on redelivery.
  const h = harness({
    handler: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient downstream failure');
    },
    maxReceiveCount: 5,
  });
  try {
    await h.queue.sendMessage({ id: 'retry-me' });

    await h.worker.start();

    assert.ok(attempts >= 2, `expected a redelivery, handler ran ${attempts} time(s)`);
    assert.equal(h.worker.state.failed, 1, 'the first attempt should be recorded as failed');
    assert.equal(h.worker.state.processed, 1, 'the retry should succeed');
    assert.equal(await depth(h.queue), 0, 'the message should be gone once it succeeded');
    assert.equal(await depth(h.dlq), 0, 'a message that eventually succeeds must not be dead-lettered');
  } finally {
    h.cleanup();
  }
});

test('a message that keeps failing is redriven to the DLQ after maxReceiveCount', async () => {
  let attempts = 0;
  const h = harness({
    handler: async () => { attempts += 1; throw new Error('permanent failure'); },
    maxReceiveCount: 2,
  });
  try {
    await h.queue.sendMessage({ id: 'poison' });

    await h.worker.start();

    assert.equal(attempts, 2, `expected exactly maxReceiveCount attempts, got ${attempts}`);
    assert.equal(h.worker.state.failed, 2);
    assert.equal(h.worker.state.deleted, 0, 'a failing message must never be deleted');
    assert.equal(await depth(h.queue), 0, 'the message should have left the main queue');
    assert.equal(await depth(h.dlq), 1, 'the poison message belongs in the DLQ');

    const [dead] = await h.dlq.receiveMessages({ maxMessages: 1, waitTimeSeconds: 0 });
    assert.equal(JSON.parse(dead.body).id, 'poison');
    assert.equal(dead.attributes.redrivenFrom, 'test-work',
      'the DLQ record should say which queue it came from');
  } finally {
    h.cleanup();
  }
});

test('an idempotent duplicate still deletes the message, so retries terminate', async () => {
  // A handler that reports `duplicate: true` has done its job - the work was
  // already applied. Treating that as a failure would loop until the DLQ.
  const h = harness({ handler: async () => ({ duplicate: true }) });
  try {
    await h.queue.sendMessage({ id: 'already-done' });

    await h.worker.start();

    assert.equal(h.worker.state.duplicates, 1);
    assert.equal(h.worker.state.processed, 0, 'a duplicate is not counted as new work');
    assert.equal(h.worker.state.failed, 0);
    assert.equal(h.worker.state.deleted, 1, 'a duplicate must still be removed from the queue');
    assert.equal(await depth(h.dlq), 0);
  } finally {
    h.cleanup();
  }
});

test('an unparseable message is dead-lettered rather than looping forever', async () => {
  let handlerCalls = 0;
  const h = harness({
    handler: async () => { handlerCalls += 1; },
    maxReceiveCount: 2,
  });
  try {
    // Bypass sendMessage's JSON encoding to plant genuinely broken content.
    await h.queue.sendMessage('this is not json{');

    await h.worker.start();

    assert.equal(handlerCalls, 0, 'the handler must never see an unparseable body');
    assert.equal(h.worker.state.failed, 2);
    assert.equal(await depth(h.queue), 0);
    assert.equal(await depth(h.dlq), 1, 'malformed input belongs in the DLQ');
  } finally {
    h.cleanup();
  }
});

test('shutdown lets in-flight work finish instead of abandoning it', async () => {
  let finished = 0;
  const h = harness({
    handler: async () => {
      await new Promise((r) => { setTimeout(r, 300); });
      finished += 1;
    },
    settings: { idleExitAfterMs: 0 }, // do not self-exit; we stop it explicitly
  });
  try {
    for (const id of ['a', 'b', 'c']) await h.queue.sendMessage({ id });

    const running = h.worker.start();
    // Stop once the batch has been claimed and is being processed.
    setTimeout(() => h.worker.stop(), 150);
    await running;

    assert.equal(finished, 3, 'in-flight messages should complete during the grace period');
    assert.equal(h.worker.state.deleted, 3);
    assert.equal(await depth(h.queue), 0);
    assert.equal(await inFlight(h.queue), 0, 'no message should be left claimed');
    assert.equal(await depth(h.dlq), 0);
  } finally {
    h.cleanup();
  }
});
