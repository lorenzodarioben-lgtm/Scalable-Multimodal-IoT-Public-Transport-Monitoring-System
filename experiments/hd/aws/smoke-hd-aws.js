#!/usr/bin/env node
/** Explicitly gated, bounded LIVE HD predictor smoke. Never a formal repeat. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAnalysisArrivalSignal } from '../../../shared/hd/arrival-signal.js';
import { loadHdAwsConfiguration, createHdAwsWorkload } from './workload.js';
import { HdAwsControlPlane } from './control-plane.js';
import { createHdAwsPorts } from './ports.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const prefix = 'sit314-hd-transport';
const region = 'us-east-1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const at = () => new Date().toISOString();

/** Eleven distinct signals: seven 50-job bins, three 250-job bins, then a 50-job closing signal. */
export function buildPredictiveSmokePlan(workload) {
  const incidentCounts = [1, 1, 1, 1, 1, 1, 1, 5, 5, 5, 1];
  let cursor = 0;
  const groups = incidentCounts.map((count, index) => {
    const incidents = workload.incidents.slice(cursor, cursor + count);
    cursor += count;
    return { index, offsetMs: index * 10_500, signalId: `smoke-signal-${index}`,
      sourceEventIds: incidents.map((incident) => incident.sourceEventId),
      jobs: incidents.flatMap((incident) => incident.jobs) };
  });
  if (cursor !== 23 || groups.length !== 11
    || groups.reduce((sum, group) => sum + group.jobs.length, 0) !== 1150
    || new Set(groups.flatMap((group) => group.jobs.map((job) => job.jobId))).size !== 1150) {
    throw new Error('bounded HD predictive smoke plan is not 23 unique incidents / 1150 jobs');
  }
  return groups;
}

function parsePredictorEvents(events, runId) {
  return events.flatMap((event) => {
    try {
      const data = JSON.parse(event.message);
      return data.runId === runId ? [{ timestamp: event.timestamp, ...data }] : [];
    } catch { return []; }
  });
}

