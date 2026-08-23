#!/usr/bin/env node
/**
 * Prints the depth, in-flight count and oldest-message age of every queue.
 *
 * This is the local equivalent of the SQS console view, and it is the evidence
 * for "the queue buffered the burst" and "the DLQ stayed empty".
 *
 * Usage: npm run queue:stats            (add --watch to refresh every 2s)
 */
import process from 'node:process';
import { BACKENDS, QUEUES } from '@sit314/shared/config';
import { getQueue } from '@sit314/shared/queues';
import { sleep } from '@sit314/shared/util';

const watch = process.argv.includes('--watch');

async function once() {
  const rows = [];
  for (const [label, name] of Object.entries(QUEUES)) {
    const attrs = await getQueue(name).getAttributes();
    rows.push({ label, name, ...attrs });
  }
  const stamp = new Date().toISOString();
  process.stdout.write(`\n[QUEUE-STATS] ${stamp}  backend=${BACKENDS.queue}\n`);
  process.stdout.write(`  ${'QUEUE'.padEnd(38)}${'VISIBLE'.padStart(9)}${'INFLIGHT'.padStart(10)}${'OLDEST(s)'.padStart(11)}\n`);
  for (const r of rows) {
    const flag = r.name.endsWith('-dlq') && r.approximateNumberOfMessages > 0 ? '  <-- DLQ NOT EMPTY' : '';
    process.stdout.write(`  ${r.name.padEnd(38)}`
      + `${String(r.approximateNumberOfMessages).padStart(9)}`
      + `${String(r.approximateNumberOfMessagesNotVisible).padStart(10)}`
      + `${String(r.approximateAgeOfOldestMessageSeconds).padStart(11)}${flag}\n`);
  }
}

if (watch) {
  process.on('SIGINT', () => process.exit(0));
  for (;;) { await once(); await sleep(2000); }
} else {
  await once();
}
