/**
 * Synthetic transport network.
 *
 * What: builds a deterministic set of bus routes/stops, tram lines/stops and
 *       train lines/stations from the run seed, then assigns vehicles to them.
 * Why:  the disruption model needs a real notion of "downstream stops on this
 *       route" so that one breakdown can fan out into many INDEPENDENT
 *       route-impact jobs. Independence is what makes the work parallelisable
 *       across ECS tasks - that is the whole basis of the scaling experiment.
 *
 * Input:  fleet sizes + seed.
 * Output: routes, stops/stations and the fleet, all reproducible.
 */
import { Rng } from './rng.js';

const BUS_ROUTES = ['703', '733', '742', '767', '822', '888', '901', '907'];
const TRAM_LINES = ['16', '48', '70', '72', '75', '96', '109'];
const TRAIN_LINES = ['BELGRAVE', 'LILYDALE', 'ALAMEIN', 'GLEN-WAVERLEY', 'PAKENHAM'];
const STATION_NAMES = [
  'BOX-HILL', 'LABURNUM', 'BLACKBURN', 'NUNAWADING', 'MITCHAM', 'HEATHERDALE',
  'RINGWOOD', 'CAMBERWELL', 'HAWTHORN', 'RICHMOND', 'BURNLEY', 'GLENFERRIE',
  'AUBURN', 'CANTERBURY', 'CHATHAM', 'SURREY-HILLS', 'UNION', 'MONT-ALBERT',
  'CROYDON', 'LILYDALE-TERMINUS',
];

/** Melbourne-ish bounding box - keeps coordinates plausible for screenshots. */
const GEO = { latMin: -37.92, latMax: -37.72, lonMin: 144.88, lonMax: 145.35 };