async function main() {
  if (!process.argv.includes('--execute-hd-smoke')) {
    throw new Error('explicit --execute-hd-smoke flag required; this command injects HD-only AWS jobs');
  }
  const { config, profile } = loadHdAwsConfiguration(path.join(root, 'experiments/hd/aws-ramp.json'));
  const runId = `hd-predictive-smoke-${randomUUID()}`;
  const runDir = path.join(root, 'artifacts/hd-smoke-runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const write = (name, value) => fs.writeFileSync(path.join(runDir, name), `${JSON.stringify(value, null, 2)}\n`);
  const manifest = { runId, classification: 'LIVE HD SMOKE ONLY; NOT FORMAL EXPERIMENT EVIDENCE',
    prefix, region, mode: 'hybrid', startedAt: at(), expectedJobs: 1150,
    incidentCount: 23, signalCount: 11, duplicateDeliveryCount: 2 };
  write('manifest.json', manifest);
  try {
    const workload = createHdAwsWorkload({ config, profile, repeatNumber: 1, executionNamespace: runId });
    const plan = buildPredictiveSmokePlan(workload);
    const control = await HdAwsControlPlane.create({ region, prefix });
    const preflight = await control.verifyHdPreflight('hybrid');
    const processingCost = await control.verifyProcessingCost(workload.processingCost);
    write('preflight.json', { preflight, processingCost });
    const analysisQueueUrl = await control.base.sqs.send(new control.base.sdk.sqs.GetQueueUrlCommand({
      QueueName: `${prefix}-analysis`,
    })).then((result) => result.QueueUrl);
    const ports = await createHdAwsPorts({ region, prefix,
      stateTableName: `${prefix}-predictor-state`, analysisQueueUrl });
    const signalQueueUrl = await control.signalQueueUrl();
    const deliverDuplicate = async (group) => {
      const signal = createAnalysisArrivalSignal({ runId, signalId: group.signalId,
        publishedJobCount: group.jobs.length, atMs: Date.now() });
      await control.base.sqs.send(new control.base.sdk.sqs.SendMessageCommand({
        QueueUrl: signalQueueUrl, MessageBody: JSON.stringify(signal), MessageGroupId: runId,
        // Distinct transport dedup ID deliberately exercises persisted logical-id deduplication.
        MessageDeduplicationId: `${group.signalId}-redelivery-${randomUUID()}`,
      }));
    };
    const dispatches = [];
    const samples = [];
    const epoch = Date.now();
    for (const group of plan) {
      await sleep(Math.max(0, epoch + group.offsetMs - Date.now()));
      const startedAt = at();
      const sent = await control.injectJobsWithSignal(group.jobs, { runId, signalId: group.signalId });
      if (sent !== group.jobs.length) throw new Error(`smoke signal ${group.index} incomplete`);
      dispatches.push({ index: group.index, startedAt, completedAt: at(),
        scheduledOffsetMs: group.offsetMs, jobs: sent, signalId: group.signalId,
        sourceEventIds: group.sourceEventIds });
      if (group.index === 0 || group.index === plan.length - 1) await deliverDuplicate(group);
      samples.push(await control.sample());
      write('dispatches.json', dispatches);
    }
    let state = null;
    let queuesClean = false;
    for (let attempt = 0; attempt < 36; attempt += 1) {
      const sample = await control.sample();
      samples.push(sample);
      state = await ports.getState(runId);
      try { await control.signalQueuesClean(); queuesClean = true; }
      catch { queuesClean = false; }
      if (state?.lastRequestedTasks > 1 && sample.service.runningCount > 1
        && sample.queue.visibleMessages === 0 && sample.queue.inFlightMessages === 0
        && queuesClean) break;
      await sleep(5000);
    }
    const finishedAt = at();
    manifest.finishedAt = finishedAt;
    write('manifest.json', manifest);
    write('samples.json', samples);
    write('predictor-state.json', state);
    const sources = plan.flatMap((group) => group.sourceEventIds);
    const accounting = await control.resultsForSources(sources, 1150);
    write('accounting.json', accounting);
    let workerLogs = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      workerLogs = await control.workerLogs({ startedAt: manifest.startedAt, finishedAt: at() });
      const taskIds = new Set(samples.flatMap((sample) => sample.tasks || [])
        .filter((task) => Date.parse(task.startedAt) >= Date.parse(manifest.startedAt))
        .map((task) => task.taskId.replace(/^ecs-/, '')));
      if (workerLogs.some((event) => event.message.includes('[WORKER_READY]')
        && [...taskIds].some((id) => event.logStreamName?.includes(id)))) break;
      await sleep(5000);
    }
    write('worker-logs.json', workerLogs);
    const predictorLogs = await control.predictorLogs({ startedAt: manifest.startedAt, finishedAt: at() });
    write('predictor-logs.json', predictorLogs);
    const scalingActivities = await control.scalingActivities();
    write('scaling-activities.json', scalingActivities.filter((activity) =>
      Date.parse(activity.StartTime) >= Date.parse(manifest.startedAt)));
    await sleep(60_000); // CloudWatch historical metric ingestion, outside smoke injection.
    const history = await control.collectHistory({ runId, startedAt: manifest.startedAt, finishedAt: at() });
    write('cloudwatch-history.json', history);
    const events = parsePredictorEvents(predictorLogs, runId);
    const requests = events.filter((event) => event.result?.scaleRequested);
    const newTasks = samples.flatMap((sample) => sample.tasks || [])
      .filter((task) => Date.parse(task.startedAt) >= Date.parse(manifest.startedAt));
    const newTaskIds = new Set(newTasks.map((task) => task.taskId.replace(/^ecs-/, '')));
    const ready = workerLogs.filter((event) => event.message.includes('[WORKER_READY]')
      && [...newTaskIds].some((id) => event.logStreamName?.includes(id)));
    const checks = {
      acceptedSignals: events.filter((event) => event.result?.acceptedJobs > 0).length === 11,
      duplicateDeliveriesSuppressed: events.filter((event) => event.result?.duplicate
        && event.result?.acceptedJobs === 0).length >= 2,
      stateRetainedElevenIds: state?.seenSignalIds?.length === 11,
      sensibleArrivalRate: history.predictive.AnalysisArrivalRate.some((point) => point.value >= 20
        && point.value <= 35),
      forecastPublished: history.predictive.PredictedArrivalRate.length > 0,
      recommendationPublished: history.predictive.PredictiveRecommendedTasks.some((point) =>
        point.value >= 2 && point.value <= 5),
      scaleRequestPublished: history.predictive.PredictiveScaleRequest.some((point) =>
        point.value >= 2 && point.value <= 5),
      onePredictiveRequest: requests.length === 1 && requests[0].result.target >= 2
        && requests[0].result.target <= 5,
      noPredictiveScaleIn: requests.every((event) => event.result.target >= 2),
      newEcsTaskRunning: newTaskIds.size > 0,
      newWorkerReady: ready.length > 0,
      jobsReconciled: accounting.resultsProduced === 1150 && accounting.duplicateResults === 0
        && accounting.queueRemaining === 0 && accounting.dlqDepth === 0,
      noWorkerErrors: !workerLogs.some((event) => event.message.includes('[PROCESSING-FAILED]')),
      signalQueuesClean: queuesClean,
      reactivePoliciesRetained: preflight.scaling.targetBacklogPerTask === 75
        && preflight.scaling.fastStepIncrease === 4,
      separateMetricNamespace: history.source === 'genuine historical CloudWatch GetMetricStatistics',
    };
    const summary = { classification: manifest.classification, runId, expectedJobs: 1150,
      completedJobs: accounting.resultsProduced, newTaskIds: [...newTaskIds],
      workerReadyEvents: ready.map((event) => ({ timestamp: event.timestamp,
        logStreamName: event.logStreamName, message: event.message })),
      scaleRequests: requests.map((event) => ({ timestamp: event.timestamp, result: event.result })),
      checks, passed: Object.values(checks).every(Boolean) };
    write('summary.json', summary);
    process.stdout.write(`HD PREDICTIVE SMOKE ${summary.passed ? 'PASS' : 'INCOMPLETE'} ${runDir}\n`);
    if (!summary.passed) process.exitCode = 1;
  } catch (error) {
    write('failure.json', { at: at(), message: error.message, stack: error.stack });
    process.stderr.write(`HD smoke STOPPED; artifact preserved at ${runDir}: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
