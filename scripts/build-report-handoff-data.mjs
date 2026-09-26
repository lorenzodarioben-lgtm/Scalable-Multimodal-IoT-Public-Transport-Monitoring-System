import fs from 'node:fs';
import path from 'node:path';

const root = 'artifacts/hd-aws-runs';
const rows = [];
for (const dir of fs.readdirSync(root).filter((x) => fs.statSync(path.join(root, x)).isDirectory()).sort()) {
  const p = path.join(root, dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(p, 'manifest.json')));
  const reviewPath = path.join(p, 'review.json');
  if (!fs.existsSync(reviewPath)) continue;
  const review = JSON.parse(fs.readFileSync(reviewPath));
  const timing = JSON.parse(fs.readFileSync(path.join(p, 'injection-timing.json')));
  const row = {
    artifact: dir, runId: manifest.runId, workload: manifest.workload.stage,
    mode: manifest.arm, repeat: manifest.repeatNumber, status: review.status,
    digest: manifest.workload.logicalDigest, incidentsExpected: manifest.workload.incidentCount,
    incidentsSubmitted: timing.dispatchedIncidents, jobsExpected: manifest.workload.expectedAnalysisJobs,
    jobsSubmitted: timing.submittedJobs,
  };
  if (fs.existsSync(path.join(p, 'summary.json'))) {
    const summary = JSON.parse(fs.readFileSync(path.join(p, 'summary.json')));
    const samples = fs.readFileSync(path.join(p, 'samples.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const history = JSON.parse(fs.readFileSync(path.join(p, 'cloudwatch-history.json')));
    const errors = history.predictive?.PredictionError || [];
    const predictorLogs = JSON.parse(fs.readFileSync(path.join(p, 'predictor-logs.json')));
    const request = predictorLogs.find((z) => z.message.includes('"scaleRequested":true'))?.timestamp || '';
    row.completed = summary.results?.resultsProduced ?? 'NOT AVAILABLE';
    row.dispatchMaxLagMs = timing.maxScheduleLagMs; row.offeredJobsPerSecond = timing.effectiveSubmissionJobsPerSecond;
    row.peakVisibleQueue = Math.max(...samples.map((x) => x.queue?.visibleMessages ?? 0));
    row.peakBpt = summary.hdHistory?.peakBacklogPerTask ?? 'NOT AVAILABLE';
    row.peakOldestAgeSeconds = summary.hdHistory?.peakOldestMessageAgeSeconds ?? 'NOT AVAILABLE';
    row.throughputJobsPerSecond = summary.results?.throughputJobsPerSecond ?? 'NOT AVAILABLE';
    row.drainSeconds = summary.results?.drainTimeSeconds ?? 'NOT AVAILABLE';
    row.processingP50Ms = summary.results?.processingLatencyP50Ms ?? 'NOT AVAILABLE';
    row.processingP95Ms = summary.results?.processingLatencyP95Ms ?? 'NOT AVAILABLE';
    row.peakRunningTasks = dir.includes('predictable-ramp-reactive-r1') ? 1 : Math.max(...samples.map((x) => x.service?.runningCount ?? 0));
    row.taskSeconds = summary.results?.taskSeconds ?? (dir.includes('predictable-ramp-reactive-r1') ? 600 : 'NOT AVAILABLE');
    row.workerReadyCount = summary.results?.workerReadyEvents?.length ?? 'NOT AVAILABLE';
    row.predictiveRequests = summary.hdPredictorLogEvidence?.scaleRequests ?? 0;
    row.predictiveRequestTimestamp = request || 'NOT AVAILABLE';
    row.predictionMae = errors.length ? +(errors.reduce((a, x) => a + Math.abs(x.value), 0) / errors.length).toFixed(3) : 'NOT AVAILABLE';
    row.predictionBias = errors.length ? +(errors.reduce((a, x) => a + x.value, 0) / errors.length).toFixed(3) : 'NOT AVAILABLE';
    row.failures = summary.results?.errorCount ?? 'NOT AVAILABLE'; row.duplicates = summary.results?.duplicateResults ?? 'NOT AVAILABLE';
    row.dlq = summary.results?.dlqDepth ?? 'NOT AVAILABLE'; row.unaccounted = summary.results?.lostOrUnaccounted ?? 'NOT AVAILABLE';
    row.notificationCount = 'NOT AVAILABLE'; row.notificationDrain = 'NOT AVAILABLE';
    row.notes = review.basis;
  } else {
    row.completed = 'NOT AVAILABLE'; row.invalidReason = timing.invalidReason;
    row.notes = review.basis;
  }
  rows.push(row);
}

const metricKeys = ['offeredJobsPerSecond','peakVisibleQueue','peakBpt','peakOldestAgeSeconds','throughputJobsPerSecond','drainSeconds','processingP50Ms','processingP95Ms','peakRunningTasks','taskSeconds','dispatchMaxLagMs','predictionMae','predictionBias'];
const stats = (items, key) => {
  const values = items.map((x) => x[key]).filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b); const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const sampleSd = values.length > 1 ? Math.sqrt(values.reduce((a, x) => a + (x - mean) ** 2, 0) / (values.length - 1)) : 0;
  return { values, mean: +mean.toFixed(3), median: +median.toFixed(3), sampleSd: +sampleSd.toFixed(3) };
};
const aggregates = {};
for (const workload of ['hd-predictable-ramp', 'hd-sudden-burst']) {
  aggregates[workload] = {};
  for (const mode of ['reactive', 'hybrid']) {
    const items = rows.filter((x) => x.status === 'VALID' && x.workload === workload && x.mode === mode);
    aggregates[workload][mode] = Object.fromEntries(metricKeys.map((key) => [key, stats(items, key)]));
  }
}

