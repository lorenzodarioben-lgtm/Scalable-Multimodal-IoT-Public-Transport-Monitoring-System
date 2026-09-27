#!/usr/bin/env node
/**
 * Evidence collector.
 *
 * WHAT IT DOES
 * Reports the current state of the stored evidence and, with --promote, copies
 * a completed experiment run out of artifacts/runs/ (which is gitignored,
 * because runs can be large) into evidence/ (which is committed, because the
 * report cites it).
 *
 * WHY IT EXISTS
 * The report must cite measurements that were actually produced. This script
 * never invents a number - it only lists and copies files that already exist,
 * and it prints the headline results straight from each run's summary.json.
 *
 * Usage:
 *   npm run evidence                      # list what has been captured
 *   npm run evidence -- --list-runs       # list runs available to promote
 *   npm run evidence -- --promote <runId> # copy one run into evidence/
 *   npm run evidence -- --promote latest
 */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { ARTIFACTS_DIR, REPO_ROOT } from '@sit314/shared/config';
import { banner } from '@sit314/shared/logging';

const RUNS_DIR = path.join(ARTIFACTS_DIR, 'runs');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'evidence');
const PRELIM_DIR = path.join(EVIDENCE_DIR, 'preliminary-scalability');

const args = process.argv.slice(2);
const valueOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const listDirs = (dir) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
};

/** Pulls the handful of numbers the report actually quotes. */
function headline(summaryPath) {
  try {
    const s = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const r = s.results || {};
    return {
      stage: s.stage,
      mode: s.config?.worker?.mode,
      seed: s.seed,
      jobs: r.totalJobsInjected,
      throughput: r.jobsPerSecondProcessed,
      p95: r.p95ProcessingMs,
      peakQueue: r.peakQueueDepth,
      lost: r.jobsLost,
      dlq: r.dlqDepth,
      tasks: `${r.minTasksObserved}-${r.maxTasksObserved}`,
      verdict: s.stability?.verdict,
    };
  } catch {
    return null;
  }
}

function report() {
  console.log(banner('sit314 evidence status', {
    'Evidence directory': path.relative(REPO_ROOT, EVIDENCE_DIR),
    'Artifacts directory': path.relative(REPO_ROOT, ARTIFACTS_DIR),
  }));

  const captured = listDirs(PRELIM_DIR);
  console.log(`\nCaptured experiment runs (committed): ${captured.length}`);
  for (const runId of captured) {
    const h = headline(path.join(PRELIM_DIR, runId, 'summary.json'));
    if (!h) {
      console.log(`  ${runId}  (no summary.json)`);
      continue;
    }
    console.log(`  ${runId}`);
    console.log(`    stage=${h.stage} mode=${h.mode} seed=${h.seed} tasks=${h.tasks}`);
    console.log(`    jobs=${h.jobs} throughput=${h.throughput}/s p95=${h.p95}ms `
      + `peakQueue=${h.peakQueue} lost=${h.lost} dlq=${h.dlq} verdict=${h.verdict}`);
  }

  const available = listDirs(RUNS_DIR);
  console.log(`\nUncommitted runs in artifacts/runs: ${available.length}`);
  for (const runId of available) console.log(`  ${runId}`);
  if (available.length) {
    console.log('\nPromote one into evidence/ with:');
    console.log('  npm run evidence -- --promote latest');
  }

  console.log('\nFormal results: docs/DISTINCTION_FINAL_RESULTS.md');
}

function promote(runId) {
  const available = listDirs(RUNS_DIR);
  if (!available.length) {
    console.error('No runs found in artifacts/runs. Run an experiment first:');
    console.error('  npm run experiment -- --config experiments/incident/stage-1.json');
    process.exitCode = 1;
    return;
  }
  const chosen = runId === 'latest' ? available[available.length - 1] : runId;
  const src = path.join(RUNS_DIR, chosen);
  if (!fs.existsSync(src)) {
    console.error(`Run not found: ${chosen}`);
    process.exitCode = 1;
    return;
  }
  const dst = path.join(PRELIM_DIR, chosen);
  if (fs.existsSync(dst)) {
    console.error(`Already promoted: ${path.relative(REPO_ROOT, dst)}`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  // Only the curated files are copied. events.jsonl is deliberately left behind
  // because it can be very large and the repository should stay small.
  const keep = ['config.json', 'summary.json', 'metrics.csv', 'scaling.csv', 'errors.log'];
  let copied = 0;
  for (const file of fs.readdirSync(src)) {
    if (!keep.includes(file)) continue;
    fs.copyFileSync(path.join(src, file), path.join(dst, file));
    copied += 1;
  }
  console.log(`Promoted ${chosen} (${copied} files) -> ${path.relative(REPO_ROOT, dst)}`);
  const h = headline(path.join(dst, 'summary.json'));
  if (h) {
    console.log(`  stage=${h.stage} mode=${h.mode} jobs=${h.jobs} `
      + `throughput=${h.throughput}/s p95=${h.p95}ms verdict=${h.verdict}`);
  }
  console.log('\nCommit it so the report can cite it:');
  console.log(`  git add evidence/preliminary-scalability/${chosen}`);
}

if (args.includes('--promote')) {
  promote(valueOf('promote') || 'latest');
} else if (args.includes('--list-runs')) {
  for (const runId of listDirs(RUNS_DIR)) console.log(runId);
} else {
  report();
}
