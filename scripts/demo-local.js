#!/usr/bin/env node
/**
 * One-command local demonstration of the whole pipeline.
 *
 * Starts the local broker, the normalised->queue bridge, the telemetry
 * processor and both workers, runs the checkpoint simulator scenario through
 * them, then prints what ended up in each queue and table.
 *
 * Node-RED is NOT started here - it is a long-running editor process and is
 * started separately with `npm run node-red`. This script checks whether it is
 * listening and says so loudly if it is not, because without Node-RED nothing
 * is validated or normalised and the queue stays empty.
 *
 * This script creates NO AWS resources and costs nothing.
 *
 * Usage: npm run demo:local
 */
import process from 'node:process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LOCAL_DATA_DIR, MQTT, QUEUES, TABLES } from '@sit314/shared/config';
import { banner } from '@sit314/shared/logging';
import { getQueue } from '@sit314/shared/queues';
import { getStore } from '@sit314/shared/store';
import { sleep } from '@sit314/shared/util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const keepState = args.includes('--keep-state');

function portOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const children = [];
function start(name, script, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${name}]`.padEnd(24);
  child.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (line.trim()) process.stdout.write(`${prefix}${line}\n`);
    }
  });
  child.stderr.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (line.trim()) process.stderr.write(`${prefix}${line}\n`);
    }
  });
  children.push({ name, child });
  return child;
}

async function stopAll() {
  for (const { child } of children) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  await sleep(2000);
  for (const { child } of children) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

async function main() {
  process.stdout.write(`${banner('SIT314 local pipeline demonstration', {
    Mode: 'fully local - no AWS resources are created and nothing is billed',
    Broker: `mqtt://${MQTT.localHost}:${MQTT.localPort}`,
    Pipeline: 'simulator -> broker -> Node-RED -> bridge -> queues -> services',
    'State directory': LOCAL_DATA_DIR,
  })}\n`);

  if (!keepState && fs.existsSync(LOCAL_DATA_DIR)) {
    fs.rmSync(LOCAL_DATA_DIR, { recursive: true, force: true });
    process.stdout.write('Cleared previous local state (pass --keep-state to keep it).\n');
  }

  // ---- prerequisites ------------------------------------------------------
  const brokerUp = await portOpen(MQTT.localPort);
  if (!brokerUp) {
    process.stdout.write('\nStarting the local MQTT broker...\n');
    start('broker', 'scripts/local-broker.js');
    await sleep(2500);
  } else {
    process.stdout.write(`\nA broker is already listening on ${MQTT.localPort} - reusing it.\n`);
  }

  const nodeRedUp = await portOpen(1880);
  if (!nodeRedUp) {
    process.stdout.write(`\n${'!'.repeat(60)}\n`);
    process.stdout.write('Node-RED is NOT running on http://127.0.0.1:1880\n');
    process.stdout.write('It performs the mode-specific validation and normalisation, so\n');
    process.stdout.write('without it nothing reaches the telemetry queue.\n\n');
    process.stdout.write('Start it in another terminal, then re-run this script:\n');
    process.stdout.write('    npm run node-red\n');
    process.stdout.write(`${'!'.repeat(60)}\n\n`);
    process.exit(1);
  }
  process.stdout.write('Node-RED is running on http://127.0.0.1:1880\n');

  // ---- services -----------------------------------------------------------
  const quiet = { LOG_QUIET: 'false', WORKER_METRICS_INTERVAL_MS: '15000' };
  process.stdout.write('\nStarting the bridge and the three services...\n\n');
  start('bridge', 'scripts/normalized-bridge.js', { BRIDGE_VERBOSE: 'false', ...quiet });
  start('telemetry-processor', 'services/telemetry-processor/src/index.js', quiet);
  start('route-impact-worker', 'services/route-impact-worker/src/index.js',
    { ...quiet, WORKER_TASK_ID: 'demo-task-1' });
  start('notification-worker', 'services/notification-worker/src/index.js', quiet);
  await sleep(3000);

  // ---- workload -----------------------------------------------------------
  const simArgs = [
    path.join(ROOT, 'simulator/src/cli.js'),
    '--buses', flag('buses', '10'),
    '--trams', flag('trams', '5'),
    '--trains', flag('trains', '2'),
    '--locations', flag('locations', '10'),
    '--interval-ms', flag('interval-ms', '2000'),
    '--duration-ms', flag('duration-ms', '24000'),
    '--seed', flag('seed', '3142026'),
    '--scenario', flag('scenario', 'bus-breakdown'),
    '--disrupt-vehicle', flag('disrupt-vehicle', 'BUS-007'),
    '--disrupt-after-ticks', flag('disrupt-after-ticks', '4'),
    '--invalid-rate', flag('invalid-rate', '0.05'),
    '--target', 'mqtt',
    '--print-every-nth', '6',
  ];

  process.stdout.write(`\n${'='.repeat(60)}\nRunning the checkpoint scenario\n${'='.repeat(60)}\n`);
  const sim = spawn(process.execPath, simArgs, { cwd: ROOT, stdio: 'inherit' });
  await new Promise((resolve) => sim.once('exit', resolve));

  // ---- let the pipeline finish -------------------------------------------
  process.stdout.write('\nWaiting for the pipeline to drain...\n');
  const analysisQueue = getQueue(QUEUES.analysis);
  const notificationQueue = getQueue(QUEUES.notifications);
  const telemetryQueue = getQueue(QUEUES.telemetry);
  const deadline = Date.now() + 90000;
  for (;;) {
    const [t, a, n] = await Promise.all([
      telemetryQueue.getAttributes(), analysisQueue.getAttributes(), notificationQueue.getAttributes(),
    ]);
    const outstanding = t.approximateNumberOfMessages + t.approximateNumberOfMessagesNotVisible
      + a.approximateNumberOfMessages + a.approximateNumberOfMessagesNotVisible
      + n.approximateNumberOfMessages + n.approximateNumberOfMessagesNotVisible;
    if (outstanding === 0 || Date.now() > deadline) break;
    process.stdout.write(`  outstanding: telemetry=${t.approximateNumberOfMessages} `
      + `analysis=${a.approximateNumberOfMessages} notifications=${n.approximateNumberOfMessages}\n`);
    await sleep(3000);
  }

  await stopAll();

  // ---- report -------------------------------------------------------------
  const store = getStore();
  const counts = {};
  for (const [label, table] of Object.entries(TABLES)) {
    counts[label] = await store.count(table);
  }
  const dlq = {
    telemetry: (await getQueue(QUEUES.telemetryDlq).getAttributes()).approximateNumberOfMessages,
    analysis: (await getQueue(QUEUES.analysisDlq).getAttributes()).approximateNumberOfMessages,
    notifications: (await getQueue(QUEUES.notificationsDlq).getAttributes()).approximateNumberOfMessages,
  };

  process.stdout.write(`\n${banner('Local pipeline result', {
    'Events processed (ProcessedEvents)': counts.processedEvents,
    'Entities tracked (CurrentState)': counts.currentState,
    'Route impact results': counts.analysisResults,
    'Simulated notifications': counts.notifications,
    'Telemetry DLQ': dlq.telemetry,
    'Analysis DLQ': dlq.analysis,
    'Notifications DLQ': dlq.notifications,
  })}\n`);

  process.stdout.write('\nInspect the stored records with:\n');
  process.stdout.write('  npm run queue:stats\n');
  process.stdout.write('  npm run state:dump -- --table analysis-results --limit 5\n');
  process.exit(0);
}

process.on('SIGINT', async () => { await stopAll(); process.exit(130); });

main().catch(async (err) => {
  process.stderr.write(`${err.stack}\n`);
  await stopAll();
  process.exit(1);
});
