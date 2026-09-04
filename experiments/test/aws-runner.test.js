import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capacityForMode } from '../aws/control-plane.js';
import { runAwsExperiment } from '../aws/runner.js';
import { buildAwsSummary } from '../aws/summary.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const runnerSource = fs.readFileSync(path.join(here, '..', 'aws', 'runner.js'), 'utf8');

function stage() {
  return {
    name: 'aws-unit-stage', type: 'incident', seed: 17, repeatCount: 3,
    warmupSeconds: 0, durationSeconds: 20, drainDeadlineSeconds: 30, sampleIntervalSeconds: 10,
    arrival: { mode: 'count-bounded', incidentIntervalSeconds: 10, incidents: 2 },
    incident: {
      scenario: 'bus-breakdown', transportMode: 'bus', reason: 'breakdown', severity: 'high',
      vehicleId: 'BUS-001', routeId: '703', affectedLocations: 1, jobsPerIncident: 2,
      notificationsPerIncident: 4,
    },
    worker: { processingDelayMs: 50, processingCpuIterations: 0 },
  };
}

function fakeController(clock, calls) {
  return {
    async configureCapacity(mode) { calls.push(['configureCapacity', mode]); },
    async verifyQueuesClean() { calls.push(['verifyQueuesClean']); },
    async verifyProcessingCost(cost) { calls.push(['verifyProcessingCost', cost]); return { ...cost, source: 'test' }; },
    async waitForStartingState(mode) { calls.push(['waitForStartingState', mode]); return { desiredCount: 1, runningCount: 1 }; },
    async sample() {
      calls.push(['sample']);
      return {
        timestamp: new Date(clock.value).toISOString(),
        queue: { visibleMessages: 0, inFlightMessages: 0, oldestMessageAgeSeconds: 0 },
        service: { desiredCount: 1, runningCount: 1 },
      };
    },
    async injectJobs(jobs) { calls.push(['injectJobs', jobs.length]); return jobs.length; },
    async scalingActivities() { return []; },
    async resultsForSources(ids, expectedJobs) { return { resultsProduced: expectedJobs, duplicateResults: 0, queueRemaining: 0, dlqDepth: 0, ids }; },
    async workerLogs() { return [{ timestamp: new Date(clock.value).toISOString(), message: '[WORKER_READY] taskId=unit' }]; },
    logReferences() { return { logGroupName: '/unit', query: 'unit test' }; },
  };
}

async function run(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-aws-run-'));
  const clock = { value: Date.UTC(2026, 0, 1) };
  const calls = [];
  const result = await runAwsExperiment({
    stage: stage(), mode, repeatNumber: 1, outputDir: root, executionNamespace: `${mode}-unit`,
    controller: fakeController(clock, calls),
    now: () => new Date(clock.value), sleep: async (milliseconds) => { clock.value += milliseconds; },
  });
  return { root, calls, result };
}

test('capacity modes are exactly fixed one or autoscale one-to-five', () => {
  assert.deepEqual(capacityForMode('fixed'), { minCapacity: 1, maxCapacity: 1, desiredCount: 1 });
  assert.deepEqual(capacityForMode('autoscale'), { minCapacity: 1, maxCapacity: 5, desiredCount: 1 });
});

test('AWS runner records a complete count-bounded manifest without local workers', async () => {
  assert.doesNotMatch(runnerSource, /LocalAutoscaler|defaultSpawner|child_process|route-impact-worker\/src/);
  const { root, calls, result } = await run('fixed');
  try {
    assert.deepEqual(calls.filter(([name]) => name === 'injectJobs').map(([, count]) => count), [2, 2]);
    assert.deepEqual(calls.slice(0, 4).map(([name, mode]) => [name, typeof mode === 'string' ? mode : null].filter(Boolean)), [
      ['configureCapacity', 'fixed'], ['verifyQueuesClean'], ['verifyProcessingCost'], ['waitForStartingState', 'fixed'],
    ]);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.runDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.workload.expectedAnalysisJobs, 4);
    assert.equal(manifest.workload.incidentCount, 2);
    assert.equal(manifest.workload.processingCost.processingCpuIterations, 0);
    assert.equal(manifest.methodology.noLocalConsumer, true);
    assert.ok(fs.existsSync(path.join(result.runDir, 'samples.jsonl')));
    assert.ok(fs.existsSync(path.join(result.runDir, 'scaling-activities.json')));
    assert.ok(fs.existsSync(path.join(result.runDir, 'summary.json')));
    assert.ok(fs.existsSync(path.join(result.runDir, 'logs', 'references.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AWS runner passes autoscale mode to the isolated control plane', async () => {
  const { root, calls } = await run('autoscale');
  try {
    assert.deepEqual(calls[0], ['configureCapacity', 'autoscale']);
    assert.deepEqual(calls.find(([name]) => name === 'waitForStartingState'), ['waitForStartingState', 'autoscale']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AWS summary derives time-series compute use, latency and scaling activity', () => {
  const summary = buildAwsSummary({
    manifest: { runId: 'run-1', mode: 'autoscale', startedAt: '2026-01-01T00:00:00.000Z', workload: { stage: 's', expectedAnalysisJobs: 4 } },
    samples: [
      { timestamp: '2026-01-01T00:00:00.000Z', service: { runningCount: 1 } },
      { timestamp: '2026-01-01T00:00:10.000Z', service: { runningCount: 2 } },
      { timestamp: '2026-01-01T00:00:20.000Z', service: { runningCount: 1 } },
    ],
    scalingActivities: [{ Description: 'increased capacity' }, { Description: 'decreased capacity' }],
    accounting: { resultsProduced: 4, queueRemaining: 0, dlqDepth: 0, drainTimeSeconds: 20 },
    workerLogs: [
      { message: '[WORKER_READY] taskId=ecs-a' },
      { message: '[ANALYSIS] processingMs=20' },
      { message: '[ANALYSIS] processingMs=40' },
      { message: '[PROCESSING-FAILED] messageId=one' },
    ],
    finishedAt: '2026-01-01T00:00:20.000Z',
  });
  assert.equal(summary.results.taskSeconds, 30);
  assert.equal(summary.results.processingLatencyP95Ms, 40);
  assert.equal(summary.results.errorCount, 1);
  assert.equal(summary.scaling.scaleOutEvents, 1);
  assert.equal(summary.scaling.scaleInEvents, 1);
});
