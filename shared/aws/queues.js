/**
 * Queue abstraction shared by every worker.
 *
 * What: `getQueue(name)` returns an object with the same five methods
 *       regardless of whether the backend is real Amazon SQS or the local
 *       file-backed queue.
 * Why:  SQS is the component that gives this architecture its scalability.
 *       It decouples producers from consumers, so a burst of analysis jobs is
 *       absorbed by the queue instead of overwhelming the workers, and the
 *       queue depth becomes the signal that drives autoscaling. Keeping one
 *       interface means the business logic that is unit-tested locally is
 *       literally the same code that runs against SQS in ECS.
 *
 * Input:  message bodies (JSON-serialisable objects).
 * Output: claimed messages with a receiptHandle; the message is only deleted
 *         after the consumer has finished successfully.
 */
import path from 'node:path';
import { BACKENDS, LOCAL_DATA_DIR, QUEUES, REGION, WORKER } from '../config/index.js';
import { LocalQueue } from './local-queue.js';

const LOCAL_QUEUE_ROOT = path.join(LOCAL_DATA_DIR, 'queues');

/** Dead-letter queue naming convention, matching the CloudFormation template. */
export function dlqNameFor(queueName) {
  if (queueName.endsWith('-dlq')) return null;
  return `${queueName}-dlq`;
}

class SqsQueue {
  constructor(name, options = {}) {
    this.name = name;
    this.region = options.region || REGION;
    this.visibilityTimeoutSeconds = options.visibilityTimeoutSeconds
      ?? WORKER.visibilityTimeoutSeconds;
    this._client = null;
    this._url = process.env[`SQS_URL_${name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`] || null;
    this._sdk = null;
  }

  async #sdk() {
    if (!this._sdk) this._sdk = await import('@aws-sdk/client-sqs');
    return this._sdk;
  }

  async #clientAndUrl() {
    const sdk = await this.#sdk();
    if (!this._client) this._client = new sdk.SQSClient({ region: this.region });
    if (!this._url) {
      const out = await this._client.send(new sdk.GetQueueUrlCommand({ QueueName: this.name }));
      this._url = out.QueueUrl;
    }
    return { sdk, client: this._client, url: this._url };
  }

  get url() {
    return this._url || `sqs://${this.name}`;
  }

  async sendMessage(body, attributes = {}) {
    const { sdk, client, url } = await this.#clientAndUrl();
    const out = await client.send(new sdk.SendMessageCommand({
      QueueUrl: url,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageAttributes: toMessageAttributes(attributes),
    }));
    return { messageId: out.MessageId };
  }

  /** SQS accepts at most 10 entries per batch, so long lists are chunked. */
  async sendMessageBatch(bodies) {
    const { sdk, client, url } = await this.#clientAndUrl();
    let successful = 0;
    let failed = 0;
    for (let i = 0; i < bodies.length; i += 10) {
      const slice = bodies.slice(i, i + 10);
      const out = await client.send(new sdk.SendMessageBatchCommand({
        QueueUrl: url,
        Entries: slice.map((body, idx) => ({
          Id: String(idx),
          MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
        })),
      }));
      successful += (out.Successful || []).length;
      failed += (out.Failed || []).length;
    }
    return { successful, failed };
  }

  async receiveMessages({
    maxMessages = 10,
    waitTimeSeconds = 20,
    visibilityTimeoutSeconds = this.visibilityTimeoutSeconds,
  } = {}) {
    const { sdk, client, url } = await this.#clientAndUrl();
    const out = await client.send(new sdk.ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: Math.min(maxMessages, 10),
      WaitTimeSeconds: Math.min(waitTimeSeconds, 20), // long polling
      VisibilityTimeout: visibilityTimeoutSeconds,
      AttributeNames: ['ApproximateReceiveCount', 'SentTimestamp'],
      MessageAttributeNames: ['All'],
    }));
    return (out.Messages || []).map((m) => ({
      messageId: m.MessageId,
      receiptHandle: m.ReceiptHandle,
      body: m.Body,
      receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 1),
      enqueuedAt: Number(m.Attributes?.SentTimestamp ?? Date.now()),
      attributes: fromMessageAttributes(m.MessageAttributes),
    }));
  }

  async deleteMessage(receiptHandle) {
    const { sdk, client, url } = await this.#clientAndUrl();
    await client.send(new sdk.DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: receiptHandle }));
    return true;
  }

  async deleteMessageBatch(receiptHandles) {
    const { sdk, client, url } = await this.#clientAndUrl();
    let deleted = 0;
    for (let i = 0; i < receiptHandles.length; i += 10) {
      const slice = receiptHandles.slice(i, i + 10);
      const out = await client.send(new sdk.DeleteMessageBatchCommand({
        QueueUrl: url,
        Entries: slice.map((h, idx) => ({ Id: String(idx), ReceiptHandle: h })),
      }));
      deleted += (out.Successful || []).length;
    }
    return { deleted };
  }

  async changeMessageVisibility(receiptHandle, timeoutSeconds) {
    const { sdk, client, url } = await this.#clientAndUrl();
    await client.send(new sdk.ChangeMessageVisibilityCommand({
      QueueUrl: url,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: timeoutSeconds,
    }));
    return true;
  }

  async getAttributes() {
    const { sdk, client, url } = await this.#clientAndUrl();
    const out = await client.send(new sdk.GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
      ],
    }));
    const a = out.Attributes || {};
    return {
      queueName: this.name,
      approximateNumberOfMessages: Number(a.ApproximateNumberOfMessages ?? 0),
      approximateNumberOfMessagesNotVisible: Number(a.ApproximateNumberOfMessagesNotVisible ?? 0),
      // ApproximateAgeOfOldestMessage is available from AWS/SQS CloudWatch,
      // not the SQS GetQueueAttributes API used for queue depth readings.
      approximateAgeOfOldestMessageSeconds: null,
    };
  }

  async purge() {
    const { sdk, client, url } = await this.#clientAndUrl();
    await client.send(new sdk.PurgeQueueCommand({ QueueUrl: url }));
  }
}

