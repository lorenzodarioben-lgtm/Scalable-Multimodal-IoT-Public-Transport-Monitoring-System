#!/usr/bin/env node
/** LOCAL DESIGN/TUNING EVIDENCE — NOT FINAL AWS HD EVIDENCE. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulateHdProfile, LOCAL_CLASSIFICATION } from './model.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const config = read('simulator/assumptions.json');
const ramp = read('predictable-ramp.json');
const burst = read('sudden-burst.json');
const flat = {
  ...ramp,
  name: 'hd-flat-noisy-local-diagnostic',
  workloadClass: 'FLAT_NOISY_LOCAL_DIAGNOSTIC',
  arrival: {
    mode: 'piecewise-incident-interval',
    segments: Array.from({ length: 21 }, (_, index) => ({
      startOffsetSeconds: index * 30,
      endOffsetSeconds: (index + 1) * 30,
      incidentIntervalSeconds: index % 2 === 0 ? 5 : 6,
    })),
  },
};

const baseline = Object.fromEntries([ramp, burst, flat].map((profile) => [
  profile.workloadClass,
  simulateHdProfile({ profile, mode: 'reactive', config }),
]));
const rows = [];
for (const historySize of [4, 6, 8]) {
  for (const predictionHorizonSeconds of [80, 100, 110, 120]) {
    for (const capacitySafetyFactor of [0.85, 1]) {
      for (const requiredConsecutiveRecommendations of [1, 2]) {
        const options = {
          historySize, predictionHorizonSeconds, capacitySafetyFactor,
          requiredConsecutiveRecommendations,
          minRisingSlopeJobsPerSecondSquared: 0.02,
          duplicateRequestCooldownSeconds: 60,
        };
        const outcomes = Object.fromEntries([ramp, burst, flat].map((profile) => [
          profile.workloadClass,
          simulateHdProfile({ profile, mode: 'hybrid', config, controllerOptions: options }),
        ]));
        const r = outcomes.PREDICTABLE_RAMP;
        const b = outcomes.SUDDEN_BURST;
        const f = outcomes.FLAT_NOISY_LOCAL_DIAGNOSTIC;
        rows.push({
          ...options,
          rampRequestSeconds: r.firstPredictiveRequestAtSeconds,
          rampReadySeconds: r.firstWorkerReadyAtSeconds,
          rampPeakBacklog: r.peakVisibleBacklog,
          rampPeakBptEquivalent: r.peakBacklogPerTaskEquivalent,
          rampOldestAgeSeconds: r.peakOldestAgeSeconds,
          rampDrainSeconds: r.drainSeconds,
          rampTaskSeconds: r.taskSeconds,
          rampMae: r.predictionMaeJobsPerSecond,
          rampBias: r.predictionBiasJobsPerSecond,
          rampMatchedForecasts: r.matchedForecasts,
          burstRequestSeconds: b.firstPredictiveRequestAtSeconds,
          burstReactiveRequestSeconds: b.firstReactiveRequestAtSeconds,
          burstPeakBacklog: b.peakVisibleBacklog,
          burstTaskSeconds: b.taskSeconds,
          burstMae: b.predictionMaeJobsPerSecond,
          burstBias: b.predictionBiasJobsPerSecond,
          flatFalsePredictiveScaleOuts: f.requests.filter((x) => x.source === 'predictive').length,
          flatTaskSeconds: f.taskSeconds,
        });
      }
    }
  }
}
const selectedOptions = {
  historySize: 8,
  predictionHorizonSeconds: 80,
  capacitySafetyFactor: 1,
  requiredConsecutiveRecommendations: 2,
  minRisingSlopeJobsPerSecondSquared: 0.02,
  duplicateRequestCooldownSeconds: 60,
};
const robustness = [];
for (const throughput of [41.640, 42.467, 43.350]) {
  for (const startup of [32.390, 40.047, 46]) {
    const varied = { ...config, singleTaskJobsPerSecond: throughput, taskReadyDelaySeconds: startup };
    for (const profile of [ramp, burst]) {
      const control = simulateHdProfile({ profile, mode: 'reactive', config: varied });
      const treatment = simulateHdProfile({ profile, mode: 'hybrid', config: varied, controllerOptions: selectedOptions });
      robustness.push({
        profile: profile.workloadClass, throughput, startup,
        reactivePeakBacklog: control.peakVisibleBacklog,
        hybridPeakBacklog: treatment.peakVisibleBacklog,
        reactiveTaskSeconds: control.taskSeconds,
        hybridTaskSeconds: treatment.taskSeconds,
        hybridFirstRequestSeconds: treatment.firstPredictiveRequestAtSeconds,
        hybridFirstReadySeconds: treatment.firstWorkerReadyAtSeconds,
      });
    }
  }
}
const output = {
  classification: LOCAL_CLASSIFICATION,
  notes: [
    'No AWS call or workload was executed. All queue, BPT, age and task-second values are local model outputs.',
    'The BPT equivalent is fluid visible backlog divided by running tasks, not a genuine historical CloudWatch datapoint.',
    'One-task throughput and fast-reactive delay are measurements from D; phase, linear multi-task capacity and fixed startup delay are assumptions.',
  ],
  config,
  baseline: Object.fromEntries(Object.entries(baseline).map(([name, result]) => [name, {
    firstAboveTargetAtSeconds: result.firstAboveTargetAtSeconds,
    firstReactiveRequestAtSeconds: result.firstReactiveRequestAtSeconds,
    firstWorkerReadyAtSeconds: result.firstWorkerReadyAtSeconds,
    peakVisibleBacklog: result.peakVisibleBacklog,
    peakBacklogPerTaskEquivalent: result.peakBacklogPerTaskEquivalent,
    peakOldestAgeSeconds: result.peakOldestAgeSeconds,
    drainSeconds: result.drainSeconds,
    taskSeconds: result.taskSeconds,
  }])),
  selectedOptions,
  robustness,
  candidates: rows,
};
const artifactDir = path.join(root, 'artifacts');
fs.mkdirSync(artifactDir, { recursive: true });
fs.writeFileSync(path.join(artifactDir, 'local-parameter-study.json'), `${JSON.stringify(output, null, 2)}\n`);
const fields = Object.keys(rows[0]);
const csvValue = (value) => value === null || value === undefined ? '' : String(value);
fs.writeFileSync(path.join(artifactDir, 'local-parameter-study.csv'), `${fields.join(',')}\n${rows.map(
  (row) => fields.map((field) => csvValue(row[field])).join(','),
).join('\n')}\n`);
process.stdout.write(`${LOCAL_CLASSIFICATION}\n${rows.length} candidates; ${artifactDir}\n`);
