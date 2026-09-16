/** Read-only HD AWS artifact analysis. All values retain their source labels. */
import fs from 'node:fs';
import path from 'node:path';
import { profileArrivalRates } from '../workload-profile.js';

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
const maxOrNull = (values) => values.length ? Math.max(...values) : null;
const firstOrNull = (values) => values.length ? values[0] : null;
const round = (value, digits = 3) => value === null ? null : Number(value.toFixed(digits));

export function describe(values) {
  const valid = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!valid.length) return { raw: values, n: 0, mean: null, median: null, sampleSd: null,
    min: null, max: null };
  const sorted = [...valid].sort((a, b) => a - b);
  const mean = valid.reduce((sum, x) => sum + x, 0) / valid.length;
  const median = sorted.length % 2
    ? sorted[Math.floor(sorted.length / 2)]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const variance = valid.length > 1
    ? valid.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (valid.length - 1) : null;
  return { raw: values, n: valid.length, mean: round(mean), median: round(median),
    sampleSd: variance === null ? null : round(Math.sqrt(variance)),
    min: sorted[0], max: sorted.at(-1) };
}

function predictedRequests(logs, namespace) {
  return logs.flatMap((event) => {
    try {
      const item = JSON.parse(event.message);
      if (item.runId !== namespace || !item.result?.scaleRequested) return [];
      return [{ atMs: Number(item.result.requestedAtMs),
        desiredTasks: Number(item.result.target),
        decisionAtMs: Number(item.result.decisionAtMs),
        logTimestamp: event.timestamp }];
    } catch { return []; }
  }).filter((item) => Number.isFinite(item.atMs)).sort((a, b) => a.atMs - b.atMs);
}

function reactiveRequests(activities) {
  return activities.flatMap((item) => {
    const match = String(item.Description ?? '').match(/desired count to (\d+)/i);
    if (!match || Number(match[1]) <= 1) return [];
    const atMs = Date.parse(item.StartTime);
    return Number.isFinite(atMs) ? [{ atMs, desiredTasks: Number(match[1]),
      cause: item.Cause }] : [];
  }).sort((a, b) => a.atMs - b.atMs);
}

export function firstOverloadOffsetSeconds(profile, capacityJobsPerSecond = 42.467) {
  return profileArrivalRates(profile).find((segment) => segment.jobsPerSecond > capacityJobsPerSecond)
    ?.startOffsetSeconds ?? null;
}

