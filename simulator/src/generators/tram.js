/**
 * Tram telemetry generator.
 *
 * Mode-specific fields: trackSegmentId, direction, nextStopId, couplingCount.
 * Health states: normal | degraded | blocked. A blocked tram cannot be diverted
 * because it is on rails, which is why a blockage impacts an entire segment.
 */
import { delayFor, eventId, occupancyFor, positionIndex, speedFor } from './common.js';

export const TRAM_HEALTH_STATES = ['normal', 'degraded', 'blocked'];

export function generateTramTelemetry({ entity, rng, tick, timestamp, health = 'normal' }) {
  const stops = entity.route.stops;
  const idx = positionIndex(entity, tick, stops.length);
  const stop = stops[idx];
  const step = entity.direction === 'inbound' ? -1 : 1;
  const nextStop = stops[(idx + step + stops.length) % stops.length];
  return {
    eventId: eventId('evt'),
    eventType: 'telemetry',
    transportMode: 'tram',
    vehicleId: entity.vehicleId,
    serviceId: entity.serviceId,
    routeId: entity.routeId,
    locationId: stop.id,
    timestamp,
    latitude: Number((stop.latitude + rng.float(-0.0005, 0.0005)).toFixed(5)),
    longitude: Number((stop.longitude + rng.float(-0.0005, 0.0005)).toFixed(5)),
    speedKph: speedFor(rng, health, 45),
    occupancy: occupancyFor(rng, entity.capacity, tick, 0.55),
    capacity: entity.capacity,
    delaySeconds: delayFor(rng, health, tick),
    health,
    modeData: {
      trackSegmentId: entity.route.segments[idx % entity.route.segments.length],
      direction: entity.direction,
      nextStopId: nextStop.id,
      couplingCount: entity.capacity > 180 ? 2 : 1,
    },
  };
}
