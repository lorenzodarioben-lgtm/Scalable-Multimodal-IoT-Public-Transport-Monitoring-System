/**
 * Telemetry processor - business logic.
 *
 * WHAT IT DOES
 * For each normalised event taken from the telemetry queue:
 *   1. validate defensively,
 *   2. claim the eventId in ProcessedEvents with a conditional write
 *      (attribute_not_exists) - a duplicate stops here,
 *   3. update CurrentState, refusing to overwrite newer state,
 *   4. evaluate delay / crowding / health,
 *   5. if it is an incident, fan it out into many independent analysis jobs,
 *   6. publish those jobs to the analysis queue.
 *
 * WHY IDEMPOTENCY IS REQUIRED
 * SQS gives at-least-once delivery: a message WILL occasionally be delivered
 * twice (visibility timeout expiry, a worker dying after processing but before
 * deleting, a retry after a transient error). Without a guard, one bus
 * breakdown delivered twice would create 100 analysis jobs instead of 50 and
 * double every downstream result. The conditional write on eventId is what
 * makes retries safe, and safe retries are what make the DLQ policy and
 * autoscaling acceptable in the first place.
 *
 * Input:  normalised event (schemas/normalized-event.schema.json)
 * Output: 0..n analysis jobs (schemas/analysis-job.schema.json) on the
 *         analysis queue, plus DynamoDB state.
 */
import { FAILURE_INJECTION, TABLES, THRESHOLDS } from '@sit314/shared/config';
import { validateNormalized } from '@sit314/shared/validation';
import { nowIso } from '@sit314/shared/util';
import { buildAnalysisJobs, evaluateEvent } from './disruption.js';

export class TelemetryProcessor {
  /**
   * @param {object} deps
   * @param {object} deps.store        store adapter (DynamoDB or local)
   * @param {object} deps.analysisQueue queue handle for analysis jobs
   * @param {object} deps.logger
   * @param {object} [deps.thresholds]
   * @param {object} [deps.failureInjection]
   * @param {() => number} [deps.random] injectable for deterministic tests
   */
  constructor({
    store,
    analysisQueue,
    logger,
    thresholds = THRESHOLDS,
    failureInjection = FAILURE_INJECTION,
    random = Math.random,
  }) {
    this.store = store;
    this.analysisQueue = analysisQueue;
    this.logger = logger;
    this.thresholds = thresholds;
    this.failureInjection = failureInjection;
    this.random = random;
    this.counters = {
      stored: 0,
      duplicates: 0,
      staleSkipped: 0,
      incidents: 0,
      jobsPublished: 0,
      invalid: 0,
    };
  }

  /** Deliberate, opt-in failure used to demonstrate retry and DLQ behaviour. */
  #maybeInjectFailure(stage) {
    if (!this.failureInjection.enabled) return;
    if (this.random() < this.failureInjection.rate) {
      const err = new Error(`injected failure at ${stage}`);
      err.injected = true;
      throw err;
    }
  }

  /**
   * Handle one normalised event.
   * @returns {Promise<{duplicate?: boolean, incident?: boolean, jobs?: number}>}
   */
  async handle(event) {
    const check = validateNormalized(event);
    if (!check.valid) {
      this.counters.invalid += 1;
      // Structurally invalid input is not retryable - throwing sends it to the
      // DLQ after the configured attempts rather than looping forever.
      const err = new Error(`normalised event failed validation: ${check.errors.slice(0, 3).join('; ')}`);
      err.nonRetryable = true;
      throw err;
    }

    this.#maybeInjectFailure('beforeIdempotencyClaim');

    // ---- 1. Idempotency claim -------------------------------------------
    // attribute_not_exists(eventId): the first writer wins, everyone else is a
    // duplicate and must not create downstream work.
    const claim = await this.store.putIfAbsent(TABLES.processedEvents, {
      eventId: event.eventId,
      processedAt: nowIso(),
      transportMode: event.transportMode,
      entityId: event.entityId,
      sourceTimestamp: event.timestamp,
      // TTL attribute so DynamoDB can expire old idempotency records itself.
      expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    });

    if (!claim.written) {
      this.counters.duplicates += 1;
      this.logger.info('DUPLICATE_SKIPPED', { eventId: event.eventId },
        `[DUPLICATE_SKIPPED] eventId=${event.eventId}`);
      return { duplicate: true };
    }

    // ---- 2. Current state, guarded against out-of-order delivery ---------
    const evaluation = evaluateEvent(event, this.thresholds);
    const stateItem = {
      entityId: event.entityId,
      transportMode: event.transportMode,
      routeId: event.routeId,
      serviceId: event.serviceId,
      locationId: event.locationId,
      timestamp: event.timestamp,
      receivedAt: event.receivedAt,
      lastEventId: event.eventId,
      health: event.health,
      metrics: event.metrics,
      position: event.position,
      modeData: event.modeData,
      demandLevel: event.demandLevel,
      occupancyRatio: evaluation.occupancyRatio,
      crowdingLevel: evaluation.crowding,
      updatedAt: nowIso(),
    };

    const stateWrite = await this.store.putIfNewer(TABLES.currentState, stateItem, 'timestamp');
    if (!stateWrite.written) {
      this.counters.staleSkipped += 1;
      this.logger.info('STALE_STATE_SKIPPED', {
        entityId: event.entityId, eventId: event.eventId, timestamp: event.timestamp,
      }, `[STALE_STATE_SKIPPED] entity=${event.entityId} eventTimestamp=${event.timestamp} `
        + '(newer state already stored)');
    } else {
      this.counters.stored += 1;
      this.logger.info('TELEMETRY', {
        eventId: event.eventId, entityId: event.entityId, mode: event.transportMode,
      }, `[TELEMETRY] event=${event.eventId} entity=${event.entityId} `
        + `mode=${event.transportMode} crowding=${evaluation.crowding ?? 'n/a'} status=stored`);
    }

    // ---- 3. Incident detection and fan-out ------------------------------
    if (!evaluation.isIncident) return { duplicate: false, incident: false, jobs: 0 };

    this.#maybeInjectFailure('beforeFanout');

    const { incidentId, jobs, locations } = buildAnalysisJobs(event, evaluation);
    const published = await this.#publishJobs(jobs);

    this.counters.incidents += 1;
    this.counters.jobsPublished += published;

    this.logger.block('INCIDENT_DETECTED', {
      incidentId,
      sourceEventId: event.eventId,
      mode: event.transportMode,
      entity: event.entityId,
      route: event.routeId,
      reason: evaluation.reason,
      severity: evaluation.severity,
      affectedLocations: locations.length,
      analysisJobs: published,
      notifications: jobs.reduce((sum, j) => sum + j.notificationFanout, 0),
    });

    return { duplicate: false, incident: true, jobs: published, incidentId };
  }

  /** Batched publish so a 1500-job fan-out is not 1500 round trips. */
  async #publishJobs(jobs) {
    if (!jobs.length) return 0;
    const result = await this.analysisQueue.sendMessageBatch(jobs);
    if (result.failed > 0) {
      // Throwing here means the source message is not deleted and the whole
      // event is retried. The derived job ids make that safe.
      throw new Error(`${result.failed} analysis jobs failed to enqueue`);
    }
    return result.successful ?? jobs.length;
  }
}

export default TelemetryProcessor;
