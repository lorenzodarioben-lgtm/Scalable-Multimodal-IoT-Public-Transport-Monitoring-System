#!/usr/bin/env node
/**
 * Builds node-red/flows.json from the readable sources in node-red/functions/.
 *
 * What: assembles the importable Node-RED flow, injecting each function node's
 *       body from its own .js file.
 * Why:  a Node-RED flow stores function code as escaped strings inside JSON,
 *       which is unreadable and impossible to unit test. Keeping each node's
 *       code in a real .js file means node-red/test/flow.test.js can execute
 *       the EXACT code that the flow deploys, and the reviewer can read it.
 *
 * Usage: node node-red/build-flows.js [--check]
 *        --check verifies flows.json is up to date instead of rewriting it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FN_DIR = path.join(HERE, 'functions');
const OUT = path.join(HERE, 'flows.json');

const read = (name) => fs.readFileSync(path.join(FN_DIR, `${name}.js`), 'utf8').trimEnd();

/** The shared validation helpers are inlined wherever `// __COMMON__` appears. */
export function functionBody(name) {
  const source = read(name);
  if (!source.includes('// __COMMON__')) return source;
  const common = read('validate-common')
    .split('\n')
    .filter((line) => !line.startsWith('// '))
    .join('\n')
    .trim();
  return source.replace('// __COMMON__', common);
}

const TAB = 'sit314-transport-flow';
const MQTT_BROKER = 'sit314-mqtt-broker';

const fn = (id, name, code, outputs, x, y, wires) => ({
  id,
  type: 'function',
  z: TAB,
  name,
  func: code,
  outputs,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x,
  y,
  wires,
});

const flows = [
  {
    id: TAB,
    type: 'tab',
    label: 'SIT314 transport validation and normalisation',
    disabled: false,
    info: [
      '# SIT314 multimodal transport processing',
      '',
      'Raw MQTT telemetry arrives on `transport/raw/#` from AWS IoT Core (or the',
      'local broker during development).',
      '',
      'The flow:',
      '1. identifies the event mode,',
      '2. validates it in a mode-specific branch (bus / tram / train / demand),',
      '3. normalises accepted events into the shared envelope,',
      '4. republishes them on `transport/normalized/<mode>`.',
      '',
      'Rejected events go to `transport/rejected/<mode>` with a reason and never',
      'reach the telemetry queue. An AWS IoT rule subscribes to',
      '`transport/normalized/+` and forwards to the telemetry SQS queue.',
    ].join('\n'),
    env: [],
  },

  // ---- MQTT broker configuration -----------------------------------------
  // Host/port come from Node-RED environment variables so the SAME flow works
  // against the local broker and against AWS IoT Core over TLS.
  {
    id: MQTT_BROKER,
    type: 'mqtt-broker',
    name: 'transport-broker',
    broker: '${MQTT_HOST}',
    port: '${MQTT_PORT}',
    clientid: '${MQTT_CLIENT_ID}',
    autoConnect: true,
    // Plain TCP for the local development broker. For AWS IoT Core, set
    // usetls true and attach a tls-config node holding the CA / client
    // certificate / private key paths - see node-red/README.md. TLS is a
    // boolean here rather than an ${ENV} reference because Node-RED substitutes
    // environment variables as strings, and any non-empty string is truthy.
    usetls: false,
    protocolVersion: '4',
    keepalive: '60',
    cleansession: true,
    birthTopic: '',
    birthQos: '0',
    birthPayload: '',
    closeTopic: '',
    willTopic: '',
    sessionExpiry: '',
  },

  // ---- ingest --------------------------------------------------------------
  {
    id: 'raw-in',
    type: 'mqtt in',
    z: TAB,
    name: 'MQTT in: transport/raw/#',
    topic: 'transport/raw/#',
    qos: '0',
    datatype: 'auto',
    broker: MQTT_BROKER,
    nl: false,
    rap: true,
    rh: 0,
    inputs: 0,
    x: 150,
    y: 220,
    wires: [['keep-raw-topic']],
  },
  fn(
    'keep-raw-topic',
    'remember source topic',
    'msg.rawTopic = msg.topic;\nreturn msg;',
    1,
    360,
    220,
    [['identify-mode']],
  ),

  // ---- mode identification (Variety fan-out) ------------------------------
  fn('identify-mode', 'identify mode', functionBody('identify-mode'), 5, 560, 220, [
    ['validate-bus'],
    ['validate-tram'],
    ['validate-train'],
    ['validate-demand'],
    ['reject'],
  ]),

  // ---- mode-specific validation branches ----------------------------------
  fn('validate-bus', 'validate bus', functionBody('validate-bus'), 2, 800, 100, [['normalize'], ['reject']]),
  fn('validate-tram', 'validate tram', functionBody('validate-tram'), 2, 800, 180, [['normalize'], ['reject']]),
  fn('validate-train', 'validate train', functionBody('validate-train'), 2, 800, 260, [['normalize'], ['reject']]),
  fn('validate-demand', 'validate demand', functionBody('validate-demand'), 2, 800, 340, [['normalize'], ['reject']]),

  // ---- normalisation and publication --------------------------------------
  fn('normalize', 'normalise to shared envelope', functionBody('normalize'), 1, 1060, 180, [
    ['normalized-out', 'debug-accepted'],
  ]),
  {
    id: 'normalized-out',
    type: 'mqtt out',
    z: TAB,
    name: 'MQTT out: transport/normalized/<mode>',
    topic: '',
    qos: '0',
    retain: 'false',
    broker: MQTT_BROKER,
    x: 1380,
    y: 160,
    wires: [],
  },
  {
    id: 'debug-accepted',
    type: 'debug',
    z: TAB,
    name: 'accepted',
    active: true,
    tosidebar: true,
    console: false,
    complete: 'payload',
    targetType: 'msg',
    statusVal: '',
    statusType: 'auto',
    x: 1360,
    y: 230,
    wires: [],
  },

  // ---- rejection path ------------------------------------------------------
  fn('reject', 'reject with reason', functionBody('reject'), 1, 1060, 430, [
    ['rejected-out', 'debug-rejected'],
  ]),
  {
    id: 'rejected-out',
    type: 'mqtt out',
    z: TAB,
    name: 'MQTT out: transport/rejected/<mode>',
    topic: '',
    qos: '0',
    retain: 'false',
    broker: MQTT_BROKER,
    x: 1380,
    y: 400,
    wires: [],
  },
  {
    id: 'debug-rejected',
    type: 'debug',
    z: TAB,
    name: 'rejected',
    active: true,
    tosidebar: true,
    console: false,
    complete: 'payload',
    targetType: 'msg',
    statusVal: '',
    statusType: 'auto',
    x: 1360,
    y: 470,
    wires: [],
  },
];

const json = `${JSON.stringify(flows, null, 4)}\n`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== json) {
    process.stderr.write('flows.json is out of date - run: node node-red/build-flows.js\n');
    process.exit(1);
  }
  process.stdout.write('flows.json is up to date\n');
} else if (process.argv[1] && process.argv[1].endsWith('build-flows.js')) {
  fs.writeFileSync(OUT, json);
  process.stdout.write(`wrote ${OUT} (${flows.length} nodes)\n`);
}

export { flows, TAB };
