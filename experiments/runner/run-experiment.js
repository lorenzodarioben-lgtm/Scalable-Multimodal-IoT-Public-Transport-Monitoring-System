#!/usr/bin/env node
/**
 * Scalability experiment runner.
 *
 * WHAT IT DOES
 * Runs one stage of the incident experiment end to end:
 *   1. prints and records the exact configuration, including the seed,
 *   2. purges the analysis queue so the stage starts from a known state,
 *   3. starts the route-impact worker either as a FIXED number of tasks
 *      (Experiment A) or under the backlog-per-task autoscaler (Experiment B),
 *   4. injects incidents at the configured rate for the configured duration,
 *   5. samples queue depth, oldest-message age and task count every second,
 *   6. stops the workers, then computes the run summary and evaluates the
 *      breaking-point criteria,
 *   7. writes everything to a timestamped directory under artifacts/runs/.
 *
 * WHY THE SEED AND THE CONFIG ARE RECORDED
 * Experiment A and Experiment B must run the IDENTICAL workload, and each stage
 * is repeated three times. Recording the config and seed alongside the results
 * is what makes those comparisons defensible.
 *
 * Usage:
 *   npm run experiment -- --config experiments/incident/stage-1.json
 *   npm run experiment -- --config experiments/incident/stage-1.json --worker-mode autoscale
 *   npm run experiment -- --config experiments/incident/stage-1.json --duration-seconds 60
 */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { ARTIFACTS_DIR, QUEUES, REPO_ROOT, TABLES } from '@sit314/shared/config';
import { banner, createLogger } from '@sit314/shared/logging';
import { getQueue } from '@sit314/shared/queues';
import { getStore } from '@sit314/shared/store';
import { mean, percentile, round, sleep } from '@sit314/shared/util';
import { LocalAutoscaler, defaultSpawner } from '../../scripts/local-autoscaler.js';
import { generateIncidentJobs } from './job-generator.js';

const logger = createLogger('experiment');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

/** Applies command-line overrides on top of the stage file. */
export function resolveStage(config, args) {
  const stage = structuredClone(config);
  if (args['duration-seconds']) stage.durationSeconds = Number(args['duration-seconds']);
  if (args['warmup-seconds'] !== undefined) stage.warmupSeconds = Number(args['warmup-seconds']);
  if (args['worker-mode']) stage.worker.mode = args['worker-mode'];
  if (args['fixed-tasks']) stage.worker.fixedTasks = Number(args['fixed-tasks']);
  if (args['max-tasks']) stage.worker.maxTasks = Number(args['max-tasks']);
  if (args['processing-delay-ms'] !== undefined) {
    stage.worker.processingDelayMs = Number(args['processing-delay-ms']);
  }
  if (args['processing-cpu-iterations'] !== undefined) {
    stage.worker.processingCpuIterations = Number(args['processing-cpu-iterations']);
  }
  if (args['concurrency']) stage.worker.concurrency = Number(args.concurrency);
  if (args['no-reset-state']) stage.resetState = false;
  if (args['target-backlog-per-task']) {
    stage.worker.targetBacklogPerTask = Number(args['target-backlog-per-task']);
  }
  if (args['incident-interval-seconds']) {
    stage.arrival.incidentIntervalSeconds = Number(args['incident-interval-seconds']);
  }
  // Bound injection by incident COUNT instead of by elapsed time. Use this for
  // any fixed-vs-autoscale comparison so both arms inject an identical workload.
  if (args.incidents) stage.arrival.incidents = Number(args.incidents);
  if (args.seed) stage.seed = Number(args.seed);
  if (args.label) stage.label = args.label;
  return stage;
}

/**
 * Evaluate the approved breaking-point definition.
 *
 * A stage is UNSTABLE when the queue keeps growing through the final window AND
 * at least one of the listed conditions holds. The breaking point is therefore
 * "the system can no longer keep up", not "the system crashed".
 */
