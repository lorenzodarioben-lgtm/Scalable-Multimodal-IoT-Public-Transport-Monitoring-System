/**
 * Bus telemetry generator.
 *
 * Mode-specific fields: roadSegmentId, nextStopId, doorsOpen, wheelchairRampOk.
 * Health states: normal | degraded | breakdown.
 */
import { delayFor, eventId, occupancyFor, positionIndex, speedFor } from './common.js';

export const BUS_HEALTH_STATES = ['normal', 'degraded', 'breakdown'];

export function generateBusTelemetry({ entity, rng, tick, timestamp, health = 'normal' }) {
  const stops = entity.route.stops;
  const idx = positionIndex(entity, tick, stops.length);
  const stop = stops[idx];
  const nextStop = stops[(idx + 1) % stops.length];
  const occupancy = occupancyFor(rng, entity.capacity, tick, 0.5);
  return {
    eventId: eventId('evt'),
    eventType: 'telemetry',
    transportMode: 'bus',
    vehicleId: entity.vehicleId,
    serviceId: entity.serviceId,
    routeId: entity.routeId,
    locationId: stop.id,
    timestamp,
    latitude: Number((stop.latitude + rng.float(-0.0008, 0.0008)).toFixed(5)),
    longitude: Number((stop.longitude + rng.float(-0.0008, 0.0008)).toFixed(5)),
    speedKph: speedFor(rng, health, 60),
    occupancy,
    capacity: entity.capacity,
    delaySeconds: delayFor(rng, health, tick),
    health,
    modeData: {
      roadSegmentId: entity.route.segments[idx % entity.route.segments.length],
      nextStopId: nextStop.id,
      doorsOpen: health === 'breakdown' ? true : rng.bool(0.25),
      wheelchairRampOk: health === 'breakdown' ? false : rng.bool(0.95),
    },
  };
}
