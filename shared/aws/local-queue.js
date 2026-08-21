/**
 * File-backed queue used when QUEUE_BACKEND=local.
 *
 * What: a small on-disk queue that implements the parts of the SQS contract the
 *       services actually depend on - long polling, visibility timeout,
 *       receive count, redrive to a dead-letter queue, and queue-depth
 *       attributes.
 * Why:  every worker in this project must be runnable and testable before (and
 *       independently of) an AWS deployment, and the local scalability
 *       experiments need several OS processes to compete for the same queue.
 *       The workers themselves contain no local/AWS branching - they only see
 *       this interface, so the identical business logic runs against real SQS.
 *
 * This is deliberately NOT a general AWS emulator. It is roughly 200 lines that
 * reproduce one queue's semantics, and the AWS adapter is a peer implementation
 * of the same five methods.
 *
 * Concurrency model: a message is a file. Claiming a message is a single
 * `rename()` from `pending/` into `inflight/`. rename() is atomic, so exactly
 * one polling process can win; the loser sees ENOENT and moves on. This is what
 * makes "run five workers against one queue" genuinely concurrent.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sleep } from '../util/index.js';

export class LocalQueue {
  /**
   * @param {string} name queue name (e.g. sit314-transport-analysis)
   * @param {object} options
   * @param {string} options.baseDir root directory holding all local queues
   * @param {string|null} options.dlqName dead-letter queue name, or null
   * @param {number} options.maxReceiveCount redrive threshold
   * @param {number} options.visibilityTimeoutSeconds default visibility timeout
   */
  constructor(name, options = {}) {
    this.name = name;
    this.baseDir = options.baseDir;
    this.dir = path.join(this.baseDir, name);
    this.pendingDir = path.join(this.dir, 'pending');
    this.inflightDir = path.join(this.dir, 'inflight');
    this.dlqName = options.dlqName ?? null;
    this.maxReceiveCount = options.maxReceiveCount ?? 3;
    this.visibilityTimeoutSeconds = options.visibilityTimeoutSeconds ?? 30;
    this.sequence = 0;
    fs.mkdirSync(this.pendingDir, { recursive: true });
    fs.mkdirSync(this.inflightDir, { recursive: true });
  }

  get url() {
    return `local://${this.name}`;
  }

  #pendingFileName(enqueuedMs, messageId) {
    this.sequence = (this.sequence + 1) % 1_000_000;
    const seq = String(this.sequence).padStart(6, '0');
    return `${String(enqueuedMs).padStart(15, '0')}-${seq}-${messageId}.json`;
  }

  /** Write-then-rename so a reader never observes a half-written message. */
  async #atomicWrite(targetPath, payload) {
    const tmp = path.join(this.dir, `.tmp-${randomUUID()}`);
    await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fsp.rename(tmp, targetPath);
  }

  async sendMessage(body, attributes = {}) {
    const messageId = randomUUID();
    const enqueuedAt = Date.now();
    const record = {
      messageId,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      attributes,
      enqueuedAt,
      firstEnqueuedAt: attributes.firstEnqueuedAt ?? enqueuedAt,
      receiveCount: 0,
    };
    await this.#atomicWrite(
      path.join(this.pendingDir, this.#pendingFileName(enqueuedAt, messageId)),
      record,
    );
    return { messageId };
  }

  async sendMessageBatch(bodies) {
    const results = [];
    for (const body of bodies) results.push(await this.sendMessage(body));
    return { successful: results.length, failed: 0, results };
  }

  /**
   * Move expired in-flight messages back to pending, or to the DLQ once they
   * have been received more than `maxReceiveCount` times. This is the local
   * equivalent of the SQS redrive policy.
   */
  async reapExpired() {
    let requeued = 0;
    let deadLettered = 0;
    let files;
    try {
      files = await fsp.readdir(this.inflightDir);
    } catch {
      return { requeued, deadLettered };
    }
    const now = Date.now();
    for (const file of files) {
      const full = path.join(this.inflightDir, file);
      let record;
      try {
        record = JSON.parse(await fsp.readFile(full, 'utf8'));
      } catch {
        continue; // being written or already claimed by another reaper
      }
      if (!record.visibleAt || record.visibleAt > now) continue;
      if (record.receiveCount >= this.maxReceiveCount && this.dlqName) {
        // Claim the expired message with an atomic rename before redriving it,
        // so two reapers can never write the same message to the DLQ twice.
        const claimPath = path.join(this.dir, `.redrive-${randomUUID()}`);
        try {
          await fsp.rename(full, claimPath);
        } catch {
          continue; // another process claimed it
        }
        const dlq = new LocalQueue(this.dlqName, {
          baseDir: this.baseDir,
          dlqName: null,
          maxReceiveCount: this.maxReceiveCount,
        });
        await dlq.sendMessage(record.body, {
          ...record.attributes,
          redrivenFrom: this.name,
          receiveCount: record.receiveCount,
        });
        await fsp.unlink(claimPath).catch(() => {});
        deadLettered += 1;
        continue;
      }
      const target = path.join(
        this.pendingDir,
        this.#pendingFileName(record.firstEnqueuedAt, record.messageId),
      );
      try {
        await fsp.rename(full, target);
        requeued += 1;
      } catch {
        // another process reaped it first
      }
    }
    return { requeued, deadLettered };
  }

  /**
   * Long-polling receive. Returns up to `maxMessages` claimed messages.
   * Each returned message carries a receiptHandle that must be presented to
   * deleteMessage() - a message is only removed after successful processing.
   */
  async receiveMessages({
    maxMessages = 10,
    waitTimeSeconds = 5,
    visibilityTimeoutSeconds = this.visibilityTimeoutSeconds,
  } = {}) {
    const deadline = Date.now() + waitTimeSeconds * 1000;
    for (;;) {
      await this.reapExpired();
      const claimed = await this.#claim(maxMessages, visibilityTimeoutSeconds);
      if (claimed.length > 0) return claimed;
      if (Date.now() >= deadline) return [];
      await sleep(100);
    }
  }

  async #claim(maxMessages, visibilityTimeoutSeconds) {
    let files;
    try {
      files = (await fsp.readdir(this.pendingDir)).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }
    const claimed = [];
    for (const file of files) {
      if (claimed.length >= maxMessages) break;
      const src = path.join(this.pendingDir, file);
      const receiptHandle = `${randomUUID()}.json`;
      const dst = path.join(this.inflightDir, receiptHandle);
      let record;
      try {
        record = JSON.parse(await fsp.readFile(src, 'utf8'));
      } catch {
        continue;
      }
      try {
        await fsp.rename(src, dst); // atomic claim - loser gets ENOENT
      } catch {
        continue;
      }
      record.receiveCount += 1;
      record.visibleAt = Date.now() + visibilityTimeoutSeconds * 1000;
      record.receiptHandle = receiptHandle;
      try {
        await fsp.writeFile(dst, JSON.stringify(record), 'utf8');
      } catch { /* ignore */ }
      claimed.push({
        messageId: record.messageId,
        receiptHandle,
        body: record.body,
        receiveCount: record.receiveCount,
        enqueuedAt: record.firstEnqueuedAt,
        attributes: record.attributes || {},
      });
    }
    return claimed;
  }

  /** Remove a message. Called ONLY after the message has been fully processed. */
  async deleteMessage(receiptHandle) {
    try {
      await fsp.unlink(path.join(this.inflightDir, receiptHandle));
      return true;
    } catch {
      return false;
    }
  }

  async deleteMessageBatch(receiptHandles) {
    let deleted = 0;
    for (const h of receiptHandles) if (await this.deleteMessage(h)) deleted += 1;
    return { deleted };
  }

  /** Make a message immediately visible again (used to fail fast on error). */
  async changeMessageVisibility(receiptHandle, timeoutSeconds) {
    const full = path.join(this.inflightDir, receiptHandle);
    try {
      const record = JSON.parse(await fsp.readFile(full, 'utf8'));
      record.visibleAt = Date.now() + timeoutSeconds * 1000;
      await fsp.writeFile(full, JSON.stringify(record), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** SQS-shaped queue attributes - the input to backlog-per-task scaling. */
  async getAttributes() {
    const [pending, inflight] = await Promise.all([
      fsp.readdir(this.pendingDir).catch(() => []),
      fsp.readdir(this.inflightDir).catch(() => []),
    ]);
    const visible = pending.filter((f) => f.endsWith('.json'));
    let oldestAgeSeconds = 0;
    if (visible.length) {
      const oldest = visible.sort()[0];
      const enqueuedMs = Number(oldest.split('-')[0]);
      if (Number.isFinite(enqueuedMs) && enqueuedMs > 0) {
        oldestAgeSeconds = Math.max(0, Math.round((Date.now() - enqueuedMs) / 1000));
      }
    }
    return {
      queueName: this.name,
      approximateNumberOfMessages: visible.length,
      approximateNumberOfMessagesNotVisible: inflight.filter((f) => f.endsWith('.json')).length,
      approximateAgeOfOldestMessageSeconds: oldestAgeSeconds,
    };
  }

  async purge() {
    for (const dir of [this.pendingDir, this.inflightDir]) {
      const files = await fsp.readdir(dir).catch(() => []);
      await Promise.all(files.map((f) => fsp.unlink(path.join(dir, f)).catch(() => {})));
    }
  }
}
