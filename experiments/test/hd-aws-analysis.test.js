import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, analyseHdRun, aggregateHdRuns, percentChange, firstOverloadOffsetSeconds } from '../hd/analysis/metrics.js';
import { lineChart, barChart } from '../hd/analysis/charts.js';
import ramp from '../hd/predictable-ramp.json' with { type: 'json' };
import burst from '../hd/sudden-burst.json' with { type: 'json' };

test('descriptive statistics retain all repeats and use sample SD', () => {
  assert.deepEqual(describe([2, 4, 6]), { raw: [2, 4, 6], n: 3, mean: 4,
    median: 4, sampleSd: 2, min: 2, max: 6 });
  assert.equal(percentChange(100, 80), -20);
  assert.equal(percentChange(0, 80), null);
});

test('overload reference derives from profile, not inferred CloudWatch queue depth', () => {
  assert.equal(firstOverloadOffsetSeconds(ramp), 510);
  assert.equal(firstOverloadOffsetSeconds(burst), 210);
});

test('aggregation rejects missing, duplicate, invalid, or unreviewed repeats', () => {
  const runs = ['PREDICTABLE_RAMP', 'SUDDEN_BURST'].flatMap((workloadClass) =>
    ['reactive', 'hybrid'].flatMap((arm) => [1, 2, 3].map((repeatNumber) => ({
      runId: `${workloadClass}-${arm}-${repeatNumber}`, workloadClass, arm, repeatNumber,
      validity: 'PENDING_MANUAL_TIMELINE_REVIEW', reviewStatus: 'VALID',
      completedJobs: 100, submittedJobs: 100, expectedJobs: 100,
      logicalDigest: `${workloadClass}-${repeatNumber}-logical`,
      workerImage: '123.dkr.ecr.us-east-1.amazonaws.com/sit314-hd-transport-route-impact-worker:hd-frozen',
      taskCpu: '256', taskMemory: '512',
      peakVisibleBacklog: arm === 'reactive' ? 100 : 80,
    }))));
  const result = aggregateHdRuns(runs);
  assert.deepEqual(result.groups.PREDICTABLE_RAMP.reactive.metrics.peakVisibleBacklog.raw,
    [100, 100, 100]);
  assert.equal(result.groups.SUDDEN_BURST.hybrid.metrics.peakVisibleBacklog.mean, 80);
  assert.throws(() => aggregateHdRuns(runs.slice(1)), /requires exactly/);
  assert.throws(() => aggregateHdRuns([...runs, runs[0]]), /requires exactly/);
  assert.throws(() => aggregateHdRuns(runs.map((run, i) => i === 0
    ? { ...run, reviewStatus: 'UNREVIEWED' } : run)), /without VALID review/);
  assert.throws(() => aggregateHdRuns(runs.map((run, i) => i === 0
    ? { ...run, submittedJobs: 99 } : run)), /without VALID review/);
  assert.throws(() => aggregateHdRuns(runs.map((run, i) => i === 0
    ? { ...run, logicalDigest: 'different' } : run)), /not a matched workload/);
  assert.throws(() => aggregateHdRuns(runs.map((run, i) => i === 0
    ? { ...run, taskCpu: '512' } : run)), /one frozen taskCpu/);
});

test('SVG charts have independent single-unit axes and escaped labels', () => {
  const svg = lineChart({ title: '<AWS>', yLabel: 'Jobs/s',
    startedAt: '2026-09-23T00:00:00Z', endedAt: '2026-09-23T00:01:00Z',
    series: [{ name: 'Observed', points: [{ timestamp: '2026-09-23T00:00:30Z', value: 20 }] }] });
  assert.match(svg, /&lt;AWS&gt;/);
  assert.match(svg, /Jobs\/s/);
  assert.match(barChart({ title: 'Tasks', yLabel: 'task-seconds', categories: [
    { name: 'reactive', value: 10 }, { name: 'hybrid', value: 20 },
  ] }), /hybrid/);
});

test('run analysis uses genuine historical BPT and rejects unreviewed validity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-hd-analysis-'));
  const write = (name, object) => fs.writeFileSync(path.join(directory, name), JSON.stringify(object));
  const started = '2026-09-23T00:00:00Z';
  try {
    write('manifest.json', { runId: 'synthetic-hd-test', arm: 'hybrid', repeatNumber: 1,
      workloadStartedAt: started, workload: { stage: ramp.name, executionNamespace: 'test-ns' } });
    write('summary.json', { runId: 'synthetic-hd-test', validity: 'PENDING_MANUAL_TIMELINE_REVIEW',
      injectionTiming: { submittedJobs: 16500, effectiveSubmissionJobsPerSecond: 25 },
      results: { expectedJobs: 16500, resultsProduced: 16500, workerReadyEvents: [],
        throughputJobsPerSecond: 25, duplicateResults: 0, duplicateJobsSkipped: 0,
        errorCount: 0, dlqDepth: 0, lostOrUnaccounted: 0 } });
    write('cloudwatch-history.json', { source: 'genuine historical CloudWatch GetMetricStatistics',
      bpt: [{ timestamp: started, value: 91 }], oldestMessageAge: [{ timestamp: started, value: 8 }],
      predictive: { PredictionError: [{ timestamp: started, value: -2 }] } });
    write('scaling-activities.json', []); write('predictor-logs.json', []);
    write('review.json', { runId: 'synthetic-hd-test', status: 'VALID',
      reviewedAt: '2026-09-23T01:00:00Z', basis: 'Checked full timing and accounting evidence' });
    fs.writeFileSync(path.join(directory, 'samples.jsonl'), `${JSON.stringify({ timestamp: started,
      queue: { visibleMessages: 500 }, service: { runningCount: 1 },
      tasks: [{ taskId: 'ecs-existing', startedAt: '2026-09-22T23:59:00Z' }] })}\n${JSON.stringify({
      timestamp: '2026-09-23T00:01:00Z', queue: { visibleMessages: 100 },
      service: { runningCount: 2 }, tasks: [
        { taskId: 'ecs-existing', startedAt: '2026-09-22T23:59:00Z' },
        { taskId: 'ecs-new', startedAt: '2026-09-23T00:00:45Z' },
      ],
    })}\n`);
    const run = analyseHdRun(directory, ramp);
    assert.equal(run.peakVisibleBacklog, 500);
    assert.equal(run.peakBacklogPerTask, 91);
    assert.equal(run.reviewStatus, 'VALID');
    assert.equal(run.predictionMaeJobsPerSecond, 2);
    assert.equal(run.firstNewTaskRunningAt, '2026-09-23T00:00:45Z');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
