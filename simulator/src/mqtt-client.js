/**
 * MQTT publisher abstraction.
 *
 * What: three interchangeable publishers -
 *       StdoutPublisher  (dry run - prints, publishes nothing)
 *       MqttPublisher    (local broker over plain TCP, for development)
 *       MqttPublisher    (AWS IoT Core over TLS 1.2 with mutual X.509 auth)
 * Why:  the project must be usable before AWS access exists, and the AWS path
 *       must be genuinely secure rather than "TLS later". AWS mode therefore
 *       refuses to start unless the endpoint, CA, certificate and private key
 *       are all configured - it never silently downgrades to an insecure
 *       connection.
 *
 * Security note: this module reads certificate FILE PATHS from configuration.
 * The certificate and key files themselves live in certs/, which is excluded by
 * .gitignore, and their contents are never logged.
 */
import fs from 'node:fs';
import { MQTT } from '@sit314/shared/config';

/** Dry-run publisher: the pipeline shape is identical, nothing leaves the machine. */
export class StdoutPublisher {
  constructor({ onPublish } = {}) {
    this.mode = 'stdout';
    this.published = 0;
    this.failed = 0;
    this.onPublish = onPublish;
  }

  async connect() { return this; }

  async publish(topic, payload) {
    this.published += 1;
    if (this.onPublish) this.onPublish(topic, payload);
    return true;
  }

  async end() { return true; }
}

/**
 * Validates AWS IoT TLS configuration before any connection attempt and
 * returns a precise, actionable error listing exactly what is missing.
 */
export function assertAwsTlsConfig(cfg = MQTT) {
  const missing = [];
  if (!cfg.awsEndpoint) missing.push('AWS_IOT_ENDPOINT (run: aws iot describe-endpoint --endpoint-type iot:Data-ATS)');
  if (!cfg.caPath) missing.push('AWS_IOT_CA_PATH (Amazon root CA 1 PEM)');
  if (!cfg.certPath) missing.push('AWS_IOT_CERT_PATH (device certificate PEM)');
  if (!cfg.keyPath) missing.push('AWS_IOT_PRIVATE_KEY_PATH (device private key PEM)');
  const unreadable = [];
  for (const [label, file] of [['CA', cfg.caPath], ['certificate', cfg.certPath], ['private key', cfg.keyPath]]) {
    if (file && !fs.existsSync(file)) unreadable.push(`${label} file not found: ${file}`);
  }
  if (missing.length || unreadable.length) {
    const lines = [
      'AWS IoT MQTT mode requires TLS configuration that is not present.',
      ...missing.map((m) => `  missing: ${m}`),
      ...unreadable.map((m) => `  ${m}`),
      '',
      'Copy .env.example to .env, fill in the values, and place the certificate',
      'files in certs/ (see certs/README.md). Nothing in certs/ is committed.',
    ];
    const err = new Error(lines.join('\n'));
    err.code = 'MQTT_TLS_CONFIG_MISSING';
    throw err;
  }
  return true;
}

export class MqttPublisher {
  /**
   * @param {object} options
   * @param {'local'|'aws'} options.mqttMode
   * @param {string} options.clientId
   * @param {number} options.qos
   */
  constructor(options = {}) {
    this.mqttMode = options.mqttMode || MQTT.mode;
    this.mode = `mqtt:${this.mqttMode}`;
    this.clientId = options.clientId
      || `${MQTT.clientIdPrefix}-${Math.random().toString(16).slice(2, 10)}`;
    this.qos = options.qos ?? MQTT.qos;
    this.config = options.config || MQTT;
    this.client = null;
    this.published = 0;
    this.failed = 0;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15000;
  }

  /** Connection options. AWS mode is mutual-TLS; local mode is plain TCP. */
  buildConnectOptions() {
    const cfg = this.config;
    if (this.mqttMode === 'aws') {
      assertAwsTlsConfig(cfg);
      return {
        url: `mqtts://${cfg.awsEndpoint}:${cfg.awsPort}`,
        options: {
          clientId: this.clientId,
          protocol: 'mqtts',
          protocolVersion: 4,
          clean: true,
          reconnectPeriod: 2000,
          connectTimeout: this.connectTimeoutMs,
          ca: [fs.readFileSync(cfg.caPath)],
          cert: fs.readFileSync(cfg.certPath),
          key: fs.readFileSync(cfg.keyPath),
          rejectUnauthorized: true, // never disable certificate verification
          minVersion: 'TLSv1.2',
        },
      };
    }
    return {
      url: `mqtt://${cfg.localHost}:${cfg.localPort}`,
      options: {
        clientId: this.clientId,
        clean: true,
        reconnectPeriod: 2000,
        connectTimeout: this.connectTimeoutMs,
      },
    };
  }

  async connect() {
    const mqtt = await import('mqtt');
    const { url, options } = this.buildConnectOptions();
    this.endpointLabel = url.replace(/\/\/([^:]+)/, (m, host) => (
      this.mqttMode === 'aws' ? `//${host.slice(0, 6)}...${host.slice(-18)}` : m
    ));
    await new Promise((resolve, reject) => {
      const client = mqtt.connect(url, options);
      const timer = setTimeout(() => {
        client.end(true);
        reject(new Error(`MQTT connection to ${this.endpointLabel} timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);
      client.once('connect', () => {
        clearTimeout(timer);
        this.client = client;
        resolve();
      });
      client.once('error', (err) => {
        clearTimeout(timer);
        client.end(true);
        reject(err);
      });
    });
    return this;
  }

  async publish(topic, payload) {
    if (!this.client) throw new Error('publisher not connected');
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return new Promise((resolve) => {
      this.client.publish(topic, body, { qos: this.qos }, (err) => {
        if (err) {
          this.failed += 1;
          resolve(false);
        } else {
          this.published += 1;
          resolve(true);
        }
      });
    });
  }

  async end() {
    if (!this.client) return true;
    await new Promise((resolve) => this.client.end(false, {}, resolve));
    this.client = null;
    return true;
  }
}

/** Factory used by the simulator. `target` is 'stdout' or 'mqtt'. */
export async function createPublisher({ target, mqttMode, clientId, onPublish } = {}) {
  if (target !== 'mqtt') return new StdoutPublisher({ onPublish });
  const publisher = new MqttPublisher({ mqttMode, clientId });
  await publisher.connect();
  return publisher;
}
