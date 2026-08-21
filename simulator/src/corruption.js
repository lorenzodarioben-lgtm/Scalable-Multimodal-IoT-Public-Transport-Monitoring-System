/**
 * Deliberate event corruption.
 *
 * What: takes a valid raw event and breaks it in one specific, documented way.
 * Why:  the Node-RED validation branches must be provably doing something.
 *       Publishing a controlled fraction of invalid events (`--invalid-rate`)
 *       produces [REJECTED] evidence with a real reason, and proves invalid
 *       data never reaches the telemetry queue.
 *
 * Invalid events are never the default: invalidRate defaults to 0.
 */

/** Each mutation maps to one of the validation rules stated in the schemas. */
export const CORRUPTIONS = [
  { id: 'negativeOccupancy', applies: (e) => e.eventType === 'telemetry', apply: (e) => ({ ...e, occupancy: -1 * (1 + (e.occupancy % 20)) }) },
  { id: 'zeroCapacity', applies: (e) => e.eventType === 'telemetry', apply: (e) => ({ ...e, capacity: 0 }) },
  { id: 'occupancyFarAboveCapacity', applies: (e) => e.eventType === 'telemetry', apply: (e) => ({ ...e, occupancy: e.capacity * 5 }) },
  { id: 'negativeSpeed', applies: (e) => e.eventType === 'telemetry', apply: (e) => ({ ...e, speedKph: -12 }) },
  { id: 'invalidTimestamp', applies: () => true, apply: (e) => ({ ...e, timestamp: 'not-a-timestamp' }) },
  { id: 'missingVehicleId', applies: (e) => e.eventType === 'telemetry', apply: (e) => { const c = { ...e }; delete c.vehicleId; return c; } },
  { id: 'missingRouteInformation', applies: (e) => e.eventType === 'telemetry', apply: (e) => { const c = { ...e }; delete c.routeId; delete c.serviceId; return c; } },
  { id: 'malformedMode', applies: () => true, apply: (e) => ({ ...e, transportMode: 'hovercraft' }) },
  { id: 'missingModeData', applies: (e) => e.eventType === 'telemetry', apply: (e) => { const c = { ...e }; delete c.modeData; return c; } },
  { id: 'invalidHealthState', applies: (e) => e.eventType === 'telemetry', apply: (e) => ({ ...e, health: 'on-fire' }) },
  { id: 'negativePassengerCount', applies: (e) => e.eventType === 'locationDemand', apply: (e) => ({ ...e, passengerCount: -7 }) },
  { id: 'invalidDemandLevel', applies: (e) => e.eventType === 'locationDemand', apply: (e) => ({ ...e, demandLevel: 'extreme' }) },
  { id: 'emptyRouteIds', applies: (e) => e.eventType === 'locationDemand', apply: (e) => ({ ...e, routeIds: [] }) },
];

/**
 * Corrupt one event. The choice is made from the seeded stream, so the same
 * seed corrupts the same events in the same way - required for the repeated
 * experiment runs.
 */
export function corruptEvent(event, rng) {
  const candidates = CORRUPTIONS.filter((c) => c.applies(event));
  const chosen = candidates[rng.int(0, candidates.length - 1)];
  const corrupted = chosen.apply(event);
  // Tag the corruption so evidence can be cross-checked against the rejection
  // reason reported by Node-RED. This field is itself schema-invalid, which is
  // acceptable: the event is already deliberately invalid.
  corrupted.__injectedFault = chosen.id;
  return corrupted;
}

export default corruptEvent;
