#!/usr/bin/env node
/**
 * Local backlog-per-task autoscaler for the route-impact worker.
 *
 * WHAT IT IS
 * A faithful local implementation of the SAME control law that
 * infrastructure/cloudformation/scaling.yaml configures on AWS:
 *
 *     BacklogPerTask = ApproximateNumberOfMessagesVisible / max(RunningTasks, 1)
 *     desiredTasks   = clamp(ceil(visibleMessages / targetBacklogPerTask), min, max)
 *
 * On AWS, Application Auto Scaling evaluates that ratio (published every minute
 * by a small Lambda) and changes the ECS service's desired count. Here, the same
 * arithmetic starts and stops route-impact worker CHILD PROCESSES against the
 * same queue. A worker process is the local analogue of a Fargate task: it is
 * stateless, it competes for the same queue, and it is terminated with SIGTERM
 * exactly as Fargate terminates a task on scale-in.
 *
 * WHY THIS IS USEFUL EVIDENCE
 * It lets the scaling behaviour - scale out under backlog, drain, scale back in
 * - be measured and reproduced without an AWS account, and it means the AWS
 * scaling policy is not the first time the control law is ever exercised.
 * It is NOT a substitute for observing real ECS task counts; the report must
 * label local results as local. See docs/SCALABILITY_TESTING.md.
 *
 * Usage:
 *   npm run autoscaler
 *   SCALING_MAX_TASKS=5 SCALING_TARGET_BACKLOG_PER_TASK=75 npm run autoscaler
 */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ARTIFACTS_DIR, QUEUES, SCALING, WORKER } from '@sit314/shared/config';
import { banner, createLogger } from '@sit314/shared/logging';
import { getQueue } from '@sit314/shared/queues';
import { sleep } from '@sit314/shared/util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = path.resolve(HERE, '..', 'services', 'route-impact-worker', 'src', 'index.js');

export class LocalAutoscaler {
  /**
   * @param {object} options
   * @param {object} options.queue queue to measure backlog on
   * @param {number} options.minTasks
   * @param {number} options.maxTasks
   * @param {number} options.targetBacklogPerTask
   * @param {number} options.evaluationIntervalMs
   * @param {number} options.scaleOutCooldownSeconds
   * @param {number} options.scaleInCooldownSeconds
   * @param {string} [options.csvPath] where to append the scaling time series
   * @param {object} [options.spawner] injectable process manager (for tests)
   */
  constructor(options) {
    this.queue = options.queue;
    this.minTasks = options.minTasks ?? SCALING.minTasks;
    this.maxTasks = options.maxTasks ?? SCALING.maxTasks;
    this.target = options.targetBacklogPerTask ?? SCALING.targetBacklogPerTask;
    this.evaluationIntervalMs = options.evaluationIntervalMs ?? SCALING.evaluationIntervalMs;
    this.scaleOutCooldownMs = (options.scaleOutCooldownSeconds ?? SCALING.scaleOutCooldownSeconds) * 1000;
    this.scaleInCooldownMs = (options.scaleInCooldownSeconds ?? SCALING.scaleInCooldownSeconds) * 1000;
    this.logger = options.logger || createLogger('autoscaler');
    this.spawner = options.spawner || defaultSpawner(options.workerEnv || {});
    this.csvPath = options.csvPath || null;
    this.now = options.now || (() => Date.now());

    this.tasks = new Map(); // taskId -> handle
    this.nextTaskNumber = 1;
    this.lastScaleOutAt = 0;
    this.lastScaleInAt = 0;
    this.running = false;
    this.history = [];
    this.events = [];

    if (this.csvPath) {
      fs.mkdirSync(path.dirname(this.csvPath), { recursive: true });
      fs.writeFileSync(this.csvPath,
        'timestamp,visibleMessages,inFlightMessages,oldestAgeSeconds,runningTasks,backlogPerTask,desiredTasks,action\n');
    }
  }

