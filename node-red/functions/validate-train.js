// Node-RED function node: VALIDATE TRAIN
//
// Train-specific rules: health is normal|degraded|cancelled, and modeData must
// carry stationId, platform, carriageCount and nextStationId. A train stops at
// stations with numbered platforms and has a variable carriage count, which is
// what determines its capacity - none of these concepts exist for a bus.
//
// Outputs: 1 accepted | 2 rejected
var MAX_OCCUPANCY_RATIO = 1.5;
// __COMMON__
var p = msg.payload;
var errors = [];

checkVehicleCommon(p, errors);

if (p.transportMode !== 'train') errors.push('transportMode must be train');
if (['normal', 'degraded', 'cancelled'].indexOf(p.health) === -1) {
    errors.push("health must be one of normal, degraded, cancelled (got '" + p.health + "')");
}
if (p.modeData && typeof p.modeData === 'object') {
    if (!isNonEmptyString(p.modeData.stationId)) errors.push('modeData.stationId is required for a train');
    if (!isInteger(p.modeData.platform) || p.modeData.platform < 1 || p.modeData.platform > 20) {
        errors.push('modeData.platform must be an integer between 1 and 20');
    }
    if (!isInteger(p.modeData.carriageCount) || p.modeData.carriageCount < 1 || p.modeData.carriageCount > 12) {
        errors.push('modeData.carriageCount must be an integer between 1 and 12');
    }
    if (!isNonEmptyString(p.modeData.nextStationId)) errors.push('modeData.nextStationId is required for a train');
}
if (p.speedKph > 160) errors.push('speedKph above the plausible train maximum of 160');

if (errors.length > 0) {
    msg.rejection = { mode: 'train', reason: errors.join('; '), errors: errors };
    return [null, msg];
}
msg.validatedBy = 'node-red:validate-train';
return [msg, null];
