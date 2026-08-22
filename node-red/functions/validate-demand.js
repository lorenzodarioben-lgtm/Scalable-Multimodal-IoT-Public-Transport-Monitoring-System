// Node-RED function node: VALIDATE LOCATION DEMAND
//
// Demand events are structurally different from telemetry: there is no vehicle,
// no speed and no capacity. They describe how many people are waiting at a
// place, so this branch validates counts, a location type and a demand level.
//
// Outputs: 1 accepted | 2 rejected
var p = msg.payload;
var errors = [];

function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }
function isInteger(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

if (!isNonEmptyString(p.eventId)) errors.push('eventId is required');
if (!isNonEmptyString(p.locationId)) errors.push('locationId is required');
if (['busStop', 'tramStop', 'station'].indexOf(p.locationType) === -1) {
    errors.push("locationType must be one of busStop, tramStop, station (got '" + p.locationType + "')");
}
if (!Array.isArray(p.routeIds) || p.routeIds.length === 0) {
    errors.push('routeIds must be a non-empty array');
} else if (!p.routeIds.every(isNonEmptyString)) {
    errors.push('routeIds must contain non-empty strings');
}
if (!isNonEmptyString(p.timestamp) || isNaN(Date.parse(p.timestamp))) {
    errors.push('timestamp must be a valid ISO-8601 date');
}
if (!isInteger(p.passengerCount) || p.passengerCount < 0) errors.push('passengerCount must be >= 0');
if (['low', 'moderate', 'high', 'critical'].indexOf(p.demandLevel) === -1) {
    errors.push("demandLevel must be one of low, moderate, high, critical (got '" + p.demandLevel + "')");
}
if (p.waitingTimeSeconds !== undefined && (!isInteger(p.waitingTimeSeconds) || p.waitingTimeSeconds < 0)) {
    errors.push('waitingTimeSeconds must be >= 0 when present');
}

if (errors.length > 0) {
    msg.rejection = { mode: 'demand', reason: errors.join('; '), errors: errors };
    return [null, msg];
}
msg.validatedBy = 'node-red:validate-demand';
return [msg, null];
