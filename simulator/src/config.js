/**
 * Simulator configuration resolution.
 *
 * What: turns command-line flags and/or a JSON config file into one resolved
 *       run configuration.
 * Why:  Volume (how many entities) and Velocity (how often they report) must be
 *       changeable from the command line without editing source code. The same
 *       resolver reads the experiment stage files so an experiment is exactly
 *       the same run as a manual command with the same numbers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MQTT } from '@sit314/shared/config';
import { SCENARIO_NAMES } from './scenarios/index.js';

export const DEFAULTS = {
  buses: 10,
  trams: 5,
  trains: 2,
  locations: 10,
  intervalMs: 5000,
  demandIntervalMs: null, // defaults to intervalMs
  durationMs: 60000,
  seed: 3142026,
  scenario: 'normal',
  target: 'stdout', // stdout | mqtt
  mqttMode: MQTT.mode, // local | aws
  invalidRate: 0,
  duplicateRate: 0,
  disruptAfterTicks: 5,
  disruptVehicleId: null,
  summaryIntervalMs: 10000,
  maxEvents: 0, // 0 = unlimited
  outFile: null,
  quiet: false,
  printEvents: true,
  printEveryNth: 1,
  label: null,
};

const NUMERIC = new Set([
  'buses', 'trams', 'trains', 'locations', 'intervalMs', 'demandIntervalMs', 'durationMs',
  'seed', 'invalidRate', 'duplicateRate', 'disruptAfterTicks', 'summaryIntervalMs',
  'maxEvents', 'printEveryNth',
]);

/** Yargs option table, also used to generate `--help`. */
export const CLI_OPTIONS = {
  buses: { type: 'number', describe: 'Number of simulated buses (Volume)' },
  trams: { type: 'number', describe: 'Number of simulated trams (Volume)' },
  trains: { type: 'number', describe: 'Number of simulated trains (Volume)' },
  locations: { type: 'number', describe: 'Number of demand locations (Volume)' },
  'interval-ms': { type: 'number', describe: 'Reporting interval per entity in ms (Velocity)' },
  'demand-interval-ms': { type: 'number', describe: 'Demand reporting interval (defaults to --interval-ms)' },
  'duration-ms': { type: 'number', describe: 'Total run duration in ms' },
  'duration-seconds': { type: 'number', describe: 'Total run duration in seconds' },
  'duration-minutes': { type: 'number', describe: 'Total run duration in minutes' },
  seed: { type: 'number', describe: 'Random seed - identical seed reproduces the workload' },
  scenario: { type: 'string', choices: SCENARIO_NAMES, describe: 'Disruption scenario' },
  target: { type: 'string', choices: ['stdout', 'mqtt'], describe: 'stdout = dry run, mqtt = publish' },
  'mqtt-mode': { type: 'string', choices: ['local', 'aws'], describe: 'local broker or AWS IoT Core over TLS' },
  'invalid-rate': { type: 'number', describe: 'Fraction of events deliberately corrupted (0-1)' },
  'duplicate-rate': { type: 'number', describe: 'Fraction of events republished verbatim (0-1)' },
  'disrupt-after-ticks': { type: 'number', describe: 'Reporting cycles before the incident starts' },
  'disrupt-vehicle': { type: 'string', describe: 'Pin the incident to a specific vehicle id' },
  'summary-interval-ms': { type: 'number', describe: 'How often to print the [SUMMARY] block' },
  'max-events': { type: 'number', describe: 'Stop after this many published events (0 = unlimited)' },
  out: { type: 'string', describe: 'Also append every published event to this JSONL file' },
  config: { type: 'string', describe: 'Load a JSON run configuration (experiment stage file)' },
  quiet: { type: 'boolean', describe: 'Suppress per-event lines, keep summaries' },
  'print-every-nth': { type: 'number', describe: 'Print only every Nth event line' },
  label: { type: 'string', describe: 'Free-text label recorded in the run summary' },
};

