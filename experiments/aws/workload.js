/**
 * Deterministic, count-bounded workload construction for the formal AWS study.
 *
 * A logical workload is shared by the fixed and autoscaled arms. Its execution
 * namespace is deliberately different per arm so DynamoDB idempotency cannot
 * suppress the second arm. Business fields, canonical timestamps and fan-out
 * remain identical; only the delivery/idempotency identifiers differ.
 */
import { createHash } from 'node:crypto';
import { derivedId } from '@sit314/shared/util';
import { generateIncidentJobs } from '../runner/job-generator.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

/** Number of arrivals scheduled in the warm-up plus measurement window. */
export function expectedIncidentCount(stage) {
  const interval = Number(stage?.arrival?.incidentIntervalSeconds);
  const total = Number(stage?.warmupSeconds) + Number(stage?.durationSeconds);
  if (!Number.isFinite(interval) || interval <= 0) throw new Error('incidentIntervalSeconds must be positive');
  if (!Number.isFinite(total) || total <= 0) throw new Error('warmupSeconds + durationSeconds must be positive');
  return Math.ceil(total / interval);
}

export function validateFormalStage(stage) {
  if (stage?.type !== 'incident') throw new Error('formal AWS runner only supports incident stages');
  if (stage?.arrival?.mode !== 'count-bounded') {
    throw new Error('formal AWS runner requires arrival.mode="count-bounded"');
  }
  const incidents = positiveInteger(stage?.arrival?.incidents, 'arrival.incidents');
  const expected = expectedIncidentCount(stage);
  if (incidents !== expected) {
    throw new Error(`arrival.incidents must be ${expected} for the configured warm-up and measurement period, got ${incidents}`);
  }
  positiveInteger(stage?.incident?.jobsPerIncident, 'incident.jobsPerIncident');
  positiveInteger(stage?.repeatCount, 'repeatCount');
  positiveInteger(stage?.drainDeadlineSeconds, 'drainDeadlineSeconds');
  positiveInteger(stage?.sampleIntervalSeconds, 'sampleIntervalSeconds');
  if (!Number.isInteger(stage?.seed)) throw new Error('seed must be an integer');
  if (!Number.isFinite(stage?.worker?.processingDelayMs) || stage.worker.processingDelayMs < 0) {
    throw new Error('worker.processingDelayMs must be an explicit non-negative number');
  }
  if (stage?.worker?.processingCpuIterations !== 0) {
    throw new Error('formal AWS runner requires worker.processingCpuIterations=0');
  }
  return stage;
}

/** A stable timestamp makes canonical jobs identical across execution arms. */
export function canonicalTimestamp(seed, repeatNumber) {
  positiveInteger(repeatNumber, 'repeatNumber');
  const seconds = ((Math.abs(seed) % 31_536_000) + (repeatNumber - 1) * 86_400);
  return new Date(Date.UTC(2024, 0, 1) + seconds * 1000).toISOString();
}

function logicalProjection(job) {
  const { jobId, incidentId, sourceEventId, ...logical } = job;
  return logical;
}

/**
 * Builds a formal workload. executionNamespace must be unique for each arm;
 * logicalWorkloadId is intentionally identical for the same stage/seed/repeat.
 */
export function createFormalWorkload(stage, {
  repeatNumber,
  executionNamespace,
} = {}) {
  validateFormalStage(stage);
  positiveInteger(repeatNumber, 'repeatNumber');
  if (!executionNamespace || typeof executionNamespace !== 'string') {
    throw new Error('executionNamespace is required to prevent cross-run idempotency suppression');
  }

  const canonicalCreatedAt = canonicalTimestamp(stage.seed, repeatNumber);
  const logicalWorkloadId = derivedId(
    'workload', stage.name, String(stage.seed), String(repeatNumber), String(stage.arrival.incidents),
  );
  const incidents = [];
  const logicalJobs = [];

  for (let sequence = 1; sequence <= stage.arrival.incidents; sequence += 1) {
    const canonicalNamespace = `${logicalWorkloadId}-incident-${sequence}`;
    const canonicalJobs = generateIncidentJobs(stage.incident, sequence, canonicalNamespace, {
      createdAt: canonicalCreatedAt,
    });
    const jobs = canonicalJobs.map((job) => ({
      ...job,
      // These three fields are execution identities. Changing them permits a
      // repeat/other arm to do real work while leaving business work unchanged.
      jobId: derivedId('job', executionNamespace, job.jobId),
      incidentId: derivedId('incident', executionNamespace, job.incidentId),
      sourceEventId: derivedId('event', executionNamespace, job.sourceEventId),
    }));
    incidents.push({
      sequence,
      scheduledOffsetSeconds: (sequence - 1) * stage.arrival.incidentIntervalSeconds,
      sourceEventId: jobs[0]?.sourceEventId ?? null,
      jobs,
    });
    logicalJobs.push(...canonicalJobs.map(logicalProjection));
  }

  const expectedAnalysisJobs = stage.arrival.incidents * stage.incident.jobsPerIncident;
  if (logicalJobs.length !== expectedAnalysisJobs) {
    throw new Error(`workload generated ${logicalJobs.length} jobs; expected ${expectedAnalysisJobs}`);
  }

  const processingCost = {
    processingDelayMs: Number(stage.worker?.processingDelayMs ?? 0),
    // CPU iterations remain a local-harness calibration parameter. Formal AWS
    // stages explicitly record zero unless the approved stage is changed later.
    processingCpuIterations: Number(stage.worker?.processingCpuIterations ?? 0),
  };
  const logicalDigest = hash(JSON.stringify(logicalJobs));

  return {
    logicalWorkloadId,
    logicalDigest,
    executionNamespace,
    canonicalCreatedAt,
    repeatNumber,
    stage: stage.name,
    seed: stage.seed,
    scenario: stage.incident.scenario,
    incidentCount: stage.arrival.incidents,
    expectedAnalysisJobs,
    sourceEventIds: incidents.map((incident) => incident.sourceEventId),
    processingCost,
    warmupSeconds: stage.warmupSeconds,
    measurementPeriodSeconds: stage.durationSeconds,
    drainDeadlineSeconds: stage.drainDeadlineSeconds,
    incidents,
  };
}

export { logicalProjection };