export function analyseHdRun(runDir, profile) {
  const manifest = readJson(path.join(runDir, 'manifest.json'));
  const summary = readJson(path.join(runDir, 'summary.json'));
  const history = readJson(path.join(runDir, 'cloudwatch-history.json'));
  const samples = readJsonl(path.join(runDir, 'samples.jsonl'));
  const activities = readJson(path.join(runDir, 'scaling-activities.json'));
  const logs = readJson(path.join(runDir, 'predictor-logs.json'));
  if (manifest.workload.stage !== profile.name || summary.runId !== manifest.runId) {
    throw new Error(`artifact/profile identity mismatch: ${runDir}`);
  }
  if (!String(history.source).includes('CloudWatch')) throw new Error('historical CloudWatch provenance absent');
  const namespace = manifest.workload.executionNamespace;
  const predictive = predictedRequests(logs, namespace);
  const reactive = reactiveRequests(activities);
  const requests = [...predictive.map((item) => ({ ...item, source: 'predictive' })),
    ...reactive.map((item) => ({ ...item, source: 'reactive' }))]
    .sort((a, b) => a.atMs - b.atMs);
  const workloadStartMs = Date.parse(manifest.workloadStartedAt);
  const overloadOffset = firstOverloadOffsetSeconds(profile);
  const overloadAtMs = overloadOffset === null ? null : workloadStartMs + overloadOffset * 1000;
  const firstRequestAtMs = requests[0]?.atMs ?? null;
  const readyEvents = (summary.results.workerReadyEvents || [])
    .map((event) => event.timestamp).sort();
  const runningTasksById = new Map();
  for (const sample of samples) {
    for (const task of sample.tasks || []) {
      if (task.startedAt && !runningTasksById.has(task.taskId)) {
        runningTasksById.set(task.taskId, { taskId: task.taskId,
          startedAt: task.startedAt, firstObservedAt: sample.timestamp });
      }
    }
  }
  const newRunningTasks = [...runningTasksById.values()]
    .filter((task) => Date.parse(task.startedAt) >= workloadStartMs)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const errors = history.predictive?.PredictionError?.map((point) => point.value) || [];
  const actualRates = history.predictive?.AnalysisArrivalRate || [];
  const falseRequests = predictive.filter((request) => !actualRates.some((point) => {
    const at = Date.parse(point.timestamp);
    return at >= request.atMs && at <= request.atMs + 120_000 && point.value > 42.467;
  }));
  const visible = samples.map((sample) => sample.queue?.visibleMessages)
    .filter((value) => Number.isFinite(value));
  const taskCounts = samples.map((sample) => sample.service?.runningCount)
    .filter((value) => Number.isFinite(value));
  const reviewPath = path.join(runDir, 'review.json');
  const review = fs.existsSync(reviewPath) ? readJson(reviewPath) : null;
  return {
    classification: 'AWS HD RUN ARTIFACT — REVIEW REQUIRED BEFORE FINAL CLAIM',
    runId: manifest.runId, artifactDirectory: runDir,
    workloadClass: profile.workloadClass, arm: manifest.arm, repeatNumber: manifest.repeatNumber,
    executionNamespace: namespace, validity: summary.validity,
    reviewStatus: review?.runId === manifest.runId && summary.validity === 'PENDING_MANUAL_TIMELINE_REVIEW'
      ? review.status : 'UNREVIEWED',
    expectedJobs: summary.results.expectedJobs,
    submittedJobs: summary.injectionTiming.submittedJobs,
    completedJobs: summary.results.resultsProduced,
    offeredJobsPerSecond: summary.injectionTiming.effectiveSubmissionJobsPerSecond,
    scheduleLagMeanMs: summary.injectionTiming.meanScheduleLagMs,
    scheduleLagP95Ms: summary.injectionTiming.p95ScheduleLagMs,
    scheduleLagMaxMs: summary.injectionTiming.maxScheduleLagMs,
    firstOverloadAt: overloadAtMs === null ? null : new Date(overloadAtMs).toISOString(),
    firstAboveTargetBptAt: firstOrNull(history.bpt.filter((point) => point.value > 75)
      .map((point) => point.timestamp).sort()),
    firstScaleRequestAt: firstRequestAtMs === null ? null : new Date(firstRequestAtMs).toISOString(),
    firstScaleRequestSource: requests[0]?.source ?? null,
    scaleRequestLatencySeconds: firstRequestAtMs === null || overloadAtMs === null
      ? null : round((firstRequestAtMs - overloadAtMs) / 1000),
    proactiveLeadSeconds: firstRequestAtMs === null || overloadAtMs === null
      ? null : round(Math.max(0, (overloadAtMs - firstRequestAtMs) / 1000)),
    firstWorkerReadyAt: readyEvents[0] ?? null,
    firstNewTaskRunningAt: newRunningTasks[0]?.startedAt ?? null,
    requestToFirstRunningSeconds: firstRequestAtMs === null || !newRunningTasks.length
      ? null : round((Date.parse(newRunningTasks[0].startedAt) - firstRequestAtMs) / 1000),
    newRunningTasks,
    workerReadyEvents: summary.results.workerReadyEvents || [],
    allObservedWorkersReadyAt: readyEvents.at(-1) ?? null,
    requestToFirstReadySeconds: firstRequestAtMs === null || !readyEvents.length
      ? null : round((Date.parse(readyEvents[0]) - firstRequestAtMs) / 1000),
    peakVisibleBacklog: maxOrNull(visible),
    peakBacklogPerTask: maxOrNull(history.bpt.map((point) => point.value)),
    backlogPerTaskSource: history.source,
    peakOldestMessageAgeSeconds: maxOrNull(history.oldestMessageAge.map((point) => point.value)),
    completionThroughputJobsPerSecond: summary.results.throughputJobsPerSecond,
    drainSeconds: summary.results.drainTimeSeconds,
    processingP50Ms: summary.results.processingLatencyP50Ms,
    processingP95Ms: summary.results.processingLatencyP95Ms,
    peakRunningTasks: maxOrNull(taskCounts),
    taskSeconds: summary.results.taskSeconds,
    predictionMaeJobsPerSecond: errors.length
      ? round(errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length) : null,
    predictionBiasJobsPerSecond: errors.length
      ? round(errors.reduce((sum, value) => sum + value, 0) / errors.length) : null,
    matchedPredictionErrorPoints: errors.length,
    falseProactiveScaleOuts: falseRequests.length,
    errors: summary.results.errorCount,
    duplicates: summary.results.duplicateResults,
    duplicateJobsSkipped: summary.results.duplicateJobsSkipped,
    dlq: summary.results.dlqDepth,
    unaccountedJobs: summary.results.lostOrUnaccounted,
    predictiveRequests: predictive,
    reactiveRequests: reactive,
    raw: { samples, history },
  };
}

