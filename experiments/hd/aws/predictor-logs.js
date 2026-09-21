/** Pure parser for the JSON emitted by the deployed HD Lambda console logger. */
const lambdaInfoPrefix = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\t[0-9a-f-]{36}\tINFO\t/i;

export function parsePredictorEvents(events, runId) {
  if (!Array.isArray(events) || typeof runId !== 'string' || !runId) return [];
  return events.flatMap((event) => {
    const line = typeof event?.message === 'string' ? event.message.trim() : '';
    const json = line.replace(lambdaInfoPrefix, '');
    if (!json.startsWith('{') || !json.endsWith('}')) return [];
    try {
      const data = JSON.parse(json);
      if (data.runId !== runId || typeof data.signalId !== 'string'
        || !data.result || typeof data.result !== 'object') return [];
      return [{ timestamp: event.timestamp, ...data }];
    } catch { return []; }
  });
}
