import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TABLES } from '@sit314/shared/config';
import { getStore } from '@sit314/shared/store';
import { createLogger } from '@sit314/shared/logging';
import { validateNotification } from '@sit314/shared/validation';
import { CHANNEL_FOR_AUDIENCE, NotificationWorker } from '../src/worker.js';

function harness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sit314-notif-'));
  const store = getStore({ fresh: true, backend: 'local', baseDir: dir });
  const logger = createLogger('test', { quiet: true });
  const worker = new NotificationWorker({ store, logger, ...options });
  return { worker, store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const alert = (patch = {}) => ({
  alertId: 'alert-aaaaaaaa0001',
  jobId: 'job-aaaaaaaa0001',
  calculationId: 'calc-aaaaaaaa0001',
  sourceEventId: 'evt-aaaaaaaa0001',
  incidentId: 'incident-aaaaaaaa',
  transportMode: 'bus',
  routeId: '703',
  locationId: 'BUS-STOP-104',
  severity: 'high',
  audience: 'passengers',
  etaMinutes: 18,
  impactLevel: 'high',
  message: 'Delays on bus route 703 near BUS-STOP-104 due to a vehicle breakdown.',
  recipientBatch: 0,
  recipientCount: 50,
  createdAt: '2026-09-04T00:00:00.000Z',
  ...patch,
});

test('an alert produces a simulated delivery record', async () => {
  const h = harness();
  const outcome = await h.worker.handle(alert());
  assert.equal(outcome.duplicate, false);

  const stored = await h.store.get(TABLES.notifications, outcome.record.notificationId);
  assert.equal(stored.status, 'delivered');
  assert.equal(stored.simulated, true, 'records must be marked as simulated');
  assert.equal(stored.alertId, 'alert-aaaaaaaa0001');
  assert.equal(stored.audience, 'passengers');
  assert.equal(stored.recipientCount, 50);
  assert.ok(validateNotification(stored).valid);
  h.cleanup();
});

test('deliveries are never real - the channel is always a simulated one', async () => {
  const h = harness();
  for (const audience of ['passengers', 'operators', 'controlRoom', 'authority']) {
    const outcome = await h.worker.handle(alert({
      alertId: `alert-${audience}-0001`, audience,
    }));
    assert.ok(outcome.record.channel.startsWith('simulated'),
      `channel ${outcome.record.channel} does not look simulated`);
    assert.equal(outcome.record.channel, CHANNEL_FOR_AUDIENCE[audience]);
    assert.equal(outcome.record.simulated, true);
  }
  h.cleanup();
});

test('a duplicate alert does not create a second delivery record', async () => {
  const h = harness();
  const first = await h.worker.handle(alert());
  const second = await h.worker.handle(alert());
  assert.deepEqual(second, { duplicate: true });
  assert.equal(h.worker.counters.delivered, 1);
  assert.equal(h.worker.counters.duplicates, 1);
  assert.equal(await h.store.count(TABLES.notifications), 1);
  assert.ok(first.record.notificationId);
  h.cleanup();
});

test('concurrent delivery of the same alert is handled exactly once', async () => {
  const h = harness();
  const results = await Promise.all(Array.from({ length: 6 }, () => h.worker.handle(alert())));
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.equal(await h.store.count(TABLES.notifications), 1);
  h.cleanup();
});

test('notification ids are derived from the alert id', async () => {
  const a = harness();
  const b = harness();
  const ra = await a.worker.handle(alert());
  const rb = await b.worker.handle(alert());
  assert.equal(ra.record.notificationId, rb.record.notificationId);
  a.cleanup();
  b.cleanup();
});

test('an invalid alert is rejected as non-retryable', async () => {
  const h = harness();
  await assert.rejects(() => h.worker.handle({ alertId: 'x' }), /failed validation/);
  assert.equal(h.worker.counters.invalid, 1);
  h.cleanup();
});

test('failure injection is off by default', async () => {
  const h = harness();
  for (let i = 0; i < 15; i += 1) {
    await h.worker.handle(alert({ alertId: `alert-clean-${String(i).padStart(5, '0')}` }));
  }
  assert.equal(h.worker.counters.delivered, 15);
  h.cleanup();
});

test('an injected failure throws and records a failed attempt', async () => {
  const h = harness({ failureInjection: { enabled: true, rate: 1 }, random: () => 0 });
  await assert.rejects(() => h.worker.handle(alert()), /injected notification failure/);
  const items = await h.store.scan(TABLES.notifications, { limit: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'failed');
  assert.equal(items[0].simulated, true);
  h.cleanup();
});

test('recipient counts accumulate across alerts', async () => {
  const h = harness();
  await h.worker.handle(alert({ alertId: 'alert-a-00001', recipientCount: 40 }));
  await h.worker.handle(alert({ alertId: 'alert-b-00001', recipientCount: 60 }));
  assert.equal(h.worker.counters.recipients, 100);
  h.cleanup();
});
