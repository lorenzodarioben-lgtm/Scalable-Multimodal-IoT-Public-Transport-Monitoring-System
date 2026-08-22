#!/usr/bin/env node
/**
 * Local MQTT broker (development substitute for AWS IoT Core).
 *
 * What: an in-process MQTT 3.1.1 broker on tcp://localhost:1883.
 * Why:  AWS IoT Core is the broker in the deployed architecture, but the whole
 *       MQTT path - real client, real broker, real topics, real subscriptions -
 *       must be testable before AWS access exists. The simulator, Node-RED and
 *       the bridge all speak unmodified MQTT to this broker, so switching to
 *       AWS IoT Core is a configuration change (MQTT_MODE=aws), not a code
 *       change.
 *
 * Security note: this broker is bound to localhost and is for development only.
 * The AWS path uses mutual TLS - see simulator/src/mqtt-client.js and
 * docs/SECURITY.md.
 *
 * Usage: npm run broker
 */
import net from 'node:net';
import process from 'node:process';
import Aedes from 'aedes';
import { banner } from '@sit314/shared/logging';
import { MQTT, TOPICS } from '@sit314/shared/config';

const port = Number(process.env.MQTT_LOCAL_PORT ?? MQTT.localPort);
const host = process.env.MQTT_BIND_HOST ?? '127.0.0.1';
const verbose = process.env.BROKER_VERBOSE === 'true';

const aedes = new Aedes({ id: 'sit314-local-broker' });
const server = net.createServer(aedes.handle);

const counts = { raw: 0, normalized: 0, rejected: 0, other: 0 };
const clients = new Set();

function classify(topic) {
  if (topic.startsWith(`${TOPICS.rawBase}/`)) return 'raw';
  if (topic.startsWith(`${TOPICS.normalizedBase}/`)) return 'normalized';
  if (topic.startsWith(`${TOPICS.rejectedBase}/`)) return 'rejected';
  return 'other';
}

aedes.on('client', (client) => {
  clients.add(client.id);
  process.stdout.write(`[BROKER] client connected  id=${client.id} total=${clients.size}\n`);
});

aedes.on('clientDisconnect', (client) => {
  clients.delete(client.id);
  process.stdout.write(`[BROKER] client disconnected id=${client.id} total=${clients.size}\n`);
});

aedes.on('subscribe', (subscriptions, client) => {
  const topics = subscriptions.map((s) => s.topic).join(', ');
  process.stdout.write(`[BROKER] subscribe        id=${client?.id} topics=${topics}\n`);
});

aedes.on('publish', (packet, client) => {
  if (!client) return; // broker-internal ($SYS) messages
  counts[classify(packet.topic)] += 1;
  if (verbose) {
    process.stdout.write(`[BROKER] publish ${packet.topic} (${packet.payload.length} bytes)\n`);
  }
});

const summaryInterval = setInterval(() => {
  process.stdout.write(`[BROKER-SUMMARY] clients=${clients.size} raw=${counts.raw} `
    + `normalized=${counts.normalized} rejected=${counts.rejected}\n`);
}, Number(process.env.BROKER_SUMMARY_INTERVAL_MS ?? 15000));
summaryInterval.unref();

server.listen(port, host, () => {
  process.stdout.write(`${banner('SIT314 local MQTT broker', {
    Address: `mqtt://${host}:${port}`,
    'Raw topics': `${TOPICS.rawBase}/{bus,tram,train,demand}/+`,
    'Normalised topics': `${TOPICS.normalizedBase}/+`,
    'Rejected topics': `${TOPICS.rejectedBase}/+`,
    Purpose: 'local stand-in for AWS IoT Core',
  })}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(`[BROKER-ERROR] port ${port} is already in use - a broker may already be running.\n`);
    process.exit(1);
  }
  throw err;
});

function shutdown(signal) {
  process.stdout.write(`\n[BROKER] ${signal} received, closing\n`);
  clearInterval(summaryInterval);
  server.close(() => {
    aedes.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
