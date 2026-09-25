import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const aggregate = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/hd-analysis/aggregate.json'), 'utf8'));
const runs = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/hd-analysis/run-metrics.json'), 'utf8'));
if (aggregate.classification !== 'REVIEWED AWS HD EVIDENCE'
  || runs.filter((run) => run.reviewStatus === 'VALID').length !== 12
  || aggregate.excludedAttempts.length !== 1
  || aggregate.excludedAttempts[0].reviewStatus !== 'INVALID') {
  throw new Error('The full reviewed 12-run AWS evidence set is required');
}
const figureDir = path.join(root, 'docs/hd-final-figures');
const dataDir = path.join(root, 'docs/hd-final-data');
fs.mkdirSync(figureDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const fmt = (value, digits = 2) => Number(value).toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
const csv = (name, rows) => fs.writeFileSync(path.join(dataDir, `${name}.csv`),
  `${rows.map((row) => row.map((value) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(',')).join('\n')}\n`);
const svg = (w, h, title, body, note) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="#ffffff"/>
<style>text{font-family:Arial,Helvetica,sans-serif;fill:#20252b}.title{font-size:21px;font-weight:700}.sub{font-size:12px;fill:#59636e}.label{font-size:13px}.small{font-size:11px;fill:#59636e}.axis{stroke:#737c85;stroke-width:1}.grid{stroke:#e3e7ea;stroke-width:1}.reactive{fill:#52606d}.hybrid{fill:#b95f2e}</style>
<text x="42" y="34" class="title">${esc(title)}</text>${body}
<text x="42" y="${h - 15}" class="small">${esc(note)}</text></svg>\n`;
const writeSvg = (name, content) => fs.writeFileSync(path.join(figureDir, `${name}.svg`), content);
const evidenceRoot = path.join(root, 'artifacts/hd-aws-runs');
const evidenceFiles = [];
function walkEvidence(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkEvidence(full);
    else if (entry.isFile()) {
      const contents = fs.readFileSync(full);
      evidenceFiles.push([path.relative(root, full).replaceAll('\\', '/'), contents.length,
        crypto.createHash('sha256').update(contents).digest('hex')]);
    }
  }
}
walkEvidence(evidenceRoot);
csv('raw-evidence-sha256', [['relative_path', 'bytes', 'sha256'], ...evidenceFiles]);

function groupedBars(name, title, workloadClass, metric, unit) {
  const reactive = aggregate.groups[workloadClass].reactive.metrics[metric].raw;
  const hybrid = aggregate.groups[workloadClass].hybrid.metrics[metric].raw;
  const W = 900, H = 470, left = 92, top = 74, plotH = 302, xCenters = [212, 455, 698];
  const max = Math.max(...reactive, ...hybrid) * 1.15;
  let body = '<rect x="610" y="48" width="11" height="11" class="reactive"/><text x="628" y="58" class="small">Reactive</text>'
    + '<rect x="718" y="48" width="11" height="11" class="hybrid"/><text x="736" y="58" class="small">Hybrid</text>';
  for (let tick = 0; tick <= 4; tick++) {
    const y = top + plotH * (1 - tick / 4);
    body += `<line x1="${left}" x2="852" y1="${y}" y2="${y}" class="grid"/>`
      + `<text x="80" y="${y + 4}" text-anchor="end" class="small">${fmt(max * tick / 4, 0)}</text>`;
  }
  body += `<line x1="${left}" x2="${left}" y1="${top}" y2="${top + plotH}" class="axis"/>`
    + `<text x="18" y="${top + 150}" transform="rotate(-90 18 ${top + 150})" class="label">${esc(unit)}</text>`;
  for (let i = 0; i < 3; i++) {
    const centre = xCenters[i], values = [reactive[i], hybrid[i]];
    for (let arm = 0; arm < 2; arm++) {
      const x = centre + (arm ? 7 : -49), height = values[arm] / max * plotH;
      body += `<rect x="${x}" y="${top + plotH - height}" width="42" height="${height}" class="${arm ? 'hybrid' : 'reactive'}"/>`
        + `<text x="${x + 21}" y="${top + plotH - height - 8}" text-anchor="middle" class="small">${fmt(values[arm], values[arm] < 300 ? 1 : 0)}</text>`;
    }
    body += `<text x="${centre}" y="${top + plotH + 22}" text-anchor="middle" class="label">r${i + 1}</text>`;
  }
  writeSvg(name, svg(W, H, title, body, 'Raw per-repeat values from 12 manually reviewed AWS formal artifacts.'));
  csv(name, [['repeat', 'reactive', 'hybrid', 'unit'],
    ...[0, 1, 2].map((i) => [i + 1, reactive[i], hybrid[i], unit])]);
}

groupedBars('figure-1-ramp-peak-bpt', 'Predictable ramp: genuine peak BacklogPerTask',
  'PREDICTABLE_RAMP', 'peakBacklogPerTask', 'jobs per task');
groupedBars('figure-3-ramp-task-seconds', 'Predictable ramp: measurement task-seconds',
  'PREDICTABLE_RAMP', 'taskSeconds', 'running task-seconds');
groupedBars('figure-5-burst-peak-bpt', 'Sudden burst: genuine peak BacklogPerTask',
  'SUDDEN_BURST', 'peakBacklogPerTask', 'jobs per task');
groupedBars('figure-6-burst-task-seconds', 'Sudden burst: measurement task-seconds',
  'SUDDEN_BURST', 'taskSeconds', 'running task-seconds');

const ramp = aggregate.groups.PREDICTABLE_RAMP;
const panels = [
  ['Peak visible queue', 'peakVisibleBacklog', 'jobs'],
  ['Peak BacklogPerTask', 'peakBacklogPerTask', 'jobs/task'],
  ['Oldest-message age', 'peakOldestMessageAgeSeconds', 'seconds'],
];
let panelBody = '<rect x="662" y="47" width="11" height="11" class="reactive"/><text x="680" y="57" class="small">Reactive mean</text>'
  + '<rect x="775" y="47" width="11" height="11" class="hybrid"/><text x="793" y="57" class="small">Hybrid mean</text>';
const panelCsv = [['metric', 'reactive_mean', 'reactive_median', 'reactive_sample_sd',
  'hybrid_mean', 'hybrid_median', 'hybrid_sample_sd', 'unit']];
for (let i = 0; i < panels.length; i++) {
  const [label, metric, unit] = panels[i];
  const r = ramp.reactive.metrics[metric], h = ramp.hybrid.metrics[metric];
  const top = 98 + i * 116, scale = 505 / Math.max(r.mean, h.mean);
  panelBody += `<text x="42" y="${top}" class="label">${esc(label)} (${esc(unit)})</text>`
    + `<rect x="242" y="${top - 16}" width="${r.mean * scale}" height="19" class="reactive"/>`
    + `<rect x="242" y="${top + 12}" width="${h.mean * scale}" height="19" class="hybrid"/>`
    + `<text x="${249 + r.mean * scale}" y="${top - 2}" class="small">${fmt(r.mean, 1)}</text>`
    + `<text x="${249 + h.mean * scale}" y="${top + 26}" class="small">${fmt(h.mean, 1)}</text>`;
  panelCsv.push([label, r.mean, r.median, r.sampleSd, h.mean, h.median, h.sampleSd, unit]);
}
writeSvg('figure-2-ramp-mean-pressure', svg(900, 480,
  'Predictable ramp: mean queue pressure across three repeats', panelBody,
  'Each row uses its own native unit and scale; values are three-run means.'));
csv('figure-2-ramp-mean-pressure', panelCsv);

const rampHybridR2 = runs.find((run) => run.workloadClass === 'PREDICTABLE_RAMP'
  && run.arm === 'hybrid' && run.repeatNumber === 2);
const rampReactiveR2 = runs.find((run) => run.workloadClass === 'PREDICTABLE_RAMP'
  && run.arm === 'reactive' && run.repeatNumber === 2);
if (!rampHybridR2 || !rampReactiveR2) throw new Error('Representative ramp r2 pair missing');
const history = JSON.parse(fs.readFileSync(path.join(root,
  'artifacts/hd-aws-runs', rampHybridR2.runId, 'cloudwatch-history.json'), 'utf8'));
const rampProfile = JSON.parse(fs.readFileSync(path.join(root, 'experiments/hd/predictable-ramp.json'), 'utf8'));
const scheduled = rampProfile.arrival.segments.map((segment) => ({
  offset: segment.startOffsetSeconds, value: 50 / segment.incidentIntervalSeconds,
}));
scheduled.push({ offset: 630, value: scheduled.at(-1).value });
const normalized = (points) => points.map((point) => ({
  offset: (Date.parse(point.timestamp) - Date.parse(rampHybridR2.workloadStartedAt)) / 1000,
  value: point.value,
})).filter((point) => point.offset >= 0 && point.offset <= 630);
const observed = normalized(history.predictive.AnalysisArrivalRate);
const predicted = normalized(history.predictive.PredictedArrivalRate);
const offset = (run, timestamp) => (Date.parse(timestamp) - Date.parse(run.workloadStartedAt)) / 1000;
const events = [
  ['High-load onset', 510, '#7f8c8d'],
  ['Hybrid request', offset(rampHybridR2, rampHybridR2.firstScaleRequestAt), '#b95f2e'],
  ['Hybrid first ready', offset(rampHybridR2, rampHybridR2.firstWorkerReadyAt), '#d98d62'],
  ['Reactive request', offset(rampReactiveR2, rampReactiveR2.firstScaleRequestAt), '#52606d'],
  ['Reactive first ready', offset(rampReactiveR2, rampReactiveR2.firstWorkerReadyAt), '#8c9ba7'],
];
const W = 1000, H = 520, x0 = 79, x1 = 954, y0 = 76, y1 = 360;
const x = (second) => x0 + second / 630 * (x1 - x0);
const rateMax = Math.ceil(Math.max(...scheduled.map((p) => p.value),
  ...observed.map((p) => p.value), ...predicted.map((p) => p.value)) / 10) * 10 + 10;
const y = (rate) => y1 - rate / rateMax * (y1 - y0);
const polyline = (points, color, width = 2) => `<polyline fill="none" stroke="${color}" stroke-width="${width}" points="${points.map((p) => `${x(p.offset).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')}"/>`;
let timeline = '';
for (let tick = 0; tick <= rateMax / 10; tick++) {
  const rate = tick * 10, yy = y(rate);
  timeline += `<line x1="${x0}" x2="${x1}" y1="${yy}" y2="${yy}" class="grid"/>`
    + `<text x="${x0 - 8}" y="${yy + 4}" text-anchor="end" class="small">${rate}</text>`;
}
for (const second of [0, 150, 270, 390, 510, 630]) {
  timeline += `<text x="${x(second)}" y="${y1 + 20}" text-anchor="middle" class="small">${second}</text>`;
}
const steps = scheduled.flatMap((point, i) => i === 0 ? [point]
  : [{ offset: point.offset, value: scheduled[i - 1].value }, point]);
timeline += polyline(steps, '#24292e', 2.5) + polyline(observed, '#708e8b', 1.6)
  + polyline(predicted, '#b95f2e', 1.6);
events.forEach(([label, second, color], i) => {
  timeline += `<line x1="${x(second)}" x2="${x(second)}" y1="${y0}" y2="${y1}" stroke="${color}" stroke-width="1.4" stroke-dasharray="5 4"/>`
    + `<circle cx="${x(second)}" cy="${y1}" r="4" fill="${color}"/>`
    + `<text x="${80 + (i % 2) * 440}" y="${406 + Math.floor(i / 2) * 20}" class="small">${esc(label)} ${fmt(second, 1)} s</text>`;
});
timeline += `<text x="79" y="57" class="small">Scheduled rate (black)  Observed rate (teal)  80 s forecast (orange)</text>`
  + `<text x="510" y="390" text-anchor="middle" class="label">Seconds from workload start</text>`
  + `<text x="18" y="218" transform="rotate(-90 18 218)" class="label">Jobs per second</text>`;
writeSvg('figure-4-ramp-r2-timeline', svg(W, H,
  'Predictable ramp r2: arrivals and scaling chronology', timeline,
  'Observed and predicted rates are genuine CloudWatch points; vertical events use raw request and WORKER_READY times.'));
csv('figure-4-ramp-r2-timeline', [
  ['kind', 'arm', 'offset_seconds', 'value', 'unit'],
  ...scheduled.map((p) => ['scheduled_rate', 'both', p.offset, p.value, 'jobs/s']),
  ...observed.map((p) => ['observed_rate', 'hybrid', p.offset, p.value, 'jobs/s']),
  ...predicted.map((p) => ['predicted_rate', 'hybrid', p.offset, p.value, 'jobs/s']),
  ...events.map(([label, second]) => [label, label.startsWith('Reactive') ? 'reactive' : 'hybrid',
    second, '', 'event']),
]);

const valid = runs.filter((run) => run.reviewStatus === 'VALID');
const fields = ['runId', 'workloadClass', 'arm', 'repeatNumber', 'logicalDigest',
  'offeredJobsPerSecond', 'completedJobs', 'scaleRequestLatencySeconds', 'proactiveLeadSeconds',
  'requestToFirstRunningSeconds', 'requestToFirstReadySeconds', 'peakVisibleBacklog',
  'peakBacklogPerTask', 'peakOldestMessageAgeSeconds', 'completionThroughputJobsPerSecond',
  'drainSeconds', 'processingP50Ms', 'processingP95Ms', 'peakRunningTasks', 'taskSeconds',
  'predictionMaeJobsPerSecond', 'predictionBiasJobsPerSecond', 'errors', 'duplicates',
  'dlq', 'unaccountedJobs'];
csv('all-reviewed-runs', [fields, ...valid.map((run) => fields.map((field) => run[field]))]);
const stats = [['workload_class', 'metric', 'arm', 'r1', 'r2', 'r3', 'mean', 'median', 'sample_sd',
  'absolute_hybrid_minus_reactive', 'percentage_hybrid_minus_reactive']];
for (const workloadClass of ['PREDICTABLE_RAMP', 'SUDDEN_BURST']) {
  const groups = aggregate.groups[workloadClass];
  for (const metric of Object.keys(groups.reactive.metrics)) {
    const r = groups.reactive.metrics[metric], h = groups.hybrid.metrics[metric];
    const delta = r.mean === null || h.mean === null ? '' : Number((h.mean - r.mean).toFixed(3));
    const percent = r.mean === null || r.mean === 0 || h.mean === null ? ''
      : Number(((h.mean - r.mean) / r.mean * 100).toFixed(3));
    for (const [arm, item] of [['reactive', r], ['hybrid', h]]) {
      stats.push([workloadClass, metric, arm, ...item.raw, item.mean, item.median,
        item.sampleSd, delta, percent]);
    }
  }
}
csv('all-aggregate-statistics', stats);
console.log(`Generated 6 formal figures and 9 source CSV files from ${valid.length} reviewed runs`);
