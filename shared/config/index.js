/**
 * Central configuration.
 *
 * What: one place that resolves every environment variable, resource name,
 *       MQTT topic and business threshold used across the system.
 * Why:  the specification requires topics and resource names to be centralised
 *       rather than scattered as magic strings, and requires the whole system to
 *       be reconfigurable (Volume / Velocity / thresholds) without editing code.
 *
 * Nothing here ever prints a secret. Certificate *paths* are configuration;
 * certificate *contents* stay on disk and out of Git.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');

/** Loads .env if present. Real environment variables always win. */
export function loadEnvFile(file = path.join(REPO_ROOT, '.env')) {
  if (!fs.existsSync(file)) return false;
  try {
    process.loadEnvFile(file);
    return true;
  } catch {
    // Fallback for older runtimes: minimal KEY=VALUE parser.
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
    return true;
  }
}

loadEnvFile();

const str = (key, fallback) => process.env[key] ?? fallback;
const num = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
};

export const PREFIX = str('RESOURCE_PREFIX', 'sit314-transport');
export const REGION = str('AWS_REGION', 'us-east-1');

/** MQTT topic hierarchy - the single source of truth for publishers/subscribers. */
export const TOPICS = {
  rawBase: str('TOPIC_RAW_BASE', 'transport/raw'),
  normalizedBase: str('TOPIC_NORMALIZED_BASE', 'transport/normalized'),
  rejectedBase: str('TOPIC_REJECTED_BASE', 'transport/rejected'),
  raw(mode, id) {
    return `${this.rawBase}/${mode}/${id}`;
  },
  rawWildcard() {
    return `${this.rawBase}/#`;
  },
  normalized(mode) {
    return `${this.normalizedBase}/${mode}`;
  },
  normalizedWildcard() {
    return `${this.normalizedBase}/#`;
  },
  rejected(mode) {
    return `${this.rejectedBase}/${mode}`;
  },
};

export const QUEUES = {
  telemetry: `${PREFIX}-telemetry`,
  telemetryDlq: `${PREFIX}-telemetry-dlq`,
  analysis: `${PREFIX}-analysis`,
  analysisDlq: `${PREFIX}-analysis-dlq`,
  notifications: `${PREFIX}-notifications`,
  notificationsDlq: `${PREFIX}-notifications-dlq`,
};

export const TABLES = {
  processedEvents: `${PREFIX}-processed-events`,
  currentState: `${PREFIX}-current-state`,
  analysisResults: `${PREFIX}-analysis-results`,
  notifications: `${PREFIX}-notifications`,
};

/**
 * Backend selection.
 * `local` - file-backed adapters used for development, unit tests and local
 *           scalability experiments. Real business logic, local plumbing.
 * `aws`   - real AWS SDK v3 clients (SQS / DynamoDB / CloudWatch).
 * See docs/IMPLEMENTATION_DECISIONS.md for why both exist.
 */
export const BACKENDS = {
  queue: str('QUEUE_BACKEND', 'local'),
  store: str('STORE_BACKEND', 'local'),
  metrics: str('METRICS_BACKEND', 'local'),
};

export const LOCAL_DATA_DIR = path.resolve(
  str('LOCAL_DATA_DIR', path.join(REPO_ROOT, 'local-data')),
);
export const ARTIFACTS_DIR = path.resolve(
  str('ARTIFACTS_DIR', path.join(REPO_ROOT, 'artifacts')),
);

export const MQTT = {
  /** `local` = plain TCP to a local broker. `aws` = MQTT over TLS to AWS IoT Core. */
  mode: str('MQTT_MODE', 'local'),
  localHost: str('MQTT_LOCAL_HOST', 'localhost'),
  localPort: num('MQTT_LOCAL_PORT', 1883),
  awsEndpoint: str('AWS_IOT_ENDPOINT', ''),
  awsPort: num('AWS_IOT_PORT', 8883),
  caPath: str('AWS_IOT_CA_PATH', ''),
  certPath: str('AWS_IOT_CERT_PATH', ''),
  keyPath: str('AWS_IOT_PRIVATE_KEY_PATH', ''),
  clientIdPrefix: str('MQTT_CLIENT_ID_PREFIX', 'sit314-sim'),
  qos: num('MQTT_QOS', 0),
};

/** Business thresholds - documented and configurable, never hard-coded inline. */
export const THRESHOLDS = {
  crowding: {
    moderate: num('CROWDING_MODERATE', 0.6),
    high: num('CROWDING_HIGH', 0.85),
    critical: num('CROWDING_CRITICAL', 1.0),
  },
  severeDelaySeconds: num('SEVERE_DELAY_SECONDS', 600),
  majorDelaySeconds: num('MAJOR_DELAY_SECONDS', 1200),
  /** Crowding alone only raises an incident at or above this level. */
  crowdingIncidentLevel: str('CROWDING_INCIDENT_LEVEL', 'critical'),
};