const camel = (key) => key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** Merge sources in order of increasing precedence: defaults < file < flags. */
export function resolveConfig(argv = {}) {
  let fileConfig = {};
  if (argv.config) {
    const file = path.resolve(argv.config);
    if (!fs.existsSync(file)) throw new Error(`config file not found: ${file}`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Stage files may nest the simulator block; accept both shapes.
    fileConfig = parsed.simulator ?? parsed;
  }

  const merged = { ...DEFAULTS };
  for (const source of [fileConfig, argv]) {
    for (const [rawKey, value] of Object.entries(source)) {
      if (value === undefined || value === null) continue;
      const key = camel(rawKey);
      // Only known settings are copied. Everything else (yargs internals such as
      // `_`/`$0`, stage-file metadata, and the alias forms handled below) is
      // ignored so the resolved configuration is exactly the documented shape.
      if (!(key in DEFAULTS)) continue;
      merged[key] = value;
    }
  }

  if (argv['duration-seconds'] ?? argv.durationSeconds ?? fileConfig.durationSeconds) {
    merged.durationMs = Number(
      argv['duration-seconds'] ?? argv.durationSeconds ?? fileConfig.durationSeconds,
    ) * 1000;
  }
  if (argv['duration-minutes'] ?? argv.durationMinutes ?? fileConfig.durationMinutes) {
    merged.durationMs = Number(
      argv['duration-minutes'] ?? argv.durationMinutes ?? fileConfig.durationMinutes,
    ) * 60000;
  }
  if (argv['disrupt-vehicle'] ?? argv.disruptVehicle ?? fileConfig.disruptVehicle) {
    merged.disruptVehicleId = argv['disrupt-vehicle'] ?? argv.disruptVehicle
      ?? fileConfig.disruptVehicle;
  }
  // The flag is `--out` but the setting is `outFile`, so it needs an explicit
  // alias like the two above. Without it the flag parsed fine and was then
  // silently dropped, and no events file was ever written.
  if (argv.out ?? fileConfig.out ?? fileConfig.outFile) {
    merged.outFile = argv.out ?? fileConfig.out ?? fileConfig.outFile;
  }

  for (const key of NUMERIC) {
    if (merged[key] !== null && merged[key] !== undefined) merged[key] = Number(merged[key]);
  }
  if (!merged.demandIntervalMs) merged.demandIntervalMs = merged.intervalMs;
  if (merged.quiet) merged.printEvents = false;

  validate(merged);
  return merged;
}

function validate(cfg) {
  const problems = [];
  for (const key of ['buses', 'trams', 'trains', 'locations']) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < 0) problems.push(`${key} must be a non-negative integer`);
  }
  if (cfg.buses + cfg.trams + cfg.trains + cfg.locations === 0) {
    problems.push('at least one entity is required (buses/trams/trains/locations)');
  }
  if (!(cfg.intervalMs > 0)) problems.push('interval-ms must be greater than 0');
  if (!(cfg.durationMs > 0)) problems.push('duration must be greater than 0');
  if (cfg.invalidRate < 0 || cfg.invalidRate > 1) problems.push('invalid-rate must be between 0 and 1');
  if (cfg.duplicateRate < 0 || cfg.duplicateRate > 1) problems.push('duplicate-rate must be between 0 and 1');
  if (!SCENARIO_NAMES.includes(cfg.scenario)) problems.push(`scenario must be one of ${SCENARIO_NAMES.join(', ')}`);
  if (problems.length) {
    const err = new Error(`invalid simulator configuration:\n - ${problems.join('\n - ')}`);
    err.problems = problems;
    throw err;
  }
}

/** Events per second implied by the configuration - printed in the banner. */
export function expectedEventsPerSecond(cfg) {
  const vehicles = cfg.buses + cfg.trams + cfg.trains;
  const vehicleRate = vehicles / (cfg.intervalMs / 1000);
  const demandRate = cfg.locations / (cfg.demandIntervalMs / 1000);
  return Number((vehicleRate + demandRate).toFixed(2));
}

export function expectedTotalEvents(cfg) {
  const ticks = Math.floor(cfg.durationMs / cfg.intervalMs);
  const demandTicks = Math.floor(cfg.durationMs / cfg.demandIntervalMs);
  return (cfg.buses + cfg.trams + cfg.trains) * ticks + cfg.locations * demandTicks;
}