export const COMPARISON_METRICS = [
  'offeredJobsPerSecond', 'completedJobs', 'scaleRequestLatencySeconds',
  'proactiveLeadSeconds', 'requestToFirstRunningSeconds', 'requestToFirstReadySeconds',
  'peakVisibleBacklog', 'peakBacklogPerTask',
  'peakOldestMessageAgeSeconds', 'completionThroughputJobsPerSecond',
  'drainSeconds', 'processingP50Ms', 'processingP95Ms', 'peakRunningTasks',
  'taskSeconds', 'predictionMaeJobsPerSecond', 'predictionBiasJobsPerSecond',
  'falseProactiveScaleOuts', 'errors', 'duplicates', 'duplicateJobsSkipped',
  'dlq', 'unaccountedJobs',
];

export function aggregateHdRuns(runs, { requireReviewed = true } = {}) {
  const groups = {};
  for (const workloadClass of ['PREDICTABLE_RAMP', 'SUDDEN_BURST']) {
    groups[workloadClass] = {};
    for (const arm of ['reactive', 'hybrid']) {
      const selected = runs.filter((run) => run.workloadClass === workloadClass && run.arm === arm)
        .sort((a, b) => a.repeatNumber - b.repeatNumber);
      if (selected.length !== 3 || selected.some((run, index) => run.repeatNumber !== index + 1)) {
        throw new Error(`${workloadClass}/${arm} requires exactly valid r1/r2/r3, found ${selected.length}`);
      }
      if (requireReviewed && selected.some((run) => run.reviewStatus !== 'VALID'
        || run.validity !== 'PENDING_MANUAL_TIMELINE_REVIEW'
        || run.completedJobs !== run.expectedJobs || run.submittedJobs !== run.expectedJobs)) {
        throw new Error(`${workloadClass}/${arm} contains a run without VALID review`);
      }
      groups[workloadClass][arm] = {
        runIds: selected.map((run) => run.runId),
        metrics: Object.fromEntries(COMPARISON_METRICS.map((name) => [name,
          describe(selected.map((run) => run[name]))])),
      };
    }
  }
  return { classification: requireReviewed ? 'REVIEWED AWS HD EVIDENCE'
    : 'PRELIMINARY UNREVIEWED AWS HD ARTIFACT ANALYSIS', groups };
}

export function percentChange(baseline, treatment) {
  if (baseline === null || treatment === null || baseline === 0) return null;
  return round((treatment - baseline) / baseline * 100, 1);
}
