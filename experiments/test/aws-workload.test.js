import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFormalWorkload, expectedIncidentCount, validateFormalStage } from '../aws/workload.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const stage = JSON.parse(fs.readFileSync(path.join(here, '..', 'incident', 'stage-1.json'), 'utf8'));

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
