/**
 * Notification worker - business logic.
 *
 * WHAT IT DOES
 * Consumes alerts from the notification queue and writes a SIMULATED delivery
 * record per alert.
 *
 * NOTHING IS ACTUALLY SENT. No SMS, no email, no push service, no third-party
 * paid API is contacted, ever. `simulated: true` is a required field on the
 * record schema so this cannot be misread later. The delivery record is the
 * deliverable; it stands in for the audience-facing channel.
 *
 * WHY IT EXISTS
 * It is the last stage of the event-driven chain and the second (secondary)
 * autoscaling candidate. It also demonstrates idempotency at a third point in
 * the pipeline: the same alertId redelivered must not produce a second
 * delivery record.
 *
 * Input:  alert (schemas/alert.schema.json)
 * Output: notification record (schemas/notification-record.schema.json)
 */
import { FAILURE_INJECTION, TABLES, WORKER } from '@sit314/shared/config';
import { validateAlert, validateNotification } from '@sit314/shared/validation';
import { burnCpu, derivedId, nowIso, sleep } from '@sit314/shared/util';

/** Which simulated channel each audience is reached on. */
export const CHANNEL_FOR_AUDIENCE = {
  passengers: 'simulatedPush',
  operators: 'simulatedOpsConsole',
  controlRoom: 'simulatedOpsConsole',
  authority: 'simulatedDisplay',
};

export class NotificationWorker {
  constructor({
    store,
    logger,
    settings = {},
    failureInjection = FAILURE_INJECTION,
    random = Math.random,
  }) {
    this.store = store;
    this.logger = logger;
    this.settings = {
      processingDelayMs: WORKER.processingDelayMs,
      processingCpuIterations: WORKER.processingCpuIterations,
      ...settings,
    };
    this.failureInjection = failureInjection;
    this.random = random;
    this.counters = { delivered: 0, duplicates: 0, recipients: 0, invalid: 0 };
  }

  async #applyProcessingCost() {
    if (this.settings.processingCpuIterations > 0) burnCpu(this.settings.processingCpuIterations);
    if (this.settings.processingDelayMs > 0) await sleep(this.settings.processingDelayMs);
  }

  async handle(alert) {
    const check = validateAlert(alert);
    if (!check.valid) {
      this.counters.invalid += 1;
      const err = new Error(`alert failed validation: ${check.errors.slice(0, 3).join('; ')}`);
      err.nonRetryable = true;
      throw err;
    }

    // Idempotency: one delivery record per alert, no matter how many times SQS
    // delivers it. The id is derived so a retry maps to the same record.
    const notificationId = derivedId('notification', alert.alertId);
    const claim = await this.store.putIfAbsent(TABLES.notifications, {
      notificationId,
      alertId: alert.alertId,
      status: 'pending',
      claimedAt: nowIso(),
    });

    if (!claim.written) {
      this.counters.duplicates += 1;
      this.logger.info('DUPLICATE_SKIPPED', { alertId: alert.alertId },
        `[DUPLICATE_SKIPPED] alertId=${alert.alertId}`);
      return { duplicate: true };
    }

    const started = Date.now();

    // Controlled failure injection so retry and DLQ behaviour can be shown.
    if (this.failureInjection.enabled && this.random() < this.failureInjection.rate) {
      const err = new Error(`injected notification failure for ${alert.alertId}`);
      err.injected = true;
      // Record the attempt as failed, then throw so the message is retried.
      await this.store.put(TABLES.notifications, {
        notificationId,
        alertId: alert.alertId,
        audience: alert.audience,
        channel: CHANNEL_FOR_AUDIENCE[alert.audience],
        severity: alert.severity,
        recipientCount: alert.recipientCount,
        status: 'failed',
        simulated: true,
        attempts: 1,
        message: alert.message,
        processingMs: Date.now() - started,
        createdAt: nowIso(),
      });
      throw err;
    }

    await this.#applyProcessingCost();

    const record = {
      notificationId,
      alertId: alert.alertId,
      jobId: alert.jobId ?? null,
      sourceEventId: alert.sourceEventId ?? null,
      audience: alert.audience,
      channel: CHANNEL_FOR_AUDIENCE[alert.audience] ?? 'simulatedDisplay',
      severity: alert.severity,
      recipientCount: alert.recipientCount ?? 0,
      status: 'delivered',
      simulated: true, // never a real send
      attempts: 1,
      message: alert.message,
      processingMs: Date.now() - started,
      createdAt: nowIso(),
    };

    const valid = validateNotification(record);
    if (!valid.valid) throw new Error(`generated an invalid notification record: ${valid.errors.join('; ')}`);

    await this.store.put(TABLES.notifications, record);
    this.counters.delivered += 1;
    this.counters.recipients += record.recipientCount;

    this.logger.info('NOTIFICATION_SIMULATED', {
      alertId: alert.alertId,
      audience: alert.audience,
      severity: alert.severity,
      recipientCount: record.recipientCount,
      status: record.status,
    }, `[NOTIFICATION_SIMULATED] alertId=${alert.alertId} audience=${alert.audience} `
      + `severity=${alert.severity} recipients=${record.recipientCount} status=delivered`);

    return { duplicate: false, record };
  }
}

export default NotificationWorker;
