#!/usr/bin/env node
/** Tomorrow-only CLI. Merely importing supporting modules makes no AWS call. */
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { loadHdAwsConfiguration } from './workload.js';
import { HdAwsControlPlane } from './control-plane.js';
import { runHdAwsExperiment } from './runner.js';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    if (argv[index + 1] && !argv[index + 1].startsWith('--')) args[key] = argv[++index];
    else args[key] = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['execute-hd-aws'] !== true || !args.config || !args.arm || !args.repeat) {
    throw new Error('usage: node experiments/hd/aws/run-hd-aws-experiment.js --execute-hd-aws --config experiments/hd/aws-ramp.json --arm reactive|hybrid --repeat 1 --prefix sit314-hd-transport');
  }
  const prefix = args.prefix || 'sit314-hd-transport';
  if (!prefix.startsWith('sit314-hd-')) throw new Error('HD-only resource prefix required');
  const { config, profile } = loadHdAwsConfiguration(args.config);
  const arm = args.arm;
  const repeatNumber = Number(args.repeat);
  const controller = await HdAwsControlPlane.create({ region: args.region || 'us-east-1', prefix });
  const outcome = await runHdAwsExperiment({
    config, profile, arm, repeatNumber, controller,
    executionNamespace: `${profile.name}-${arm}-r${repeatNumber}-${randomUUID()}`,
  });
  process.stdout.write(`${outcome.summary.validity}: ${outcome.runDir}\n`);
  if (outcome.summary.validity !== 'PENDING_MANUAL_TIMELINE_REVIEW') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`HD AWS run stopped: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
