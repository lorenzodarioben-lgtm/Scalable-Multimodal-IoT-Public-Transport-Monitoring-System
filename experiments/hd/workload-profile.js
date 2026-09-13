/** Deterministic HD-only piecewise incident schedule generation. */

function positive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function whole(value, label) {
  const number = positive(value, label);
  if (!Number.isInteger(number)) throw new Error(`${label} must be an integer`);
  return number;
}

function closeToInteger(value) {
  return Math.abs(value - Math.round(value)) < 1e-9;
}

/** Validates an HD profile without reusing or mutating formal-D workload code. */
export function validateHdWorkloadProfile(profile) {
  if (profile?.evidenceClassification?.status !== 'HD PLANNED EXPERIMENT') {
    throw new Error('HD profile must be explicitly classified as HD PLANNED EXPERIMENT');
  }
  const warmupSeconds = whole(profile?.warmupSeconds, 'warmupSeconds');
  const measurementSeconds = whole(profile?.measurementSeconds, 'measurementSeconds');
  const jobsPerIncident = whole(profile?.incident?.jobsPerIncident, 'incident.jobsPerIncident');
  const totalSeconds = warmupSeconds + measurementSeconds;
  const segments = profile?.arrival?.segments;
  if (!Array.isArray(segments) || !segments.length) throw new Error('arrival.segments is required');
  let nextStart = 0;
  for (const [index, segment] of segments.entries()) {
    const start = Number(segment?.startOffsetSeconds);
    const end = Number(segment?.endOffsetSeconds);
    const interval = positive(segment?.incidentIntervalSeconds, `segments[${index}].incidentIntervalSeconds`);
    if (start !== nextStart || !Number.isFinite(end) || end <= start) {
      throw new Error(`segments[${index}] must begin at ${nextStart} and have a positive duration`);
    }
    if (!closeToInteger((end - start) / interval)) {
      throw new Error(`segments[${index}] duration must be divisible by its incident interval`);
    }
    nextStart = end;
  }
  if (nextStart !== totalSeconds) {
    throw new Error(`segments must end at warmup + measurement (${totalSeconds}s)`);
  }
  return { warmupSeconds, measurementSeconds, jobsPerIncident, totalSeconds };
}

/** Returns a stable precomputed schedule that baseline and treatment can share. */
export function createHdArrivalSchedule(profile) {
  const { warmupSeconds, jobsPerIncident, totalSeconds } = validateHdWorkloadProfile(profile);
  const incidents = [];
  for (const segment of profile.arrival.segments) {
    for (let offset = segment.startOffsetSeconds;
      offset < segment.endOffsetSeconds;
      offset += segment.incidentIntervalSeconds) {
      incidents.push({
        sequence: incidents.length + 1,
        scheduledOffsetSeconds: Number(offset.toFixed(6)),
        expectedJobs: jobsPerIncident,
        phase: offset < warmupSeconds ? 'warmup' : 'measurement',
      });
    }
  }
  return {
    incidents,
    scheduledArrivalSeconds: totalSeconds,
    expectedJobs: incidents.length * jobsPerIncident,
  };
}

export function profileArrivalRates(profile) {
  validateHdWorkloadProfile(profile);
  return profile.arrival.segments.map((segment) => ({
    startOffsetSeconds: segment.startOffsetSeconds,
    endOffsetSeconds: segment.endOffsetSeconds,
    jobsPerSecond: profile.incident.jobsPerIncident / segment.incidentIntervalSeconds,
  }));
}
