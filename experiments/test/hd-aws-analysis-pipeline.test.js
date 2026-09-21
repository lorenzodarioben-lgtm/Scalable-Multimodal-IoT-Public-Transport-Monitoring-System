import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyseDirectory } from '../hd/analysis/aggregate.js';
import { parsePredictorEvents } from '../hd/aws/predictor-logs.js';

const classification = 'MOCK DATA; NOT EXPERIMENTAL EVIDENCE';
const startedAt = '2026-09-23T00:00:00Z';
const iso = (seconds) => new Date(Date.parse(startedAt) + seconds * 1000).toISOString();
const write = (directory, name, value) => fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value)}\n`);

function createMockRun(root, workloadClass, arm, repeatNumber, { invalid = false } = {}) {
  const stage = workloadClass === 'PREDICTABLE_RAMP' ? 'hd-predictable-ramp' : 'hd-sudden-burst';
  const runId = `MOCK-${workloadClass}-${arm}-r${repeatNumber}${invalid ? '-invalid' : ''}`;
  const directory = path.join(root, runId);
  fs.mkdirSync(directory);
  write(directory, 'manifest.json', { runId, arm, repeatNumber,
    evidenceClassification: classification, workloadStartedAt: startedAt,
    workload: { stage, executionNamespace: runId, logicalDigest: `${workloadClass}-r${repeatNumber}` },
    processingCostVerified: { workerImage: '123.dkr.ecr.us-east-1.amazonaws.com/sit314-hd-transport-route-impact-worker:hd-frozen',
      taskCpu: '256', taskMemory: '512' } });
  if (invalid) {
    write(directory, 'summary.json', { runId, validity: 'TIMING-INVALID' });
    return directory;
  }
  write(directory, 'summary.json', { runId, validity: 'PENDING_MANUAL_TIMELINE_REVIEW',
    injectionTiming: { submittedJobs: 100, effectiveSubmissionJobsPerSecond: 20,
      meanScheduleLagMs: 3, p95ScheduleLagMs: 5, maxScheduleLagMs: 7 },
    results: { expectedJobs: 100, resultsProduced: 100,
      workerReadyEvents: [{ timestamp: iso(130), message: '[WORKER_READY] taskId=ecs-new' }],
      throughputJobsPerSecond: 18, drainTimeSeconds: 4,
      processingLatencyP50Ms: 50, processingLatencyP95Ms: 53,
      taskSeconds: arm === 'reactive' ? 620 : 700,
      errorCount: 0, duplicateResults: 0, duplicateJobsSkipped: 0,
      dlqDepth: 0, lostOrUnaccounted: 0 } });
  write(directory, 'cloudwatch-history.json', { source: classification,
    bpt: [{ timestamp: iso(60), value: arm === 'reactive' ? 120 : 80 }],
    oldestMessageAge: [{ timestamp: iso(60), value: arm === 'reactive' ? 20 : 10 }],
    predictive: { AnalysisArrivalRate: [{ timestamp: iso(10), value: 20 }],
      PredictedArrivalRate: [{ timestamp: iso(20), value: 25 }],
      PredictionError: [{ timestamp: iso(30), value: -5 }] } });
  write(directory, 'scaling-activities.json', arm === 'reactive'
    ? [{ Description: 'Setting desired count to 5.', StartTime: iso(100) }] : []);
  write(directory, 'predictor-logs.json', arm === 'hybrid'
    ? [{ timestamp: iso(40), message: `${iso(40)}\t469a5a77-7d64-5d0b-ab30-395966c0e5cf\tINFO\t${JSON.stringify({ runId, signalId: 'signal-4', result: {
      acceptedJobs: 100, scaleRequested: true, target: 5,
      requestedAtMs: Date.parse(iso(40)), decisionAtMs: Date.parse(iso(40)),
    } })}` }] : []);
  write(directory, 'review.json', { runId, status: 'VALID', reviewedAt: iso(700),
    basis: 'Mock fixture timing and accounting verified' });
  fs.writeFileSync(path.join(directory, 'samples.jsonl'), [
    { timestamp: iso(0), queue: { visibleMessages: 0 }, service: { runningCount: 1 } },
    { timestamp: iso(60), queue: { visibleMessages: arm === 'reactive' ? 200 : 100 },
      service: { runningCount: 1 } },
    { timestamp: iso(630), queue: { visibleMessages: 0 }, service: { runningCount: 5 } },
  ].map(JSON.stringify).join('\n') + '\n');
  return directory;
}

test('full mock pipeline retains invalid attempts, calculates means and stamps charts', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-hd-mock-analysis-'));
  const input = path.join(base, 'input'); const output = path.join(base, 'output');
  fs.mkdirSync(input);
  try {
    for (const workloadClass of ['PREDICTABLE_RAMP', 'SUDDEN_BURST']) {
      for (const arm of ['reactive', 'hybrid']) {
        for (const repeat of [1, 2, 3]) createMockRun(input, workloadClass, arm, repeat);
      }
    }
    createMockRun(input, 'PREDICTABLE_RAMP', 'reactive', 2, { invalid: true });
    const result = analyseDirectory(input, output, { mock: true });
    assert.equal(result.aggregate.classification, classification);
    assert.equal(result.aggregate.excludedAttempts.length, 1);
    assert.equal(result.aggregate.excludedAttempts[0].validity, 'TIMING-INVALID');
    const ramp = result.aggregate.groups.PREDICTABLE_RAMP;
    assert.equal(ramp.reactive.metrics.peakVisibleBacklog.mean, 200);
    assert.equal(ramp.hybrid.metrics.peakVisibleBacklog.mean, 100);
    assert.equal(ramp.hybrid.metrics.taskSeconds.mean, 700);
    assert.equal(ramp.hybrid.metrics.predictionMaeJobsPerSecond.mean, 5);
    const hybridFixture = path.join(input, 'MOCK-PREDICTABLE_RAMP-hybrid-r1');
    assert.equal(parsePredictorEvents(JSON.parse(fs.readFileSync(path.join(hybridFixture,
      'predictor-logs.json'), 'utf8')), 'MOCK-PREDICTABLE_RAMP-hybrid-r1').length, 1);
    const hybridRun = result.runs.find((run) => run.runId === 'MOCK-PREDICTABLE_RAMP-hybrid-r1');
    assert.equal(hybridRun.predictiveRequests[0].desiredTasks, 5);
    assert.equal(hybridRun.predictorSamples[0].signalId, 'signal-4');
    assert.equal(hybridRun.predictedRateTimeline[0].value, 25);
    assert.equal(hybridRun.queueTimeline[1].visible, 100);
    assert.equal(hybridRun.taskCountTimeline.at(-1).running, 5);
    assert.deepEqual(ramp.reactive.metrics.peakVisibleBacklog.raw, [200, 200, 200]);
    assert.match(fs.readFileSync(path.join(output, 'comparison.md'), 'utf8'), /-50%/);
    const svg = fs.readFileSync(path.join(output, 'charts/PREDICTABLE_RAMP/visible-backlog-comparison.svg'), 'utf8');
    assert.match(svg, /MOCK DATA — NOT EXPERIMENTAL EVIDENCE/);
    assert.match(svg, /reactive mean, all r1–r3/);
    assert.ok(fs.existsSync(path.join(output, 'charts/PREDICTABLE_RAMP/forecast-mae-hybrid.svg')));
    assert.throws(() => analyseDirectory(input, path.join(base, 'unsafe')), /mock\/AWS artifact boundary/);
    const historyFile = path.join(input, 'MOCK-PREDICTABLE_RAMP-hybrid-r3', 'cloudwatch-history.json');
    const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    write(path.dirname(historyFile), 'cloudwatch-history.json', { ...history, bpt: [] });
    assert.throws(() => analyseDirectory(input, path.join(base, 'missing-bpt'), { mock: true }),
      /BacklogPerTask datapoints are missing/);
    write(path.dirname(historyFile), 'cloudwatch-history.json', history);
    const missing = path.join(input, 'MOCK-PREDICTABLE_RAMP-hybrid-r3');
    fs.rmSync(missing, { recursive: true });
    assert.throws(() => analyseDirectory(input, path.join(base, 'missing'), { mock: true }), /requires exactly/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
