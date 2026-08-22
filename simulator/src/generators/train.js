/**
 * Train telemetry generator.
 *
 * Mode-specific fields: stationId, platform, carriageCount, nextStationId,
 * expressService. Health states: normal | degraded | cancelled.
 * A cancellation removes an entire service, so its impact is the widest.
 */
import { delayFor, eventId, occupancyFor, positionIndex, speedFor } from './common.js';

export const TRAIN_HEALTH_STATES = ['normal', 'degraded', 'cancelled'];

export function generateTrainTelemetry({ entity, rng, tick, timestamp, health = 'normal' }) {
  const stations = entity.route.stations;
  const idx = positionIndex(entity, tick, stations.length);
  const station = stations[idx];
  const nextStation = stations[(idx + 1) % stations.length];
  return {
    eventId: eventId('evt'),
    eventType: 'telemetry',
    transportMode: 'train',
    vehicleId: entity.vehicleId,
    serviceId: entity.serviceId,
    routeId: entity.routeId,
    locationId: station.id,
    timestamp,
    latitude: Number((station.latitude + rng.float(-0.002, 0.002)).toFixed(5)),
    longitude: Number((station.longitude + rng.float(-0.002, 0.002)).toFixed(5)),
    speedKph: speedFor(rng, health, 130),
    occupancy: occupancyFor(rng, entity.capacity, tick, 0.45),
    capacity: entity.capacity,
    delaySeconds: delayFor(rng, health, tick),
    health,
    modeData: {
      stationId: station.id,
      platform: station.platform,
      carriageCount: entity.carriageCount,
      nextStationId: nextStation.id,
      expressService: rng.bool(0.3),
    },
  };
}
