// Node-RED function node: NORMALISE
//
// What: converts an accepted, mode-specific raw event into the shared
//       normalised envelope, and sets the outbound MQTT topic.
// Why:  downstream services should not have to know four payload shapes. The
//       envelope gives them one uniform structure, while modeData preserves
//       every mode-specific field so no information is destroyed. This is the
//       last step before the event reaches the queue.
//
// Output topic: transport/normalized/{bus|tram|train|demand}
var p = msg.payload;
var mode = msg.transportMode;
var receivedAt = msg.receivedAt || new Date().toISOString();

var normalized = {
    schemaVersion: '1.0',
    eventId: p.eventId,
    sourceEventType: p.eventType,
    transportMode: mode,
    entityId: mode === 'demand' ? p.locationId : p.vehicleId,
    serviceId: p.serviceId === undefined ? null : p.serviceId,
    routeId: p.routeId === undefined ? null : p.routeId,
    routeIds: p.routeIds || (p.routeId ? [p.routeId] : []),
    locationId: p.locationId === undefined ? null : p.locationId,
    locationType: p.locationType === undefined ? null : p.locationType,
    timestamp: p.timestamp,
    receivedAt: receivedAt,
    position: null,
    metrics: {},
    health: 'normal',
    demandLevel: null,
    modeData: {},
    validation: { validatedBy: msg.validatedBy || 'node-red', branch: mode }
};

if (mode === 'demand') {
    normalized.metrics = {
        passengerCount: p.passengerCount === undefined ? null : p.passengerCount,
        waitingTimeSeconds: p.waitingTimeSeconds === undefined ? null : p.waitingTimeSeconds
    };
    normalized.demandLevel = p.demandLevel === undefined ? null : p.demandLevel;
    normalized.modeData = {
        locationType: p.locationType,
        shelterCapacity: p.shelterCapacity === undefined ? null : p.shelterCapacity
    };
} else {
    normalized.position = { latitude: p.latitude, longitude: p.longitude };
    normalized.metrics = {
        speedKph: p.speedKph === undefined ? null : p.speedKph,
        occupancy: p.occupancy === undefined ? null : p.occupancy,
        capacity: p.capacity === undefined ? null : p.capacity,
        delaySeconds: p.delaySeconds === undefined ? null : p.delaySeconds
    };
    normalized.health = p.health;
    // Copy so the mode-specific fields survive normalisation intact.
    normalized.modeData = Object.assign({}, p.modeData);
}

msg.payload = normalized;
msg.topic = 'transport/normalized/' + mode;

// Evidence-friendly one-liner. node.warn is used so it is visible in the
// Node-RED debug sidebar without needing a debug node wired to every branch.
var label = mode === 'demand'
    ? normalized.entityId + ' passengers=' + normalized.metrics.passengerCount
    : normalized.entityId + ' health=' + normalized.health + ' delay=' + normalized.metrics.delaySeconds + 's';
node.status({ fill: 'green', shape: 'dot', text: 'accepted ' + mode + ' ' + normalized.entityId });
node.warn('[ACCEPTED] mode=' + mode + ' eventId=' + normalized.eventId + ' ' + label);

return msg;
