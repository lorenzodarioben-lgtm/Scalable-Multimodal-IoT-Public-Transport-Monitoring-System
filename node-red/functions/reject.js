// Node-RED function node: REJECT
//
// What: formats a rejected event, publishes it to transport/rejected/<mode>
//       and logs a readable reason.
// Why:  invalid data must never reach the telemetry queue, and the rejection
//       must be explainable. The printed block is the evidence that the
//       validation branches are genuinely doing work.
var rejection = msg.rejection || { mode: 'unknown', reason: 'unspecified' };
var source = msg.payload || {};

var record = {
    rejectedAt: new Date().toISOString(),
    mode: rejection.mode,
    eventId: source.eventId || null,
    entityId: source.vehicleId || source.locationId || null,
    reason: rejection.reason,
    errors: rejection.errors || [rejection.reason],
    injectedFault: source.__injectedFault || null,
    rawTopic: msg.rawTopic || msg.topic || null
};

msg.payload = record;
msg.topic = 'transport/rejected/' + rejection.mode;

node.status({ fill: 'red', shape: 'ring', text: 'rejected ' + rejection.mode });
node.warn('[REJECTED]\n  mode=' + record.mode
    + '\n  eventId=' + record.eventId
    + '\n  reason=' + record.reason);

return msg;
