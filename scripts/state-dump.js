#!/usr/bin/env node
/**
 * Prints a sample of records from a DynamoDB (or local) table.
 *
 * This is the evidence for "state was persisted" and "route impact results were
 * stored", without dumping thousands of lines into a screenshot.
 *
 * Usage:
 *   npm run state:dump -- --table current-state --limit 5
 *   npm run state:dump -- --table analysis-results --limit 3 --full
 */
import process from 'node:process';
import { BACKENDS, TABLES } from '@sit314/shared/config';
import { getStore } from '@sit314/shared/store';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const full = args.includes('--full');

const shortNames = {
  'processed-events': TABLES.processedEvents,
  'current-state': TABLES.currentState,
  'analysis-results': TABLES.analysisResults,
  notifications: TABLES.notifications,
};

const requested = flag('table', 'current-state');
const table = shortNames[requested] || requested;
const limit = Number(flag('limit', 5));

const store = getStore();
const total = await store.count(table);
const items = await store.scan(table, { limit });

process.stdout.write(`\n[STATE-DUMP] table=${table} backend=${BACKENDS.store} `
  + `showing=${items.length} of ${total}\n\n`);

for (const item of items) {
  if (full) {
    process.stdout.write(`${JSON.stringify(item, null, 2)}\n\n`);
    continue;
  }
  // Compact, screenshot-friendly one-liner per record type.
  if (item.entityId) {
    process.stdout.write(`  ${String(item.entityId).padEnd(14)} mode=${item.transportMode} `
      + `health=${item.health} crowding=${item.crowdingLevel ?? 'n/a'} `
      + `delay=${item.metrics?.delaySeconds ?? 'n/a'}s ts=${item.timestamp}\n`);
  } else if (item.jobId && item.etaMinutes !== undefined) {
    process.stdout.write(`  ${String(item.jobId).padEnd(30)} mode=${item.transportMode} `
      + `location=${item.locationId} eta=${item.etaMinutes}min impact=${item.impactLevel} `
      + `quality=${item.qualityIndicator}\n`);
  } else if (item.notificationId) {
    process.stdout.write(`  ${String(item.notificationId).padEnd(38)} audience=${item.audience} `
      + `channel=${item.channel} recipients=${item.recipientCount} status=${item.status} `
      + `simulated=${item.simulated}\n`);
  } else if (item.eventId) {
    process.stdout.write(`  ${String(item.eventId).padEnd(46)} mode=${item.transportMode} `
      + `entity=${item.entityId} processedAt=${item.processedAt}\n`);
  } else {
    process.stdout.write(`  ${JSON.stringify(item)}\n`);
  }
}
if (!items.length) process.stdout.write('  (no records - run npm run demo:local first)\n');
process.stdout.write('\n');
