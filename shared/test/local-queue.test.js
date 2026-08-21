import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalQueue } from '../aws/local-queue.js';
import { dlqNameFor } from '../aws/queues.js';
import { sleep } from '../util/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-q-'));
}

function makeQueue(baseDir, name = 'test-queue', options = {}) {
  return new LocalQueue(name, {
    baseDir,
    dlqName: `${name}-dlq`,
    maxReceiveCount: 3,
    visibilityTimeoutSeconds: 30,
    ...options,
  });
}

test('send then receive returns the message body', async () => {
  const dir = tmpDir();
  const q = makeQueue(dir);
  await q.sendMessage({ jobId: 'job-1' });
  const [msg] = await q.receiveMessages({ maxMessages: 10, waitTimeSeconds: 0 });
  assert.equal(JSON.parse(msg.body).jobId, 'job-1');
  assert.equal(msg.receiveCount, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a received message is invisible to other consumers', async () => {
  const dir = tmpDir();
  const q = makeQueue(dir);
  await q.sendMessage({ jobId: 'job-1' });
  const first = await q.receiveMessages({ maxMessages: 10, waitTimeSeconds: 0 });
  const second = await q.receiveMessages({ maxMessages: 10, waitTimeSeconds: 0 });
  assert.equal(first.length, 1);
  assert.equal(second.length, 0, 'in-flight message must not be delivered twice');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deleting a message removes it permanently', async () => {
  const dir = tmpDir();
  const q = makeQueue(dir);
  await q.sendMessage({ jobId: 'job-1' });
  const [msg] = await q.receiveMessages({ waitTimeSeconds: 0 });
  await q.deleteMessage(msg.receiptHandle);
  const attrs = await q.getAttributes();
  assert.equal(attrs.approximateNumberOfMessages, 0);
  assert.equal(attrs.approximateNumberOfMessagesNotVisible, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a message that is NOT deleted becomes visible again after the timeout', async () => {
  // This is the safety property the workers rely on: on failure they simply do
  // not delete, and the message is redelivered rather than lost.
  const dir = tmpDir();
  const q = makeQueue(dir, 'retry-queue', { visibilityTimeoutSeconds: 0 });
  await q.sendMessage({ jobId: 'job-retry' });
  const [first] = await q.receiveMessages({ waitTimeSeconds: 0, visibilityTimeoutSeconds: 0 });
  assert.equal(first.receiveCount, 1);
  await sleep(20);
  const [second] = await q.receiveMessages({ waitTimeSeconds: 0, visibilityTimeoutSeconds: 0 });
  assert.ok(second, 'message was not redelivered');
  assert.equal(second.receiveCount, 2, 'receive count must increase on redelivery');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('redrive policy moves a repeatedly failing message to the DLQ', async () => {
  const dir = tmpDir();
  const q = makeQueue(dir, 'poison-queue', { visibilityTimeoutSeconds: 0, maxReceiveCount: 2 });
  await q.sendMessage({ jobId: 'poison' });
  // Receive twice without deleting: receiveCount reaches maxReceiveCount.
  for (let i = 0; i < 2; i += 1) {
    await q.receiveMessages({ waitTimeSeconds: 0, visibilityTimeoutSeconds: 0 });
    await sleep(10);
  }
  const result = await q.reapExpired();
  assert.equal(result.deadLettered, 1, 'message should have been dead-lettered');

  const dlq = new LocalQueue('poison-queue-dlq', { baseDir: dir, dlqName: null });
  const dlqAttrs = await dlq.getAttributes();
  assert.equal(dlqAttrs.approximateNumberOfMessages, 1);
  const [dead] = await dlq.receiveMessages({ waitTimeSeconds: 0 });
  assert.equal(JSON.parse(dead.body).jobId, 'poison');
  assert.equal(dead.attributes.redrivenFrom, 'poison-queue');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('queue attributes report depth and age of oldest message', async () => {
  const dir = tmpDir();
  const q = makeQueue(dir, 'depth-queue');
  await q.sendMessageBatch(Array.from({ length: 25 }, (_, i) => ({ jobId: `job-${i}` })));
  const attrs = await q.getAttributes();
  assert.equal(attrs.approximateNumberOfMessages, 25);
  assert.equal(attrs.queueName, 'depth-queue');
  assert.ok(attrs.approximateAgeOfOldestMessageSeconds >= 0);

  await q.receiveMessages({ maxMessages: 10, waitTimeSeconds: 0 });
  const after = await q.getAttributes();
  assert.equal(after.approximateNumberOfMessages, 15);
  assert.equal(after.approximateNumberOfMessagesNotVisible, 10);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('messages are delivered roughly in order', async () => {
  const dir = tmpDir();
  const q = makeQueue(dir, 'order-queue');
  for (let i = 0; i < 10; i += 1) await q.sendMessage({ n: i });
  const msgs = await q.receiveMessages({ maxMessages: 10, waitTimeSeconds: 0 });
  const order = msgs.map((m) => JSON.parse(m.body).n);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('concurrent consumers never receive the same message twice', async () => {
  // The property that makes "run N workers against one queue" valid.
  const dir = tmpDir();
  const total = 200;
  const producer = makeQueue(dir, 'race-queue');
  await producer.sendMessageBatch(Array.from({ length: total }, (_, i) => ({ n: i })));

  const consumers = Array.from({ length: 5 }, () => makeQueue(dir, 'race-queue'));
  const seen = [];
  await Promise.all(consumers.map(async (c) => {
    for (;;) {
      const msgs = await c.receiveMessages({ maxMessages: 7, waitTimeSeconds: 0 });
      if (!msgs.length) break;
      for (const m of msgs) {
        seen.push(JSON.parse(m.body).n);
        await c.deleteMessage(m.receiptHandle);
      }
    }
  }));

  assert.equal(seen.length, total, 'every message must be delivered exactly once');
  assert.equal(new Set(seen).size, total, 'a message was delivered to two consumers');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('long polling waits for a message instead of spinning', async () => {
  const dir = tmpDir();
  const q = makeQueue(dir, 'poll-queue');
  const started = Date.now();
  const pending = q.receiveMessages({ maxMessages: 1, waitTimeSeconds: 2 });
  setTimeout(() => { q.sendMessage({ late: true }); }, 250);
  const msgs = await pending;
  const elapsed = Date.now() - started;
  assert.equal(msgs.length, 1);
  assert.ok(elapsed >= 200, 'should have waited for the late message');
  assert.ok(elapsed < 2000, 'should have returned as soon as the message arrived');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('changeMessageVisibility can release a message early', async () => {
  const dir = tmpDir();
  const q = makeQueue(dir, 'visibility-queue');
  await q.sendMessage({ jobId: 'job-1' });
  const [msg] = await q.receiveMessages({ waitTimeSeconds: 0, visibilityTimeoutSeconds: 300 });
  await q.changeMessageVisibility(msg.receiptHandle, 0);
  await sleep(10);
  const [again] = await q.receiveMessages({ waitTimeSeconds: 0 });
  assert.ok(again, 'message should be immediately available again');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DLQ naming convention matches the CloudFormation template', () => {
  assert.equal(dlqNameFor('sit314-transport-analysis'), 'sit314-transport-analysis-dlq');
  assert.equal(dlqNameFor('sit314-transport-analysis-dlq'), null, 'a DLQ has no DLQ of its own');
});
