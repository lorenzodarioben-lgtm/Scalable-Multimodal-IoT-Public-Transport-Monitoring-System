/**
 * Disruption detection and analysis-job fan-out.
 *
 * WHAT THIS DOES
 * Given one normalised event, decide whether it represents an operational
 * incident, and if so decompose that incident into many INDEPENDENT
 * route-impact jobs.
 *
 * WHY FAN-OUT MATTERS (this is the heart of the scalability argument)
 * A single bus breakdown is one event, but its consequences are not. Every
 * downstream stop needs its own recalculated arrival estimate, and each of
 * those calculations depends only on the incident context - not on the result
 * of any other calculation. Because the jobs are independent:
 *   - they can be placed on a queue and consumed in any order,
 *   - any number of workers can process them concurrently without coordination,
 *   - adding workers increases throughput almost linearly,
 *   - a worker that dies mid-job costs one job, not the whole incident.
 * That is precisely the property Application Auto Scaling exploits: backlog
 * grows, more tasks start, backlog drains.
 *
 * Detection rules are deliberately simple and explainable:
 *   bus   health = breakdown  -> incident
 *   tram  health = blocked    -> incident
 *   train health = cancelled  -> incident
 *   any   delaySeconds >= SEVERE_DELAY_SECONDS -> incident
 *   any   crowding at or above CROWDING_INCIDENT_LEVEL -> incident
 * All thresholds come from configuration (shared/config).
 */
import { FANOUT, THRESHOLDS } from '@sit314/shared/config';
import { crowdingLevel, occupancyRatio } from '@sit314/shared/validation';
import { derivedId } from '@sit314/shared/util';

/** Hard failure state per mode. A tram cannot "break down"; it is "blocked". */
export const FAILURE_STATE = { bus: 'breakdown', tram: 'blocked', train: 'cancelled' };

const CROWDING_ORDER = ['normal', 'moderate', 'high', 'critical'];

/**
 * Classify one normalised event.
 * @returns {{isIncident: boolean, reason: string|null, severity: string,
 *            crowding: string|null, occupancyRatio: number|null, delaySeconds: number|null}}
 */
export function evaluateEvent(event, thresholds = THRESHOLDS) {
  const metrics = event.metrics || {};
  const ratio = occupancyRatio(metrics.occupancy, metrics.capacity);
  const crowding = crowdingLevel(metrics.occupancy, metrics.capacity, thresholds.crowding);
  const delaySeconds = Number.isFinite(metrics.delaySeconds) ? metrics.delaySeconds : null;

  // 1. Hard failure states are always incidents, and always the most severe.
  const failureState = FAILURE_STATE[event.transportMode];
  if (failureState && event.health === failureState) {
    return {
      isIncident: true,
      reason: failureState,
      severity: event.transportMode === 'train' ? 'critical' : 'high',
      crowding,
      occupancyRatio: ratio,
      delaySeconds,
    };
  }

  // 2. Excessive delay, regardless of the reported health state.
  if (delaySeconds !== null && delaySeconds >= thresholds.severeDelaySeconds) {
    return {
      isIncident: true,
      reason: 'severeDelay',
      severity: delaySeconds >= thresholds.majorDelaySeconds ? 'high' : 'medium',
      crowding,
      occupancyRatio: ratio,
      delaySeconds,
    };
  }

  // 3. Crowding, but only at or above the configured level. Without this guard
  //    a busy peak hour would raise an incident for every full vehicle.
  if (crowding
    && CROWDING_ORDER.indexOf(crowding)
      >= CROWDING_ORDER.indexOf(thresholds.crowdingIncidentLevel)) {
    return {
      isIncident: true,
      reason: 'crowding',
      severity: crowding === 'critical' ? 'medium' : 'low',
      crowding,
      occupancyRatio: ratio,
      delaySeconds,
    };
  }

  return { isIncident: false, reason: null, severity: 'low', crowding, occupancyRatio: ratio, delaySeconds };
}

