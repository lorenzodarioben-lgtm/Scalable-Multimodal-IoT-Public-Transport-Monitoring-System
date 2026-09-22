#!/usr/bin/env node
/** Offline, narrowly scoped recovery of a task-seconds reduction failure. Never contacts AWS. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { integrateRunningTaskSeconds } from '../aws/task-seconds.js';

const digest = (raw) => createHash('sha256').update(raw).digest('hex');
const read = (runDir, name) => fs.readFileSync(path.join(runDir, name), 'utf8');

function expectedRecovery(runDir) {
  const originalRaw = read(runDir, 'summary.json');
  const samplesRaw = read(runDir, 'samples.jsonl');
  const original = JSON.parse(originalRaw);
  const manifest = JSON.parse(read(runDir, 'manifest.json'));
  const samples = samplesRaw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (manifest.runId !== original.runId || original.validity !== 'PENDING_REQUIRED_METRICS'
    || original.injectionTiming?.status !== 'VALID'
    || !isDeepStrictEqual(original.missingRequiredMetrics, ['measurement task-seconds'])
    || original.taskSecondsError !== 'task-second sample timestamps must increase'
    || original.results?.taskSeconds !== null
    || original.results?.resultsProduced !== original.results?.expectedJobs
    || original.results?.lostOrUnaccounted !== 0 || original.results?.errorCount !== 0
    || original.results?.duplicateResults !== 0 || original.results?.dlqDepth !== 0) {
    throw new Error('artifact is not eligible for task-seconds-only recovery');
  }
  const taskSeconds = integrateRunningTaskSeconds(samples, manifest.measurementStartedAt,
    manifest.workloadCompletedAt);
  const { taskSecondsError, ...withoutError } = original;
  return { ...withoutError, results: { ...original.results, taskSeconds },
    missingRequiredMetrics: [], validity: 'PENDING_MANUAL_TIMELINE_REVIEW',
    recovery: { kind: 'offline chronological sample reduction; no workload reinjection',
      originalSummarySha256: digest(originalRaw), samplesSha256: digest(samplesRaw),
      originalValidity: original.validity, originalTaskSecondsError: taskSecondsError } };
}

export function readHdSummary(runDir) {
  const recoveredPath = path.join(runDir, 'summary-recovered.json');
  if (!fs.existsSync(recoveredPath)) return JSON.parse(read(runDir, 'summary.json'));
  const expected = expectedRecovery(runDir);
  const recovered = JSON.parse(fs.readFileSync(recoveredPath, 'utf8'));
  if (!isDeepStrictEqual(recovered, expected)) {
    throw new Error('recovered summary does not match preserved original and raw samples');
  }
  return recovered;
}

export function recoverTaskSeconds(runDir) {
  const recovered = expectedRecovery(runDir);
  const output = path.join(runDir, 'summary-recovered.json');
  fs.writeFileSync(output, `${JSON.stringify(recovered, null, 2)}\n`, { flag: 'wx' });
  return { output, taskSeconds: recovered.results.taskSeconds, validity: recovered.validity };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--run-dir');
  if (index < 0 || !process.argv[index + 1]) throw new Error('usage: node summary-evidence.js --run-dir EXISTING_RUN_DIRECTORY');
  const result = recoverTaskSeconds(path.resolve(process.argv[index + 1]));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
