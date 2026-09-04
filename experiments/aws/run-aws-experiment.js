#!/usr/bin/env node
/** CLI entry point for a later credentialed AWS session. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PREFIX, REGION } from '@sit314/shared/config';
import { AwsControlPlane } from './control-plane.js';
import { runAwsExperiment } from './runner.js';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) { args[key] = next; index += 1; }
    else args[key] = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config || !args['worker-mode'] || !args.repeat) {
    process.stderr.write('usage: npm run experiment:aws -- --config <stage.json> --worker-mode fixed|autoscale --repeat 1\n');
    process.exitCode = 2;
    return;
  }
  const configPath = path.resolve(args.config);
  const stage = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const controller = await AwsControlPlane.create({ region: args.region || REGION, prefix: args.prefix || PREFIX });
  const result = await runAwsExperiment({
    stage,
    mode: args['worker-mode'],
    repeatNumber: Number(args.repeat),
    controller,
    executionNamespace: args['execution-namespace'],
  });
  process.stdout.write(`AWS experiment complete: ${result.runDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`AWS experiment failed: ${error.message}\n`);
  process.exitCode = 1;
});
