/**
 * Small shared helpers.
 *
 * What: id generation, time helpers, statistics used by every service.
 * Why: identifiers must be stable and unique because every stage of the
 *      pipeline uses them as the idempotency key for conditional writes.
 */
import { randomUUID, createHash } from 'node:crypto';

/** Prefixed unique id, e.g. `evt-3f0c...`. */
export function newId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Deterministic id derived from stable inputs.
 * Used so that re-running the same seeded experiment produces the same
 * jobIds/alertIds - which in turn makes duplicate-suppression observable.
 */
export function derivedId(prefix, ...parts) {
  const hash = createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 24);
  return `${prefix}-${hash}`;
}

export const nowIso = () => new Date().toISOString();

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Milliseconds between two ISO timestamps (b - a). Returns null if unparsable. */
export function isoDeltaMs(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return tb - ta;
}

/** Nearest-rank percentile. `p` is 0-100. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Round to `dp` decimal places, keeping the value a number. */
export const round = (n, dp = 2) => (n === null || n === undefined ? null : Number(n.toFixed(dp)));

/**
 * Deterministic CPU work used only by the configurable worker processing cost.
 * See docs/SCALABILITY_TESTING.md - this is a documented TEST PARAMETER, it is
 * not used to manipulate measured results.
 */
export function burnCpu(iterations) {
  let acc = 0;
  for (let i = 0; i < iterations; i += 1) {
    acc += Math.sqrt(i % 10007) * Math.sin(i % 977);
  }
  return acc;
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
