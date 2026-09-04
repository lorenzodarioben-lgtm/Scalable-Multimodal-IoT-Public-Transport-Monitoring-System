import { percentile, round } from '@sit314/shared/util';

/** Extracts the machine-readable values retained in existing worker log lines. */
export function summariseWorkerLogs(events = []) {
  const processingMs = [];
  let errors = 0;
  let duplicates = 0;
  const ready = [];
  for (const event of events) {
    const message = event.message || '';
    if (message.includes('[ANALYSIS]')) {
      const match = message.match(/processingMs=([0-9.]+)/);
      if (match) processingMs.push(Number(match[1]));
    }
    if (message.includes('[PROCESSING-FAILED]')) errors += 1;
    if (message.includes('[DUPLICATE_SKIPPED]')) duplicates += 1;
    if (message.includes('[WORKER_READY]')) ready.push(event);
  }
  return {
    completedFromLogs: processingMs.length,
    processingLatencyP95Ms: round(percentile(processingMs, 95)),
    processingLatencySamples: processingMs.length,
    errorCount: errors,
    duplicateJobsSkipped: duplicates,
    workerReadyEvents: ready,
  };
}

export function taskSeconds(samples = []) {
  let total = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const previous = samples[i - 1];
    const current = samples[i];
    const seconds = Math.max(0, (Date.parse(current.timestamp) - Date.parse(previous.timestamp)) / 1000);
    total += seconds * Number(previous.service?.runningCount ?? 0);
  }
  return round(total);
}

export function buildAwsSummary({ manifest, samples, scalingActivities, accounting, workerLogs, finishedAt }) {
  const logSummary = summariseWorkerLogs(workerLogs);
  const first = samples[0];
  const last = samples.at(-1);
  const elapsedSeconds = first && last
    ? round((Date.parse(last.timestamp) - Date.parse(first.timestamp)) / 1000)
    : 0;
  const resultsProduced = accounting.resultsProduced ?? 0;
  const expected = manifest.workload.expectedAnalysisJobs;
  const queued = accounting.queueRemaining ?? 0;
  const dlq = accounting.dlqDepth ?? 0;
  const accountedFor = resultsProduced + queued + dlq;
  const scaleOutEvents = scalingActivities.filter((a) => /scale out|increased/i.test(a.Description || a.description || '')).length;
  const scaleInEvents = scalingActivities.filter((a) => /scale in|decreased/i.test(a.Description || a.description || '')).length;

  return {
    runId: manifest.runId,
    stage: manifest.workload.stage,
    mode: manifest.mode,
    startedAt: manifest.startedAt,
    finishedAt,
    results: {
      expectedJobs: expected,
      resultsProduced,
      duplicateResults: accounting.duplicateResults ?? 0,
      queueRemaining: queued,
      dlqDepth: dlq,
      jobsAccountedFor: accountedFor,
      lostOrUnaccounted: Math.max(0, expected - accountedFor),
      throughputJobsPerSecond: round(resultsProduced / Math.max(elapsedSeconds, 0.001)),
      drainTimeSeconds: accounting.drainTimeSeconds ?? null,
      taskSeconds: taskSeconds(samples),
      ...logSummary,
    },
    scaling: {
      activities: scalingActivities.length,
      scaleOutEvents,
      scaleInEvents,
    },
  };
}
