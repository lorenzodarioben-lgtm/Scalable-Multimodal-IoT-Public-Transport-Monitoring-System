/**
 * Explainable, local-only predictive-reactive autoscaling decision logic.
 *
 * This module has no AWS dependency. A future deployment adapter may pass its
 * output to an AWS scaling mechanism, but unit tests exercise only this pure
 * decision boundary. The existing Distinction reactive policies remain the
 * safety controller; this module never recommends scale-in.
 */

const DEFAULTS = Object.freeze({
  minTasks: 1,
  maxTasks: 5,
  targetBacklogPerTask: 75,
  // Conservative observed single-worker completion rate from valid D fixed runs.
  perTaskSustainableJobsPerSecond: 42.467,
  historySize: 8,
  predictionHorizonSeconds: 80,
  minRisingSlopeJobsPerSecondSquared: 0.02,
  requiredConsecutiveRecommendations: 2,
  duplicateRequestCooldownSeconds: 60,
});

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function positive(value, label) {
  const number = finite(value, label);
  if (number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function nonNegative(value, label) {
  const number = finite(value, label);
  if (number < 0) throw new Error(`${label} must not be negative`);
  return number;
}

function whole(value, label) {
  const number = positive(value, label);
  if (!Number.isInteger(number)) throw new Error(`${label} must be an integer`);
  return number;
}

function nonNegativeWhole(value, label) {
  const number = nonNegative(value, label);
  if (!Number.isInteger(number)) throw new Error(`${label} must be an integer`);
  return number;
}

function clamp(value, lower, upper) {
  return Math.min(upper, Math.max(lower, value));
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function normaliseConfig(options = {}) {
  const config = { ...DEFAULTS, ...options };
  config.minTasks = whole(config.minTasks, 'minTasks');
  config.maxTasks = whole(config.maxTasks, 'maxTasks');
  if (config.maxTasks < config.minTasks) throw new Error('maxTasks must be at least minTasks');
  config.targetBacklogPerTask = positive(config.targetBacklogPerTask, 'targetBacklogPerTask');
  config.perTaskSustainableJobsPerSecond = positive(
    config.perTaskSustainableJobsPerSecond,
    'perTaskSustainableJobsPerSecond',
  );
  config.historySize = whole(config.historySize, 'historySize');
  if (config.historySize < 2) throw new Error('historySize must be at least two');
  config.predictionHorizonSeconds = positive(config.predictionHorizonSeconds, 'predictionHorizonSeconds');
  config.minRisingSlopeJobsPerSecondSquared = nonNegative(
    config.minRisingSlopeJobsPerSecondSquared,
    'minRisingSlopeJobsPerSecondSquared',
  );
  config.requiredConsecutiveRecommendations = whole(
    config.requiredConsecutiveRecommendations,
    'requiredConsecutiveRecommendations',
  );
  config.duplicateRequestCooldownSeconds = nonNegative(
    config.duplicateRequestCooldownSeconds,
    'duplicateRequestCooldownSeconds',
  );
  return Object.freeze(config);
}

/** Fits arrival rate against elapsed seconds with ordinary least squares. */
export function fitLinearRateModel(samples) {
  if (!Array.isArray(samples) || samples.length < 2) {
    throw new Error('at least two samples are required for linear regression');
  }
  const firstAtMs = finite(samples[0]?.atMs, 'samples[0].atMs');
  const values = samples.map((sample, index) => {
    const atMs = finite(sample?.atMs, `samples[${index}].atMs`);
    const arrivalRateJobsPerSecond = nonNegative(
      sample?.arrivalRateJobsPerSecond,
      `samples[${index}].arrivalRateJobsPerSecond`,
    );
    return { x: (atMs - firstAtMs) / 1000, y: arrivalRateJobsPerSecond };
  });
  for (let index = 1; index < values.length; index += 1) {
    if (values[index].x <= values[index - 1].x) {
      throw new Error('sample timestamps must increase strictly');
    }
  }
  const meanX = values.reduce((total, point) => total + point.x, 0) / values.length;
  const meanY = values.reduce((total, point) => total + point.y, 0) / values.length;
  const denominator = values.reduce((total, point) => total + (point.x - meanX) ** 2, 0);
  if (denominator === 0) throw new Error('sample timestamps must not be identical');
  const slope = values.reduce(
    (total, point) => total + (point.x - meanX) * (point.y - meanY),
    0,
  ) / denominator;
  const intercept = meanY - slope * meanX;
  return {
    firstAtMs,
    lastAtMs: finite(samples.at(-1)?.atMs, 'last sample timestamp'),
    slopeJobsPerSecondSquared: slope,
    interceptJobsPerSecond: intercept,
    predictAt(atMs) {
      const elapsedSeconds = (finite(atMs, 'prediction timestamp') - firstAtMs) / 1000;
      return Math.max(0, intercept + slope * elapsedSeconds);
    },
  };
}

/** Mean absolute forecasting error for independently matched forecast pairs. */
export function predictionMae(pairs = []) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  const absoluteErrors = pairs.map((pair, index) => Math.abs(
    nonNegative(pair?.predictedJobsPerSecond, `pairs[${index}].predictedJobsPerSecond`)
      - nonNegative(pair?.actualJobsPerSecond, `pairs[${index}].actualJobsPerSecond`),
  ));
  return round(absoluteErrors.reduce((total, value) => total + value, 0) / absoluteErrors.length);
}

/**
 * Produces proactive scale-out recommendations from recent arrival-rate
 * observations. `now` is injectable so timing behaviour remains deterministic
 * in tests. The caller supplies current task state, including any reactive
 * capacity floor; recommendations can therefore never reduce it.
 */
export class HybridPredictiveController {
  constructor({ now = () => Date.now(), state = null, ...options } = {}) {
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.now = now;
    this.config = normaliseConfig(options);
    this.samples = [];
    this.consecutivePositiveRecommendations = 0;
    this.lastScaleRequestAtMs = null;
    this.lastRequestedTasks = null;
    if (state !== null) this.restoreState(state);
  }

  exportState() {
    return {
      samples: this.samples.map((sample) => ({ ...sample })),
      consecutivePositiveRecommendations: this.consecutivePositiveRecommendations,
      lastScaleRequestAtMs: this.lastScaleRequestAtMs,
      lastRequestedTasks: this.lastRequestedTasks,
    };
  }

  restoreState(state) {
    if (!state || !Array.isArray(state.samples) || state.samples.length > this.config.historySize) {
      throw new Error('invalid controller state samples');
    }
    const samples = state.samples.map((sample, index) => ({
      atMs: finite(sample?.atMs, `state.samples[${index}].atMs`),
      arrivalRateJobsPerSecond: nonNegative(
        sample?.arrivalRateJobsPerSecond, `state.samples[${index}].arrivalRateJobsPerSecond`,
      ),
    }));
    for (let index = 1; index < samples.length; index += 1) {
      if (samples[index].atMs <= samples[index - 1].atMs) throw new Error('state samples must increase');
    }
    const consecutive = nonNegativeWhole(
      state.consecutivePositiveRecommendations, 'state.consecutivePositiveRecommendations',
    );
    const lastAt = state.lastScaleRequestAtMs === null ? null
      : finite(state.lastScaleRequestAtMs, 'state.lastScaleRequestAtMs');
    const lastTasks = state.lastRequestedTasks === null ? null
      : whole(state.lastRequestedTasks, 'state.lastRequestedTasks');
    if ((lastAt === null) !== (lastTasks === null)) throw new Error('incomplete last scale request state');
    this.samples = samples;
    this.consecutivePositiveRecommendations = consecutive;
    this.lastScaleRequestAtMs = lastAt;
    this.lastRequestedTasks = lastTasks;
  }

  observe({
    atMs = this.now(),
    arrivalRateJobsPerSecond,
    visibleBacklog = 0,
    backlogPerTask = 0,
    runningTasks,
    desiredTasks,
    reactiveRequiredTasks = Math.max(runningTasks ?? 0, desiredTasks ?? 0),
  } = {}) {
    const timestamp = finite(atMs, 'atMs');
    const rate = nonNegative(arrivalRateJobsPerSecond, 'arrivalRateJobsPerSecond');
    const visible = nonNegative(visibleBacklog, 'visibleBacklog');
    const bpt = nonNegative(backlogPerTask, 'backlogPerTask');
    const running = nonNegativeWhole(runningTasks, 'runningTasks');
    const desired = nonNegativeWhole(desiredTasks, 'desiredTasks');
    const reactiveFloor = nonNegativeWhole(reactiveRequiredTasks, 'reactiveRequiredTasks');
    const observedFloorTasks = clamp(
      Math.max(this.config.minTasks, running, desired, reactiveFloor),
      this.config.minTasks,
      this.config.maxTasks,
    );
    const previous = this.samples.at(-1);
    const common = {
      observedAtMs: timestamp,
      observedArrivalRateJobsPerSecond: rate,
      observedFloorTasks,
      reactiveFallbackActive: bpt > this.config.targetBacklogPerTask,
      recommendedTasks: observedFloorTasks,
      shouldRequestScaleOut: false,
      predictionHorizonSeconds: this.config.predictionHorizonSeconds,
    };
    if (previous && timestamp < previous.atMs) throw new Error('observations must be chronological');
    if (previous && timestamp === previous.atMs) {
      if (rate !== previous.arrivalRateJobsPerSecond) throw new Error('conflicting duplicate observation');
      return { ...common, reason: 'duplicate-observation', sampleCount: this.samples.length };
    }
    this.samples.push({ atMs: timestamp, arrivalRateJobsPerSecond: rate });
    if (this.samples.length > this.config.historySize) this.samples.shift();
    if (this.samples.length < this.config.historySize) {
      this.consecutivePositiveRecommendations = 0;
      return { ...common, reason: 'insufficient-history', sampleCount: this.samples.length };
    }

    const model = fitLinearRateModel(this.samples);
    const slope = model.slopeJobsPerSecondSquared;
    const forecastAtMs = timestamp + this.config.predictionHorizonSeconds * 1000;
    const predictedArrivalRateJobsPerSecond = model.predictAt(forecastAtMs);
    const forecast = {
      forecastAtMs,
      predictedArrivalRateJobsPerSecond: round(predictedArrivalRateJobsPerSecond),
    };
    if (slope <= -this.config.minRisingSlopeJobsPerSecondSquared) {
      this.consecutivePositiveRecommendations = 0;
      return {
        ...common, ...forecast,
        reason: 'hold-falling-traffic',
        sampleCount: this.samples.length,
        slopeJobsPerSecondSquared: round(slope, 6),
      };
    }
    if (slope < this.config.minRisingSlopeJobsPerSecondSquared) {
      this.consecutivePositiveRecommendations = 0;
      return {
        ...common, ...forecast,
        reason: 'hold-flat-or-noisy-traffic',
        sampleCount: this.samples.length,
        slopeJobsPerSecondSquared: round(slope, 6),
      };
    }

    const predictedNetJobs = Math.max(0,
      (predictedArrivalRateJobsPerSecond
        - observedFloorTasks * this.config.perTaskSustainableJobsPerSecond)
      * this.config.predictionHorizonSeconds);
    const predictedVisibleBacklog = visible + predictedNetJobs;
    const tasksForPredictedRate = Math.ceil(
      predictedArrivalRateJobsPerSecond / this.config.perTaskSustainableJobsPerSecond,
    );
    const tasksForPredictedBacklog = Math.ceil(
      predictedVisibleBacklog / this.config.targetBacklogPerTask,
    );
    const recommendedTasks = clamp(
      Math.max(observedFloorTasks, tasksForPredictedRate, tasksForPredictedBacklog),
      this.config.minTasks,
      this.config.maxTasks,
    );
    const prediction = {
      ...common,
      sampleCount: this.samples.length,
      slopeJobsPerSecondSquared: round(slope, 6),
      ...forecast,
      predictedVisibleBacklog: round(predictedVisibleBacklog),
      tasksForPredictedRate: clamp(tasksForPredictedRate, this.config.minTasks, this.config.maxTasks),
      tasksForPredictedBacklog: clamp(tasksForPredictedBacklog, this.config.minTasks, this.config.maxTasks),
      recommendedTasks,
    };
    if (recommendedTasks <= observedFloorTasks) {
      this.consecutivePositiveRecommendations = 0;
      return { ...prediction, reason: 'hold-capacity-sufficient' };
    }

    this.consecutivePositiveRecommendations += 1;
    if (this.consecutivePositiveRecommendations < this.config.requiredConsecutiveRecommendations) {
      return {
        ...prediction,
        reason: 'hold-hysteresis',
        consecutivePositiveRecommendations: this.consecutivePositiveRecommendations,
      };
    }

    const cooldownMs = this.config.duplicateRequestCooldownSeconds * 1000;
    const duplicateWithinCooldown = this.lastRequestedTasks !== null
      && recommendedTasks <= this.lastRequestedTasks
      && timestamp - this.lastScaleRequestAtMs < cooldownMs;
    if (duplicateWithinCooldown) {
      return {
        ...prediction,
        reason: 'hold-duplicate-request',
        consecutivePositiveRecommendations: this.consecutivePositiveRecommendations,
      };
    }

    this.lastRequestedTasks = recommendedTasks;
    this.lastScaleRequestAtMs = timestamp;
    return {
      ...prediction,
      reason: 'predictive-scale-out',
      consecutivePositiveRecommendations: this.consecutivePositiveRecommendations,
      shouldRequestScaleOut: true,
    };
  }
}

export { DEFAULTS as DEFAULT_HYBRID_CONTROLLER_CONFIG };
