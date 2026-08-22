#!/usr/bin/env node
/**
 * Normalised MQTT -> telemetry queue bridge.
 *
 * WHAT THIS IS
 * In the deployed AWS architecture this component does not exist as code: an
 * AWS IoT **Rule** subscribes to `transport/normalized/+` and delivers each
 * message straight into the telemetry SQS queue (see
 * infrastructure/cloudformation/iot-rule.yaml). That is a managed, no-code
 * integration.
 *
 * This script is the LOCAL stand-in for that rule, so the whole pipeline can be
 * run and measured on a laptop:
 *
 *   Node-RED -> transport/normalized/<mode> -> [this bridge | AWS IoT Rule] -> telemetry queue
 *
 * WHY IT EXISTS
 * The specification's preferred design deliberately routes Node-RED output back
 * through the broker and lets an IoT Rule do the queue delivery, rather than
 * depending on a third-party Node-RED SQS contrib node. Node-RED is still the
 * processing stage immediately before the queue. This script only replaces the
 * managed rule when there is no AWS account attached.
 *
 * Usage: npm run bridge
 */
import process from 'node:process';
import mqtt from 'mqtt';
import fs from 'node:fs';
import { MQTT, QUEUES, TOPICS } from '@sit314/shared/config';
import { banner, createLogger } from '@sit314/shared/logging';
import { getQueue } from '@sit314/shared/queues';
import { validateNormalized } from '@sit314/shared/validation';
import { assertAwsTlsConfig } from '@sit314/simulator/mqtt-client';

const logger = createLogger('normalized-bridge', {
  jsonFile: process.env.LOG_JSON_FILE || null,
});
const queue = getQueue(QUEUES.telemetry);
const verbose = process.env.BRIDGE_VERBOSE !== 'false';

let url;
let options = {
  clean: true,
  connectTimeout: 15000,
  clientId: `sit314-bridge-${Math.random().toString(16).slice(2, 10)}`,
};
if (MQTT.mode === 'aws') {
  assertAwsTlsConfig(MQTT);
  url = `mqtts://${MQTT.awsEndpoint}:${MQTT.awsPort}`;
  options = {
    ...options,
    ca: [fs.readFileSync(MQTT.caPath)],
    cert: fs.readFileSync(MQTT.certPath),
    key: fs.readFileSync(MQTT.keyPath),
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  };
} else {
  url = `mqtt://${MQTT.localHost}:${MQTT.localPort}`;
}

const stats = { received: 0, enqueued: 0, rejected: 0, failed: 0 };
const client = mqtt.connect(url, options);

client.on('connect', () => {
  process.stdout.write(`${banner('SIT314 normalised -> queue bridge', {
    Role: 'local stand-in for the AWS IoT rule',
    Broker: MQTT.mode === 'aws' ? 'AWS IoT Core (TLS)' : url,
    Subscribe: TOPICS.normalizedWildcard(),
    Queue: `${queue.name} (${queue.url})`,
  })}\n`);
  client.subscribe(TOPICS.normalizedWildcard(), { qos: 0 }, (err) => {
    if (err) {
      logger.error('BRIDGE-ERROR', { error: err.message });
      process.exit(1);
    }
  });
});

client.on('error', (err) => {
  logger.error('BRIDGE-ERROR', { error: err.message });
  process.exit(1);
});

client.on('message', async (topic, payload) => {
  stats.received += 1;
  let event;
  try {
    event = JSON.parse(payload.toString());
  } catch {
    stats.rejected += 1;
    logger.warn('BRIDGE-REJECTED', { topic, reason: 'payload is not valid JSON' });
    return;
  }

  // Defence in depth: Node-RED already validated, but the queue must never
  // receive something the processor cannot parse.
  const check = validateNormalized(event);
  if (!check.valid) {
    stats.rejected += 1;
    logger.warn('BRIDGE-REJECTED', {
      topic, eventId: event.eventId, reason: check.errors.slice(0, 2).join('; '),
    });
    return;
  }

  try {
    await queue.sendMessage(event, { sourceTopic: topic });
    stats.enqueued += 1;
    if (verbose) {
      logger.info('ENQUEUED', {}, `[ENQUEUED] ${topic.padEnd(28)} `
        + `entity=${String(event.entityId).padEnd(12)} health=${event.health} -> ${queue.name}`);
    }
  } catch (err) {
    stats.failed += 1;
    logger.error('BRIDGE-ENQUEUE-FAILED', { eventId: event.eventId, error: err.message });
  }
});

const summary = setInterval(() => {
  logger.block('BRIDGE-SUMMARY', stats);
}, Number(process.env.BRIDGE_SUMMARY_INTERVAL_MS ?? 15000));
summary.unref();

function shutdown() {
  clearInterval(summary);
  logger.block('BRIDGE-SUMMARY', stats);
  client.end(true, {}, () => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
