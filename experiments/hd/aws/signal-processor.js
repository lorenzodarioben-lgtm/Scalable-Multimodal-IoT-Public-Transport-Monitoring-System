/** AWS independent, event-driven 10 s signal aggregation and scale-out protocol. */
import { HybridPredictiveController } from '../predictive-controller.js';
import { parseAnalysisArrivalSignal } from '../../../shared/hd/arrival-signal.js';

export const HD_METRIC_NAMESPACE = 'SIT314/HDTransport';
export const HD_METRIC_NAMES = Object.freeze([
  'AnalysisArrivalRate', 'PredictedArrivalRate', 'PredictiveRecommendedTasks',
  'PredictiveScaleRequest', 'PredictionError', 'RunningTaskCount',
  'AnalysisQueueVisible', 'PredictorObservedBacklogPerTask',
]);

function fresh(runId, signal) {
  return {
    runId, version: 0, originAtMs: signal.atMs, binIndex: 0, binJobs: 0,
    seenSignalIds: [], controllerState: null, forecasts: [], pendingScaleRequest: null,
  };
}

function metric(name, value, signal, atMs, serviceName) {
  return {
    namespace: HD_METRIC_NAMESPACE, name, value, atMs,
    dimensions: { ServiceName: serviceName, RunId: signal.runId },
  };
}

function validatePorts(ports) {
  for (const method of ['getState', 'putState', 'serviceSnapshot', 'queueSnapshot', 'requestScaleOut', 'publishMetrics']) {
    if (typeof ports?.[method] !== 'function') throw new Error(`ports.${method} is required`);
  }
}

/**
 * SQS FIFO plus a version-conditional state write serializes one run. The
 * state is committed before ECS update; a retry sees pendingScaleRequest and
 * resumes it. A successful ECS update followed by a failed state write is
 * harmless because the retry checks current desired count before updating.
 */
