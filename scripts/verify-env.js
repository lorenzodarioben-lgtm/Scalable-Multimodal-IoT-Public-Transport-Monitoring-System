#!/usr/bin/env node
/**
 * Environment check.
 *
 * Reports what this machine can and cannot do, so a blocker is obvious before
 * you start rather than halfway through a deployment. Never prints a secret,
 * an account id or a credential.
 *
 * Usage: npm run verify-env
 */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BACKENDS, MQTT, QUEUES, REGION, REPO_ROOT, TABLES } from '@sit314/shared/config';
import { banner } from '@sit314/shared/logging';

const results = [];
const record = (name, ok, detail, required = true) => results.push({ name, ok, detail, required });

function tryCommand(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // On Windows, npm/aws are .cmd shims that execFile cannot launch directly.
      shell: process.platform === 'win32',
    }).trim();
  } catch {
    return null;
  }
}

// ---- toolchain -------------------------------------------------------------
const nodeMajor = Number(process.versions.node.split('.')[0]);
record('Node.js >= 20', nodeMajor >= 20, `v${process.versions.node}`);

const npmVersion = tryCommand('npm', ['--version']);
record('npm', Boolean(npmVersion), npmVersion ?? 'not found');

const gitVersion = tryCommand('git', ['--version']);
record('git', Boolean(gitVersion), gitVersion ?? 'not found', false);

const gitUser = tryCommand('git', ['config', 'user.name']);
const gitEmail = tryCommand('git', ['config', 'user.email']);
record('git identity configured', Boolean(gitUser && gitEmail),
  gitUser && gitEmail ? 'set (commits possible)' : 'not set - commits will be skipped', false);

// ---- container tooling -----------------------------------------------------
const dockerVersion = tryCommand('docker', ['--version']);
record('Docker CLI', Boolean(dockerVersion), dockerVersion ?? 'not found', false);
const dockerDaemon = dockerVersion ? tryCommand('docker', ['info', '--format', '{{.ServerVersion}}']) : null;
record('Docker daemon running', Boolean(dockerDaemon),
  dockerDaemon ? `server ${dockerDaemon}` : 'not reachable - image builds and docker compose are blocked', false);

// ---- AWS -------------------------------------------------------------------
const awsVersion = tryCommand('aws', ['--version']);
record('AWS CLI', Boolean(awsVersion), awsVersion ?? 'not found - AWS deployment is blocked', false);

let awsIdentity = null;
if (awsVersion) {
  const out = tryCommand('aws',
    ['sts', 'get-caller-identity', '--query', 'Arn', '--output', 'text']);
  awsIdentity = out;
}
record('AWS credentials', Boolean(awsIdentity),
  awsIdentity
    // Only a short suffix, so the account id never lands in a screenshot.
    ? `authenticated (ARN ends ...${awsIdentity.slice(-20)})`
    : 'no usable credentials - the project still runs fully in local mode',
  false);

// ---- project files ---------------------------------------------------------
const hasEnv = fs.existsSync(path.join(REPO_ROOT, '.env'));
record('.env present', hasEnv, hasEnv ? 'found' : 'not found - defaults from .env.example apply', false);

const nodeModules = fs.existsSync(path.join(REPO_ROOT, 'node_modules'));
record('dependencies installed', nodeModules, nodeModules ? 'node_modules present' : 'run: npm install');

const flows = path.join(REPO_ROOT, 'node-red', 'flows.json');
record('Node-RED flow present', fs.existsSync(flows), fs.existsSync(flows) ? 'node-red/flows.json' : 'run: npm run flows:build');

const schemaCount = fs.existsSync(path.join(REPO_ROOT, 'schemas'))
  ? fs.readdirSync(path.join(REPO_ROOT, 'schemas')).filter((f) => f.endsWith('.json')).length
  : 0;
record('JSON schemas', schemaCount >= 8, `${schemaCount} schema files`);

// ---- MQTT TLS configuration (only relevant in AWS mode) --------------------
if (MQTT.mode === 'aws') {
  for (const [label, file] of [
    ['IoT CA certificate', MQTT.caPath],
    ['IoT client certificate', MQTT.certPath],
    ['IoT private key', MQTT.keyPath],
  ]) {
    record(label, Boolean(file) && fs.existsSync(file),
      file ? (fs.existsSync(file) ? 'present' : `missing: ${file}`) : 'not configured');
  }
  record('IoT endpoint configured', Boolean(MQTT.awsEndpoint),
    MQTT.awsEndpoint ? 'set' : 'AWS_IOT_ENDPOINT is empty');
} else {
  record('MQTT mode', true, 'local broker (set MQTT_MODE=aws for AWS IoT Core over TLS)', false);
}

// ---- report ----------------------------------------------------------------
process.stdout.write(`${banner('SIT314 environment check', {
  Platform: `${process.platform} ${process.arch}`,
  'Queue backend': BACKENDS.queue,
  'Store backend': BACKENDS.store,
  'Metrics backend': BACKENDS.metrics,
  'AWS region': REGION,
  'MQTT mode': MQTT.mode,
  Queues: Object.values(QUEUES).length,
  Tables: Object.values(TABLES).length,
})}\n`);

let requiredFailures = 0;
for (const r of results) {
  const mark = r.ok ? 'OK  ' : (r.required ? 'FAIL' : 'WARN');
  if (!r.ok && r.required) requiredFailures += 1;
  process.stdout.write(`[${mark}] ${r.name.padEnd(30)} ${r.detail}\n`);
}

process.stdout.write('\n');
if (requiredFailures > 0) {
  process.stdout.write(`${requiredFailures} required check(s) failed.\n`);
  process.exit(1);
}
process.stdout.write('All required checks passed.\n');
process.stdout.write('Local pipeline:  npm run demo:local\n');
process.stdout.write('AWS deployment:  see docs/AWS_DEPLOYMENT.md\n');
