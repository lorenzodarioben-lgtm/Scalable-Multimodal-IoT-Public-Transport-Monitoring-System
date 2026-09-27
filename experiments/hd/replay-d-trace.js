#!/usr/bin/env node
/** Read-only replay of actual final-D dispatch completions and coarse SQS/ECS samples. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HybridPredictiveController } from './predictive-controller.js';

export const REPLAY_CLASSIFICATION = 'OFFLINE SANITY CHECK ONLY; NOT FINAL HD EVIDENCE';
const hdRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultDRun = path.resolve(hdRoot, '../artifacts/aws-runs/2026-09-22T10-51-14-826Z-incident-stage-1-autoscale-r1');

const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const jsonl = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);

export function replayDTrace({ runDirectory = defaultDRun,
  frozen = json(path.join(hdRoot, 'experiments/hd/final-controller-config.json')) } = {}) {
  const manifest = json(path.join(runDirectory, 'manifest.json'));
  const timing = json(path.join(runDirectory, 'injection-timing.json'));
  if (timing.status !== 'VALID' || timing.submittedJobs !== manifest.workload.expectedAnalysisJobs) {
    throw new Error('D trace is not a complete valid injection');
  }
  const start = Date.parse(manifest.workloadStartedAt);
  const dispatches = jsonl(path.join(runDirectory, 'dispatches.jsonl'))
    .filter((item) => item.status === 'submitted' && item.actualDispatchCompletedAt);
  const bySequence = new Map();
  for (const dispatch of dispatches) {
    if (bySequence.has(dispatch.sequence)) throw new Error('duplicate completed D dispatch record');
    bySequence.set(dispatch.sequence, dispatch);
  }
  if (bySequence.size !== manifest.workload.incidentCount) throw new Error('D dispatch records are incomplete');
  const samples = jsonl(path.join(runDirectory, 'samples.jsonl'))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const controller = new HybridPredictiveController({
    historySize: frozen.historySize,
    predictionHorizonSeconds: frozen.predictionHorizonSeconds,
    perTaskSustainableJobsPerSecond: frozen.perTaskSustainableJobsPerSecond * frozen.capacitySafetyFactor,
    minRisingSlopeJobsPerSecondSquared: frozen.minRisingSlopeJobsPerSecondSquared,
    requiredConsecutiveRecommendations: frozen.requiredConsecutiveRecommendations,
    duplicateRequestCooldownSeconds: frozen.duplicateRequestCooldownSeconds,
    targetBacklogPerTask: frozen.targetBacklogPerTask,
    minTasks: frozen.minTasks, maxTasks: frozen.maxTasks,
  });
  const trace = [];
  let sampleIndex = 0;
  for (let endOffset = frozen.sampleIntervalSeconds;
    endOffset <= timing.plannedInjectionDurationSeconds; endOffset += frozen.sampleIntervalSeconds) {
    const endAtMs = start + endOffset * 1000;
    while (sampleIndex + 1 < samples.length && Date.parse(samples[sampleIndex + 1].timestamp) <= endAtMs) {
      sampleIndex += 1;
    }
    const sample = samples[sampleIndex];
    const jobs = [...bySequence.values()].filter((item) => {
      const at = Date.parse(item.actualDispatchCompletedAt);
      return at > endAtMs - frozen.sampleIntervalSeconds * 1000 && at <= endAtMs;
    }).reduce((sum, item) => sum + item.submittedJobs, 0);
    const running = sample.service.runningCount;
    const desired = sample.service.desiredCount;
    const visible = sample.queue.visibleMessages;
    const decision = controller.observe({ atMs: endAtMs,
      arrivalRateJobsPerSecond: jobs / frozen.sampleIntervalSeconds,
      visibleBacklog: visible, backlogPerTask: visible / Math.max(1, running),
      runningTasks: running, desiredTasks: desired, reactiveRequiredTasks: desired });
    trace.push({ endOffsetSeconds: endOffset, acceptedJobsInBin: jobs,
      observedRateJobsPerSecond: jobs / frozen.sampleIntervalSeconds,
      queueSampleAgeSeconds: Number(((endAtMs - Date.parse(sample.timestamp)) / 1000).toFixed(3)),
      sampledVisibleBacklog: visible, sampledRunningTasks: running,
      sampledDesiredTasks: desired, forecastRateJobsPerSecond: decision.predictedArrivalRateJobsPerSecond ?? null,
      recommendation: decision.recommendedTasks, wouldRequestScaleOut: decision.shouldRequestScaleOut,
      reason: decision.reason });
  }
  const proposed = trace.filter((item) => item.wouldRequestScaleOut);
  return {
    classification: REPLAY_CLASSIFICATION,
    sourceRunId: manifest.runId,
    sourcePaths: ['manifest.json', 'injection-timing.json', 'dispatches.jsonl', 'samples.jsonl'],
    provenance: 'Read-only original D fast-reactive retest artifact, not an HD run',
    inputLimitations: [
      'Dispatch completion is the last observed batch completion, not a per-job SQS acceptance timestamp.',
      'SQS/ECS samples are about ten seconds apart; hold-last replay does not recover state between samples.',
      'Sampled visible/running ratio is an inferred controller input, not historical CloudWatch BacklogPerTask.',
      'Original D capacity is replayed as observed. Proposed HD requests are not applied, so this cannot predict counterfactual backlog or savings.',
    ],
    dispatchedIncidents: bySequence.size,
    completedDispatchJobs: [...bySequence.values()].reduce((sum, item) => sum + item.submittedJobs, 0),
    bins: trace.length,
    firstRecommendation: proposed[0] ?? null,
    recommendationCount: proposed.length,
    maxQueueSampleAgeSeconds: Math.max(...trace.map((item) => item.queueSampleAgeSeconds)),
    trace,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = replayDTrace();
  const output = path.join(hdRoot, 'experiments/hd/artifacts/d-trace-replay.json');
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${REPLAY_CLASSIFICATION}\n${result.sourceRunId}; ${result.bins} bins; ${result.recommendationCount} proposed requests\n`);
}
