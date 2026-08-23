/**
 * Analysis-job workload generator for incident experiments.
 *
 * WHAT IT DOES
 * Produces exactly the job set an incident of the configured size would produce,
 * using the SAME fan-out code the telemetry processor uses. It does not
 * reimplement the fan-out - it builds a synthetic normalised event of the right
 * shape and calls buildAnalysisJobs(), so the experiment workload and the
 * production workload cannot diverge.
 *
 * WHY IT EXISTS
 * The incident experiment measures the route-impact worker, not the ingestion
 * path. Injecting jobs straight onto the analysis queue lets each stage deliver
 * a precise, repeatable number of jobs (50 / 250 / 750 / 1500 per incident)
 * without depending on MQTT timing or on the simulator's random walk.
 */
import { buildAnalysisJobs } from '@sit314/telemetry-processor/disruption';

/**
 * Builds a normalised event that will fan out to the requested size.
 *
 * `runId` is part of the event id on purpose. Job ids are DERIVED from the
 * source event id, and the workers suppress a jobId they have already seen.
 * Without the run id, the second run of a stage would be recognised as a
 * duplicate of the first and would do no work at all - which is correct
 * idempotency behaviour, but useless as an experiment. Including the run id
 * keeps the workload identical in size, shape and distribution while making it
 * genuinely new work each run.
 */
export function syntheticIncidentEvent(incident, sequence, runId = 'adhoc') {
  const mode = incident.transportMode === 'multimodal' ? 'train' : incident.transportMode;
  return {
    schemaVersion: '1.0',
    eventId: `evt-exp-${runId}-${incident.scenario}-${String(sequence).padStart(6, '0')}`,
    sourceEventType: 'telemetry',
    transportMode: mode,
    entityId: incident.vehicleId,
    serviceId: `SERVICE-${incident.routeId}`,
    routeId: incident.routeId,
    routeIds: [incident.routeId],
    locationId: incident.anchorLocationId || `${incident.routeId}-ORIGIN`,
    locationType: null,
    timestamp: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    position: { latitude: -37.818, longitude: 145.119 },
    metrics: {
      speedKph: 0,
      occupancy: 60,
      capacity: 60,
      delaySeconds: 1800,
    },
    health: incident.reason === 'breakdown' ? 'breakdown'
      : (incident.reason === 'blocked' ? 'blocked' : 'cancelled'),
    demandLevel: null,
    modeData: {},
    validation: { validatedBy: 'experiment-runner', branch: mode },
  };
}

/**
 * Generate one incident's worth of analysis jobs at exactly the configured size.
 * @param {object} incident stage config `incident` block
 * @param {number} sequence incident number within the run
 * @returns {object[]} analysis jobs
 */
export function generateIncidentJobs(incident, sequence, runId = 'adhoc') {
  const event = syntheticIncidentEvent(incident, sequence, runId);
  const evaluation = {
    isIncident: true,
    reason: incident.reason,
    severity: incident.severity,
    crowding: 'critical',
    occupancyRatio: 1,
    delaySeconds: 1800,
  };
  // Override the configured fan-out so the stage size is exact.
  const fanout = {
    [event.transportMode]: {
      affectedLocations: incident.affectedLocations,
      targetJobs: incident.jobsPerIncident,
      targetNotifications: incident.notificationsPerIncident,
    },
  };
  const { jobs } = buildAnalysisJobs(event, evaluation, { fanout });
  return jobs;
}

export default generateIncidentJobs;
