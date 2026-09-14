/** Matched HD AWS workload construction; no AWS SDK or network use. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { derivedId } from '@sit314/shared/util';
import { generateIncidentJobs } from '../../runner/job-generator.js';
import { canonicalTimestamp, logicalProjection } from '../../aws/workload.js';
import { createHdArrivalSchedule, validateHdWorkloadProfile } from '../workload-profile.js';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function loadHdAwsConfiguration(file) {
  const configPath = path.resolve(file instanceof URL ? fileURLToPath(file) : file);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.evidenceClassification !== 'HD PLANNED EXPERIMENT; NOT EXECUTED'
    || !['reactive', 'hybrid'].every((mode) => config.arms?.includes(mode))) {
    throw new Error('HD AWS configuration is not a matched planned study');
  }
  if (typeof config.profileFile !== 'string' || path.basename(config.profileFile) !== config.profileFile) {
    throw new Error('profileFile must be a same-directory basename');
  }
  const profile = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), config.profileFile), 'utf8'));
  validateHdWorkloadProfile(profile);
  for (const key of ['seed', 'repeatCount', 'sampleIntervalSeconds', 'drainDeadlineSeconds']) {
    if (!Number.isInteger(config[key]) || (key !== 'seed' && config[key] < 1)) {
      throw new Error(`${key} must be an explicit integer`);
    }
  }
  if (profile.worker.minTasks !== 1 || profile.worker.maxTasks !== 5
    || profile.worker.targetBacklogPerTask !== 75 || profile.worker.processingDelayMs !== 50
    || profile.worker.processingCpuIterations !== 0) {
    throw new Error('HD workload worker settings must match the final D reactive baseline');
  }
  return { config, profile };
}

export function createHdAwsWorkload({ config, profile, repeatNumber, executionNamespace }) {
  validateHdWorkloadProfile(profile);
  if (!Number.isInteger(repeatNumber) || repeatNumber < 1 || repeatNumber > config.repeatCount) {
    throw new Error('repeatNumber outside planned range');
  }
  if (typeof executionNamespace !== 'string' || !executionNamespace) throw new Error('fresh executionNamespace required');
  const schedule = createHdArrivalSchedule(profile);
  const canonicalCreatedAt = canonicalTimestamp(config.seed, repeatNumber);
  const logicalWorkloadId = derivedId('hd-workload', profile.name, String(config.seed),
    String(repeatNumber), String(schedule.incidents.length));
  const logicalJobs = [];
  const incidents = schedule.incidents.map((item) => {
    const canonical = generateIncidentJobs(profile.incident, item.sequence,
      `${logicalWorkloadId}-incident-${item.sequence}`, { createdAt: canonicalCreatedAt });
    logicalJobs.push(...canonical.map(logicalProjection));
    const jobs = canonical.map((job) => ({
      ...job,
      jobId: derivedId('job', executionNamespace, job.jobId),
      incidentId: derivedId('incident', executionNamespace, job.incidentId),
      sourceEventId: derivedId('event', executionNamespace, job.sourceEventId),
    }));
    return { ...item, sourceEventId: jobs[0]?.sourceEventId, jobs };
  });
  if (logicalJobs.length !== schedule.expectedJobs) throw new Error('HD fan-out count mismatch');
  return {
    stage: profile.name, workloadClass: profile.workloadClass,
    logicalWorkloadId, logicalDigest: digest(logicalJobs), executionNamespace,
    repeatNumber, seed: config.seed, canonicalCreatedAt,
    expectedAnalysisJobs: schedule.expectedJobs,
    incidentCount: incidents.length,
    sourceEventIds: incidents.map((incident) => incident.sourceEventId),
    warmupSeconds: profile.warmupSeconds,
    measurementPeriodSeconds: profile.measurementSeconds,
    scheduledArrivalSeconds: schedule.scheduledArrivalSeconds,
    processingCost: { processingDelayMs: profile.worker.processingDelayMs,
      processingCpuIterations: profile.worker.processingCpuIterations },
    incidents,
  };
}
