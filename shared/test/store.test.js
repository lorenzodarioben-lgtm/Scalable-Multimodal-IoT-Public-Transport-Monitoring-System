import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DynamoStore, getStore, keyNameFor } from '../aws/store.js';
import { TABLES } from '../config/index.js';

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-db-'));
  return { db: getStore({ fresh: true, backend: 'local', baseDir: dir }), dir };
}

test('each table has a documented single partition key', () => {
  assert.equal(keyNameFor(TABLES.processedEvents), 'eventId');
  assert.equal(keyNameFor(TABLES.currentState), 'entityId');
  assert.equal(keyNameFor(TABLES.analysisResults), 'jobId');
  assert.equal(keyNameFor(TABLES.notifications), 'notificationId');
});

test('putIfAbsent writes once and refuses the second write', async () => {
  const { db, dir } = store();
  const item = { eventId: 'evt-1', processedAt: '2026-09-04T00:00:00.000Z' };
  assert.deepEqual(await db.putIfAbsent(TABLES.processedEvents, item), { written: true });
  const second = await db.putIfAbsent(TABLES.processedEvents, { ...item, processedAt: 'later' });
  assert.equal(second.written, false);
  assert.equal(second.reason, 'alreadyExists');
  // The original record must be untouched by the rejected write.
  const stored = await db.get(TABLES.processedEvents, 'evt-1');
  assert.equal(stored.processedAt, '2026-09-04T00:00:00.000Z');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('putIfAbsent is safe when many writers race for the same key', async () => {
  const { db, dir } = store();
  const attempts = await Promise.all(Array.from({ length: 25 }, (_, i) => db.putIfAbsent(
    TABLES.processedEvents,
    { eventId: 'evt-contended', writer: i },
  )));
  const winners = attempts.filter((r) => r.written);
  assert.equal(winners.length, 1, 'exactly one writer may win an idempotency claim');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('putIfNewer refuses an older timestamp but accepts a newer one', async () => {
  const { db, dir } = store();
  const table = TABLES.currentState;
  await db.putIfNewer(table, { entityId: 'BUS-001', timestamp: '2026-09-04T00:05:00.000Z', speedKph: 40 });

  const stale = await db.putIfNewer(table, { entityId: 'BUS-001', timestamp: '2026-09-04T00:04:00.000Z', speedKph: 99 });
  assert.equal(stale.written, false);
  assert.equal(stale.reason, 'staleTimestamp');
  assert.equal((await db.get(table, 'BUS-001')).speedKph, 40, 'stale event overwrote newer state');

  const fresh = await db.putIfNewer(table, { entityId: 'BUS-001', timestamp: '2026-09-04T00:06:00.000Z', speedKph: 55 });
  assert.equal(fresh.written, true);
  assert.equal((await db.get(table, 'BUS-001')).speedKph, 55);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('putIfNewer treats an identical timestamp as stale', async () => {
  const { db, dir } = store();
  const item = { entityId: 'TRAM-001', timestamp: '2026-09-04T00:00:00.000Z', v: 1 };
  await db.putIfNewer(TABLES.currentState, item);
  const repeat = await db.putIfNewer(TABLES.currentState, { ...item, v: 2 });
  assert.equal(repeat.written, false);
  assert.equal((await db.get(TABLES.currentState, 'TRAM-001')).v, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('get returns null for a missing key rather than throwing', async () => {
  const { db, dir } = store();
  assert.equal(await db.get(TABLES.currentState, 'NOPE'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scan and count reflect what was written', async () => {
  const { db, dir } = store();
  for (let i = 0; i < 7; i += 1) {
    await db.put(TABLES.analysisResults, { jobId: `job-${i}`, etaMinutes: i });
  }
  assert.equal(await db.count(TABLES.analysisResults), 7);
  const items = await db.scan(TABLES.analysisResults, { limit: 100 });
  assert.equal(items.length, 7);
  assert.deepEqual(items.map((i) => i.jobId).sort(), Array.from({ length: 7 }, (_, i) => `job-${i}`).sort());
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ids containing path separators cannot escape the table directory', async () => {
  const { db, dir } = store();
  await db.put(TABLES.analysisResults, { jobId: '../../escape', value: 1 });
  const written = fs.readdirSync(path.join(dir, TABLES.analysisResults));
  assert.equal(written.length, 1);
  // Path separators are stripped, so the key stays inside the table directory.
  assert.ok(!/[\\/]/.test(written[0]), `unsanitised file name: ${written[0]}`);
  assert.equal(
    path.dirname(path.resolve(dir, TABLES.analysisResults, written[0])),
    path.resolve(dir, TABLES.analysisResults),
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DynamoDB count follows every Scan page', async () => {
  const pages = [
    { Count: 100, LastEvaluatedKey: { jobId: 'page-1' } },
    { Count: 37 },
  ];
  const commands = [];
  const db = new DynamoStore('test', {
    documentClient: { send: async (command) => { commands.push(command); return pages.shift(); } },
    sdk: { ScanCommand: class { constructor(input) { this.input = input; } } },
  });
  assert.equal(await db.count(TABLES.analysisResults), 137);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[1].input.ExclusiveStartKey, { jobId: 'page-1' });
});

test('DynamoDB index count follows every Query page for run-scoped accounting', async () => {
  const pages = [
    { Count: 10, LastEvaluatedKey: { jobId: 'page-1' } },
    { Count: 4 },
  ];
  const db = new DynamoStore('test', {
    documentClient: { send: async () => pages.shift() },
    sdk: { QueryCommand: class { constructor(input) { this.input = input; } } },
  });
  assert.equal(await db.countByIndex(TABLES.analysisResults, {
    indexName: 'SourceEventIdIndex', keyName: 'sourceEventId', keyValue: 'evt-run-1',
  }), 14);
});