export async function processAnalysisArrival({
  signal: rawSignal, mode, ports, serviceName,
  controllerConfig = {}, observationIntervalSeconds = 10, seenIdLimit = 2048,
}) {
  const signal = parseAnalysisArrivalSignal(rawSignal);
  if (!['reactive', 'hybrid'].includes(mode)) throw new Error('mode must be reactive or hybrid');
  if (typeof serviceName !== 'string' || !serviceName) throw new Error('serviceName is required');
  if (!Number.isInteger(observationIntervalSeconds) || observationIntervalSeconds < 1) {
    throw new Error('observationIntervalSeconds must be a positive integer');
  }
  if (!Number.isInteger(seenIdLimit) || seenIdLimit < 1) throw new Error('seenIdLimit must be positive');
  validatePorts(ports);
  const intervalMs = observationIntervalSeconds * 1000;
  const stored = await ports.getState(signal.runId);
  const state = stored ? structuredClone(stored) : fresh(signal.runId, signal);
  if (state.runId !== signal.runId || !Number.isInteger(state.version) || state.version < 0) {
    throw new Error('invalid persisted HD predictor state');
  }

  async function finishPending() {
    const pending = state.pendingScaleRequest;
    if (!pending) return { scaleRequested: false, target: null };
    const live = await ports.serviceSnapshot();
    const desired = Number(live.desiredTasks);
    const running = Number(live.runningTasks);
    const target = Math.max(desired, running, pending.targetTasks);
    if (!Number.isInteger(desired) || !Number.isInteger(running)
      || target < 1 || target > 5) throw new Error('invalid current ECS capacity');
    const scaleRequested = target > desired;
    if (scaleRequested) await ports.requestScaleOut(target, { runId: signal.runId, signalId: pending.signalId });
    state.pendingScaleRequest = null;
    await ports.putState(state, state.version);
    state.version += 1;
    if (scaleRequested) {
      try {
        await ports.publishMetrics([metric('PredictiveScaleRequest', target, signal, pending.atMs, serviceName)]);
      } catch { /* scaling succeeded; a telemetry fault cannot undo it */ }
    }
    return { scaleRequested, target };
  }

  if (state.seenSignalIds.includes(signal.signalId)) {
    const pendingResult = await finishPending();
    return { duplicate: true, acceptedJobs: 0, ...pendingResult, stateVersion: state.version };
  }
  const arrivalsAtMs = Math.max(signal.atMs, state.originAtMs + state.binIndex * intervalMs);
  const newBinIndex = Math.floor((arrivalsAtMs - state.originAtMs) / intervalMs);
  const service = await ports.serviceSnapshot();
  const queue = await ports.queueSnapshot();
  const desiredTasks = Number(service.desiredTasks);
  const runningTasks = Number(service.runningTasks);
  const visibleBacklog = Number(queue.visibleBacklog);
  if (!Number.isInteger(desiredTasks) || desiredTasks < 1 || desiredTasks > 5
    || !Number.isInteger(runningTasks) || runningTasks < 0 || runningTasks > 5
    || !Number.isFinite(visibleBacklog) || visibleBacklog < 0) {
    throw new Error('invalid service or queue snapshot');
  }
  const bpt = visibleBacklog / Math.max(1, runningTasks);
  const predictor = mode === 'hybrid' ? new HybridPredictiveController({
    ...controllerConfig, state: state.controllerState,
  }) : null;
  const emitted = [];
  let pending = state.pendingScaleRequest;
  for (let bin = state.binIndex; bin < newBinIndex; bin += 1) {
    const rate = (bin === state.binIndex ? state.binJobs : 0) / observationIntervalSeconds;
    const endAtMs = state.originAtMs + (bin + 1) * intervalMs;
    emitted.push(metric('AnalysisArrivalRate', rate, signal, endAtMs, serviceName));
    emitted.push(metric('RunningTaskCount', runningTasks, signal, endAtMs, serviceName));
    emitted.push(metric('AnalysisQueueVisible', visibleBacklog, signal, endAtMs, serviceName));
    emitted.push(metric('PredictorObservedBacklogPerTask', bpt, signal, endAtMs, serviceName));
    for (let index = state.forecasts.length - 1; index >= 0; index -= 1) {
      if (state.forecasts[index].dueAtMs <= endAtMs) {
        emitted.push(metric('PredictionError', state.forecasts[index].predictedRate - rate,
          signal, endAtMs, serviceName));
        state.forecasts.splice(index, 1);
      }
    }
    if (predictor) {
      const decision = predictor.observe({
        atMs: endAtMs,
        arrivalRateJobsPerSecond: rate,
        visibleBacklog,
        backlogPerTask: bpt,
        runningTasks,
        desiredTasks: Math.max(desiredTasks, pending?.targetTasks ?? 1),
        reactiveRequiredTasks: desiredTasks,
      });
      emitted.push(metric('PredictiveRecommendedTasks', decision.recommendedTasks,
        signal, endAtMs, serviceName));
      if (decision.predictedArrivalRateJobsPerSecond !== undefined) {
        emitted.push(metric('PredictedArrivalRate', decision.predictedArrivalRateJobsPerSecond,
          signal, endAtMs, serviceName));
        state.forecasts.push({ dueAtMs: decision.forecastAtMs,
          predictedRate: decision.predictedArrivalRateJobsPerSecond });
      }
      if (decision.shouldRequestScaleOut) {
        pending = { targetTasks: Math.max(pending?.targetTasks ?? 1, decision.recommendedTasks),
          signalId: signal.signalId, atMs: endAtMs };
      }
    }
  }
  state.binJobs = (newBinIndex === state.binIndex ? state.binJobs : 0) + signal.publishedJobCount;
  state.binIndex = newBinIndex;
  // A signal processed after its original bin has closed is assigned to the
  // current bin. Its count is retained; chronology is not rewritten.
  state.seenSignalIds.push(signal.signalId);
  if (state.seenSignalIds.length > seenIdLimit) {
    state.seenSignalIds.splice(0, state.seenSignalIds.length - seenIdLimit);
  }
  state.pendingScaleRequest = pending;
  if (predictor) state.controllerState = predictor.exportState();
  await ports.putState(state, state.version);
  state.version += 1;
  // A metrics fault cannot turn a successful job enqueue into a retry that
  // duplicates business work; keep scaling live and report the telemetry fault.
  let metricError = null;
  if (emitted.length) {
    try { await ports.publishMetrics(emitted); } catch (error) { metricError = error.message; }
  }
  const pendingResult = await finishPending();
  return {
    duplicate: false, acceptedJobs: signal.publishedJobCount,
    emittedMetricCount: emitted.length, metricError,
    ...pendingResult, stateVersion: state.version,
  };
}