export function evaluateStability(stage, samples, results, injectionEndSeconds = null) {
  const configuredWindow = stage.sla?.finalWindowSeconds ?? 300;

  // Only the INJECTION phase counts. After injection stops the queue always
  // drains, so including the drain would let an overloaded configuration look
  // healthy. The question is whether the system kept up while load arrived.
  const injectionEnd = injectionEndSeconds
    ?? (stage.warmupSeconds + stage.durationSeconds);
  const injectionSamples = samples.filter((s) => s.elapsedSeconds <= injectionEnd);
  // A short checkpoint run may be shorter than the configured window; use
  // whatever measurement phase exists, and report which window was used.
  const measurementSpan = Math.max(0, injectionEnd - (stage.warmupSeconds ?? 0));
  const windowSeconds = Math.min(configuredWindow, measurementSpan || configuredWindow);
  const windowStart = Math.max(stage.warmupSeconds ?? 0, injectionEnd - windowSeconds);
  const tail = injectionSamples.filter((s) => s.elapsedSeconds >= windowStart);
  const reasons = [];

  const queueGrowing = tail.length >= 2
    && tail.at(-1).visibleMessages > tail[0].visibleMessages;

  if (results.p95ProcessingMs !== null
    && results.p95ProcessingMs > (stage.sla?.p95LatencyMs ?? 5000)) {
    reasons.push(`p95 route-impact latency ${results.p95ProcessingMs}ms exceeds `
      + `${stage.sla?.p95LatencyMs ?? 5000}ms`);
  }
  const maxOldest = tail.length ? Math.max(...tail.map((s) => s.oldestAgeSeconds)) : 0;
  if (maxOldest > (stage.sla?.oldestMessageAgeSeconds ?? 10)) {
    reasons.push(`age of oldest message reached ${maxOldest}s, above `
      + `${stage.sla?.oldestMessageAgeSeconds ?? 10}s`);
  }
  const atMax = tail.length
    && tail.every((s) => s.runningTasks >= (stage.worker.maxTasks ?? 5));
  if (atMax && queueGrowing) {
    reasons.push(`service held at the maximum of ${stage.worker.maxTasks} tasks while the backlog grew`);
  }
  if (results.jobsLost > 0) reasons.push(`${results.jobsLost} jobs were not processed`);
  if (results.duplicateResults > 0) reasons.push(`${results.duplicateResults} duplicate results were produced`);
  if (results.dlqDepth > 0) reasons.push(`${results.dlqDepth} valid jobs reached the dead-letter queue`);

  return {
    queueGrowingInFinalWindow: queueGrowing,
    finalWindowSeconds: windowSeconds,
    windowStartSeconds: windowStart,
    windowEndSeconds: injectionEnd,
    note: 'Evaluated over the injection phase only; the post-injection drain is excluded.',
    stable: !(queueGrowing && reasons.length > 0),
    breachedCriteria: reasons,
    verdict: queueGrowing && reasons.length > 0 ? 'UNSTABLE' : 'STABLE',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) {
    process.stderr.write('usage: npm run experiment -- --config experiments/incident/stage-1.json\n');
    process.exit(2);
  }

  const configPath = path.resolve(args.config);
  if (!fs.existsSync(configPath)) {
    process.stderr.write(`config not found: ${configPath}\n`);
    process.exit(2);
  }
  const stage = resolveStage(JSON.parse(fs.readFileSync(configPath, 'utf8')), args);

  if (stage.type !== 'incident') {
    process.stderr.write(`this runner handles incident stages; "${stage.type}" stages are driven `
      + 'by the simulator (see docs/SCALABILITY_TESTING.md)\n');
    process.exit(2);
  }

  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[:.]/g, '-')}-${stage.name}-${stage.worker.mode}`;
  const runDir = path.join(ARTIFACTS_DIR, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });

  const analysisQueue = getQueue(QUEUES.analysis);
  const analysisDlq = getQueue(QUEUES.analysisDlq);
  const store = getStore();

  const jobsPerIncident = stage.incident.jobsPerIncident;
  const intervalSeconds = stage.arrival.incidentIntervalSeconds;
  const arrivalRate = jobsPerIncident / intervalSeconds;

  process.stdout.write(`${banner(`SIT314 experiment: ${stage.name}`, {
    Description: stage.description,
    'Run id': runId,
    Seed: stage.seed,
    'Worker mode': stage.worker.mode,
    Tasks: stage.worker.mode === 'fixed'
      ? `fixed ${stage.worker.fixedTasks}`
      : `autoscale ${stage.worker.minTasks}-${stage.worker.maxTasks} @ ${stage.worker.targetBacklogPerTask} jobs/task`,
    Concurrency: stage.worker.concurrency,
    'Processing delay': `${stage.worker.processingDelayMs ?? 0} ms (test parameter)`,
    'Processing CPU': `${stage.worker.processingCpuIterations ?? 0} iterations (test parameter)`,
    'Jobs per incident': jobsPerIncident,
    'Incident interval': `${intervalSeconds} s`,
    'Arrival rate': `${arrivalRate.toFixed(1)} jobs/s`,
    Duration: `${stage.durationSeconds} s`,
    'Warm-up': `${stage.warmupSeconds} s`,
    'SLA p95': `${stage.sla.p95LatencyMs} ms`,
    'SLA oldest age': `${stage.sla.oldestMessageAgeSeconds} s`,
    'Artifacts': runDir,
  })}\n`);

  fs.writeFileSync(path.join(runDir, 'config.json'), `${JSON.stringify({
    ...stage, resolvedFrom: path.relative(REPO_ROOT, configPath),
  }, null, 2)}\n`);

  // ---- clean starting state -------------------------------------------
  // Every stage must start from a known state, and leftover state from earlier
  // runs also inflates the local file-backed store, which distorts timings.
  await analysisQueue.purge();
  await analysisDlq.purge();
  if (stage.resetState !== false) {
    await getQueue(QUEUES.notifications).purge();
    await getQueue(QUEUES.notificationsDlq).purge();
  }
  const resultsBefore = await store.count(TABLES.analysisResults);

  // ---- start the workers ------------------------------------------------
  const workerEnv = {
    WORKER_PROCESSING_DELAY_MS: String(stage.worker.processingDelayMs ?? 0),
    WORKER_PROCESSING_CPU_ITERATIONS: String(stage.worker.processingCpuIterations ?? 0),
    WORKER_CONCURRENCY: String(stage.worker.concurrency),
    WORKER_WAIT_TIME_SECONDS: '2',
    LOG_QUIET: 'true',
    LOG_JSON_FILE: path.join(runDir, 'workers.jsonl'),
  };

  const autoscaler = new LocalAutoscaler({
    queue: analysisQueue,
    minTasks: stage.worker.mode === 'fixed' ? stage.worker.fixedTasks : stage.worker.minTasks,
    maxTasks: stage.worker.mode === 'fixed' ? stage.worker.fixedTasks : stage.worker.maxTasks,
    targetBacklogPerTask: stage.worker.targetBacklogPerTask,
    evaluationIntervalMs: stage.worker.evaluationIntervalMs,
    scaleOutCooldownSeconds: stage.worker.scaleOutCooldownSeconds,
    scaleInCooldownSeconds: stage.worker.scaleInCooldownSeconds,
    csvPath: path.join(runDir, 'scaling.csv'),
    spawner: defaultSpawner(workerEnv),
    logger,
  });

  // Fixed mode pins min = max, so the control law can never change the count.
  const autoscalerLoop = autoscaler.start();

  // ---- sample the time series ------------------------------------------
  const samples = [];
  const metricsCsv = path.join(runDir, 'metrics.csv');
  fs.writeFileSync(metricsCsv,
    'elapsedSeconds,timestamp,visibleMessages,inFlightMessages,oldestAgeSeconds,runningTasks,backlogPerTask,jobsInjected\n');

  let jobsInjected = 0;
  let sampling = true;
  const runStart = Date.now();

  const sampler = (async () => {
    while (sampling) {
      const attrs = await analysisQueue.getAttributes();
      const elapsedSeconds = round((Date.now() - runStart) / 1000, 1);
      const runningTasks = autoscaler.runningTasks;
      const sample = {
        elapsedSeconds,
        timestamp: new Date().toISOString(),
        visibleMessages: attrs.approximateNumberOfMessages,
        inFlightMessages: attrs.approximateNumberOfMessagesNotVisible,
        oldestAgeSeconds: attrs.approximateAgeOfOldestMessageSeconds,
        runningTasks,
        backlogPerTask: round(attrs.approximateNumberOfMessages / Math.max(runningTasks, 1)),
        jobsInjected,
      };
      samples.push(sample);
      fs.appendFileSync(metricsCsv, `${sample.elapsedSeconds},${sample.timestamp},`
        + `${sample.visibleMessages},${sample.inFlightMessages},${sample.oldestAgeSeconds},`
        + `${sample.runningTasks},${sample.backlogPerTask},${sample.jobsInjected}\n`);
      await sleep(1000);
    }
  })();

  // ---- inject the workload ---------------------------------------------
  //
  // Two ways to bound injection:
  //
  //   time-bounded  (default)  inject for warmup+duration seconds
  //   count-bounded (--incidents N) inject exactly N incidents
  //
  // Count-bounded exists because a time-bounded run does NOT guarantee both
  // arms of an A/B comparison receive the same workload. Enqueuing an incident
  // is itself work, and it slows down when several workers are competing for
  // the same queue, so the autoscaled arm can fit fewer incidents into the same
  // wall-clock window than the fixed arm. That was observed directly: a
  // time-bounded stage 2 injected 1500 jobs with one worker but only 750 with
  // five. Comparing those two runs would be meaningless. Use --incidents for
  // any fixed-vs-autoscale comparison; the time bound is fine for a single
  // soak run where only the arrival RATE matters.
  const totalSeconds = stage.warmupSeconds + stage.durationSeconds;
  const endAt = runStart + totalSeconds * 1000;
  const targetIncidents = stage.arrival.incidents ?? null;
  let incidentSequence = 0;
  const injectionErrors = [];

  const stillInjecting = () => (targetIncidents !== null
    ? incidentSequence < targetIncidents
    : Date.now() < endAt);

  process.stdout.write(targetIncidents !== null
    ? `[EXPERIMENT] warm-up ${stage.warmupSeconds}s, then injecting exactly `
      + `${targetIncidents} incidents (${targetIncidents * stage.incident.jobsPerIncident} jobs)\n\n`
    : `[EXPERIMENT] warm-up ${stage.warmupSeconds}s, then measuring for ${stage.durationSeconds}s\n\n`);

  while (stillInjecting()) {
    const cycleStart = Date.now();
    incidentSequence += 1;
    const jobs = generateIncidentJobs(stage.incident, incidentSequence, runId);
    try {
      const sent = await analysisQueue.sendMessageBatch(jobs);
      jobsInjected += sent.successful ?? jobs.length;
      const phase = (Date.now() - runStart) / 1000 < stage.warmupSeconds ? 'warmup' : 'measure';
      process.stdout.write(`[INJECT] incident=${incidentSequence} phase=${phase} `
        + `jobs=${jobs.length} totalInjected=${jobsInjected} `
        + `queueDepth=${samples.at(-1)?.visibleMessages ?? '?'} `
        + `tasks=${autoscaler.runningTasks}\n`);
    } catch (err) {
      injectionErrors.push(err.message);
    }
    const wait = Math.max(0, intervalSeconds * 1000 - (Date.now() - cycleStart));
    // A count-bounded run always waits the full interval, so the arrival rate
    // stays as configured; only a time-bounded run is cut short by the deadline.
    await sleep(targetIncidents !== null
      ? wait
      : Math.min(wait, Math.max(0, endAt - Date.now())));
  }

  const injectionEndSeconds = round((Date.now() - runStart) / 1000, 1);

  // ---- drain: let the workers finish what is left ------------------------
  process.stdout.write('\n[EXPERIMENT] injection complete, draining the queue\n');
  const drainDeadline = Date.now() + 120000;
  for (;;) {
    const attrs = await analysisQueue.getAttributes();
    if (attrs.approximateNumberOfMessages === 0 && attrs.approximateNumberOfMessagesNotVisible === 0) break;
    if (Date.now() > drainDeadline) {
      process.stdout.write('[EXPERIMENT] drain timeout reached - the backlog did not clear\n');
      break;
    }
    await sleep(1000);
  }

  sampling = false;
  await sampler;
  autoscaler.running = false;
  await autoscaler.stop();
  await autoscalerLoop.catch(() => {});
  // Give the workers a moment to flush their final metrics on SIGTERM.
  await sleep(1500);

  // ---- collect results ---------------------------------------------------
  const finalAttrs = await analysisQueue.getAttributes();
  const dlqAttrs = await analysisDlq.getAttributes();
  const resultsAfter = await store.count(TABLES.analysisResults);
  const resultsProduced = resultsAfter - resultsBefore;

  const workerRecords = readJsonl(path.join(runDir, 'workers.jsonl'));
  const processingTimes = workerRecords
    .filter((r) => r.tag === 'ANALYSIS' && Number.isFinite(r.processingMs))
    .map((r) => r.processingMs);
  const duplicateRecords = workerRecords.filter((r) => r.tag === 'DUPLICATE_SKIPPED').length;
  const failureRecords = workerRecords.filter((r) => r.tag === 'PROCESSING-FAILED').length;

  const elapsedSeconds = round((Date.now() - runStart) / 1000, 1);
  const scalingSummary = autoscaler.summary();

  // Job accounting. Every injected job ends in exactly one of three states:
  // it produced a result, it is still queued, or it reached the DLQ. Anything
  // unaccounted for is a genuine loss and is one of the breaking-point criteria.
  //
  // NOTE: duplicateRecords counts extra DELIVERIES of a job that was already
  // processed (SQS is at-least-once). It is not a count of extra jobs, so it
  // must not appear in this sum - it would double-count.
  const unprocessedInQueue = finalAttrs.approximateNumberOfMessages
    + finalAttrs.approximateNumberOfMessagesNotVisible;
  const accountedFor = resultsProduced
    + unprocessedInQueue
    + dlqAttrs.approximateNumberOfMessages;

  const results = {
    totalJobsInjected: jobsInjected,
    incidentsInjected: incidentSequence,
    resultsProduced,
    // Redeliveries that were correctly suppressed. Non-zero is GOOD evidence:
    // it means SQS redelivered and idempotency caught it.
    duplicateJobsSkipped: duplicateRecords,
    // A duplicate RESULT means one job produced two stored results, i.e.
    // idempotency failed. It must always be zero.
    duplicateResults: Math.max(0, resultsProduced - jobsInjected),
    processingFailures: failureRecords,
    unprocessedInQueue,
    jobsAccountedFor: accountedFor,
    jobsLost: Math.max(0, jobsInjected - accountedFor),
    elapsedSeconds,
    jobsPerSecondInjected: round(jobsInjected / Math.max(elapsedSeconds, 0.001)),
    jobsPerSecondProcessed: round(resultsProduced / Math.max(elapsedSeconds, 0.001)),
    meanProcessingMs: round(mean(processingTimes)),
    p95ProcessingMs: round(percentile(processingTimes, 95)),
    peakQueueDepth: samples.length ? Math.max(...samples.map((s) => s.visibleMessages)) : null,
    endingQueueDepth: finalAttrs.approximateNumberOfMessages,
    peakOldestAgeSeconds: samples.length ? Math.max(...samples.map((s) => s.oldestAgeSeconds)) : null,
    dlqDepth: dlqAttrs.approximateNumberOfMessages,
    minTasksObserved: scalingSummary.minTasksObserved,
    maxTasksObserved: scalingSummary.maxTasksObserved,
    scaleOutEvents: scalingSummary.scaleOutEvents,
    scaleInEvents: scalingSummary.scaleInEvents,
    injectionErrors: injectionErrors.length,
  };

  const stability = evaluateStability(stage, samples, results, injectionEndSeconds);

  const summary = {
    runId,
    stage: stage.name,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    seed: stage.seed,
    config: stage,
    results,
    stability,
    scaling: scalingSummary,
    environment: {
      queueBackend: process.env.QUEUE_BACKEND || 'local',
      storeBackend: process.env.STORE_BACKEND || 'local',
      note: 'Local backends unless QUEUE_BACKEND/STORE_BACKEND are set to aws.',
    },
  };

  fs.writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  if (injectionErrors.length) {
    fs.writeFileSync(path.join(runDir, 'errors.log'), `${injectionErrors.join('\n')}\n`);
  }

  process.stdout.write(`\n${banner(`Result: ${stage.name} (${stage.worker.mode})`, {
    'Jobs injected': results.totalJobsInjected,
    'Results produced': results.resultsProduced,
    'Duplicates skipped': results.duplicateJobsSkipped,
    'Left unprocessed': results.unprocessedInQueue,
    'Jobs lost': results.jobsLost,
    'Duplicate results': results.duplicateResults,
    'Processing failures': results.processingFailures,
    'Injected rate': `${results.jobsPerSecondInjected} jobs/s`,
    'Processed rate': `${results.jobsPerSecondProcessed} jobs/s`,
    'Mean latency': `${results.meanProcessingMs} ms`,
    'p95 latency': `${results.p95ProcessingMs} ms`,
    'Peak queue depth': results.peakQueueDepth,
    'Ending queue depth': results.endingQueueDepth,
    'Peak oldest age': `${results.peakOldestAgeSeconds} s`,
    'DLQ depth': results.dlqDepth,
    'Tasks min/max': `${results.minTasksObserved}/${results.maxTasksObserved}`,
    'Scale out/in events': `${results.scaleOutEvents}/${results.scaleInEvents}`,
    Verdict: stability.verdict,
    Elapsed: `${results.elapsedSeconds} s`,
  })}\n`);

  if (stability.breachedCriteria.length) {
    process.stdout.write('\nBreached criteria:\n');
    for (const reason of stability.breachedCriteria) process.stdout.write(`  - ${reason}\n`);
  }
  process.stdout.write(`\nArtifacts: ${runDir}\n`);
  process.exit(0);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

const isCli = process.argv[1] && process.argv[1].endsWith('run-experiment.js');
if (isCli) {
  main().catch((err) => {
    process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
}