  get runningTasks() {
    return this.tasks.size;
  }

  /**
   * The control law. Pure arithmetic, so it can be unit tested directly.
   * @returns {number} desired task count
   */
  desiredTaskCount(visibleMessages, runningTasks) {
    const running = Math.max(runningTasks, 1);
    const backlogPerTask = visibleMessages / running;
    // Target tracking: to bring backlogPerTask down to the target, the service
    // needs enough tasks that visible/desired <= target.
    const raw = Math.ceil(visibleMessages / this.target);
    const desired = Math.max(this.minTasks, Math.min(this.maxTasks, raw));
    return { desired, backlogPerTask };
  }

  startTask() {
    const taskId = `task-${this.nextTaskNumber}`;
    this.nextTaskNumber += 1;
    const handle = this.spawner.start(taskId);
    this.tasks.set(taskId, handle);
    return taskId;
  }

  stopTask() {
    // Stop the most recently started task, mirroring how a scale-in event
    // terminates one task while the others keep consuming.
    const taskId = [...this.tasks.keys()].pop();
    if (!taskId) return null;
    const handle = this.tasks.get(taskId);
    this.tasks.delete(taskId);
    this.spawner.stop(handle); // SIGTERM: the worker drains and exits cleanly
    return taskId;
  }

  /** One evaluation cycle. Returns the recorded sample. */
  async evaluate() {
    const attrs = await this.queue.getAttributes();
    const visible = attrs.approximateNumberOfMessages;
    const running = this.runningTasks;
    const { desired, backlogPerTask } = this.desiredTaskCount(visible, running);

    const now = this.now();
    let action = 'none';

    if (desired > running) {
      if (now - this.lastScaleOutAt >= this.scaleOutCooldownMs) {
        const started = [];
        for (let i = running; i < desired; i += 1) started.push(this.startTask());
        this.lastScaleOutAt = now;
        action = `scaleOut:${started.length}`;
        this.events.push({ at: new Date(now).toISOString(), action, from: running, to: desired, backlogPerTask });
        this.logger.block('SCALE-OUT', {
          reason: 'backlog per task above target',
          backlogPerTask: backlogPerTask.toFixed(1),
          target: this.target,
          visibleMessages: visible,
          from: running,
          to: desired,
          started: started.join(','),
        });
      } else {
        action = 'scaleOutCooldown';
      }
    } else if (desired < running) {
      if (now - this.lastScaleInAt >= this.scaleInCooldownMs) {
        const stopped = [];
        for (let i = running; i > desired; i -= 1) stopped.push(this.stopTask());
        this.lastScaleInAt = now;
        action = `scaleIn:${stopped.length}`;
        this.events.push({ at: new Date(now).toISOString(), action, from: running, to: desired, backlogPerTask });
        this.logger.block('SCALE-IN', {
          reason: 'backlog per task below target',
          backlogPerTask: backlogPerTask.toFixed(1),
          target: this.target,
          visibleMessages: visible,
          from: running,
          to: desired,
          stopped: stopped.join(','),
        });
      } else {
        action = 'scaleInCooldown';
      }
    }

    const sample = {
      timestamp: new Date(now).toISOString(),
      visibleMessages: visible,
      inFlightMessages: attrs.approximateNumberOfMessagesNotVisible,
      oldestAgeSeconds: attrs.approximateAgeOfOldestMessageSeconds,
      runningTasks: this.runningTasks,
      backlogPerTask: Number(backlogPerTask.toFixed(2)),
      desiredTasks: desired,
      action,
    };
    this.history.push(sample);
    if (this.csvPath) {
      fs.appendFileSync(this.csvPath,
        `${sample.timestamp},${sample.visibleMessages},${sample.inFlightMessages},`
        + `${sample.oldestAgeSeconds},${sample.runningTasks},${sample.backlogPerTask},`
        + `${sample.desiredTasks},${sample.action}\n`);
    }
    return sample;
  }