/** Fan-out profile for an incident: how wide is the blast radius? */
export function fanoutProfileFor(event, evaluation, fanout = FANOUT) {
  if (evaluation.reason === 'severeDelay' || evaluation.reason === 'crowding') return fanout.delay;
  return fanout[event.transportMode] ?? fanout.delay;
}

/**
 * Spread `total` items across `buckets` as evenly as possible.
 * Used so a stage that asks for 5000 notifications across 750 jobs produces
 * exactly 5000, not 750 x round(6.67).
 */
export function distribute(total, buckets) {
  if (buckets <= 0) return [];
  const base = Math.floor(total / buckets);
  const remainder = total % buckets;
  return Array.from({ length: buckets }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * Affected locations for an incident. Uses whatever route context the event
 * carries; when the processor has no network map it synthesises stable,
 * deterministic location ids from the route id so results stay reproducible.
 */
export function affectedLocations(event, count) {
  const mode = event.transportMode;
  const prefix = mode === 'train' ? 'STATION' : (mode === 'tram' ? 'TRAM-STOP' : 'BUS-STOP');
  const anchor = event.locationId || event.modeData?.nextStopId
    || event.modeData?.nextStationId || `${prefix}-000`;
  const locations = [anchor];
  for (let i = 1; i < count; i += 1) {
    // Deterministic downstream stop identifiers derived from the route, so the
    // same incident always produces the same job set.
    locations.push(`${prefix}-${event.routeId ?? 'NA'}-D${String(i).padStart(3, '0')}`);
  }
  return locations.slice(0, count);
}

/**
 * Decompose one incident into independent analysis jobs.
 *
 * Every job id is DERIVED from (sourceEventId, location, index) rather than
 * random, so redelivery of the same telemetry event produces the same job ids.
 * Combined with the conditional write on jobId, that makes the whole fan-out
 * idempotent: a retried event cannot double the workload.
 *
 * @returns {{incidentId: string, jobs: object[]}}
 */
export function buildAnalysisJobs(event, evaluation, options = {}) {
  const fanout = options.fanout || FANOUT;
  const profile = fanoutProfileFor(event, evaluation, fanout);
  const createdAt = options.createdAt || new Date().toISOString();
  const incidentId = derivedId('incident', event.eventId, evaluation.reason);

  const locationCount = Math.max(1, profile.affectedLocations);
  const locations = affectedLocations(event, locationCount);
  const jobsPerLocation = distribute(profile.targetJobs, locationCount);
  const totalJobs = jobsPerLocation.reduce((a, b) => a + b, 0);
  const notificationsPerJob = distribute(profile.targetNotifications, totalJobs);

  const jobs = [];
  let jobIndex = 0;
  locations.forEach((locationId, locationIndex) => {
    for (let i = 0; i < jobsPerLocation[locationIndex]; i += 1) {
      jobs.push({
        jobId: derivedId('job', event.eventId, locationId, String(i)),
        incidentId,
        sourceEventId: event.eventId,
        transportMode: event.transportMode === 'demand' ? 'bus' : event.transportMode,
        vehicleId: event.entityId ?? null,
        routeId: event.routeId ?? null,
        affectedLocationId: locationId,
        hopsFromIncident: locationIndex,
        taskType: 'routeImpactEta',
        priority: severityToPriority(evaluation.severity),
        reason: evaluation.reason,
        severity: evaluation.severity,
        context: {
          delaySeconds: evaluation.delaySeconds,
          occupancyRatio: evaluation.occupancyRatio === null
            ? null : Number(evaluation.occupancyRatio.toFixed(4)),
          crowdingLevel: evaluation.crowding,
          direction: event.modeData?.direction ?? null,
          segmentId: event.modeData?.trackSegmentId ?? event.modeData?.roadSegmentId ?? null,
        },
        notificationFanout: notificationsPerJob[jobIndex] ?? 0,
        createdAt,
      });
      jobIndex += 1;
    }
  });

  return { incidentId, jobs, locations };
}

function severityToPriority(severity) {
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'high';
  if (severity === 'medium') return 'normal';
  return 'low';
}
