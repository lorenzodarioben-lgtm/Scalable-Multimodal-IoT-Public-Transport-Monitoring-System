import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFormalWorkload, expectedIncidentCount, validateFormalStage } from '../aws/workload.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const stage = JSON.parse(fs.readFileSync(path.join(here, '..', 'incident', 'stage-1.json'), 'utf8'));
const calibration = JSON.parse(fs.readFileSync(
  path.join(here, '..', 'calibration', 'aws-stage-1-capacity.json'), 'utf8',
));
const timingSanity = JSON.parse(fs.readFileSync(
  path.join(here, '..', 'calibration', 'aws-injector-timing-sanity.json'), 'utf8',
));

test('formal AWS workload is count-bounded and uses the declared seed', () => {
  assert.equal(expectedIncidentCount(stage), 63);
  assert.doesNotThrow(() => validateFormalStage(stage));
  assert.throws(() => validateFormalStage({ ...stage, arrival: { ...stage.arrival, incidents: 62 } }),
    /arrival\.incidents must be 63/);
  assert.throws(() => validateFormalStage({ ...stage, arrival: { ...stage.arrival, mode: 'sustained' } }),
    /count-bounded/);
  assert.throws(() => validateFormalStage({
    ...stage, worker: { ...stage.worker, processingCpuIterations: undefined },
  }), /processingCpuIterations=0/);
});

test('fixed and autoscaled arms share logical work but never reuse idempotency identities', () => {
  const fixed = createFormalWorkload(stage, { repeatNumber: 1, executionNamespace: 'fixed-run-1' });
  const autoscale = createFormalWorkload(stage, { repeatNumber: 1, executionNamespace: 'autoscale-run-1' });
  assert.equal(fixed.logicalWorkloadId, autoscale.logicalWorkloadId);
  assert.equal(fixed.logicalDigest, autoscale.logicalDigest);
  assert.notEqual(fixed.incidents[0].jobs[0].jobId, autoscale.incidents[0].jobs[0].jobId);
  assert.notEqual(fixed.incidents[0].jobs[0].sourceEventId, autoscale.incidents[0].jobs[0].sourceEventId);
  assert.equal(fixed.expectedAnalysisJobs, 3150);
  assert.equal(fixed.processingCost.processingCpuIterations, 0);
});

test('AWS capacity calibration is count-bounded and explicitly excluded from formal evidence', () => {
  assert.doesNotThrow(() => validateFormalStage(calibration));
  assert.deepEqual(calibration.evidenceClassification, {
    status: 'CALIBRATION ONLY',
    prohibition: 'NOT FORMAL EVIDENCE',
  });
  assert.equal(calibration.warmupSeconds, 30);
  assert.equal(calibration.durationSeconds, 150);
  assert.equal(calibration.arrival.incidentIntervalSeconds, 1);
  assert.equal(calibration.arrival.incidents, 180);
  assert.equal(expectedIncidentCount(calibration), 180);
  assert.equal(calibration.incident.jobsPerIncident, 50);
  assert.equal(calibration.arrival.incidents * calibration.incident.jobsPerIncident, 9000);
  assert.deepEqual(calibration.timingGuard, {
    maxDispatchStartLagIntervals: 1,
    sustainedStartLagIntervals: 0.5,
    sustainedStartLagIncidents: 3,
  });
  assert.equal(calibration.worker.processingDelayMs, 50);
  assert.equal(calibration.worker.processingCpuIterations, 0);
  assert.equal(calibration.worker.minTasks, 1);
  assert.equal(calibration.worker.maxTasks, 5);
  assert.equal(calibration.worker.targetBacklogPerTask, 75);
  // This is an explicit guard against the calibration silently replacing stage 1.
  assert.equal(stage.arrival.incidentIntervalSeconds, 10);
  assert.equal(stage.arrival.incidents, 63);
});

test('AWS injector timing sanity check is isolated and retains fifty unique jobs per incident', () => {
  assert.doesNotThrow(() => validateFormalStage(timingSanity));
  assert.deepEqual(timingSanity.evidenceClassification, {
    status: 'INJECTOR TIMING SANITY CHECK ONLY',
    prohibition: 'NOT CALIBRATION EVIDENCE. NOT FORMAL EVIDENCE',
  });
  assert.equal(timingSanity.arrival.incidentIntervalSeconds, 1);
  assert.equal(timingSanity.arrival.incidents, 30);
  assert.equal(timingSanity.incident.jobsPerIncident, 50);
  const workload = createFormalWorkload(timingSanity, {
    repeatNumber: 1,
    executionNamespace: 'timing-sanity-unit',
  });
  assert.equal(workload.expectedAnalysisJobs, 1500);
  assert.equal(workload.incidents[0].jobs.length, 50);
  assert.equal(new Set(workload.incidents[0].jobs.map((job) => job.jobId)).size, 50);
});
