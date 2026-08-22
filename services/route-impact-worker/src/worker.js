/**
 * Route-impact / ETA worker - business logic.
 *
 * WHAT IT DOES
 * For each analysis job taken from the analysis queue:
 *   1. claim the jobId with a conditional write (idempotency),
 *   2. calculate a deterministic route impact / ETA,
 *   3. store the result in DynamoDB,
 *   4. if the impact warrants it, emit alerts onto the notification queue,
 *   5. return, so the runtime deletes the queue message.
 *
 * WHY THIS IS THE AUTOSCALING TARGET
 * This is the only stage whose work grows super-linearly with an incident: one
 * telemetry event becomes hundreds or thousands of jobs. Each job is
 * independent, stateless and CPU-bound, so throughput scales with the number of
 * running tasks. When the analysis queue backlog per running task rises above
 * the target, Application Auto Scaling starts more tasks; they consume from the
 * same queue with no coordination, the backlog drains, and the service scales
 * back toward the minimum.
 *
 * Input:  analysis job (schemas/analysis-job.schema.json)
 * Output: analysis result in DynamoDB + 0..n alerts (schemas/alert.schema.json)
 */
import {
  FAILURE_INJECTION, TABLES, WORKER,
} from '@sit314/shared/config';
import { validateAlert, validateAnalysisJob } from '@sit314/shared/validation';
import { burnCpu, derivedId, nowIso, sleep } from '@sit314/shared/util';
import { calculateRouteImpact } from './eta.js';

/** Impact levels that are worth telling somebody about. */
export const ALERTABLE_LEVELS = new Set(['medium', 'high', 'critical']);

/** Who hears about an alert, by severity. Passengers are not paged for everything. */
export function audiencesFor(impactLevel) {
  if (impactLevel === 'critical') return ['passengers', 'operators', 'controlRoom', 'authority'];
  if (impactLevel === 'high') return ['passengers', 'operators', 'controlRoom'];
  if (impactLevel === 'medium') return ['operators', 'controlRoom'];
  return [];
}

export class RouteImpactWorker {
  /**
   * @param {object} deps
   * @param {object} deps.store
   * @param {object} deps.notificationQueue
   * @param {object} deps.logger
   * @param {object} [deps.settings] processing-cost test parameters
   * @param {object} [deps.failureInjection]
   * @param {() => number} [deps.random]
   */
  constructor({
    store,
    notificationQueue,
    logger,
    settings = {},
    failureInjection = FAILURE_INJECTION,
    random = Math.random,
  }) {
    this.store = store;
    this.notificationQueue = notificationQueue;
    this.logger = logger;
    this.settings = {
      processingDelayMs: WORKER.processingDelayMs,
      processingCpuIterations: WORKER.processingCpuIterations,
      ...settings,
    };
    this.failureInjection = failureInjection;
    this.random = random;
    this.counters = {
      processed: 0, duplicates: 0, alertsEmitted: 0, notificationsQueued: 0, invalid: 0,
    };
  }

