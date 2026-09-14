/** Common HD analysis-job arrival signal for application and experiment paths. */
export function createAnalysisArrivalSignal({ runId, signalId, publishedJobCount, atMs }) {
  if (typeof runId !== 'string' || !runId || runId.length > 128) throw new Error('runId is required (<=128 characters)');
  if (typeof signalId !== 'string' || !signalId || signalId.length > 128) throw new Error('signalId is required (<=128 characters)');
  if (!Number.isInteger(publishedJobCount) || publishedJobCount < 1) throw new Error('publishedJobCount must be positive integer');
  if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs < 0) throw new Error('atMs must be a non-negative timestamp');
  return Object.freeze({ schema: 'sit314-hd-analysis-arrival/v1', runId, signalId, publishedJobCount, atMs });
}

export function parseAnalysisArrivalSignal(input) {
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  if (value?.schema !== 'sit314-hd-analysis-arrival/v1') throw new Error('unsupported arrival signal schema');
  return createAnalysisArrivalSignal(value);
}
