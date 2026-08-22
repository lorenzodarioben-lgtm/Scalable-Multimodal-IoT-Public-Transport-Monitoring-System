// Node-RED function node: VALIDATE BUS
//
// Bus-specific rules: health is normal|degraded|breakdown, and modeData must
// carry roadSegmentId and nextStopId. A bus is road-based, so its disruption
// state is a breakdown - it has no track segment and no platform.
//
// Outputs: 1 accepted | 2 rejected
var MAX_OCCUPANCY_RATIO = 1.5;
// __COMMON__
var p = msg.payload;
var errors = [];

checkVehicleCommon(p, errors);

if (p.transportMode !== 'bus') errors.push('transportMode must be bus');
if (['normal', 'degraded', 'breakdown'].indexOf(p.health) === -1) {
    errors.push("health must be one of normal, degraded, breakdown (got '" + p.health + "')");
}
if (p.modeData && typeof p.modeData === 'object') {
    if (!isNonEmptyString(p.modeData.roadSegmentId)) errors.push('modeData.roadSegmentId is required for a bus');
    if (!isNonEmptyString(p.modeData.nextStopId)) errors.push('modeData.nextStopId is required for a bus');
}
if (p.speedKph > 120) errors.push('speedKph above the plausible bus maximum of 120');

if (errors.length > 0) {
    msg.rejection = { mode: 'bus', reason: errors.join('; '), errors: errors };
    return [null, msg];
}
msg.validatedBy = 'node-red:validate-bus';
return [msg, null];
