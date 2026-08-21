/**
 * Behaviour shared by the three vehicle generators.
 *
 * What: load factor, delay and speed models plus the event-id helper.
 * Why:  the four raw event types must share a common core (so normalisation is
 *       meaningful) while still differing in real, mode-specific ways. Anything
 *       genuinely shared lives here; anything mode-specific lives in the
 *       individual generator, which is what "Variety" means in this project.
 */
import { newId } from '@sit314/shared/util';

/**
 * A smooth peak/off-peak style load curve so occupancy is not white noise.
 * `tick` is the reporting cycle number, so the curve is reproducible.
 */
export function loadFactor(rng, tick, base = 0.5) {
  const wave = Math.sin((tick % 60) / 60 * Math.PI * 2) * 0.18;
  return Math.min(1.35, Math.max(0.02, base + wave + rng.gaussian(0, 0.08, -0.25, 0.25)));
}

/** Occupancy derived from capacity and the load curve, clamped to the schema. */
export function occupancyFor(rng, capacity, tick, base = 0.5) {
  const raw = Math.round(capacity * loadFactor(rng, tick, base));
  return Math.max(0, Math.min(Math.round(capacity * 1.4), raw));
}

/**
 * Delay model. Healthy services drift by a minute or two; degraded services
 * accumulate more; a hard failure (breakdown/blocked/cancelled) produces the
 * large delay the processor's severe-delay rule reacts to.
 */
export function delayFor(rng, health, tick) {
  const drift = Math.round(rng.gaussian(70, 110, -120, 900));
  if (health === 'normal') return Math.max(-60, drift);
  if (health === 'degraded') return Math.max(0, drift + 240 + rng.int(0, 300));
  // breakdown / blocked / cancelled
  return Math.max(0, drift + 900 + rng.int(0, 1800) + Math.min(tick, 60) * 5);
}

export function speedFor(rng, health, maxSpeed) {
  if (health === 'breakdown' || health === 'cancelled') return 0;
  if (health === 'blocked') return Number(rng.float(0, 4).toFixed(1));
  if (health === 'degraded') return Number(rng.float(3, maxSpeed * 0.5).toFixed(1));
  return Number(rng.float(maxSpeed * 0.25, maxSpeed * 0.95).toFixed(1));
}

export function eventId(prefix = 'evt') {
  return newId(prefix);
}

/** Advances an entity along its route deterministically. */
export function positionIndex(entity, tick, length) {
  return (entity.stopIndex + tick) % length;
}
