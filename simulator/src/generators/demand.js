/**
 * Location demand generator.
 *
 * This is the fourth, structurally different event type: it has no vehicle, no
 * speed and no capacity - it describes people waiting at a place. It is what
 * makes the "Variety" claim more than four renamed copies of one payload.
 */
import { eventId } from './common.js';

export const DEMAND_LEVELS = ['low', 'moderate', 'high', 'critical'];

/** Demand level is derived from the passenger count, not chosen at random. */
export function demandLevelFor(passengerCount, shelterCapacity) {
  const capacity = shelterCapacity > 0 ? shelterCapacity : 30;
  const ratio = passengerCount / capacity;
  if (ratio >= 3) return 'critical';
  if (ratio >= 2) return 'high';
  if (ratio >= 1) return 'moderate';
  return 'low';
}

export function generateDemandEvent({ entity, rng, tick, timestamp, surgeMultiplier = 1 }) {
  const wave = 1 + Math.sin((tick % 45) / 45 * Math.PI * 2) * 0.5;
  const base = rng.gaussian(entity.shelterCapacity * 1.1, entity.shelterCapacity * 0.5, 0, 4000);
  const passengerCount = Math.max(0, Math.round(base * wave * surgeMultiplier));
  return {
    eventId: eventId('evt-demand'),
    eventType: 'locationDemand',
    locationType: entity.locationType,
    locationId: entity.locationId,
    routeIds: entity.routeIds.length ? entity.routeIds : ['UNKNOWN'],
    timestamp,
    passengerCount,
    demandLevel: demandLevelFor(passengerCount, entity.shelterCapacity),
    waitingTimeSeconds: Math.max(0, Math.round(rng.gaussian(240, 180, 0, 7200))),
    shelterCapacity: entity.shelterCapacity,
  };
}