  /**
   * Configurable processing cost.
   *
   * This is a DOCUMENTED TEST PARAMETER (WORKER_PROCESSING_DELAY_MS /
   * WORKER_PROCESSING_CPU_ITERATIONS), default 0. Its purpose is to give each
   * job a realistic, controlled service time so queue build-up and worker
   * scaling can be observed at an affordable workload size. It does not alter
   * any calculated result, and every experiment records the value used.
   */
  async #applyProcessingCost() {
    if (this.settings.processingCpuIterations > 0) {
      burnCpu(this.settings.processingCpuIterations);
    }
    if (this.settings.processingDelayMs > 0) {
      await sleep(this.settings.processingDelayMs);
    }
  }

  #maybeInjectFailure(stage) {
    if (!this.failureInjection.enabled) return;
    if (this.random() < this.failureInjection.rate) {
      const err = new Error(`injected failure at ${stage}`);
      err.injected = true;
      throw err;
    }
  }

  async handle(job) {
    const check = validateAnalysisJob(job);
    if (!check.valid) {
      this.counters.invalid += 1;
      const err = new Error(`analysis job failed validation: ${check.errors.slice(0, 3).join('; ')}`);
      err.nonRetryable = true;
      throw err;
    }

    // ---- 1. Idempotency claim on jobId -----------------------------------
    // The calculation itself is cheap to repeat, but the ALERTS are not: a
    // redelivered job must not notify everybody twice.
    const calculationId = derivedId('calc', job.jobId);
    const claim = await this.store.putIfAbsent(TABLES.analysisResults, {
      jobId: job.jobId,
      calculationId,
      status: 'inProgress',
      claimedAt: nowIso(),
    });

    if (!claim.written) {
      this.counters.duplicates += 1;
      this.logger.info('DUPLICATE_SKIPPED', { jobId: job.jobId },
        `[DUPLICATE_SKIPPED] jobId=${job.jobId}`);
      return { duplicate: true };
    }

    this.#maybeInjectFailure('beforeCalculation');
    const started = Date.now();
    await this.#applyProcessingCost();

    // ---- 2. Deterministic route impact -----------------------------------
    const impact = calculateRouteImpact(job);
    const processingMs = Date.now() - started;

    const result = {
      jobId: job.jobId,
      calculationId,
      incidentId: job.incidentId,
      sourceEventId: job.sourceEventId,
      transportMode: job.transportMode,
      vehicleId: job.vehicleId ?? null,
      routeId: job.routeId ?? null,
      locationId: job.affectedLocationId ?? null,
      hopsFromIncident: job.hopsFromIncident ?? 0,
      reason: job.reason ?? null,
      severity: job.severity ?? null,
      etaMinutes: impact.etaMinutes,
      impactLevel: impact.impactLevel,
      components: impact.components,
      qualityIndicator: impact.qualityIndicator,
      status: 'complete',
      processingMs,
      calculatedAt: nowIso(),
    };

    // ---- 3. Store the result ---------------------------------------------
    await this.store.put(TABLES.analysisResults, result);

    // ---- 4. Alert fan-out -------------------------------------------------
    const alerts = this.buildAlerts(job, result);
    if (alerts.length) {
      const batch = await this.notificationQueue.sendMessageBatch(alerts);
      if (batch.failed > 0) {
        // Do not swallow this: the message is not deleted and will be retried.
        // The jobId claim already exists, so the retry is recognised as a
        // duplicate and no second result is written - but the alerts are
        // re-sent, which the notification worker de-duplicates by alertId.
        throw new Error(`${batch.failed} alerts failed to enqueue for job ${job.jobId}`);
      }
      this.counters.alertsEmitted += alerts.length;
      this.counters.notificationsQueued += alerts.reduce((s, a) => s + a.recipientCount, 0);
    }

    this.counters.processed += 1;
    this.logger.info('ANALYSIS', {
      jobId: job.jobId, mode: job.transportMode, locationId: job.affectedLocationId,
      impactLevel: result.impactLevel, etaMinutes: result.etaMinutes, processingMs,
    }, `[ANALYSIS] job=${job.jobId} mode=${job.transportMode} `
      + `location=${job.affectedLocationId} impact=${result.impactLevel} `
      + `eta=${result.etaMinutes} alerts=${alerts.length} processingMs=${processingMs}`);

    return { duplicate: false, result, alerts: alerts.length };
  }

  /**
   * Turn one calculated impact into alerts. `notificationFanout` from the job
   * says how many simulated recipients this job represents, which is how the
   * experiment stages reach 200 / 1000 / 5000 / 10000 notifications.
   */
  buildAlerts(job, result) {
    if (!ALERTABLE_LEVELS.has(result.impactLevel)) return [];
    const audiences = audiencesFor(result.impactLevel);
    if (!audiences.length) return [];

    const totalRecipients = job.notificationFanout ?? 0;
    if (totalRecipients <= 0) return [];

    // Spread the recipients across the audiences, largest share to passengers.
    const perAudience = Math.floor(totalRecipients / audiences.length);
    const remainder = totalRecipients % audiences.length;

    const alerts = audiences.map((audience, index) => {
      const recipientCount = perAudience + (index < remainder ? 1 : 0);
      const alert = {
        alertId: derivedId('alert', job.jobId, audience),
        jobId: job.jobId,
        calculationId: result.calculationId,
        sourceEventId: job.sourceEventId,
        incidentId: job.incidentId ?? null,
        transportMode: job.transportMode,
        routeId: job.routeId ?? null,
        locationId: job.affectedLocationId ?? null,
        severity: severityFor(result.impactLevel),
        audience,
        etaMinutes: result.etaMinutes,
        impactLevel: result.impactLevel,
        message: buildMessage(job, result, audience),
        recipientBatch: index,
        recipientCount,
        createdAt: result.calculatedAt,
      };
      return alert;
    }).filter((a) => a.recipientCount > 0);

    for (const alert of alerts) {
      const valid = validateAlert(alert);
      if (!valid.valid) throw new Error(`generated an invalid alert: ${valid.errors.join('; ')}`);
    }
    return alerts;
  }
}

function severityFor(impactLevel) {
  if (impactLevel === 'critical') return 'critical';
  if (impactLevel === 'high') return 'high';
  if (impactLevel === 'medium') return 'medium';
  return 'low';
}

function buildMessage(job, result, audience) {
  const where = job.affectedLocationId ?? 'the affected area';
  const service = job.routeId ? `${job.transportMode} route ${job.routeId}` : job.transportMode;
  const cause = {
    breakdown: 'a vehicle breakdown',
    blocked: 'a blocked track segment',
    cancelled: 'a cancelled service',
    severeDelay: 'a severe delay',
    crowding: 'crowding',
  }[job.reason] ?? 'a service disruption';

  if (audience === 'passengers') {
    return `Delays on ${service} near ${where} due to ${cause}. `
      + `Next expected arrival in about ${Math.round(result.etaMinutes)} minutes.`;
  }
  if (audience === 'operators') {
    return `${service}: ${cause} affecting ${where}. Revised ETA ${result.etaMinutes} min `
      + `(impact ${result.impactLevel}).`;
  }
  if (audience === 'controlRoom') {
    return `Incident ${job.incidentId}: ${service} at ${where}, impact ${result.impactLevel}, `
      + `ETA ${result.etaMinutes} min, severity ${job.severity}.`;
  }
  return `Network impact report: ${service} at ${where} rated ${result.impactLevel} `
    + `(ETA ${result.etaMinutes} min) following ${cause}.`;
}

export default RouteImpactWorker;
