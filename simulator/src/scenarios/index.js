/**
 * Disruption scenarios.
 *
 * What: a scenario decides which vehicles become unhealthy, when, and which
 *       locations see a passenger surge as a result.
 * Why:  the four approved experiment stages are driven by four different
 *       incident types, and each incident type must produce a different
 *       fan-out size. Keeping the scenarios declarative means the same code
 *       path runs for a 10-vehicle demo and a 1000-vehicle load stage.
 *
 * Input:  the built network + resolved run options.
 * Output: { healthFor(entity, tick), surgeFor(location, tick), describe() }
 */
import { Rng } from '../rng.js';

export const SCENARIO_NAMES = [
  'normal',
  'bus-breakdown',
  'tram-blockage',
  'train-cancellation',
  'multimodal-disruption',
];

/**
 * @param {string} name scenario name
 * @param {object} network from buildNetwork()
 * @param {object} options { seed, disruptAfterTicks, degradeBeforeFailure }
 */
export function createScenario(name, network, options = {}) {
  const seed = options.seed ?? 1;
  const startTick = options.disruptAfterTicks ?? 5;
  const rng = new Rng(seed).child(`scenario-${name}`);
  const degradeLead = options.degradeBeforeFailure ?? 2;

  /** Vehicles selected up-front so the same seed always breaks the same vehicle. */
  const targets = [];
  const pickVehicle = (mode, failHealth) => {
    const fleet = network.fleet[mode];
    if (!fleet.length) return null;
    const entity = fleet[rng.int(0, fleet.length - 1)];
    const target = { mode, vehicleId: entity.vehicleId, routeId: entity.routeId, failHealth };
    targets.push(target);
    return target;
  };

  switch (name) {
    case 'bus-breakdown':
      pickVehicle('bus', 'breakdown');
      break;
    case 'tram-blockage':
      pickVehicle('tram', 'blocked');
      break;
    case 'train-cancellation':
      pickVehicle('train', 'cancelled');
      break;
    case 'multimodal-disruption':
      pickVehicle('bus', 'breakdown');
      pickVehicle('tram', 'blocked');
      pickVehicle('train', 'cancelled');
      break;
    case 'normal':
    default:
      break;
  }

  // Explicit override wins, e.g. the checkpoint demo pins BUS-007.
  if (options.disruptVehicleId && targets.length) {
    targets[0].vehicleId = options.disruptVehicleId;
    const fleetEntity = Object.values(network.fleet)
      .flat()
      .find((e) => e.vehicleId === options.disruptVehicleId);
    if (fleetEntity) {
      targets[0].mode = fleetEntity.transportMode;
      targets[0].routeId = fleetEntity.routeId;
    }
  }

  const byVehicle = new Map(targets.map((t) => [t.vehicleId, t]));
  const surgeLocations = new Set(
    targets.flatMap((t) => network.locationsForRoute(t.mode, t.routeId).slice(0, 8)),
  );

  return {
    name,
    targets,
    startTick,

    /**
     * Health for one vehicle at one tick. Vehicles degrade first and then fail,
     * which gives the processor a realistic ramp rather than a step change.
     */
    healthFor(entity, tick) {
      const target = byVehicle.get(entity.vehicleId);
      if (!target) {
        // A small amount of background degradation keeps the data realistic
        // without tripping the incident rules for every vehicle.
        return rng.child(`bg-${entity.vehicleId}-${tick}`).bool(0.01) ? 'degraded' : 'normal';
      }
      if (tick >= startTick) return target.failHealth;
      if (tick >= startTick - degradeLead) return 'degraded';
      return 'normal';
    },

    /** Passenger surge multiplier at a location once the incident has started. */
    surgeFor(location, tick) {
      if (tick < startTick) return 1;
      return surgeLocations.has(location.locationId) ? 2.5 : 1;
    },

    describe() {
      if (!targets.length) return 'normal operation, no injected disruption';
      return targets
        .map((t) => `${t.mode} ${t.vehicleId} -> ${t.failHealth} at tick ${startTick}`)
        .join('; ');
    },
  };
}

export default createScenario;
