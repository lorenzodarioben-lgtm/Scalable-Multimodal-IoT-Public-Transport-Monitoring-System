#!/usr/bin/env node
/**
 * Checkpoint demonstration.
 *
 * WHAT IT DOES
 * Runs the approved preliminary demo scenario against whichever backend is
 * currently configured:
 *
 *   10 buses, 5 trams, 2 trains, 10 demand locations, interval 2s, seed 3142026
 *   -> normal multimodal telemetry
 *   -> BUS-007 breaks down
 *   -> the processor detects the incident and fans it out into 50 jobs
 *   -> the route-impact worker produces ETA/impact results
 *   -> 200 simulated notification records are written
 *
 * WHAT IT DOES NOT DO
 * It never creates AWS infrastructure. If QUEUE_BACKEND/STORE_BACKEND are set
 * to `aws` it only CHECKS that the queues and tables already exist, and if they
 * do not it prints the exact prerequisite commands and exits non-zero.
 * Deploying infrastructure is a deliberate, separate action - see
 * docs/AWS_DEPLOYMENT.md.
 *
 * Usage:
 *   npm run demo:checkpoint             # uses the configured backends
 *   npm run demo:checkpoint -- --check  # preflight only, run nothing
 */
import process from 'node:process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKENDS, QUEUES, REPO_ROOT, TABLES } from '@sit314/shared/config';
import { banner } from '@sit314/shared/logging';
import { getQueue } from '@sit314/shared/queues';
import { getStore } from '@sit314/shared/store';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const checkOnly = process.argv.includes('--check');

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  const mark = ok === true ? 'OK  ' : ok === false ? 'FAIL' : 'WARN';
  console.log(`[${mark}] ${name.padEnd(32)} ${detail}`);
};

/** Confirms each queue answers a GetQueueAttributes-style call. */
async function checkQueues() {
  for (const [label, name] of Object.entries(QUEUES)) {
    try {
      const attrs = await getQueue(name).getAttributes();
      record(`queue ${label}`, true, `${name} depth=${attrs.approximateNumberOfMessages}`);
    } catch (err) {
      record(`queue ${label}`, false, `${name} unreachable - ${err.name || err.message}`);
    }
  }
}

/** Confirms each table answers a read. A missing table throws here. */
async function checkTables() {
  const store = getStore();
  for (const [label, name] of Object.entries(TABLES)) {
    try {
      const count = await store.count(name);
      record(`table ${label}`, true, `${name} items=${count}`);
    } catch (err) {
      record(`table ${label}`, false, `${name} unreachable - ${err.name || err.message}`);
    }
  }
}

function printPrerequisites() {
  console.log('\nPrerequisites are not met for the AWS backend.\n');
  console.log('Deploy the infrastructure first (see docs/AWS_DEPLOYMENT.md):');
  console.log('  aws sts get-caller-identity');
  console.log('  ./infrastructure/scripts/deploy.ps1 -Stack queues');
  console.log('  ./infrastructure/scripts/deploy.ps1 -Stack dynamodb');
  console.log('  ./infrastructure/scripts/deploy.ps1 -Stack iot-rule');
  console.log('\nOr run the whole checkpoint locally instead, with no AWS account:');
  console.log('  npm run demo:local');
}

/** Streams the local pipeline demo, which owns the broker/bridge/worker processes. */
function runLocalDemo() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'demo-local.js')], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main() {
  console.log(banner('sit314 checkpoint demonstration', {
    'Queue backend': BACKENDS.queue,
    'Store backend': BACKENDS.store,
    'Metrics backend': BACKENDS.metrics,
    Scenario: 'bus-breakdown (BUS-007)',
    Seed: 3142026,
    'Expected fan-out': '50 analysis jobs, 200 notifications per incident',
  }));

  await checkQueues();
  await checkTables();

  const failures = results.filter((r) => r.ok === false);
  const usingAws = BACKENDS.queue === 'aws' || BACKENDS.store === 'aws';

  if (failures.length) {
    console.log(`\n${failures.length} prerequisite check(s) failed.`);
    if (usingAws) printPrerequisites();
    else console.log('Local backends failed unexpectedly - check filesystem permissions.');
    process.exitCode = 1;
    return;
  }

  console.log('\nAll prerequisites satisfied.');
  if (checkOnly) {
    console.log('--check given, so no workload was run.');
    return;
  }

  if (usingAws) {
    // The AWS path deliberately stops here in this build: the simulator and the
    // workers must be pointed at the deployed endpoints, which is a documented
    // manual step rather than something this script should improvise.
    console.log('\nAWS backends are configured and reachable.');
    console.log('Run the checkpoint workload against them with:');
    console.log('  npm run simulate -- --scenario bus-breakdown --disrupt-vehicle BUS-007 \\');
    console.log('    --buses 10 --trams 5 --trains 2 --locations 10 --interval-ms 2000 \\');
    console.log('    --seed 3142026 --target mqtt --mqtt-mode aws --duration-seconds 60');
    console.log('  npm run processor      # in a second terminal');
    console.log('  npm run route-worker   # in a third terminal');
    console.log('\nSee docs/AWS_DEPLOYMENT.md for the full sequence.');
    return;
  }

  console.log('\nRunning the checkpoint workload through the local pipeline...\n');
  process.exitCode = await runLocalDemo();
}

main().catch((err) => {
  console.error(`[ERROR] ${err.message}`);
  process.exitCode = 1;
});
