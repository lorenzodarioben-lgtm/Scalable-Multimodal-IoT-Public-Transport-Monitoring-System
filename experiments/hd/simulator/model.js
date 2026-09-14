/** LOCAL DESIGN/TUNING EVIDENCE — NOT FINAL AWS HD EVIDENCE. */
import { HybridPredictiveController } from '../predictive-controller.js';
import { createHdArrivalSchedule, validateHdWorkloadProfile } from '../workload-profile.js';

export const LOCAL_CLASSIFICATION = 'LOCAL DESIGN/TUNING EVIDENCE; NOT FINAL AWS HD EVIDENCE';

function requiredFinite(value, label, minimum = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${label} must be a finite number >= ${minimum}`);
  }
  return value;
}

export function validateSimulationConfig(config) {
  const fields = {
    timeStepSeconds: 0.1,
    observationIntervalSeconds: 0.1,
    reactiveMetricIntervalSeconds: 0.1,
    reactiveRequestDelaySeconds: 0,
    taskReadyDelaySeconds: 0,
    singleTaskJobsPerSecond: 0.001,
    maxAfterArrivalSeconds: 1,
    targetBacklogPerTask: 1,
    minTasks: 1,
    maxTasks: 1,
    fastReactiveTaskIncrease: 1,
  };
  for (const [field, minimum] of Object.entries(fields)) requiredFinite(config?.[field], field, minimum);
  for (const field of ['minTasks', 'maxTasks', 'fastReactiveTaskIncrease']) {
    if (!Number.isInteger(config[field])) throw new Error(`${field} must be an integer`);
  }
  if (config.maxTasks < config.minTasks) throw new Error('maxTasks must be >= minTasks');
  for (const field of ['observationIntervalSeconds', 'reactiveMetricIntervalSeconds']) {
    const quotient = config[field] / config.timeStepSeconds;
    if (Math.abs(quotient - Math.round(quotient)) > 1e-8) throw new Error(`${field} must align to timeStepSeconds`);
  }
  return config;
}

function takeFromQueue(queue, amount) {
  let remaining = amount;
  while (remaining > 1e-9 && queue.length) {
    const head = queue[0];
    const removed = Math.min(head.jobs, remaining);
    head.jobs -= removed;
    remaining -= removed;
    if (head.jobs <= 1e-9) queue.shift();
  }
  return amount - remaining;
}

/** Fluid-capacity, FIFO time-step model. No queue network/SDK calls. */
export function simulateHdProfile({ profile, mode, config, controllerOptions = {} }) {
  if (!['reactive', 'hybrid'].includes(mode)) throw new Error('mode must be reactive or hybrid');
  validateHdWorkloadProfile(profile);
  validateSimulationConfig(config);
  const schedule = createHdArrivalSchedule(profile);
  const dt = config.timeStepSeconds;
  const total = schedule.scheduledArrivalSeconds;
  const controller = mode === 'hybrid' ? new HybridPredictiveController({
    minTasks: config.minTasks,
    maxTasks: config.maxTasks,
    targetBacklogPerTask: config.targetBacklogPerTask,
    perTaskSustainableJobsPerSecond: config.singleTaskJobsPerSecond
      * (controllerOptions.capacitySafetyFactor ?? 1),
    ...Object.fromEntries(Object.entries(controllerOptions).filter(([key, value]) =>
      key !== 'capacitySafetyFactor' && value !== undefined)),
  }) : null;
  let nextIncident = 0;
  let arrivals = 0;
  let completed = 0;
  let backlog = 0;
  let desiredTasks = config.minTasks;
  let runningTasks = config.minTasks;
  let nextReactiveRequestAt = null;
  const readiness = [];
  const fifo = [];
  const requests = [];
  const readyEvents = [];
  const trace = [];
  const forecastPairs = [];
  const pendingForecasts = [];
  let bucketArrivals = 0;
  let taskSeconds = 0;
  let peakVisibleBacklog = 0;
  let peakBacklogPerTaskEquivalent = 0;
  let peakOldestAgeSeconds = 0;
  let firstAboveTargetAtSeconds = null;
  let drainedAtSeconds = null;
  const intervalSteps = Math.round(config.observationIntervalSeconds / dt);
  const metricSteps = Math.round(config.reactiveMetricIntervalSeconds / dt);
  const maxSteps = Math.ceil((total + config.maxAfterArrivalSeconds) / dt);

  function requestScaleOut(atSeconds, targetTasks, source) {
    const bounded = Math.min(config.maxTasks, Math.max(desiredTasks, targetTasks));
    if (bounded <= desiredTasks) return false;
    const added = bounded - desiredTasks;
    desiredTasks = bounded;
    readiness.push({ atSeconds: atSeconds + config.taskReadyDelaySeconds, added });
    requests.push({ atSeconds, source, desiredTasks: bounded });
    return true;
  }

  for (let step = 0; step <= maxSteps; step += 1) {
    const t = Number((step * dt).toFixed(6));
    for (let index = readiness.length - 1; index >= 0; index -= 1) {
      if (readiness[index].atSeconds <= t + 1e-8) {
        runningTasks += readiness[index].added;
        readyEvents.push({ atSeconds: t, runningTasks });
        readiness.splice(index, 1);
      }
    }
    if (nextReactiveRequestAt !== null && nextReactiveRequestAt <= t + 1e-8) {
      requestScaleOut(t, desiredTasks + config.fastReactiveTaskIncrease, 'reactive');
      nextReactiveRequestAt = null;
    }
    if (step > 0 && step % intervalSteps === 0 && t <= total + 1e-8) {
      const observedRate = bucketArrivals / config.observationIntervalSeconds;
      bucketArrivals = 0;
      for (let index = pendingForecasts.length - 1; index >= 0; index -= 1) {
        if (pendingForecasts[index].dueSeconds <= t + 1e-8) {
          forecastPairs.push({ predicted: pendingForecasts[index].predicted, actual: observedRate });
          pendingForecasts.splice(index, 1);
        }
      }
      if (controller) {
        const result = controller.observe({
          atMs: t * 1000,
          arrivalRateJobsPerSecond: observedRate,
          visibleBacklog: backlog,
          backlogPerTask: backlog / runningTasks,
          runningTasks,
          desiredTasks,
          reactiveRequiredTasks: desiredTasks,
        });
        if (result.predictedArrivalRateJobsPerSecond !== undefined) {
          pendingForecasts.push({
            dueSeconds: t + result.predictionHorizonSeconds,
            predicted: result.predictedArrivalRateJobsPerSecond,
          });
        }
        if (result.shouldRequestScaleOut) requestScaleOut(t, result.recommendedTasks, 'predictive');
      }
    }
    while (nextIncident < schedule.incidents.length
      && schedule.incidents[nextIncident].scheduledOffsetSeconds <= t + 1e-8) {
      const jobs = schedule.incidents[nextIncident].expectedJobs;
      fifo.push({ atSeconds: t, jobs });
      backlog += jobs;
      arrivals += jobs;
      bucketArrivals += jobs;
      nextIncident += 1;
    }
    const bpt = backlog / runningTasks;
    if (bpt > config.targetBacklogPerTask && firstAboveTargetAtSeconds === null) {
      firstAboveTargetAtSeconds = t;
    }
    if (step > 0 && step % metricSteps === 0 && bpt > config.targetBacklogPerTask
      && desiredTasks < config.maxTasks && nextReactiveRequestAt === null) {
      nextReactiveRequestAt = t + config.reactiveRequestDelaySeconds;
    }
    const oldestAge = fifo.length ? t - fifo[0].atSeconds : 0;
    peakVisibleBacklog = Math.max(peakVisibleBacklog, backlog);
    peakBacklogPerTaskEquivalent = Math.max(peakBacklogPerTaskEquivalent, bpt);
    peakOldestAgeSeconds = Math.max(peakOldestAgeSeconds, oldestAge);
    if (step % intervalSteps === 0) {
      trace.push({ atSeconds: t, arrivals, completed: Number(completed.toFixed(3)),
        visibleBacklog: Number(backlog.toFixed(3)), runningTasks, desiredTasks,
        backlogPerTaskEquivalent: Number(bpt.toFixed(3)), oldestAgeSeconds: Number(oldestAge.toFixed(3)) });
    }
    if (t >= total && backlog <= 1e-7 && nextIncident === schedule.incidents.length) {
      drainedAtSeconds = t;
      break;
    }
    taskSeconds += runningTasks * dt;
    const served = takeFromQueue(fifo, Math.min(backlog, runningTasks * config.singleTaskJobsPerSecond * dt));
    completed += served;
    backlog = Math.max(0, backlog - served);
  }
  if (drainedAtSeconds === null) throw new Error('local simulation did not drain by configured deadline');
  const errors = forecastPairs.map(({ predicted, actual }) => predicted - actual);
  const mean = errors.length ? errors.reduce((sum, x) => sum + x, 0) / errors.length : null;
  const mae = errors.length ? errors.reduce((sum, x) => sum + Math.abs(x), 0) / errors.length : null;
  return {
    classification: LOCAL_CLASSIFICATION,
    profile: profile.name, mode, config, controllerOptions,
    expectedJobs: schedule.expectedJobs,
    arrivals, completed: Number(completed.toFixed(6)), unaccounted: Number((arrivals - completed).toFixed(6)),
    firstAboveTargetAtSeconds,
    firstPredictiveRequestAtSeconds: requests.find((x) => x.source === 'predictive')?.atSeconds ?? null,
    firstReactiveRequestAtSeconds: requests.find((x) => x.source === 'reactive')?.atSeconds ?? null,
    firstWorkerReadyAtSeconds: readyEvents[0]?.atSeconds ?? null,
    allWorkersReadyAtSeconds: readyEvents.at(-1)?.atSeconds ?? null,
    peakVisibleBacklog: Number(peakVisibleBacklog.toFixed(3)),
    peakBacklogPerTaskEquivalent: Number(peakBacklogPerTaskEquivalent.toFixed(3)),
    peakOldestAgeSeconds: Number(peakOldestAgeSeconds.toFixed(3)),
    drainedAtSeconds,
    drainSeconds: Number(Math.max(0, drainedAtSeconds - total).toFixed(3)),
    taskSeconds: Number(taskSeconds.toFixed(3)),
    predictionMaeJobsPerSecond: mae === null ? null : Number(mae.toFixed(3)),
    predictionBiasJobsPerSecond: mean === null ? null : Number(mean.toFixed(3)),
    matchedForecasts: errors.length,
    requests, readyEvents, trace,
  };
}
