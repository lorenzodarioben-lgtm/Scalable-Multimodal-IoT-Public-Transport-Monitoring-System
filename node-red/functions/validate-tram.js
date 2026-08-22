// Node-RED function node: VALIDATE TRAM
//
// Tram-specific rules: health is normal|degraded|blocked, and modeData must
// carry trackSegmentId, direction and nextStopId. A tram runs on rails, so it
// cannot be diverted - a blockage is a property of a track segment plus a
// direction, which is why those two fields are mandatory here and absent for a bus.
//
// Outputs: 1 accepted | 2 rejected
var MAX_OCCUPANCY_RATIO = 1.5;
// __COMMON__
var p = msg.payload;
var errors = [];

checkVehicleCommon(p, errors);

if (p.transportMode !== 'tram') errors.push('transportMode must be tram');
if (['normal', 'degraded', 'blocked'].indexOf(p.health) === -1) {
    errors.push("health must be one of normal, degraded, blocked (got '" + p.health + "')");
}
if (p.modeData && typeof p.modeData === 'object') {
    if (!isNonEmptyString(p.modeData.trackSegmentId)) errors.push('modeData.trackSegmentId is required for a tram');
    if (['inbound', 'outbound'].indexOf(p.modeData.direction) === -1) {
        errors.push('modeData.direction must be inbound or outbound');
    }
    if (!isNonEmptyString(p.modeData.nextStopId)) errors.push('modeData.nextStopId is required for a tram');
}
if (p.speedKph > 80) errors.push('speedKph above the plausible tram maximum of 80');

if (errors.length > 0) {
    msg.rejection = { mode: 'tram', reason: errors.join('; '), errors: errors };
    return [null, msg];
}
msg.validatedBy = 'node-red:validate-tram';
return [msg, null];
