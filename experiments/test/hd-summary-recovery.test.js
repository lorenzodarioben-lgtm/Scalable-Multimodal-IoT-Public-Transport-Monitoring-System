import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverTaskSeconds, readHdSummary } from '../hd/analysis/summary-evidence.js';

test('offline recovery sorts an append-order race while preserving original summary', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-task-seconds-recovery-'));
  const origin = Date.parse('2026-09-23T00:00:00Z');
  const iso = (seconds) => new Date(origin + seconds * 1000).toISOString();
  const original = { runId: 'recovery-fixture', validity: 'PENDING_REQUIRED_METRICS',
    injectionTiming: { status: 'VALID' },
    results: { expectedJobs: 100, resultsProduced: 100, taskSeconds: null,
      lostOrUnaccounted: 0, errorCount: 0, duplicateResults: 0, dlqDepth: 0 },
    missingRequiredMetrics: ['measurement task-seconds'],
    taskSecondsError: 'task-second sample timestamps must increase' };
  const raw = `${JSON.stringify(original)}\n`;
  try {
    fs.writeFileSync(path.join(runDir, 'summary.json'), raw);
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ runId: 'recovery-fixture',
      measurementStartedAt: iso(10), workloadCompletedAt: iso(50) }));
    fs.writeFileSync(path.join(runDir, 'samples.jsonl'), [
      { timestamp: iso(0), service: { runningCount: 1 } },
      { timestamp: iso(30), service: { runningCount: 3 } },
      { timestamp: iso(20), service: { runningCount: 1 } },
      { timestamp: iso(60), service: { runningCount: 3 } },
    ].map(JSON.stringify).join('\n') + '\n');
    assert.equal(recoverTaskSeconds(runDir).taskSeconds, 80);
    assert.equal(readHdSummary(runDir).validity, 'PENDING_MANUAL_TIMELINE_REVIEW');
    assert.equal(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8'), raw);
    assert.throws(() => recoverTaskSeconds(runDir), /EEXIST/);
    fs.appendFileSync(path.join(runDir, 'samples.jsonl'), '\n');
    assert.throws(() => readHdSummary(runDir), /does not match preserved original/);
  } finally { fs.rmSync(runDir, { recursive: true, force: true }); }
});
