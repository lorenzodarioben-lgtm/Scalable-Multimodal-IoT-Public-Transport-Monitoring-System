/**
 * Multimodal transport simulator.
 *
 * What: drives the network, generators and scenario on a timer and publishes
 *       raw events to MQTT (or stdout in dry-run mode).
 * Why:  this is the Volume/Velocity/Variety source for the whole project.
 *       - Volume:   entity counts are configuration, not code.
 *       - Velocity: the reporting interval is configuration, not code.
 *       - Variety:  four structurally different payload types on four topics.
 *
 * Output: per-event lines, periodic [SUMMARY] blocks, and a final run summary
 *         object containing attempted / published / failed / rate / elapsed -
 *         exactly the load-test figures the report needs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { banner, createLogger } from '@sit314/shared/logging';
import { TOPICS } from '@sit314/shared/config';
import { validateRaw } from '@sit314/shared/validation';
import { Rng } from './rng.js';
import { buildNetwork } from './network.js';
import { createScenario } from './scenarios/index.js';
import { createPublisher } from './mqtt-client.js';
import {
  generateBusTelemetry,
  generateDemandEvent,
  generateTrainTelemetry,
  generateTramTelemetry,
} from './generators/index.js';
import { expectedEventsPerSecond, expectedTotalEvents } from './config.js';
import { corruptEvent } from './corruption.js';

export class Simulator {
  constructor(cfg, options = {}) {
    this.cfg = cfg;
    this.logger = options.logger || createLogger('simulator', { quiet: cfg.quiet });
    this.network = buildNetwork({
      seed: cfg.seed,
      buses: cfg.buses,
      trams: cfg.trams,
      trains: cfg.trains,
      locations: cfg.locations,
    });
    this.scenario = createScenario(cfg.scenario, this.network, {
      seed: cfg.seed,
      disruptAfterTicks: cfg.disruptAfterTicks,
      disruptVehicleId: cfg.disruptVehicleId,
    });
    this.rng = new Rng(cfg.seed);
    this.publisher = options.publisher || null;
    this.stats = {
      attempted: 0,
      published: 0,
      failed: 0,
      corrupted: 0,
      duplicated: 0,
      byMode: { bus: 0, tram: 0, train: 0, demand: 0 },
      startedAt: null,
      finishedAt: null,
    };
    this.tick = 0;
    this.demandTick = 0;
    this.stopping = false;
    this.outStream = cfg.outFile
      ? (fs.mkdirSync(path.dirname(path.resolve(cfg.outFile)), { recursive: true }),
        fs.createWriteStream(path.resolve(cfg.outFile), { flags: 'a' }))
      : null;
    this.printCounter = 0;
  }

  banner() {
    const cfg = this.cfg;
    return banner('SIT314 multimodal transport simulator', {
      Seed: cfg.seed,
      Buses: cfg.buses,
      Trams: cfg.trams,
      Trains: cfg.trains,
      'Demand locations': cfg.locations,
      Interval: `${cfg.intervalMs} ms`,
      'Demand interval': `${cfg.demandIntervalMs} ms`,
      Duration: `${Math.round(cfg.durationMs / 1000)} s`,
      Scenario: cfg.scenario,
      Incident: this.scenario.describe(),
      Target: cfg.target === 'mqtt' ? `MQTT (${cfg.mqttMode})` : 'stdout (dry run)',
      'Invalid rate': cfg.invalidRate,
      'Duplicate rate': cfg.duplicateRate,
      'Expected rate': `${expectedEventsPerSecond(cfg)} events/s`,
      'Expected total': expectedTotalEvents(cfg),
      Label: cfg.label,
    });
  }

  /** Builds every event due on this vehicle tick. */
  buildVehicleEvents(timestamp) {
    const events = [];
    const tick = this.tick;
    for (const entity of this.network.fleet.bus) {
      const health = this.scenario.healthFor(entity, tick);
      events.push(generateBusTelemetry({
        entity, rng: this.rng.child(`${entity.vehicleId}-${tick}`), tick, timestamp, health,
      }));
    }
    for (const entity of this.network.fleet.tram) {
      const health = this.scenario.healthFor(entity, tick);
      events.push(generateTramTelemetry({
        entity, rng: this.rng.child(`${entity.vehicleId}-${tick}`), tick, timestamp, health,
      }));
    }
    for (const entity of this.network.fleet.train) {
      const health = this.scenario.healthFor(entity, tick);
      events.push(generateTrainTelemetry({
        entity, rng: this.rng.child(`${entity.vehicleId}-${tick}`), tick, timestamp, health,
      }));
    }
    return events;
  }

  buildDemandEvents(timestamp) {
    const tick = this.demandTick;
    return this.network.demandLocations.map((location) => generateDemandEvent({
      entity: location,
      rng: this.rng.child(`${location.locationId}-demand-${tick}`),
      tick,
      timestamp,
      surgeMultiplier: this.scenario.surgeFor(location, this.tick),
    }));
  }

  topicFor(event) {
    if (event.eventType === 'locationDemand') return TOPICS.raw('demand', event.locationId);
    return TOPICS.raw(event.transportMode, event.vehicleId);
  }

  async publishEvent(event, { corrupt = false } = {}) {
    const topic = this.topicFor(event);
    let payload = event;
    if (corrupt) {
      payload = corruptEvent(event, this.rng.child(`corrupt-${event.eventId}`));
      this.stats.corrupted += 1;
    }
    this.stats.attempted += 1;
    const ok = await this.publisher.publish(topic, payload);
    if (ok) {
      this.stats.published += 1;
      const mode = event.eventType === 'locationDemand' ? 'demand' : event.transportMode;
      this.stats.byMode[mode] += 1;
      if (this.outStream) this.outStream.write(`${JSON.stringify({ topic, payload })}\n`);
      this.printEvent(event, corrupt);
    } else {
      this.stats.failed += 1;
    }
    return ok;
  }

  printEvent(event, corrupt) {
    if (!this.cfg.printEvents) return;
    this.printCounter += 1;
    if (this.printCounter % Math.max(1, this.cfg.printEveryNth) !== 0) return;
    const tag = corrupt ? 'PUBLISHED-INVALID' : 'PUBLISHED';
    if (event.eventType === 'locationDemand') {
      this.logger.info(tag, {}, `[${tag}] demand ${event.locationId.padEnd(16)} `
        + `type=${event.locationType} passengers=${event.passengerCount} level=${event.demandLevel}`);
      return;
    }
    const label = event.transportMode.padEnd(5);
    const health = event.health === 'normal' ? '' : ` health=${event.health}`;
    this.logger.info(tag, {}, `[${tag}] ${label} ${event.vehicleId.padEnd(10)} `
      + `route=${String(event.routeId).padEnd(14)} occ=${event.occupancy}/${event.capacity} `
      + `delay=${event.delaySeconds}s${health}`);
  }

  printSummary() {
    const elapsed = (Date.now() - this.stats.startedAt) / 1000;
    const rate = elapsed > 0 ? this.stats.published / elapsed : 0;
    this.logger.block('SUMMARY', {
      attempted: this.stats.attempted,
      published: this.stats.published,
      failed: this.stats.failed,
      corrupted: this.stats.corrupted,
      duplicated: this.stats.duplicated,
      rate: `${rate.toFixed(2)} events/s`,
      elapsed: `${elapsed.toFixed(1)}s`,
      bus: this.stats.byMode.bus,
      tram: this.stats.byMode.tram,
      train: this.stats.byMode.train,
      demand: this.stats.byMode.demand,
    });
  }

  /** True once the run should stop (duration reached or max events published). */
  shouldStop() {
    if (this.stopping) return true;
    if (this.cfg.maxEvents > 0 && this.stats.published >= this.cfg.maxEvents) return true;
    return Date.now() - this.stats.startedAt >= this.cfg.durationMs;
  }

  async runTick() {
    const timestamp = new Date().toISOString();
    const events = this.buildVehicleEvents(timestamp);
    const dueForDemand = this.tick === 0
      || (this.tick * this.cfg.intervalMs) % this.cfg.demandIntervalMs < this.cfg.intervalMs;
    if (dueForDemand) {
      events.push(...this.buildDemandEvents(timestamp));
      this.demandTick += 1;
    }

    for (const event of events) {
      if (this.cfg.maxEvents > 0 && this.stats.published >= this.cfg.maxEvents) break;
      const corruptRng = this.rng.child(`invalid-${event.eventId}`);
      const corrupt = this.cfg.invalidRate > 0 && corruptRng.bool(this.cfg.invalidRate);
      await this.publishEvent(event, { corrupt });
      // Duplicate injection republishes the SAME eventId so downstream
      // idempotency (attribute_not_exists) can be demonstrated end to end.
      if (this.cfg.duplicateRate > 0
        && this.rng.child(`dup-${event.eventId}`).bool(this.cfg.duplicateRate)) {
        await this.publishEvent(event, { corrupt: false });
        this.stats.duplicated += 1;
      }
    }
    this.tick += 1;
  }

  async run() {
    if (!this.publisher) {
      this.publisher = await createPublisher({
        target: this.cfg.target,
        mqttMode: this.cfg.mqttMode,
      });
    }
    process.stdout.write(`${this.banner()}\n`);
    if (this.publisher.endpointLabel) {
      process.stdout.write(`Connected to ${this.publisher.endpointLabel}\n\n`);
    }
    this.stats.startedAt = Date.now();
    let lastSummary = Date.now();

    while (!this.shouldStop()) {
      const tickStart = Date.now();
      await this.runTick();
      if (Date.now() - lastSummary >= this.cfg.summaryIntervalMs) {
        this.printSummary();
        lastSummary = Date.now();
      }
      const drift = Date.now() - tickStart;
      const wait = Math.max(0, this.cfg.intervalMs - drift);
      if (this.shouldStop()) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    this.stats.finishedAt = Date.now();
    this.printSummary();
    await this.shutdown();
    return this.summary();
  }

  summary() {
    const elapsedSeconds = ((this.stats.finishedAt ?? Date.now()) - this.stats.startedAt) / 1000;
    return {
      config: this.cfg,
      network: this.network.summary(),
      scenario: { name: this.scenario.name, description: this.scenario.describe(), targets: this.scenario.targets },
      attemptedEvents: this.stats.attempted,
      publishedEvents: this.stats.published,
      failedEvents: this.stats.failed,
      corruptedEvents: this.stats.corrupted,
      duplicatedEvents: this.stats.duplicated,
      byMode: this.stats.byMode,
      elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
      eventsPerSecond: Number((this.stats.published / Math.max(elapsedSeconds, 0.001)).toFixed(2)),
      ticks: this.tick,
      startedAt: new Date(this.stats.startedAt).toISOString(),
      finishedAt: new Date(this.stats.finishedAt ?? Date.now()).toISOString(),
    };
  }

  async shutdown() {
    this.stopping = true;
    if (this.outStream) await new Promise((resolve) => this.outStream.end(resolve));
    if (this.publisher) await this.publisher.end();
  }

  /**
   * Self-check used by tests and by `--validate-only`: generates one tick and
   * validates every payload against its mode-specific schema.
   */
  selfCheck() {
    const timestamp = new Date().toISOString();
    const events = [...this.buildVehicleEvents(timestamp), ...this.buildDemandEvents(timestamp)];
    const results = events.map((e) => ({ event: e, ...validateRaw(e) }));
    return {
      total: results.length,
      valid: results.filter((r) => r.valid).length,
      invalid: results.filter((r) => !r.valid),
    };
  }
}

export default Simulator;
