/**
 * Deterministic pseudo-random number generator.
 *
 * What: a seeded 32-bit PRNG (mulberry32) plus the sampling helpers the
 *       generators need.
 * Why:  the experiment design requires each stage to be repeated three times
 *       with the SAME seed, and Experiment A (fixed 1 task) must be compared
 *       against Experiment B (autoscaling) using an IDENTICAL workload.
 *       Math.random() would make that comparison meaningless. Every entity also
 *       gets its own child stream derived from the run seed, so changing the
 *       number of trams does not shift the bus stream.
 */

/** mulberry32 - small, fast, and good enough for workload generation. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable string -> 32-bit hash, used to derive per-entity seeds. */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.next = mulberry32(this.seed);
  }

  /** Derive an independent stream. Same label + same parent seed = same stream. */
  child(label) {
    return new Rng((this.seed ^ hashString(String(label))) >>> 0);
  }

  float(min = 0, max = 1) {
    return min + this.next() * (max - min);
  }

  /** Inclusive integer in [min, max]. */
  int(min, max) {
    return Math.floor(this.float(min, max + 1));
  }

  bool(probability = 0.5) {
    return this.next() < probability;
  }

  pick(array) {
    return array[this.int(0, array.length - 1)];
  }

  /** Fisher-Yates using this stream - deterministic for a given seed. */
  shuffle(array) {
    const out = [...array];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** Box-Muller normal sample, clamped so payloads stay schema-valid. */
  gaussian(meanValue, stdDev, min = -Infinity, max = Infinity) {
    const u1 = Math.max(this.next(), 1e-9);
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.min(max, Math.max(min, meanValue + z * stdDev));
  }

  /** Weighted pick: entries are [value, weight]. */
  weighted(entries) {
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.float(0, total);
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return value;
    }
    return entries[entries.length - 1][0];
  }
}

export default Rng;
