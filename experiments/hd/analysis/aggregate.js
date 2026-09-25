#!/usr/bin/env node
/** Read-only evidence reduction; never contacts AWS. Requires manual VALID reviews for final tables. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyseHdRun, aggregateHdRuns, percentChange } from './metrics.js';
import { readHdSummary } from './summary-evidence.js';
import { barChart, writeRunCharts, writeComparisonCharts } from './charts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const profiles = Object.fromEntries(['predictable-ramp', 'sudden-burst'].map((name) => {
  const profile = JSON.parse(fs.readFileSync(path.join(root, 'experiments/hd', `${name}.json`), 'utf8'));
  return [profile.name, profile];
}));

function argument(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
}

function table(aggregate, workloadClass) {
  const groups = aggregate.groups[workloadClass];
  const lines = [`## ${workloadClass}`, '', '| Metric | Reactive r1/r2/r3 | Mean ± sample SD | Hybrid r1/r2/r3 | Mean ± sample SD | Change in mean |',
    '|---|---:|---:|---:|---:|---:|'];
  for (const [name, baseline] of Object.entries(groups.reactive.metrics)) {
    const treatment = groups.hybrid.metrics[name];
    const raw = (values) => values.map((value) => value ?? 'NA').join(', ');
    const centre = (item) => item.mean === null ? 'NA' : `${item.mean} ± ${item.sampleSd ?? 'NA'}`;
    const change = percentChange(baseline.mean, treatment.mean);
    lines.push(`| ${name} | ${raw(baseline.raw)} | ${centre(baseline)} | ${raw(treatment.raw)} | ${centre(treatment)} | ${change === null ? 'NA' : `${change}%`} |`);
  }
  return lines.join('\n');
}

function excludedReviewStatus(directory, runId) {
  const reviewFile = path.join(directory, 'review.json');
  if (!fs.existsSync(reviewFile)) return 'UNREVIEWED';
  const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  return review.runId === runId && review.status === 'INVALID'
    && Number.isFinite(Date.parse(review.reviewedAt))
    && typeof review.basis === 'string' && review.basis.length >= 15
    ? 'INVALID' : 'UNREVIEWED';
}

export function analyseDirectory(inputDir, outputDir, { preview = false, mock = false } = {}) {
  const directories = fs.readdirSync(inputDir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && fs.existsSync(path.join(inputDir, item.name, 'manifest.json')))
    .map((item) => path.join(inputDir, item.name));
  const runs = [];
  const excluded = [];
  for (const directory of directories) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    const isMock = manifest.evidenceClassification === 'MOCK DATA; NOT EXPERIMENTAL EVIDENCE';
    if (isMock !== mock) throw new Error(`mock/AWS artifact boundary mismatch in ${directory}`);
    const profile = profiles[manifest.workload?.stage];
    if (!profile) throw new Error(`unknown HD workload profile in ${directory}`);
    const summaryFile = path.join(directory, 'summary.json');
    if (!fs.existsSync(summaryFile)) {
      excluded.push({ runId: manifest.runId, validity: 'INCOMPLETE_ARTIFACT',
        reviewStatus: excludedReviewStatus(directory, manifest.runId) });
      continue;
    }
    const summary = readHdSummary(directory);
    if (summary.validity !== 'PENDING_MANUAL_TIMELINE_REVIEW') {
      excluded.push({ runId: manifest.runId, validity: summary.validity,
        reviewStatus: excludedReviewStatus(directory, manifest.runId) });
      continue;
    }
    runs.push(analyseHdRun(directory, profile, { allowMock: mock }));
  }
  if (mock && runs.some((run) => run.classification !== 'MOCK DATA; NOT EXPERIMENTAL EVIDENCE')) {
    throw new Error('mock analysis cannot mix in AWS-labelled runs');
  }
  // Preserve invalid/aborted attempts in input; only explicitly reviewed valid
  // replacements enter the final three-repeat comparison.
  const eligible = runs.filter((run) => preview
    ? run.validity === 'PENDING_MANUAL_TIMELINE_REVIEW' && run.reviewStatus !== 'INVALID'
    : run.reviewStatus === 'VALID');
  excluded.push(...runs.filter((run) => !eligible.includes(run)).map((run) => ({
    runId: run.runId, validity: run.validity, reviewStatus: run.reviewStatus,
  })));
  const aggregate = aggregateHdRuns(eligible, { requireReviewed: !preview, mock });
  aggregate.excludedAttempts = excluded;
  fs.mkdirSync(outputDir, { recursive: true });
  const compact = runs.map(({ raw, ...run }) => run);
  fs.writeFileSync(path.join(outputDir, 'run-metrics.json'), `${JSON.stringify(compact, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'aggregate.json'), `${JSON.stringify(aggregate, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'comparison.md'), [
    `# ${aggregate.classification}`, '',
    'All three valid repeats are shown; invalid/aborted attempts remain in the artifact directory and are listed in aggregate.json. Mean changes are descriptive, not significance claims. Positive changes are increases.', '',
    table(aggregate, 'PREDICTABLE_RAMP'), '', table(aggregate, 'SUDDEN_BURST'), '',
    'Task-seconds approximate relative worker use, not complete AWS billing. CloudWatch backlog values are genuine historical datapoints.',
  ].join('\n'));
  for (const run of eligible) writeRunCharts(run, path.join(outputDir, 'charts', run.runId), { mock });
  for (const workloadClass of ['PREDICTABLE_RAMP', 'SUDDEN_BURST']) {
    for (const metric of ['peakVisibleBacklog', 'taskSeconds']) {
      const categories = ['reactive', 'hybrid'].map((arm) => ({ name: arm,
        value: aggregate.groups[workloadClass][arm].metrics[metric].mean }));
      fs.writeFileSync(path.join(outputDir, `${workloadClass}-${metric}.svg`), barChart({
        title: `${workloadClass}: ${metric} (all-repeat means)`, yLabel: metric, categories,
        watermark: mock ? 'MOCK DATA — NOT EXPERIMENTAL EVIDENCE' : '',
      }));
    }
    writeComparisonCharts(eligible, aggregate, workloadClass,
      path.join(outputDir, 'charts', workloadClass), { mock });
  }
  return { runs: compact, aggregate };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputDir = argument('--input'); const outputDir = argument('--output');
  if (!inputDir || !outputDir) throw new Error('usage: node experiments/hd/analysis/aggregate.js --input artifacts/hd-aws-runs --output artifacts/hd-analysis [--preview] [--mock]');
  const outcome = analyseDirectory(path.resolve(inputDir), path.resolve(outputDir), {
    preview: process.argv.includes('--preview'),
    mock: process.argv.includes('--mock'),
  });
  process.stdout.write(`${outcome.aggregate.classification}; ${outcome.runs.length} runs analysed\n`);
}
