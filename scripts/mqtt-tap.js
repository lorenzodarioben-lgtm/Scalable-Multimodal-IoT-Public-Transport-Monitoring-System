#!/usr/bin/env node
/**
 * MQTT topic tap - subscribes and prints what is actually on the broker.
 *
 * What: connects to the local broker or to AWS IoT Core over TLS and prints a
 *       compact line per message, plus a periodic count per topic branch.
 * Why:  this is the evidence tool for "the simulator really published over
 *       MQTT" and "Node-RED really republished a normalised event". It is the
 *       local equivalent of the AWS IoT MQTT test client.
 *
 * Usage:
 *   node scripts/mqtt-tap.js                       # all transport topics
 *   node scripts/mqtt-tap.js "transport/normalized/#"
 *   node scripts/mqtt-tap.js "transport/#" --count 20 --timeout 15000
 *   MQTT_MODE=aws node scripts/mqtt-tap.js         # AWS IoT Core over TLS
 */
import process from 'node:process';
import mqtt from 'mqtt';
import { MQTT, TOPICS } from '@sit314/shared/config';
import { banner } from '@sit314/shared/logging';
import { assertAwsTlsConfig } from '@sit314/simulator/mqtt-client';
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

const topicFilter = positional[0] || `${TOPICS.rawBase.split('/')[0]}/#`;
const maxMessages = Number(flag('count', 0));
const timeoutMs = Number(flag('timeout', 0));
const showPayload = args.includes('--payload');
const quiet = args.includes('--quiet');

let url;
let options = { clean: true, connectTimeout: 15000, clientId: `sit314-tap-${Math.random().toString(16).slice(2, 10)}` };
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

const counts = new Map();
let received = 0;
const started = Date.now();

const client = mqtt.connect(url, options);

client.on('connect', () => {
  process.stdout.write(`${banner('SIT314 MQTT tap', {
    Broker: MQTT.mode === 'aws' ? 'AWS IoT Core (TLS)' : url,
    Filter: topicFilter,
    'Stop after': maxMessages ? `${maxMessages} messages` : 'Ctrl+C',
    Timeout: timeoutMs ? `${timeoutMs} ms` : 'none',
  })}\n`);
  client.subscribe(topicFilter, { qos: 0 }, (err) => {
    if (err) {
      process.stderr.write(`[TAP-ERROR] subscribe failed: ${err.message}\n`);
      process.exit(1);
    }
  });
});

client.on('error', (err) => {
  process.stderr.write(`[TAP-ERROR] ${err.message}\n`);
  process.exit(1);
});

client.on('message', (topic, payload) => {
  received += 1;
  const branch = topic.split('/').slice(0, 3).join('/');
  counts.set(branch, (counts.get(branch) || 0) + 1);
  if (!quiet) {
    let summary = `${payload.length} bytes`;
    try {
      const obj = JSON.parse(payload.toString());
      summary = obj.eventType === 'locationDemand'
        ? `demand ${obj.locationId} passengers=${obj.passengerCount}`
        : `${obj.transportMode ?? obj.sourceEventType ?? '?'} ${obj.vehicleId ?? obj.entityId ?? ''} `
          + `health=${obj.health ?? '?'}`;
      if (showPayload) summary = JSON.stringify(obj);
    } catch { /* not JSON - keep byte count */ }
    process.stdout.write(`[TAP] ${topic.padEnd(38)} ${summary}\n`);
  }
  if (maxMessages && received >= maxMessages) finish(0);
});

function finish(code) {
  process.stdout.write('\n[TAP-SUMMARY]\n');
  for (const [branch, n] of [...counts.entries()].sort()) {
    process.stdout.write(`  ${branch.padEnd(30)} ${n}\n`);
  }
  process.stdout.write(`  ${'total'.padEnd(30)} ${received} in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  client.end(true, {}, () => process.exit(code));
}

if (timeoutMs) setTimeout(() => finish(received > 0 ? 0 : 2), timeoutMs);
process.on('SIGINT', () => finish(0));