function toMessageAttributes(attributes) {
  const out = {};
  for (const [k, v] of Object.entries(attributes || {})) {
    if (v === undefined || v === null) continue;
    out[k] = { DataType: 'String', StringValue: String(v) };
  }
  return Object.keys(out).length ? out : undefined;
}

function fromMessageAttributes(attrs) {
  const out = {};
  for (const [k, v] of Object.entries(attrs || {})) out[k] = v.StringValue;
  return out;
}

const cache = new Map();

/**
 * Returns a queue handle. `backend` defaults to QUEUE_BACKEND
 * ('local' for development and local experiments, 'aws' for SQS).
 */
export function getQueue(name, options = {}) {
  const backend = options.backend || BACKENDS.queue;
  const key = `${backend}:${name}:${options.baseDir || ''}`;
  if (cache.has(key)) return cache.get(key);
  const common = {
    dlqName: options.dlqName === undefined ? dlqNameFor(name) : options.dlqName,
    maxReceiveCount: options.maxReceiveCount ?? WORKER.maxReceiveCount,
    visibilityTimeoutSeconds: options.visibilityTimeoutSeconds ?? WORKER.visibilityTimeoutSeconds,
  };
  const queue = backend === 'aws' || backend === 'sqs'
    ? new SqsQueue(name, common)
    : new LocalQueue(name, { ...common, baseDir: options.baseDir || LOCAL_QUEUE_ROOT });
  cache.set(key, queue);
  return queue;
}

/** Convenience accessors used by the services. */
export const queues = {
  telemetry: (o) => getQueue(QUEUES.telemetry, o),
  analysis: (o) => getQueue(QUEUES.analysis, o),
  notifications: (o) => getQueue(QUEUES.notifications, o),
  telemetryDlq: (o) => getQueue(QUEUES.telemetryDlq, o),
  analysisDlq: (o) => getQueue(QUEUES.analysisDlq, o),
  notificationsDlq: (o) => getQueue(QUEUES.notificationsDlq, o),
};

export { LocalQueue, SqsQueue };
export { LOCAL_QUEUE_ROOT };