/**
 * Disruption fan-out sizing. One incident must be able to create many jobs,
 * because independent jobs are what let several ECS tasks work in parallel.
 *
 * `targetJobs` is spread evenly across `affectedLocations`, and
 * `targetNotifications` is spread evenly across the jobs, so the totals match
 * the approved experiment stages exactly (50/200, 250/1000, 750/5000, 1500/10000).
 * Every value is overridable via environment variables, which is how the
 * experiment stage files scale the workload without touching source code.
 */
export const FANOUT = {
  bus: {
    affectedLocations: num('FANOUT_BUS_LOCATIONS', 5),
    targetJobs: num('FANOUT_BUS_JOBS', 50),
    targetNotifications: num('FANOUT_BUS_NOTIFICATIONS', 200),
  },
  tram: {
    affectedLocations: num('FANOUT_TRAM_LOCATIONS', 15),
    targetJobs: num('FANOUT_TRAM_JOBS', 250),
    targetNotifications: num('FANOUT_TRAM_NOTIFICATIONS', 1000),
  },
  train: {
    affectedLocations: num('FANOUT_TRAIN_LOCATIONS', 20),
    targetJobs: num('FANOUT_TRAIN_JOBS', 750),
    targetNotifications: num('FANOUT_TRAIN_NOTIFICATIONS', 5000),
  },
  multimodal: {
    affectedLocations: num('FANOUT_MULTIMODAL_LOCATIONS', 40),
    targetJobs: num('FANOUT_MULTIMODAL_JOBS', 1500),
    targetNotifications: num('FANOUT_MULTIMODAL_NOTIFICATIONS', 10000),
  },
  /** Delay-only incidents are deliberately much smaller than hard failures. */
  delay: {
    affectedLocations: num('FANOUT_DELAY_LOCATIONS', 3),
    targetJobs: num('FANOUT_DELAY_JOBS', 6),
    targetNotifications: num('FANOUT_DELAY_NOTIFICATIONS', 12),
  },
};

export const WORKER = {
  batchSize: num('WORKER_BATCH_SIZE', 10),
  waitTimeSeconds: num('WORKER_WAIT_TIME_SECONDS', 5),
  visibilityTimeoutSeconds: num('WORKER_VISIBILITY_TIMEOUT_SECONDS', 30),
  maxReceiveCount: num('QUEUE_MAX_RECEIVE_COUNT', 3),
  concurrency: num('WORKER_CONCURRENCY', 4),
  /** Documented TEST PARAMETER - see docs/SCALABILITY_TESTING.md. Default 0. */
  processingDelayMs: num('WORKER_PROCESSING_DELAY_MS', 0),
  processingCpuIterations: num('WORKER_PROCESSING_CPU_ITERATIONS', 0),
  metricsIntervalMs: num('WORKER_METRICS_INTERVAL_MS', 10000),
  idleExitAfterMs: num('WORKER_IDLE_EXIT_AFTER_MS', 0),
  shutdownGraceMs: num('WORKER_SHUTDOWN_GRACE_MS', 15000),
};

/** Deliberate failure injection. OFF by default - never enabled implicitly. */
export const FAILURE_INJECTION = {
  enabled: bool('FAILURE_INJECTION_ENABLED', false),
  rate: num('FAILURE_RATE', 0),
  duplicateRate: num('FAILURE_DUPLICATE_RATE', 0),
};

export const SCALING = {
  minTasks: num('SCALING_MIN_TASKS', 1),
  maxTasks: num('SCALING_MAX_TASKS', 5),
  targetBacklogPerTask: num('SCALING_TARGET_BACKLOG_PER_TASK', 75),
  scaleOutCooldownSeconds: num('SCALING_SCALE_OUT_COOLDOWN', 60),
  scaleInCooldownSeconds: num('SCALING_SCALE_IN_COOLDOWN', 180),
  evaluationIntervalMs: num('SCALING_EVALUATION_INTERVAL_MS', 10000),
  ecsClusterName: `${PREFIX}-cluster`,
  ecsServiceName: `${PREFIX}-route-impact`,
  metricNamespace: str('METRIC_NAMESPACE', 'SIT314/Transport'),
};

export const config = {
  PREFIX,
  REGION,
  TOPICS,
  QUEUES,
  TABLES,
  BACKENDS,
  MQTT,
  THRESHOLDS,
  FANOUT,
  WORKER,
  FAILURE_INJECTION,
  SCALING,
  LOCAL_DATA_DIR,
  ARTIFACTS_DIR,
  REPO_ROOT,
};

export default config;
