#!/usr/bin/env node
/**
 * Simulator command line entry point.
 *
 * Examples:
 *   npm run simulate -- --buses 10 --trams 5 --trains 2 --locations 10 --interval-ms 5000
 *   npm run simulate -- --buses 100 --trams 25 --trains 15 --locations 100 --interval-ms 1000
 *   npm run simulate -- --scenario bus-breakdown --disrupt-vehicle BUS-007 --target mqtt
 *   npm run simulate -- --config experiments/telemetry-growth/stage-1.json
 */
import process from 'node:process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { CLI_OPTIONS, resolveConfig } from './config.js';
import { Simulator } from './simulator.js';

async function main() {
  const parser = yargs(hideBin(process.argv))
    .scriptName('simulate')
    .usage('$0 [options]')
    .options({
      ...CLI_OPTIONS,
      'validate-only': {
        type: 'boolean',
        describe: 'Generate one reporting cycle, validate every payload, then exit',
      },
      'print-config': { type: 'boolean', describe: 'Print the resolved configuration and exit' },
    })
    .example('$0 --buses 10 --trams 5 --trains 2 --locations 10 --interval-ms 5000', 'small demo workload')
    .example('$0 --buses 1000 --trams 0 --trains 0 --locations 0 --interval-ms 1000', 'high velocity stage')
    .example('$0 --scenario bus-breakdown --disrupt-vehicle BUS-007', 'inject a breakdown')
    .help()
    .strict(false)
    .wrap(Math.min(110, process.stdout.columns || 110));

  const argv = parser.parseSync();

  let cfg;
  try {
    cfg = resolveConfig(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }

  if (argv['print-config']) {
    process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
    return;
  }

  const simulator = new Simulator(cfg);

  if (argv['validate-only']) {
    process.stdout.write(`${simulator.banner()}\n`);
    const result = simulator.selfCheck();
    process.stdout.write(`\n[SELF-CHECK] generated=${result.total} valid=${result.valid} invalid=${result.invalid.length}\n`);
    for (const bad of result.invalid.slice(0, 10)) {
      process.stdout.write(`  [INVALID] ${bad.event.eventId} ${bad.errors.join('; ')}\n`);
    }
    process.exit(result.invalid.length === 0 ? 0 : 1);
  }

  // Ctrl+C prints the final summary rather than dropping the run on the floor.
  let shuttingDown = false;
  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    simulator.stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    const summary = await simulator.run();
    process.stdout.write(`\n[RUN-COMPLETE] published=${summary.publishedEvents} `
      + `failed=${summary.failedEvents} rate=${summary.eventsPerSecond}/s `
      + `elapsed=${summary.elapsedSeconds}s\n`);
  } catch (err) {
    process.stderr.write(`\n[SIMULATOR-ERROR] ${err.message}\n`);
    await simulator.shutdown().catch(() => {});
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