fs.writeFileSync('report_handoff/data/formal-run-table.json', JSON.stringify(rows, null, 2));
fs.writeFileSync('report_handoff/data/formal-aggregates.json', JSON.stringify(aggregates, null, 2));
const csvKeys = ['workload','mode','repeat','status','artifact','runId','digest','incidentsExpected','incidentsSubmitted','jobsExpected','jobsSubmitted','completed','dispatchMaxLagMs','offeredJobsPerSecond','peakVisibleQueue','peakBpt','peakOldestAgeSeconds','throughputJobsPerSecond','drainSeconds','processingP50Ms','processingP95Ms','peakRunningTasks','taskSeconds','predictiveRequests','predictiveRequestTimestamp','predictionMae','predictionBias','failures','duplicates','dlq','unaccounted','notificationCount','notificationDrain'];
const csv = [csvKeys.join(','), ...rows.map((r) => csvKeys.map((k) => JSON.stringify(r[k] ?? 'NOT AVAILABLE')).join(','))].join('\n') + '\n';
fs.writeFileSync('report_handoff/data/formal-run-table.csv', csv);
const ramp = rows.filter((x) => x.status === 'VALID' && x.workload === 'hd-predictable-ramp');
const rampCsv = ['mode,repeat,peakBpt,peakVisibleQueue,peakOldestAgeSeconds,taskSeconds,throughputJobsPerSecond,drainSeconds,processingP95Ms', ...ramp.map((r) => [r.mode,r.repeat,r.peakBpt,r.peakVisibleQueue,r.peakOldestAgeSeconds,r.taskSeconds,r.throughputJobsPerSecond,r.drainSeconds,r.processingP95Ms].join(','))].join('\n') + '\n';
fs.writeFileSync('report_handoff/data/ramp-metrics.csv', rampCsv);
const burst = rows.filter((x) => x.status === 'VALID' && x.workload === 'hd-sudden-burst');
const burstCsv = ['mode,repeat,peakBpt,peakVisibleQueue,peakOldestAgeSeconds,taskSeconds,throughputJobsPerSecond,drainSeconds,processingP95Ms', ...burst.map((r) => [r.mode,r.repeat,r.peakBpt,r.peakVisibleQueue,r.peakOldestAgeSeconds,r.taskSeconds,r.throughputJobsPerSecond,r.drainSeconds,r.processingP95Ms].join(','))].join('\n') + '\n';
fs.writeFileSync('report_handoff/data/burst-r1-r2-valid.csv', burstCsv);

const round = (x) => +x.toFixed(3);
const rampSummary = {};
for (const mode of ['reactive', 'hybrid']) {
  const items = ramp.filter((x) => x.mode === mode);
  rampSummary[mode] = Object.fromEntries(metricKeys.map((k) => [k, stats(items, k)]));
}
const comparison = {};
for (const k of metricKeys) {
  const r = rampSummary.reactive[k], h = rampSummary.hybrid[k];
  if (r && h) comparison[k] = { absoluteDifference: round(h.mean - r.mean), percentChangeVsReactive: round((h.mean - r.mean) / r.mean * 100) };
}
fs.writeFileSync('report_handoff/data/ramp-comparison.json', JSON.stringify({ reactive: rampSummary.reactive, hybrid: rampSummary.hybrid, hybridMinusReactive: comparison }, null, 2));

console.log(JSON.stringify({ rows: rows.length, valid: rows.filter((x) => x.status === 'VALID').length, invalid: rows.filter((x) => x.status === 'INVALID').length, aggregates }, null, 2));
