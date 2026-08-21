/**
 * Metrics publishing (CloudWatch, or a local CSV/JSONL equivalent).
 *
 * What: buffers counters and timings and flushes them periodically.
 * Why:  CloudWatch is how the bottleneck is identified in the final report -
 *       queue depth, age of oldest message, processing latency and task count
 *       are the four series that show WHERE the system stopped keeping up.
 *       Publishing the same metric names locally means the experiment runner
 *       produces the same series without an AWS account.
 *
 * Output: METRICS_BACKEND=local  -> artifacts/metrics/<service>.csv (+ .jsonl)
 *         METRICS_BACKEND=aws    -> CloudWatch namespace SIT314/Transport
 */
import fs from 'node:fs';
import path from 'node:path';
import { ARTIFACTS_DIR, BACKENDS, REGION, SCALING } from '../config/index.js';
import { mean, percentile, round } from '../util/index.js';

const CSV_HEADER = 'timestamp,service,metric,value,unit,dimensions\n';

class LocalMetrics {
  constructor(service, dir) {
    this.service = service;
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.csvPath = path.join(dir, `${service}.csv`);
    if (!fs.existsSync(this.csvPath)) fs.writeFileSync(this.csvPath, CSV_HEADER);
    this.stream = fs.createWriteStream(this.csvPath, { flags: 'a' });
  }

  async publish(points) {
    for (const p of points) {
      const dims = Object.entries(p.dimensions || {}).map(([k, v]) => `${k}=${v}`).join(';');
      this.stream.write(
        `${p.timestamp},${this.service},${p.name},${p.value},${p.unit},"${dims}"\n`,
      );
    }
  }

  async close() {
    await new Promise((resolve) => this.stream.end(resolve));
  }
}

class CloudWatchMetrics {
  constructor(service, namespace, region) {
    this.service = service;
    this.namespace = namespace;
    this.region = region;
    this._client = null;
    this._sdk = null;
  }

  async #client() {
    if (!this._client) {
      this._sdk = await import('@aws-sdk/client-cloudwatch');
      this._client = new this._sdk.CloudWatchClient({ region: this.region });
    }
    return { client: this._client, sdk: this._sdk };
  }

  async publish(points) {
    if (!points.length) return;
    const { client, sdk } = await this.#client();
    // CloudWatch accepts at most 1000 metric data items per call (20 is plenty here).
    for (let i = 0; i < points.length; i += 20) {
      const slice = points.slice(i, i + 20);
      await client.send(new sdk.PutMetricDataCommand({
        Namespace: this.namespace,
        MetricData: slice.map((p) => ({
          MetricName: p.name,
          Value: p.value,
          Unit: p.unit,
          Timestamp: new Date(p.timestamp),
          Dimensions: Object.entries({ Service: this.service, ...(p.dimensions || {}) })
            .map(([Name, Value]) => ({ Name, Value: String(Value) })),
        })),
      }));
    }
  }

  async close() { /* nothing buffered client-side */ }
}

/**
 * Metric recorder used by every service.
 * `counter` values are summed and flushed; `timing` values are flushed as
 * count / mean / p95 so latency percentiles are available in both backends.
 */
export function createMetrics(service, options = {}) {
  const backend = options.backend || BACKENDS.metrics;
  const dimensions = options.dimensions || {};
  const sink = backend === 'aws' || backend === 'cloudwatch'
    ? new CloudWatchMetrics(service, options.namespace || SCALING.metricNamespace,
      options.region || REGION)
    : new LocalMetrics(service, options.dir || path.join(ARTIFACTS_DIR, 'metrics'));

  const counters = new Map();
  const timings = new Map();
  const gauges = new Map();

  const api = {
    backend,
    counter(name, value = 1, dims = {}) {
      const key = `${name}|${JSON.stringify(dims)}`;
      const cur = counters.get(key) || { name, dims, value: 0 };
      cur.value += value;
      counters.set(key, cur);
    },
    timing(name, ms, dims = {}) {
      const key = `${name}|${JSON.stringify(dims)}`;
      const cur = timings.get(key) || { name, dims, values: [] };
      cur.values.push(ms);
      timings.set(key, cur);
    },
    gauge(name, value, dims = {}) {
      gauges.set(`${name}|${JSON.stringify(dims)}`, { name, dims, value });
    },
    snapshot() {
      const out = {};
      for (const c of counters.values()) out[c.name] = c.value;
      for (const t of timings.values()) {
        out[`${t.name}Mean`] = round(mean(t.values));
        out[`${t.name}P95`] = round(percentile(t.values, 95));
      }
      for (const g of gauges.values()) out[g.name] = g.value;
      return out;
    },
    async flush() {
      const timestamp = new Date().toISOString();
      const points = [];
      const push = (name, value, unit, dims) => points.push({
        timestamp, name, value, unit, dimensions: { ...dimensions, ...dims },
      });
      for (const c of counters.values()) push(c.name, c.value, 'Count', c.dims);
      for (const t of timings.values()) {
        if (!t.values.length) continue;
        push(`${t.name}Count`, t.values.length, 'Count', t.dims);
        push(`${t.name}Mean`, round(mean(t.values)), 'Milliseconds', t.dims);
        push(`${t.name}P95`, round(percentile(t.values, 95)), 'Milliseconds', t.dims);
      }
      for (const g of gauges.values()) push(g.name, g.value, 'Count', g.dims);
      counters.clear();
      timings.clear();
      if (!points.length) return 0;
      await sink.publish(points);
      return points.length;
    },
    async close() {
      await api.flush();
      await sink.close();
    },
  };
  return api;
}

export { LocalMetrics, CloudWatchMetrics };
