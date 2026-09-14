import test from 'node:test';
import assert from 'node:assert/strict';
import { createHdAwsWorkload, loadHdAwsConfiguration } from '../hd/aws/workload.js';

test('each HD class creates matched logical jobs with fresh arm identities', () => {
  for (const [file, expected] of [['aws-ramp.json', 16_500], ['aws-sudden-burst.json', 18_300]]) {
    const { config, profile } = loadHdAwsConfiguration(new URL(`../hd/${file}`, import.meta.url));
    const reactive = createHdAwsWorkload({ config, profile, repeatNumber: 1,
      executionNamespace: `${profile.name}-reactive-r1-test` });
    const hybrid = createHdAwsWorkload({ config, profile, repeatNumber: 1,
      executionNamespace: `${profile.name}-hybrid-r1-test` });
    assert.equal(reactive.expectedAnalysisJobs, expected);
    assert.equal(hybrid.expectedAnalysisJobs, expected);
    assert.equal(reactive.logicalDigest, hybrid.logicalDigest);
    assert.deepEqual(reactive.incidents.map((item) => item.scheduledOffsetSeconds),
      hybrid.incidents.map((item) => item.scheduledOffsetSeconds));
    assert.notEqual(reactive.incidents[0].jobs[0].jobId, hybrid.incidents[0].jobs[0].jobId);
    assert.equal(reactive.incidents.reduce((sum, item) => sum + item.jobs.length, 0), expected);
    assert.equal(reactive.incidents[0].jobs.length, 50);
  }
});
