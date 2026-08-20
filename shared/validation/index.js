/**
 * Schema validation and normalisation.
 *
 * What: compiles the JSON Schemas in /schemas and exposes
 *       - mode-specific validation of RAW events (Variety),
 *       - conversion of a raw event into the shared NORMALISED envelope,
 *       - defensive validation of the internal message types.
 * Why:  Node-RED performs the authoritative validation/normalisation in the
 *       deployed pipeline (its function nodes implement the same rule set, and
 *       shared/test/node-red-flow.test.js executes those nodes against these
 *       fixtures). This module gives the simulator a self-check, gives the
 *       services a defensive second check, and gives the tests a single place
 *       to assert the rules from.
 *
 * Input:  a raw JSON object from MQTT.
 * Output: { valid, mode, errors[] } and a normalised envelope.
 */
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { REPO_ROOT, THRESHOLDS } from '../config/index.js';

const SCHEMA_DIR = path.join(REPO_ROOT, 'schemas');

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
}

export const schemas = {
  bus: load('bus-telemetry.schema.json'),
  tram: load('tram-telemetry.schema.json'),
  train: load('train-telemetry.schema.json'),
  demand: load('location-demand.schema.json'),
  normalized: load('normalized-event.schema.json'),
  analysisJob: load('analysis-job.schema.json'),
  alert: load('alert.schema.json'),
  notification: load('notification-record.schema.json'),
};

const validators = Object.fromEntries(
  Object.entries(schemas).map(([key, schema]) => [key, ajv.compile(schema)]),
);

/**
 * Occupancy may legitimately exceed capacity (standing crush load), but a value
 * far beyond capacity indicates a broken sensor rather than a full vehicle.
 */
export const MAX_OCCUPANCY_RATIO = Number(process.env.MAX_OCCUPANCY_RATIO ?? 1.5);

function ajvErrors(validate) {
  return (validate.errors || []).map((e) => {
    const field = e.instancePath ? e.instancePath.replace(/^\//, '').replace(/\//g, '.') : 'payload';
    return `${field} ${e.message}`.trim();
  });
}

/**
 * Decide which mode-specific branch a payload belongs to.
 * Returns null when the payload does not declare a recognised mode/type -
 * that itself is a rejection reason ("malformed mode").
 */
export function identifyMode(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.eventType === 'locationDemand') return 'demand';
  if (payload.eventType === 'telemetry') {
    if (['bus', 'tram', 'train'].includes(payload.transportMode)) return payload.transportMode;
  }
  return null;
}

/**
 * Semantic rules that JSON Schema cannot express on its own.
 * Kept short and explainable - each rule maps to a stated requirement.
 */
export function semanticChecks(mode, payload) {
  const errors = [];
  if (mode !== 'demand') {
    const { occupancy, capacity } = payload;
    if (Number.isFinite(occupancy) && Number.isFinite(capacity) && capacity > 0) {
      if (occupancy > capacity * MAX_OCCUPANCY_RATIO) {
        errors.push(
          `occupancy ${occupancy} exceeds ${MAX_OCCUPANCY_RATIO}x capacity ${capacity}`,
        );
      }
    }
    if (Number.isNaN(Date.parse(payload.timestamp))) errors.push('timestamp is not a valid date');
  } else {
    if (Number.isNaN(Date.parse(payload.timestamp))) errors.push('timestamp is not a valid date');
    if (
      Number.isFinite(payload.shelterCapacity)
      && payload.shelterCapacity > 0
      && payload.passengerCount > payload.shelterCapacity * 20
    ) {
      errors.push('passengerCount implausible for shelterCapacity');
    }
  }
  return errors;
}

/**
 * Validate a RAW event against its mode-specific schema.
 * This is the "Variety" gate: four different shapes, four different branches.
 */
export function validateRaw(payload) {
  const mode = identifyMode(payload);
  if (!mode) {
    return {
      valid: false,
      mode: null,
      errors: ['unrecognised eventType/transportMode combination'],
    };
  }
  const validate = validators[mode];
  const ok = validate(payload);
  const errors = ok ? [] : ajvErrors(validate);
  errors.push(...semanticChecks(mode, payload));
  return { valid: errors.length === 0, mode, errors };
}

/**
 * Convert an accepted raw event into the shared normalised envelope.
 * Mode-specific fields are preserved under `modeData` - normalisation makes the
 * downstream services uniform without destroying Variety.
 */
export function normalize(payload, options = {}) {
  const mode = options.mode || identifyMode(payload);
  const receivedAt = options.receivedAt || new Date().toISOString();
  const base = {
    schemaVersion: '1.0',
    eventId: payload.eventId,
    sourceEventType: payload.eventType,
    transportMode: mode,
    entityId: mode === 'demand' ? payload.locationId : payload.vehicleId,
    serviceId: payload.serviceId ?? null,
    routeId: payload.routeId ?? null,
    routeIds: payload.routeIds ?? (payload.routeId ? [payload.routeId] : []),
    locationId: payload.locationId ?? null,
    locationType: payload.locationType ?? null,
    timestamp: payload.timestamp,
    receivedAt,
    position: null,
    metrics: {},
    health: 'normal',
    demandLevel: null,
    modeData: {},
    validation: { validatedBy: options.validatedBy || 'shared/validation', branch: mode },
  };

  if (mode === 'demand') {
    return {
      ...base,
      metrics: {
        passengerCount: payload.passengerCount ?? null,
        waitingTimeSeconds: payload.waitingTimeSeconds ?? null,
      },
      health: 'normal',
      demandLevel: payload.demandLevel ?? null,
      modeData: {
        locationType: payload.locationType,
        shelterCapacity: payload.shelterCapacity ?? null,
      },
    };
  }

  return {
    ...base,
    position: { latitude: payload.latitude, longitude: payload.longitude },
    metrics: {
      speedKph: payload.speedKph ?? null,
      occupancy: payload.occupancy ?? null,
      capacity: payload.capacity ?? null,
      delaySeconds: payload.delaySeconds ?? null,
    },
    health: payload.health,
    modeData: { ...payload.modeData },
  };
}

function makeValidator(key) {
  return (obj) => {
    const validate = validators[key];
    const ok = validate(obj);
    return { valid: ok, errors: ok ? [] : ajvErrors(validate) };
  };
}

export const validateNormalized = makeValidator('normalized');
export const validateAnalysisJob = makeValidator('analysisJob');
export const validateAlert = makeValidator('alert');
export const validateNotification = makeValidator('notification');

/**
 * Crowding classification shared by the processor and the ETA worker.
 * occupancyRatio = occupancy / capacity, thresholds come from configuration.
 */
export function crowdingLevel(occupancy, capacity, thresholds = THRESHOLDS.crowding) {
  if (!Number.isFinite(occupancy) || !Number.isFinite(capacity) || capacity <= 0) return null;
  const ratio = occupancy / capacity;
  if (ratio >= thresholds.critical) return 'critical';
  if (ratio >= thresholds.high) return 'high';
  if (ratio >= thresholds.moderate) return 'moderate';
  return 'normal';
}

export function occupancyRatio(occupancy, capacity) {
  if (!Number.isFinite(occupancy) || !Number.isFinite(capacity) || capacity <= 0) return null;
  return occupancy / capacity;
}
