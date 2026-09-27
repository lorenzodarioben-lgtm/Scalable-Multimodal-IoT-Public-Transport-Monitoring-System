/** Formal AWS experiment orchestration, deliberately independent of local workers. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ARTIFACTS_DIR } from '@sit314/shared/config';
import { mean, percentile, round, sleep as defaultSleep } from '@sit314/shared/util';
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

function injectionTimingGuard(stage) {
  const intervalMs = Number(stage.arrival.incidentIntervalSeconds) * 1000;
  const configured = stage.timingGuard ?? {};
  const maxDispatchStartLagIntervals = Number(configured.maxDispatchStartLagIntervals ?? 1);
  const sustainedStartLagIntervals = Number(configured.sustainedStartLagIntervals ?? 0.5);
  const sustainedStartLagIncidents = Number(configured.sustainedStartLagIncidents ?? 3);
  if (!Number.isFinite(maxDispatchStartLagIntervals) || maxDispatchStartLagIntervals <= 0
    || !Number.isFinite(sustainedStartLagIntervals) || sustainedStartLagIntervals <= 0
    || !Number.isInteger(sustainedStartLagIncidents) || sustainedStartLagIncidents < 1) {
    throw new Error('timingGuard values must be positive');
  }
  return {
    intervalMs,
    maxDispatchStartLagMs: intervalMs * maxDispatchStartLagIntervals,
    sustainedStartLagMs: intervalMs * sustainedStartLagIntervals,
    sustainedStartLagIncidents,
    maxDispatchStartLagIntervals,
    sustainedStartLagIntervals,
  };
}

function injectionTimingSummary({ workloadStartedAt, workload, guard, dispatches, status, invalidReason = null }) {
  const startMs = Date.parse(workloadStartedAt);
  const completedAt = dispatches.reduce((latest, dispatch) => (
    !dispatch.actualDispatchCompletedAt || (latest
      && Date.parse(latest) >= Date.parse(dispatch.actualDispatchCompletedAt))
      ? latest : dispatch.actualDispatchCompletedAt
  ), null);
  const actualDurationMs = completedAt ? Math.max(0, Date.parse(completedAt) - startMs) : null;
  const scheduleLags = dispatches
    .map((dispatch) => dispatch.scheduleLagMs)
    .filter((lag) => Number.isFinite(lag));
  const submittedJobs = dispatches.reduce((total, dispatch) => total + (dispatch.submittedJobs ?? 0), 0);
  return {
    status,
    invalidReason,
    workloadStartedAt,
    plannedInjectionDurationSeconds: workload.incidentCount * guard.intervalMs / 1000,
    actualInjectionDurationSeconds: actualDurationMs === null ? null : round(actualDurationMs / 1000, 3),
    expectedIncidents: workload.incidentCount,
    dispatchedIncidents: dispatches.filter((dispatch) => dispatch.actualDispatchCompletedAt).length,
    expectedJobs: workload.expectedAnalysisJobs,
    submittedJobs,
    effectiveSubmissionJobsPerSecond: actualDurationMs && actualDurationMs > 0
      ? round(submittedJobs / (actualDurationMs / 1000), 3) : null,
    meanScheduleLagMs: round(mean(scheduleLags), 3),
    p95ScheduleLagMs: round(percentile(scheduleLags, 95), 3),
    maxScheduleLagMs: round(scheduleLags.length ? Math.max(...scheduleLags) : null, 3),
    guard: {
      maxDispatchStartLagMs: guard.maxDispatchStartLagMs,
      sustainedStartLagMs: guard.sustainedStartLagMs,
      sustainedStartLagIncidents: guard.sustainedStartLagIncidents,
    },
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
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
} = {}) {
  validateFormalStage(stage);
  if (!controller) throw new Error('AWS experiment requires a control-plane controller');
  if (!['fixed', 'autoscale'].includes(mode)) throw new Error('mode must be fixed or autoscale');
  if (!Number.isInteger(repeatNumber) || repeatNumber < 1 || repeatNumber > stage.repeatCount) {
    throw new Error(`repeatNumber must be between 1 and ${stage.repeatCount}`);
  }
  const workload = createFormalWorkload(stage, { repeatNumber, executionNamespace });
  const orchestrationStartedAt = asDate(now());
  const runId = `${orchestrationStartedAt.toISOString().replace(/[:.]/g, '-')}-${stage.name}-${mode}-r${repeatNumber}`;
  const writer = createAwsArtifactWriter(runDirectory(outputDir, runId));
  const manifest = {
    schemaVersion: 1,
    runId,
    // `startedAt` remains the workload epoch for backwards-compatible
    // summaries. Keep orchestration and workload timing distinct so an ECS
    // readiness wait can never silently consume warm-up time.
    orchestrationStartedAt: orchestrationStartedAt.toISOString(),
    startedAt: null,
    workloadStartedAt: null,
    measurementStartedAt: null,
    workloadCompletedAt: null,
    drainStartedAt: null,
    drainCompletedAt: null,
    mode,
    methodology: {
      evidenceClassification: stage.evidenceClassification ?? { status: 'FORMAL EVIDENCE' },
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
  manifest.workerStartup = await controller.waitForWorkerReady();
  manifest.preflightCompletedAt = asDate(now()).toISOString();
  writer.writeJson('manifest.json', manifest);

  let jobsInjected = 0;
  const samples = [];
  const takeSample = async (phase, { shouldRecord = () => true } = {}) => {
    const sample = {
      ...(await controller.sample()),
      phase,
      jobsInjected,
      expectedJobs: workload.expectedAnalysisJobs,
    };
    if (!shouldRecord()) return null;
    samples.push(sample);
    writer.appendSample(sample);
    return sample;
  };

  // This sample is deliberately outside the workload clock. It records the
  // post-preflight state without shortening the configured warm-up interval.
  await takeSample('preflight-ready');

  // All workload offsets, including the 30-second warm-up, are measured from
  // this epoch only after capacity and the exact ECS-task readiness check pass.
  const workloadStartedAt = asDate(now());
  const measurementStartedAt = new Date(
    workloadStartedAt.getTime() + stage.warmupSeconds * 1000,
  );
  manifest.startedAt = workloadStartedAt.toISOString();
  manifest.workloadStartedAt = workloadStartedAt.toISOString();
  manifest.measurementStartedAt = measurementStartedAt.toISOString();
  writer.writeJson('manifest.json', manifest);

  const startMilliseconds = workloadStartedAt.getTime();
  const waitUntilOffset = async (seconds) => {
    const remaining = startMilliseconds + seconds * 1000 - asDate(now()).getTime();
    if (remaining > 0) await sleep(remaining);
  };
  const timingGuard = injectionTimingGuard(stage);
  const dispatches = [];
  let consecutiveSustainedLaggedDispatches = 0;
  let timingInvalidReason = null;
  let dispatchFailure = null;
  const inFlightDispatches = [];
  const persistInjectionTiming = (status, invalidReason = null) => {
    const timing = injectionTimingSummary({
      workloadStartedAt: manifest.workloadStartedAt,
      workload,
      guard: timingGuard,
      dispatches,
      status,
      invalidReason,
    });
    manifest.injectionTiming = timing;
    writer.writeJson('injection-timing.json', timing);
    writer.writeJson('manifest.json', manifest);
    return timing;
  };

  // Sampling runs independently. A slow SQS/ECS observation cannot delay a
  // scheduled SQS arrival; stale in-flight samples are simply not recorded
  // after the timer stops at the measurement boundary.
  let samplerActive = false;
  let samplerInFlight = false;
  let samplerFailure = null;
  let samplerTimer = null;
  const phaseAt = () => (asDate(now()).getTime() < measurementStartedAt.getTime() ? 'warmup' : 'measurement');
  const sampleIndependently = () => {
    if (!samplerActive || samplerInFlight) return;
    samplerInFlight = true;
    void (async () => {
      try {
        await takeSample(phaseAt(), { shouldRecord: () => samplerActive });
      } catch (error) {
        samplerFailure = error;
      } finally {
        samplerInFlight = false;
      }
    })();
  };
  const startIndependentSampling = () => {
    samplerActive = true;
    samplerTimer = setIntervalFn(sampleIndependently, stage.sampleIntervalSeconds * 1000);
  };
  const stopIndependentSampling = () => {
    samplerActive = false;
    if (samplerTimer !== null) clearIntervalFn(samplerTimer);
    samplerTimer = null;
  };
  const throwIfSamplerFailed = () => {
    if (samplerFailure) throw new Error(`independent telemetry sampling failed: ${samplerFailure.message}`);
  };
  const markTimingInvalid = (reason) => {
    timingInvalidReason = reason;
    persistInjectionTiming('TIMING-INVALID', reason);
  };

  persistInjectionTiming('RUNNING');
  startIndependentSampling();
  try {
    for (const incident of workload.incidents) {
      await waitUntilOffset(incident.scheduledOffsetSeconds);
      throwIfSamplerFailed();
      if (dispatchFailure) throw dispatchFailure;
      const scheduledDispatchMs = startMilliseconds + incident.scheduledOffsetSeconds * 1000;
      const actualDispatchStartedAt = asDate(now());
      const scheduleLagMs = Math.max(0, actualDispatchStartedAt.getTime() - scheduledDispatchMs);
      const dispatch = {
        sequence: incident.sequence,
        expectedJobs: incident.jobs.length,
        scheduledDispatchAt: new Date(scheduledDispatchMs).toISOString(),
        actualDispatchStartedAt: actualDispatchStartedAt.toISOString(),
        actualDispatchCompletedAt: null,
        scheduleLagMs,
        completionScheduleLagMs: null,
        dispatchDurationMs: null,
        submittedJobs: 0,
      };

      if (scheduleLagMs >= timingGuard.maxDispatchStartLagMs) {
        dispatch.status = 'not-submitted-schedule-lag';
        dispatches.push(dispatch);
        writer.appendDispatch(dispatch);
        markTimingInvalid(
          `incident ${incident.sequence} dispatch started ${scheduleLagMs}ms late; maximum is ${timingGuard.maxDispatchStartLagMs}ms`,
        );
        break;
      }

      consecutiveSustainedLaggedDispatches = scheduleLagMs >= timingGuard.sustainedStartLagMs
        ? consecutiveSustainedLaggedDispatches + 1 : 0;
      if (consecutiveSustainedLaggedDispatches >= timingGuard.sustainedStartLagIncidents) {
        dispatch.status = 'not-submitted-sustained-schedule-lag';
        dispatches.push(dispatch);
        writer.appendDispatch(dispatch);
        markTimingInvalid(
          `${consecutiveSustainedLaggedDispatches} consecutive dispatches started at least ${timingGuard.sustainedStartLagMs}ms late`,
        );
        break;
      }

      // Do not await this dispatch in the scheduler. Its five SQS batches may
      // take longer than an interval during connection setup, but later
      // incidents must still begin at their own epoch-derived offsets.
      dispatch.status = 'dispatching';
      dispatches.push(dispatch);
      writer.appendDispatch(dispatch);
      const inFlight = (async () => {
        try {
          const sent = await controller.injectJobs(incident.jobs);
          const actualDispatchCompletedAt = asDate(now());
          dispatch.actualDispatchCompletedAt = actualDispatchCompletedAt.toISOString();
          dispatch.dispatchDurationMs = actualDispatchCompletedAt.getTime() - actualDispatchStartedAt.getTime();
          dispatch.completionScheduleLagMs = Math.max(0, actualDispatchCompletedAt.getTime() - scheduledDispatchMs);
          dispatch.submittedJobs = sent;
          dispatch.status = sent === incident.jobs.length ? 'submitted' : 'incomplete';
          writer.appendDispatch(dispatch);
          if (sent !== incident.jobs.length) {
            throw new Error(`incident ${incident.sequence}: sent ${sent}/${incident.jobs.length} jobs`);
          }
          if (incident.sequence === 1) manifest.firstWorkloadArrivalAt = actualDispatchCompletedAt.toISOString();
          jobsInjected += sent;
        } catch (error) {
          dispatch.status = 'failed';
          dispatch.failure = error.message;
          writer.appendDispatch(dispatch);
          dispatchFailure = error;
        }
      })();
      inFlightDispatches.push(inFlight);
    }

    throwIfSamplerFailed();
    await Promise.all(inFlightDispatches);
    throwIfSamplerFailed();
    if (dispatchFailure) throw dispatchFailure;
    if (!timingInvalidReason) {
      // The last scheduled arrival occurs one interval before the measurement
      // window closes; preserve that final interval instead of ending early.
      await waitUntilOffset(stage.warmupSeconds + stage.durationSeconds);
      throwIfSamplerFailed();
      await takeSample('measurement-complete');
      persistInjectionTiming('VALID');
    } else {
      persistInjectionTiming('TIMING-INVALID', timingInvalidReason);
      await takeSample('timing-invalid');
    }
  } finally {
    stopIndependentSampling();
  }

  const drainStarted = asDate(now());
  manifest.workloadCompletedAt = drainStarted.toISOString();
  manifest.drainStartedAt = drainStarted.toISOString();
  const drainDeadline = drainStarted.getTime() + stage.drainDeadlineSeconds * 1000;
  let finalSample = samples.at(-1);
  while ((finalSample.queue?.visibleMessages ?? 0) + (finalSample.queue?.inFlightMessages ?? 0) > 0
    && asDate(now()).getTime() < drainDeadline) {
    await sleep(stage.sampleIntervalSeconds * 1000);
    finalSample = await takeSample('drain');
  }
  if (finalSample !== samples.at(-1)) finalSample = await takeSample('drain-final');
  const drainCompletedAt = asDate(now()).toISOString();
  const finishedAt = drainCompletedAt;
  // CloudWatch Logs is eventually consistent. This collection grace is outside
  // the measured/drain window, so it never improves a reported throughput or
  // drain time; it only gives final worker events time to become queryable.
  await sleep(5000);
  const logCollectionAt = asDate(now()).toISOString();
  manifest.drainCompletedAt = drainCompletedAt;
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
