/** Left-continuous running-task integral over an explicitly bounded interval. */
export function integrateRunningTaskSeconds(samples, startAt, endAt) {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('task-second interval must have finite increasing bounds');
  }
  if (!Array.isArray(samples) || samples.length < 2) throw new Error('task-second samples are insufficient');
  const points = samples.map((sample) => ({
    at: Date.parse(sample.timestamp), running: sample.service?.runningCount,
  })).sort((a, b) => a.at - b.at);
  if (points.some((point) => !Number.isFinite(point.at)
    || !Number.isInteger(point.running) || point.running < 0 || point.running > 5)) {
    throw new Error('task-second sample has invalid time or running count');
  }
  if (points[0].at > start || points.at(-1).at < end) {
    throw new Error('task-second samples do not cover the measurement interval');
  }
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]; const current = points[index];
    if (current.at <= previous.at) throw new Error('task-second sample timestamps must be unique');
    const from = Math.max(start, previous.at); const to = Math.min(end, current.at);
    if (to > from) total += previous.running * (to - from) / 1000;
  }
  return Number(total.toFixed(3));
}
