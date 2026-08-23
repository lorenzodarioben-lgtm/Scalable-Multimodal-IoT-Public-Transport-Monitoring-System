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
 * This is deliberately NOT a general AWS emulator. It is one queue's semantics,
 * and the AWS adapter in queues.js is a peer implementation of the same methods.
 *
 * CONCURRENCY MODEL
 * A message is a file in `pending/`. Claiming it means creating
 * `inflight/<messageId>.json` with the exclusive-create flag 'wx'. Exclusive
 * create is atomic on both Windows (CREATE_NEW) and POSIX (O_EXCL), so exactly
 * one polling process can win and the losers get EEXIST.
 *
 * Note: rename() is deliberately NOT used as the claim primitive. On Windows,
 * concurrent renames of the same source file can each report success even
 * though only one destination is actually produced, which silently delivers one
 * message to several consumers. This was observed on the development machine
 * and is why the claim is an exclusive create.
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
    // Nothing can become visible again sooner than the visibility timeout, so
    // reaping more often than half of it cannot find anything new. Capped at
    // one second so redelivery still feels prompt.
    this.reapIntervalMs = options.reapIntervalMs
      ?? Math.min(1000, Math.max(0, (this.visibilityTimeoutSeconds * 1000) / 2));
    this._lastReapAt = 0;
    fs.mkdirSync(this.pendingDir, { recursive: true });
    fs.mkdirSync(this.inflightDir, { recursive: true });
  }

  get url() {
    return `local://${this.name}`;
  }

  /**
   * Deterministic pending file name: sorting by name gives FIFO order, and
   * re-writing the same message produces the same path instead of a duplicate.
   */
  #pendingPath(enqueuedMs, messageId) {
    return path.join(this.pendingDir, `${String(enqueuedMs).padStart(15, '0')}-${messageId}.json`);
  }

  #inflightPath(messageId) {
    return path.join(this.inflightDir, `${messageId}.json`);
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
      firstEnqueuedAt: enqueuedAt,
      receiveCount: 0,
    };
    await this.#atomicWrite(this.#pendingPath(enqueuedAt, messageId), record);
    return { messageId };
  }

  async sendMessageBatch(bodies) {
    const results = [];
    for (const body of bodies) results.push(await this.sendMessage(body));
    return { successful: results.length, failed: 0, results };
  }

  /** Puts a record back on the pending side (used by redelivery). */
  async #requeue(record) {
    await this.#atomicWrite(
      this.#pendingPath(record.firstEnqueuedAt, record.messageId),
      { ...record, visibleAt: undefined, receiptHandle: undefined },
    );
  }

  /**
   * Move expired in-flight messages back to pending, or to the DLQ once they
   * have been received more than `maxReceiveCount` times. This is the local
   * equivalent of the SQS redrive policy.
   */
  /**
   * @param {boolean} force reap even if one ran very recently.
   *
   * Reaping reads every in-flight record, so running it on every poll of every
   * consumer is pure overhead that grows with the number of workers. There is
   * never any need to reap more often than half the visibility timeout, since
   * nothing can expire faster than that - see `reapIntervalMs`.
   */
  async reapExpired(force = false) {
    const now0 = Date.now();
    if (!force && this._lastReapAt && now0 - this._lastReapAt < this.reapIntervalMs) {
      return { requeued: 0, deadLettered: 0, skipped: true };
    }
    this._lastReapAt = now0;

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
      if (!file.endsWith('.json')) continue;
      const full = path.join(this.inflightDir, file);
      let record;
      try {
        record = JSON.parse(await fsp.readFile(full, 'utf8'));
      } catch {
        continue; // being written, or already removed by another reaper
      }
      if (!record.visibleAt || record.visibleAt > now) continue;

      if (record.receiveCount >= this.maxReceiveCount && this.dlqName) {
        // Claim the expired message by removing the in-flight file first, so
        // two reapers can never write the same message to the DLQ twice.
        const claimed = await fsp.rm(full).then(() => true).catch(() => false);
        if (!claimed) continue;
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
        deadLettered += 1;
        continue;
      }

      await this.#requeue(record);
      // Releasing the in-flight file last makes the operation safe to repeat:
      // a crash between the two steps only ever duplicates a pending file with
      // an identical path, which overwrites rather than multiplies.
      await fsp.rm(full).catch(() => {});
      requeued += 1;
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

    // Contention control. Real SQS hands each consumer a different set of
    // messages; a shared directory does not. Without this, N concurrent
    // consumers all scan from the head of the queue, race for the same few
    // files, and N-1 of them lose every race - which made adding workers
    // REDUCE throughput. Two adjustments fix it while keeping delivery
    // approximately FIFO:
    //   1. only consider a bounded window at the head of the queue, so the
    //      per-poll cost does not grow with a backlog of thousands, and
    //      SQS itself only guarantees approximate ordering anyway;
    //   2. start each consumer at a random offset inside that window, so
    //      concurrent consumers mostly claim different messages.
    const windowSize = Math.max(maxMessages * 8, 64);
    const window = files.slice(0, windowSize);
    const offset = window.length > maxMessages
      ? Math.floor(Math.random() * window.length)
      : 0;
    const ordered = offset === 0
      ? window
      : [...window.slice(offset), ...window.slice(0, offset)];

    const claimed = [];
    for (const file of ordered) {
      if (claimed.length >= maxMessages) break;
      const src = path.join(this.pendingDir, file);
      let record;
      try {
        record = JSON.parse(await fsp.readFile(src, 'utf8'));
      } catch {
        continue; // consumed by someone else between readdir and readFile
      }

      const inflight = {
        ...record,
        receiveCount: record.receiveCount + 1,
        visibleAt: Date.now() + visibilityTimeoutSeconds * 1000,
        receiptHandle: record.messageId,
      };
      try {
        // Exclusive create: atomic on Windows and POSIX. Exactly one claimant.
        await fsp.writeFile(this.#inflightPath(record.messageId), JSON.stringify(inflight), { flag: 'wx' });
      } catch (err) {
        if (err.code === 'EEXIST') continue; // another consumer won the race
        throw err;
      }
      // The claim is now held, so removing the pending copy is safe.
      await fsp.rm(src).catch(() => {});

      claimed.push({
        messageId: record.messageId,
        receiptHandle: record.messageId,
        body: record.body,
        receiveCount: inflight.receiveCount,
        enqueuedAt: record.firstEnqueuedAt,
        attributes: record.attributes || {},
      });
    }
    return claimed;
  }

  /** Remove a message. Called ONLY after the message has been fully processed. */
  async deleteMessage(receiptHandle) {
    try {
      await fsp.unlink(this.#inflightPath(receiptHandle));
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

  /** Make a message visible again sooner (used to fail fast on error). */
  async changeMessageVisibility(receiptHandle, timeoutSeconds) {
    const full = this.#inflightPath(receiptHandle);
    try {
      const record = JSON.parse(await fsp.readFile(full, 'utf8'));
      if (timeoutSeconds <= 0) {
        // Release it now rather than waiting for the next reap, matching the
        // SQS behaviour where a zero visibility timeout is immediate.
        await this.#requeue(record);
        await fsp.rm(full).catch(() => {});
        return true;
      }
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
