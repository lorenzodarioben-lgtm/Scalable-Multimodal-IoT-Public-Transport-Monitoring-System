// Shared validation rules, inlined into each mode-specific validation node.
// Node-RED function nodes cannot import modules, so this block is injected into
// the bus, tram and train nodes by node-red/build-flows.js. Keeping it in one
// source file means the three branches can never drift apart.
function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }
function isFiniteNumber(v) { return typeof v === 'number' && isFinite(v); }
function isInteger(v) { return isFiniteNumber(v) && Math.floor(v) === v; }

// Rules every vehicle telemetry event must satisfy, regardless of mode.
function checkVehicleCommon(p, errors) {
    if (!isNonEmptyString(p.eventId)) errors.push('eventId is required');
    if (!isNonEmptyString(p.vehicleId)) errors.push('vehicleId is required');
    if (!isNonEmptyString(p.routeId)) errors.push('routeId is required');
    if (!isNonEmptyString(p.serviceId)) errors.push('serviceId is required');
    if (!isNonEmptyString(p.timestamp) || isNaN(Date.parse(p.timestamp))) {
        errors.push('timestamp must be a valid ISO-8601 date');
    }
    if (!isFiniteNumber(p.latitude) || p.latitude < -90 || p.latitude > 90) {
        errors.push('latitude must be between -90 and 90');
    }
    if (!isFiniteNumber(p.longitude) || p.longitude < -180 || p.longitude > 180) {
        errors.push('longitude must be between -180 and 180');
    }
    if (!isFiniteNumber(p.speedKph) || p.speedKph < 0) errors.push('speedKph must be >= 0');
    if (!isInteger(p.occupancy) || p.occupancy < 0) errors.push('occupancy must be >= 0');
    if (!isInteger(p.capacity) || p.capacity <= 0) errors.push('capacity must be > 0');
    if (isInteger(p.occupancy) && isInteger(p.capacity) && p.capacity > 0
        && p.occupancy > p.capacity * MAX_OCCUPANCY_RATIO) {
        errors.push('occupancy ' + p.occupancy + ' exceeds ' + MAX_OCCUPANCY_RATIO
            + 'x capacity ' + p.capacity);
    }
    if (!isInteger(p.delaySeconds)) errors.push('delaySeconds must be an integer');
    if (p.modeData === null || typeof p.modeData !== 'object' || Array.isArray(p.modeData)) {
        errors.push('modeData object is required');
    }
}
