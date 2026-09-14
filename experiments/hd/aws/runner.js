/** Count-bounded HD piecewise AWS experiment runner. No AWS client is created here. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ARTIFACTS_DIR } from '@sit314/shared/config';
import { mean, percentile, round, sleep as defaultSleep } from '@sit314/shared/util';
import { createAwsArtifactWriter } from '../../aws/artifacts.js';
import { buildAwsSummary } from '../../aws/summary.js';
import { createHdAwsWorkload } from './workload.js';

const date = (value) => value instanceof Date ? value : new Date(value);

function publicWorkload(workload) {
  const { incidents, ...withoutJobs } = workload;
  return { ...withoutJobs, schedule: incidents.map((item) => ({
    sequence: item.sequence,
    scheduledOffsetSeconds: item.scheduledOffsetSeconds,
    sourceEventId: item.sourceEventId,
    expectedJobs: item.jobs.length,
  })) };
}

function intervalAt(profile, offset) {
  const segment = profile.arrival.segments.find((item) => offset >= item.startOffsetSeconds
    && offset < item.endOffsetSeconds);
  if (!segment) throw new Error(`no HD arrival segment at ${offset}s`);
  return segment.incidentIntervalSeconds;
}

function summariseInjection({ workload, startedAt, dispatches, guard, invalidReason, invalidStatus }) {
  const completed = dispatches.filter((item) => item.actualDispatchCompletedAt);
  const last = completed.reduce((latest, item) => Math.max(latest,
    Date.parse(item.actualDispatchCompletedAt)), Date.parse(startedAt));
  const duration = (last - Date.parse(startedAt)) / 1000;
  const lags = dispatches.map((item) => item.scheduleLagMs).filter(Number.isFinite);
  const jobs = completed.reduce((sum, item) => sum + item.submittedJobs, 0);
  return {
    status: invalidStatus || 'VALID', invalidReason,
    workloadStartedAt: startedAt,
    plannedInjectionDurationSeconds: workload.scheduledArrivalSeconds,
    actualInjectionDurationSeconds: round(duration, 3),
    expectedIncidents: workload.incidentCount, dispatchedIncidents: completed.length,
    expectedJobs: workload.expectedAnalysisJobs, submittedJobs: jobs,
    effectiveSubmissionJobsPerSecond: duration > 0 ? round(jobs / duration, 3) : null,
    meanScheduleLagMs: round(mean(lags), 3),
    p95ScheduleLagMs: round(percentile(lags, 95), 3),
    maxScheduleLagMs: lags.length ? Math.max(...lags) : null,
    guard,
  };
}

function processingP50(logs) {
  const values = logs.flatMap((event) => {
    if (!event.message?.includes('[ANALYSIS]')) return [];
    const match = event.message.match(/processingMs=([0-9.]+)/);
    return match ? [Number(match[1])] : [];
  });
  return round(percentile(values, 50));
}

export async function runHdAwsExperiment({
  config, profile, arm, repeatNumber, controller,
  executionNamespace = `${arm}-${randomUUID()}`,
  outputDir = path.join(ARTIFACTS_DIR, 'hd-aws-runs'),
  now = () => new Date(), sleep = defaultSleep,
  setIntervalFn = globalThis.setInterval, clearIntervalFn = globalThis.clearInterval,
  metricsGraceMs = 60_000,
} = {}) {
  if (!['reactive', 'hybrid'].includes(arm)) throw new Error('arm must be reactive or hybrid');
  if (!controller) throw new Error('HD controller port required');
  const workload = createHdAwsWorkload({ config, profile, repeatNumber, executionNamespace });
  const orchestratedAt = date(now());
  const runId = `${orchestratedAt.toISOString().replace(/[:.]/g, '-')}-${profile.name}-${arm}-r${repeatNumber}-${randomUUID().slice(0, 8)}`;
  fs.mkdirSync(outputDir, { recursive: true });
  const runDir = path.join(outputDir, runId);
  fs.mkdirSync(runDir);
  const writer = createAwsArtifactWriter(runDir);
  const manifest = {
    schemaVersion: 1, runId, arm, repeatNumber,
    evidenceClassification: 'HD AWS EXPERIMENT — UNVALIDATED UNTIL ACCOUNTING AND CLOUDWATCH REVIEW',
    orchestrationStartedAt: orchestratedAt.toISOString(),
    workloadStartedAt: null, measurementStartedAt: null, finishedAt: null,
    methodology: { sameLogicalWorkloadAcrossArms: true,
      oneToFiveTasks: true, targetBacklogPerTask: 75,
      controllerMode: arm, noAlarmForcing: true },
    workload: publicWorkload(workload),
  };
  writer.writeJson('manifest.json', manifest);
  manifest.preflight = await controller.verifyHdPreflight(arm);
  manifest.processingCostVerified = await controller.verifyProcessingCost(workload.processingCost);
  writer.writeJson('manifest.json', manifest);
  const samples = [];
  let jobsInjected = 0;
  const takeSample = async (phase, active = () => true) => {
    const sample = { ...(await controller.sample()), phase,
      jobsInjected, expectedJobs: workload.expectedAnalysisJobs };
    if (!active()) return null;
    samples.push(sample);
    writer.appendSample(sample);
    return sample;
  };
  await takeSample('preflight-ready');
  const startMs = date(now()).getTime();
  manifest.workloadStartedAt = new Date(startMs).toISOString();
  manifest.startedAt = manifest.workloadStartedAt;
  manifest.measurementStartedAt = new Date(startMs + profile.warmupSeconds * 1000).toISOString();
  manifest.mode = arm;
  writer.writeJson('manifest.json', manifest);
  const waitUntil = async (offsetSeconds) => {
    const remaining = startMs + offsetSeconds * 1000 - date(now()).getTime();
    if (remaining > 0) await sleep(remaining);
  };
  const guard = config.timingGuard;
  const dispatches = [];
  const inFlight = [];
  let consecutiveLate = 0;
  let invalidReason = null;
  let invalidStatus = null;
  let dispatchFailure = null;
  let samplerActive = true;
  let samplerInFlight = false;
  let samplerError = null;
  const sampling = () => {
    if (!samplerActive || samplerInFlight) return;
    samplerInFlight = true;
    void (async () => {
      try {
        await takeSample(date(now()).getTime() < Date.parse(manifest.measurementStartedAt)
          ? 'warmup' : 'measurement', () => samplerActive);
      } catch (error) { samplerError = error; }
      finally { samplerInFlight = false; }
    })();
  };
  const timer = setIntervalFn(sampling, config.sampleIntervalSeconds * 1000);
  try {
    for (const incident of workload.incidents) {
      await waitUntil(incident.scheduledOffsetSeconds);
      if (samplerError || dispatchFailure) break;
      const scheduled = startMs + incident.scheduledOffsetSeconds * 1000;
      const started = date(now()).getTime();
      const lag = Math.max(0, started - scheduled);
      const intervalMs = intervalAt(profile, incident.scheduledOffsetSeconds) * 1000;
      const record = {
        sequence: incident.sequence, expectedJobs: incident.jobs.length,
        scheduledDispatchAt: new Date(scheduled).toISOString(),
        actualDispatchStartedAt: new Date(started).toISOString(),
        scheduleLagMs: lag, actualDispatchCompletedAt: null, submittedJobs: 0,
      };
      dispatches.push(record);
      if (lag >= intervalMs * guard.maxDispatchStartLagIntervals) {
        invalidReason = `incident ${incident.sequence} started ${lag}ms late (limit ${intervalMs * guard.maxDispatchStartLagIntervals}ms)`;
        invalidStatus = 'TIMING-INVALID';
        record.status = 'not-submitted-schedule-lag';
        writer.appendDispatch(record);
        break;
      }
      consecutiveLate = lag >= intervalMs * guard.sustainedStartLagIntervals ? consecutiveLate + 1 : 0;
      if (consecutiveLate >= guard.sustainedStartLagIncidents) {
        invalidReason = `${consecutiveLate} consecutive dispatches exceeded the sustained lag guard`;
        invalidStatus = 'TIMING-INVALID';
        record.status = 'not-submitted-sustained-lag';
        writer.appendDispatch(record);
        break;
      }
      record.status = 'dispatching';
      writer.appendDispatch(record);
      inFlight.push((async () => {
        try {
          const sent = await controller.injectJobsWithSignal(incident.jobs, {
            runId: executionNamespace, signalId: incident.sourceEventId,
          });
          record.actualDispatchCompletedAt = date(now()).toISOString();
          record.submittedJobs = sent;
          record.completionScheduleLagMs = Math.max(0,
            Date.parse(record.actualDispatchCompletedAt) - scheduled);
          record.dispatchDurationMs = Date.parse(record.actualDispatchCompletedAt) - started;
          record.status = sent === incident.jobs.length ? 'submitted' : 'incomplete';
          writer.appendDispatch(record);
          if (sent !== incident.jobs.length) throw new Error(`incident ${incident.sequence} incomplete`);
          jobsInjected += sent;
        } catch (error) {
          record.status = 'failed';
          record.failure = error.message;
          writer.appendDispatch(record);
          dispatchFailure = error;
        }
      })());
    }
    await Promise.all(inFlight);
    if (samplerError) dispatchFailure = samplerError;
    if (dispatchFailure) {
      invalidReason ??= `dispatch or sampling failure: ${dispatchFailure.message}`;
      invalidStatus ??= 'FAILED';
    }
    if (!invalidReason) {
      await waitUntil(workload.scheduledArrivalSeconds);
      await takeSample('measurement-complete');
    }
  } finally {
    samplerActive = false;
    clearIntervalFn(timer);
  }
  manifest.injectionTiming = summariseInjection({ workload, startedAt: manifest.workloadStartedAt,
    dispatches, guard, invalidReason, invalidStatus });
  writer.writeJson('injection-timing.json', manifest.injectionTiming);
  writer.writeJson('manifest.json', manifest);
  let last = samples.at(-1) || await takeSample('post-injection');
  const drainStartedAt = date(now());
  const deadline = drainStartedAt.getTime() + config.drainDeadlineSeconds * 1000;
  while ((last.queue?.visibleMessages ?? 0) + (last.queue?.inFlightMessages ?? 0) > 0
    && date(now()).getTime() < deadline) {
    await sleep(config.sampleIntervalSeconds * 1000);
    last = await takeSample('drain');
  }
  const finishedAt = date(now()).toISOString();
  manifest.finishedAt = finishedAt;
  manifest.workloadCompletedAt = invalidReason ? null
    : new Date(startMs + workload.scheduledArrivalSeconds * 1000).toISOString();
  writer.writeJson('manifest.json', manifest);
  await sleep(5000); // CloudWatch Logs collection grace, outside measured interval.
  const activities = (await controller.scalingActivities()).filter((item) => {
    const at = Date.parse(item.StartTime || item.startTime);
    return at >= orchestratedAt.getTime() && at <= Date.parse(finishedAt) + 60_000;
  });
  const [accounting, workerLogs, predictorLogs] = await Promise.all([
    controller.resultsForSources(workload.sourceEventIds, workload.expectedAnalysisJobs),
    controller.workerLogs({ startedAt: manifest.workloadStartedAt, finishedAt }),
    controller.predictorLogs({ startedAt: manifest.workloadStartedAt, finishedAt }),
  ]);
  accounting.drainTimeSeconds = round((Date.parse(finishedAt) - drainStartedAt.getTime()) / 1000);
  accounting.drainTimedOut = (last.queue?.visibleMessages ?? 0) + (last.queue?.inFlightMessages ?? 0) > 0;
  writer.writeJson('scaling-activities.json', activities);
  writer.writeJson('predictor-logs.json', predictorLogs);
  writer.writeLogReference(controller.logReferences({ startedAt: manifest.workloadStartedAt, finishedAt }));
  for (const event of workerLogs) writer.appendLogEvent(event);
  const summary = buildAwsSummary({ manifest, samples, scalingActivities: activities,
    accounting, workerLogs, finishedAt });
  summary.arm = arm;
  summary.results.processingLatencyP50Ms = processingP50(workerLogs);
  summary.accounting = accounting;
  summary.artifacts = { runDirectory: runDir, samples: writer.samplesPath };
  await sleep(metricsGraceMs); // historical metric retrieval is outside measured duration.
  const history = await controller.collectHistory({ runId: executionNamespace,
    startedAt: manifest.workloadStartedAt, finishedAt });
  writer.writeJson('cloudwatch-history.json', history);
  summary.hdHistory = {
    source: history.source,
    peakBacklogPerTask: history.bpt.length ? Math.max(...history.bpt.map((x) => x.value)) : null,
    peakOldestMessageAgeSeconds: history.oldestMessageAge.length
      ? Math.max(...history.oldestMessageAge.map((x) => x.value)) : null,
    metricPoints: Object.fromEntries(Object.entries(history.predictive)
      .map(([name, points]) => [name, points.length])),
  };
  const countsClean = summary.results.resultsProduced === workload.expectedAnalysisJobs
    && summary.results.duplicateResults === 0 && summary.results.queueRemaining === 0
    && summary.results.dlqDepth === 0 && summary.results.lostOrUnaccounted === 0
    && summary.results.errorCount === 0 && !accounting.drainTimedOut;
  summary.validity = invalidReason ? invalidStatus
    : !countsClean ? 'RELIABILITY-INVALID'
      : !history.bpt.length ? 'PENDING_GENUINE_CLOUDWATCH_BPT'
        : 'PENDING_MANUAL_TIMELINE_REVIEW';
  writer.writeJson('summary.json', summary);
  return { runDir, manifest, summary, history };
}