  async start() {
    this.running = true;
    // Always begin at the minimum, exactly as the ECS service does.
    while (this.runningTasks < this.minTasks) this.startTask();
    this.logger.info('AUTOSCALER-STARTED', {
      minTasks: this.minTasks, maxTasks: this.maxTasks, target: this.target,
    }, `[AUTOSCALER] started at minimum ${this.minTasks} task(s), `
      + `target ${this.target} jobs/task, max ${this.maxTasks}`);

    while (this.running) {
      await this.evaluate();
      await sleep(this.evaluationIntervalMs);
    }
  }

  async stop() {
    this.running = false;
    for (const [taskId, handle] of this.tasks) {
      this.spawner.stop(handle);
      this.tasks.delete(taskId);
    }
  }

  summary() {
    const taskCounts = this.history.map((h) => h.runningTasks);
    const backlogs = this.history.map((h) => h.visibleMessages);
    return {
      samples: this.history.length,
      minTasksObserved: taskCounts.length ? Math.min(...taskCounts) : null,
      maxTasksObserved: taskCounts.length ? Math.max(...taskCounts) : null,
      finalTasks: this.runningTasks,
      peakQueueDepth: backlogs.length ? Math.max(...backlogs) : null,
      endingQueueDepth: backlogs.length ? backlogs[backlogs.length - 1] : null,
      scaleOutEvents: this.events.filter((e) => e.action.startsWith('scaleOut')).length,
      scaleInEvents: this.events.filter((e) => e.action.startsWith('scaleIn')).length,
      events: this.events,
    };
  }
}

/** Spawns real route-impact worker processes. */
export function defaultSpawner(extraEnv = {}) {
  return {
    start(taskId) {
      const child = spawn(process.execPath, [WORKER_ENTRY], {
        env: {
          ...process.env,
          ...extraEnv,
          WORKER_TASK_ID: taskId,
          LOG_QUIET: extraEnv.LOG_QUIET ?? 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', () => {});
      child.stderr.on('data', () => {});
      return { taskId, child };
    },
    stop(handle) {
      // SIGTERM, matching how ECS terminates a task: the worker stops claiming
      // new messages, finishes what it holds and exits.
      try {
        handle.child.kill('SIGTERM');
      } catch { /* already gone */ }
    },
  };
}

// ---------------------------------------------------------------- CLI entry
const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCli) {
  const queue = getQueue(QUEUES.analysis);
  const csvPath = path.join(ARTIFACTS_DIR, 'metrics', 'autoscaler.csv');
  const autoscaler = new LocalAutoscaler({
    queue,
    csvPath,
    workerEnv: { WORKER_PROCESSING_DELAY_MS: String(WORKER.processingDelayMs) },
  });

  process.stdout.write(`${banner('SIT314 local autoscaler (route impact worker)', {
    Queue: queue.name,
    'Min tasks': autoscaler.minTasks,
    'Max tasks': autoscaler.maxTasks,
    'Target backlog/task': autoscaler.target,
    'Evaluation interval': `${autoscaler.evaluationIntervalMs} ms`,
    'Scale-out cooldown': `${autoscaler.scaleOutCooldownMs / 1000} s`,
    'Scale-in cooldown': `${autoscaler.scaleInCooldownMs / 1000} s`,
    'Worker delay': `${WORKER.processingDelayMs} ms (test parameter)`,
    'Time series': csvPath,
    Note: 'local stand-in for ECS Application Auto Scaling',
  })}\n`);

  const shutdown = async () => {
    process.stdout.write('\n[AUTOSCALER] stopping all tasks\n');
    await autoscaler.stop();
    process.stdout.write(`${JSON.stringify(autoscaler.summary(), null, 2)}\n`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  autoscaler.start().catch((err) => {
    process.stderr.write(`[AUTOSCALER-ERROR] ${err.stack}\n`);
    process.exit(1);
  });
}

export default LocalAutoscaler;
