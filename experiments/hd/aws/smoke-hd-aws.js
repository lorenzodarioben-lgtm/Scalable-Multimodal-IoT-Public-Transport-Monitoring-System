#!/usr/bin/env node
/** Tomorrow-only bounded two-incident integration smoke test. No automatic invocation. */
import { randomUUID } from 'node:crypto';
import { loadHdAwsConfiguration, createHdAwsWorkload } from './workload.js';
import { HdAwsControlPlane } from './control-plane.js';

async function main() {
  if (!process.argv.includes('--execute-hd-smoke')) {
    throw new Error('explicit --execute-hd-smoke flag required; this command calls AWS tomorrow only');
  }
  const prefix = 'sit314-hd-transport';
  const { config, profile } = loadHdAwsConfiguration('experiments/hd/aws-ramp.json');
  const runId = `hd-smoke-${randomUUID()}`;
  const workload = createHdAwsWorkload({ config, profile, repeatNumber: 1, executionNamespace: runId });
  const control = await HdAwsControlPlane.create({ region: 'us-east-1', prefix });
  const baseline = await control.verifyHdPreflight('reactive');
  await control.verifyProcessingCost(workload.processingCost);
  for (const incident of workload.incidents.slice(0, 2)) {
    const sent = await control.injectJobsWithSignal(incident.jobs,
      { runId, signalId: incident.sourceEventId });
    if (sent !== incident.jobs.length) throw new Error('smoke injection incomplete');
    await new Promise((resolve) => setTimeout(resolve, 11_000));
  }
  let last;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    last = await control.sample();
    if ((last.queue.visibleMessages ?? 0) + (last.queue.inFlightMessages ?? 0) === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if ((last.queue.visibleMessages ?? 0) + (last.queue.inFlightMessages ?? 0) !== 0) {
    throw new Error(`HD smoke analysis queue failed to drain: ${JSON.stringify(last.queue)}`);
  }
  await control.signalQueuesClean();
  const sources = workload.incidents.slice(0, 2).map((item) => item.sourceEventId);
  const result = await control.resultsForSources(sources, 100);
  if (result.resultsProduced !== 100 || result.duplicateResults || result.dlqDepth
    || result.lostOrUnaccounted) throw new Error(`HD smoke accounting failed: ${JSON.stringify(result)}`);
  process.stdout.write(`HD smoke PASS runId=${runId}; 100/100 jobs; starting=${JSON.stringify(baseline.service)}\n`);
  process.stdout.write('Wait for the 10-second HD arrival-rate datapoint and verify predictor state/metrics manually before full runs.\n');
}

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
