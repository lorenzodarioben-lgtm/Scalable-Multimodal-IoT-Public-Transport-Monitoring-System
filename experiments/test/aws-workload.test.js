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
  assert.equal(calibration.arrival.incidentIntervalSeconds, 3);
  assert.equal(calibration.arrival.incidents, 60);
  assert.equal(expectedIncidentCount(calibration), 60);
  assert.equal(calibration.incident.jobsPerIncident, 50);
  assert.equal(calibration.arrival.incidents * calibration.incident.jobsPerIncident, 3000);
  assert.equal(calibration.worker.processingDelayMs, 50);
  assert.equal(calibration.worker.processingCpuIterations, 0);
  assert.equal(calibration.worker.minTasks, 1);
  assert.equal(calibration.worker.maxTasks, 5);
  assert.equal(calibration.worker.targetBacklogPerTask, 75);
  // This is an explicit guard against the calibration silently replacing stage 1.
  assert.equal(stage.arrival.incidentIntervalSeconds, 10);
  assert.equal(stage.arrival.incidents, 63);
});
