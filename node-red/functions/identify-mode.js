// Node-RED function node: IDENTIFY MODE
//
// What: inspects the raw MQTT payload and routes it to the correct
//       mode-specific validation branch.
// Why:  this is where Variety becomes visible in the flow. Four structurally
//       different payload shapes arrive on transport/raw/#, and each one is
//       sent down its own branch instead of through one generic handler.
//
// Outputs: 1 bus | 2 tram | 3 train | 4 demand | 5 unroutable
var payload = msg.payload;

// Node-RED may deliver a Buffer or a string if the MQTT node is not set to
// parse JSON. Parsing defensively keeps the flow robust.
if (Buffer.isBuffer(payload)) { payload = payload.toString('utf8'); }
if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); }
    catch (e) {
        msg.rejection = { mode: 'unknown', reason: 'payload is not valid JSON' };
        return [null, null, null, null, msg];
    }
}

if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    msg.rejection = { mode: 'unknown', reason: 'payload is not a JSON object' };
    return [null, null, null, null, msg];
}

msg.payload = payload;
msg.receivedAt = new Date().toISOString();

if (payload.eventType === 'locationDemand') {
    msg.transportMode = 'demand';
    return [null, null, null, msg, null];
}

if (payload.eventType === 'telemetry') {
    if (payload.transportMode === 'bus') { msg.transportMode = 'bus'; return [msg, null, null, null, null]; }
    if (payload.transportMode === 'tram') { msg.transportMode = 'tram'; return [null, msg, null, null, null]; }
    if (payload.transportMode === 'train') { msg.transportMode = 'train'; return [null, null, msg, null, null]; }
}

msg.rejection = {
    mode: String(payload.transportMode || 'unknown'),
    reason: 'unrecognised eventType/transportMode combination'
};
return [null, null, null, null, msg];
