/** Formal AWS experiment orchestration, deliberately independent of local workers. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ARTIFACTS_DIR } from '@sit314/shared/config';
import { sleep as defaultSleep } from '@sit314/shared/util';
import { createAwsArtifactWriter } from './artifacts.js';
import { buildAwsSummary } from './summary.js';
import { createFormalWorkload, validateFormalStage } from './workload.js';

function asDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function runDirectory(outputDir, runId) {
  const directory = path.join(outputDir, runId);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function publicWorkload(workload) {
  return {
    logicalWorkloadId: workload.logicalWorkloadId,
    logicalDigest: workload.logicalDigest,
    executionNamespace: workload.executionNamespace,
    canonicalCreatedAt: workload.canonicalCreatedAt,
    repeatNumber: workload.repeatNumber,
    stage: workload.stage,
    seed: workload.seed,
    scenario: workload.scenario,
    incidentCount: workload.incidentCount,
    expectedAnalysisJobs: workload.expectedAnalysisJobs,
    sourceEventIds: workload.sourceEventIds,
    processingCost: workload.processingCost,
    warmupSeconds: workload.warmupSeconds,
    measurementPeriodSeconds: workload.measurementPeriodSeconds,
    drainDeadlineSeconds: workload.drainDeadlineSeconds,
    schedule: workload.incidents.map(({ sequence, scheduledOffsetSeconds, sourceEventId, jobs }) => ({
      sequence, scheduledOffsetSeconds, sourceEventId, expectedJobs: jobs.length,
    })),
  };
}

/**
 * `controller` is the only side-effect boundary. The real AWS control plane is
 * passed by the CLI; unit tests use a deterministic in-memory fake. No local
 * autoscaler or worker process exists in this execution path.
 */
export async function runAwsExperiment({
  stage,
  mode,
  repeatNumber,
  controller,
  outputDir = path.join(ARTIFACTS_DIR, 'aws-runs'),
  executionNamespace = `${mode}-${randomUUID()}`,
  now = () => new Date(),
  sleep = defaultSleep,
} = {}) {
  validateFormalStage(stage);
  if (!controller) throw new Error('AWS experiment requires a control-plane controller');
  if (!['fixed', 'autoscale'].includes(mode)) throw new Error('mode must be fixed or autoscale');
  if (!Number.isInteger(repeatNumber) || repeatNumber < 1 || repeatNumber > stage.repeatCount) {
    throw new Error(`repeatNumber must be between 1 and ${stage.repeatCount}`);
  }
  const workload = createFormalWorkload(stage, { repeatNumber, executionNamespace });
  const startedAt = asDate(now());
  const runId = `${startedAt.toISOString().replace(/[:.]/g, '-')}-${stage.name}-${mode}-r${repeatNumber}`;
  const writer = createAwsArtifactWriter(runDirectory(outputDir, runId));
  const manifest = {
    schemaVersion: 1,
    runId,
    startedAt: startedAt.toISOString(),
    mode,
    methodology: {
      countBounded: true,
      fixedCapacity: mode === 'fixed' ? { min: 1, max: 1, desired: 1 } : null,
      autoscaleCapacity: mode === 'autoscale' ? { min: 1, max: 5, desired: 1 } : null,
      noLocalConsumer: true,
    },
    workload: publicWorkload(workload),
  };
  writer.writeJson('manifest.json', manifest);

  await controller.configureCapacity(mode);
  await controller.verifyQueuesClean();
  manifest.processingCostVerified = await controller.verifyProcessingCost(workload.processingCost);
  manifest.startingState = await controller.waitForStartingState(mode);
  writer.writeJson('manifest.json', manifest);

  let jobsInjected = 0;
  const samples = [];
  const takeSample = async (phase) => {
    const sample = {
      ...(await controller.sample()),
      phase,
      jobsInjected,
      expectedJobs: workload.expectedAnalysisJobs,
    };
    samples.push(sample);
    writer.appendSample(sample);
    return sample;
  };
  await takeSample('starting-state');

  const startMilliseconds = startedAt.getTime();
  const waitUntilOffset = async (seconds) => {
    const remaining = startMilliseconds + seconds * 1000 - asDate(now()).getTime();
    if (remaining > 0) await sleep(remaining);
  };
  for (const incident of workload.incidents) {
    await waitUntilOffset(incident.scheduledOffsetSeconds);
    const sent = await controller.injectJobs(incident.jobs);
    if (sent !== incident.jobs.length) {
      throw new Error(`incident ${incident.sequence}: sent ${sent}/${incident.jobs.length} jobs`);
    }
    jobsInjected += sent;
    await takeSample(incident.scheduledOffsetSeconds < stage.warmupSeconds ? 'warmup' : 'measurement');
  }

  // The last scheduled arrival occurs one interval before the measurement
  // window closes; preserve that final interval instead of ending early.
  await waitUntilOffset(stage.warmupSeconds + stage.durationSeconds);
  await takeSample('measurement-complete');

  const drainStarted = asDate(now());
  const drainDeadline = drainStarted.getTime() + stage.drainDeadlineSeconds * 1000;
  let finalSample = samples.at(-1);
  while ((finalSample.queue?.visibleMessages ?? 0) + (finalSample.queue?.inFlightMessages ?? 0) > 0
    && asDate(now()).getTime() < drainDeadline) {
    await sleep(stage.sampleIntervalSeconds * 1000);
    finalSample = await takeSample('drain');
  }
  if (finalSample !== samples.at(-1)) finalSample = await takeSample('drain-final');
  const finishedAt = asDate(now()).toISOString();
  // CloudWatch Logs is eventually consistent. This collection grace is outside
  // the measured/drain window, so it never improves a reported throughput or
  // drain time; it only gives final worker events time to become queryable.
  await sleep(5000);
  const logCollectionAt = asDate(now()).toISOString();
  manifest.finishedAt = finishedAt;
  manifest.logCollectionAt = logCollectionAt;
  writer.writeJson('manifest.json', manifest);

  const [scalingActivities, resultCounts, workerLogs] = await Promise.all([
    controller.scalingActivities(),
    controller.resultsForSources(workload.sourceEventIds, workload.expectedAnalysisJobs),
    controller.workerLogs({ startedAt: manifest.startedAt, finishedAt: logCollectionAt }),
  ]);
  const accounting = {
    ...resultCounts,
    drainTimeSeconds: Math.max(0, (Date.parse(finishedAt) - drainStarted.getTime()) / 1000),
    drainTimedOut: (finalSample.queue?.visibleMessages ?? 0) + (finalSample.queue?.inFlightMessages ?? 0) > 0,
  };
  writer.writeJson('scaling-activities.json', scalingActivities);
  writer.writeLogReference(controller.logReferences({
    startedAt: manifest.startedAt, finishedAt: logCollectionAt, measurementFinishedAt: finishedAt,
  }));
  for (const event of workerLogs) writer.appendLogEvent(event);
  const summary = buildAwsSummary({
    manifest,
    samples,
    scalingActivities,
    accounting,
    workerLogs,
    finishedAt,
  });
  summary.accounting = accounting;
  summary.artifacts = { runDirectory: writer.runDir, samples: writer.samplesPath };
  writer.writeJson('summary.json', summary);
  return { runDir: writer.runDir, manifest, samples, summary };
}

export { publicWorkload };