function buildStops(rng, prefix, count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${String(i + 1).padStart(3, '0')}`,
    latitude: Number(rng.float(GEO.latMin, GEO.latMax).toFixed(5)),
    longitude: Number(rng.float(GEO.lonMin, GEO.lonMax).toFixed(5)),
  }));
}

/**
 * @param {object} options
 * @param {number} options.seed
 * @param {number} options.buses
 * @param {number} options.trams
 * @param {number} options.trains
 * @param {number} options.locations number of demand locations
 */
export function buildNetwork({ seed, buses, trams, trains, locations }) {
  const rng = new Rng(seed).child('network');

  // Route counts scale with fleet size but stay bounded and repeatable.
  const busRouteCount = Math.max(1, Math.min(BUS_ROUTES.length, Math.ceil(buses / 8)));
  const tramLineCount = Math.max(1, Math.min(TRAM_LINES.length, Math.ceil(trams / 5)));
  const trainLineCount = Math.max(1, Math.min(TRAIN_LINES.length, Math.ceil(trains / 4)));

  const busRoutes = BUS_ROUTES.slice(0, busRouteCount).map((routeId, i) => ({
    routeId,
    serviceId: `SERVICE-${routeId}`,
    stops: buildStops(rng.child(`bus-route-${routeId}`), `BUS-STOP-${100 + i * 100}`, 12)
      .map((s, idx) => ({ ...s, id: `BUS-STOP-${100 + i * 100 + idx}` })),
    segments: Array.from({ length: 12 }, (_, k) => `ROAD-SEG-${i * 20 + k + 1}`),
  }));

  const tramLines = TRAM_LINES.slice(0, tramLineCount).map((routeId, i) => ({
    routeId,
    serviceId: `TRAM-SERVICE-${routeId}`,
    stops: Array.from({ length: 14 }, (_, idx) => ({
      id: `TRAM-STOP-${200 + i * 100 + idx}`,
      latitude: Number(rng.float(GEO.latMin, GEO.latMax).toFixed(5)),
      longitude: Number(rng.float(GEO.lonMin, GEO.lonMax).toFixed(5)),
    })),
    segments: Array.from({ length: 14 }, (_, k) => `TRAM-SEG-${i * 20 + k + 1}`),
  }));

  const trainLines = TRAIN_LINES.slice(0, trainLineCount).map((routeId, i) => {
    const stations = STATION_NAMES.slice(i * 4, i * 4 + 8);
    const chosen = stations.length >= 4 ? stations : STATION_NAMES.slice(0, 8);
    return {
      routeId,
      serviceId: `TRAIN-SERVICE-${routeId}`,
      stations: chosen.map((name, idx) => ({
        id: name,
        platform: (idx % 4) + 1,
        latitude: Number(rng.float(GEO.latMin, GEO.latMax).toFixed(5)),
        longitude: Number(rng.float(GEO.lonMin, GEO.lonMax).toFixed(5)),
      })),
    };
  });

  // Fleet assignment is round-robin so it stays stable as counts grow.
  const busFleet = Array.from({ length: buses }, (_, i) => {
    const route = busRoutes[i % busRoutes.length];
    return {
      vehicleId: `BUS-${String(i + 1).padStart(3, '0')}`,
      transportMode: 'bus',
      routeId: route.routeId,
      serviceId: route.serviceId,
      route,
      capacity: rng.child(`bus-cap-${i}`).pick([45, 55, 60, 70, 80]),
      stopIndex: i % route.stops.length,
    };
  });

  const tramFleet = Array.from({ length: trams }, (_, i) => {
    const line = tramLines[i % tramLines.length];
    return {
      vehicleId: `TRAM-${String(i + 1).padStart(3, '0')}`,
      transportMode: 'tram',
      routeId: line.routeId,
      serviceId: line.serviceId,
      route: line,
      capacity: rng.child(`tram-cap-${i}`).pick([120, 150, 180, 210]),
      stopIndex: i % line.stops.length,
      direction: i % 2 === 0 ? 'outbound' : 'inbound',
    };
  });

  const trainFleet = Array.from({ length: trains }, (_, i) => {
    const line = trainLines[i % trainLines.length];
    const carriages = rng.child(`train-car-${i}`).pick([3, 6, 6, 9]);
    return {
      vehicleId: `TRAIN-${String(i + 1).padStart(3, '0')}`,
      transportMode: 'train',
      routeId: line.routeId,
      serviceId: line.serviceId,
      route: line,
      carriageCount: carriages,
      capacity: carriages * 130,
      stopIndex: i % line.stations.length,
    };
  });

  // Demand locations are drawn from the real stop/station inventory so that a
  // disruption at a stop and demand at that stop refer to the same place.
  const allLocations = [
    ...busRoutes.flatMap((r) => r.stops.map((s) => ({
      locationId: s.id, locationType: 'busStop', routeIds: [r.routeId],
    }))),
    ...tramLines.flatMap((r) => r.stops.map((s) => ({
      locationId: s.id, locationType: 'tramStop', routeIds: [r.routeId],
    }))),
    ...trainLines.flatMap((r) => r.stations.map((s) => ({
      locationId: s.id, locationType: 'station', routeIds: [r.routeId],
    }))),
  ];
  const shuffled = rng.child('locations').shuffle(allLocations);
  const demandLocations = Array.from({ length: locations }, (_, i) => {
    const base = shuffled[i % shuffled.length];
    return {
      ...base,
      // A station serves several lines - merge them so routeIds is meaningful.
      routeIds: base.locationType === 'station'
        ? trainLines.filter((l) => l.stations.some((s) => s.id === base.locationId))
          .map((l) => l.routeId)
        : base.routeIds,
      shelterCapacity: 20 + (i % 5) * 15,
    };
  });

  return {
    seed,
    busRoutes,
    tramLines,
    trainLines,
    fleet: { bus: busFleet, tram: tramFleet, train: trainFleet },
    demandLocations,
    /** All stops/stations on a route - the fan-out candidate set. */
    locationsForRoute(mode, routeId) {
      if (mode === 'bus') {
        return (busRoutes.find((r) => r.routeId === routeId)?.stops || []).map((s) => s.id);
      }
      if (mode === 'tram') {
        return (tramLines.find((r) => r.routeId === routeId)?.stops || []).map((s) => s.id);
      }
      return (trainLines.find((r) => r.routeId === routeId)?.stations || []).map((s) => s.id);
    },
    summary() {
      return {
        busRoutes: busRoutes.length,
        tramLines: tramLines.length,
        trainLines: trainLines.length,
        buses: busFleet.length,
        trams: tramFleet.length,
        trains: trainFleet.length,
        demandLocations: demandLocations.length,
      };
    },
  };
}

export { GEO };
