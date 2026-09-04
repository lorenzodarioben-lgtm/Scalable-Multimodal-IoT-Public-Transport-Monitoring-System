/**
 * Key/value store abstraction (DynamoDB, or a local file-backed equivalent).
 *
 * What: four operations the pipeline needs -
 *       put()          unconditional write
 *       putIfAbsent()  conditional write, fails if the key already exists
 *       putIfNewer()   conditional write, fails if stored timestamp is newer
 *       get()/scan()   reads used by evidence and dashboards
 * Why:  idempotency is the reason this project can retry safely. Every stage
 *       writes with a conditional expression keyed on a unique id
 *       (eventId / jobId / notificationId), so a message redelivered by SQS -
 *       which WILL happen, SQS is at-least-once - cannot produce duplicate
 *       downstream work. putIfNewer() additionally stops an out-of-order
 *       telemetry event from overwriting fresher vehicle state.
 *
 * The DynamoDB implementation uses:
 *   putIfAbsent -> ConditionExpression: attribute_not_exists(<pk>)
 *   putIfNewer  -> ConditionExpression: attribute_not_exists(<pk>) OR #ts < :ts
 * and treats ConditionalCheckFailedException as "already handled", not an error.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BACKENDS, LOCAL_DATA_DIR, REGION, TABLES } from '../config/index.js';
import { sleep } from '../util/index.js';

/** Partition key for each table. Simple, single-key tables are easy to explain. */
export const TABLE_KEYS = {
  [TABLES.processedEvents]: 'eventId',
  [TABLES.currentState]: 'entityId',
  [TABLES.analysisResults]: 'jobId',
  [TABLES.notifications]: 'notificationId',
};

export function keyNameFor(table) {
  return TABLE_KEYS[table] || 'id';
}

const safe = (value) => String(value).replace(/[^A-Za-z0-9._-]/g, '_');

class LocalStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.writes = 0;
    this.conditionalFailures = 0;
  }

  #dir(table) {
    const dir = path.join(this.baseDir, table);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  #file(table, key) {
    return path.join(this.#dir(table), `${safe(key)}.json`);
  }

  async put(table, item) {
    const key = item[keyNameFor(table)];
    await fsp.writeFile(this.#file(table, key), JSON.stringify(item, null, 0), 'utf8');
    this.writes += 1;
    return { written: true };
  }

  /** Exclusive create ('wx') is the local analogue of attribute_not_exists. */
  async putIfAbsent(table, item) {
    const key = item[keyNameFor(table)];
    try {
      await fsp.writeFile(this.#file(table, key), JSON.stringify(item), { flag: 'wx' });
      this.writes += 1;
      return { written: true };
    } catch (err) {
      if (err.code === 'EEXIST') {
        this.conditionalFailures += 1;
        return { written: false, reason: 'alreadyExists' };
      }
      throw err;
    }
  }

  /** Guarded read-modify-write; the lock file makes it safe across processes. */
  async putIfNewer(table, item, timestampField = 'timestamp') {
    const key = item[keyNameFor(table)];
    const file = this.#file(table, key);
    const lock = `${file}.lock`;
    const release = await acquireLock(lock);
    try {
      let existing = null;
      try {
        existing = JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch { /* first write */ }
      if (existing) {
        const prev = Date.parse(existing[timestampField] ?? 0);
        const next = Date.parse(item[timestampField] ?? 0);
        if (Number.isFinite(prev) && Number.isFinite(next) && next <= prev) {
          this.conditionalFailures += 1;
          return { written: false, reason: 'staleTimestamp', existing };
        }
      }
      await fsp.writeFile(file, JSON.stringify(item), 'utf8');
      this.writes += 1;
      return { written: true, existing };
    } finally {
      await release();
    }
  }

  async get(table, key) {
    try {
      return JSON.parse(await fsp.readFile(this.#file(table, key), 'utf8'));
    } catch {
      return null;
    }
  }

  async scan(table, { limit = 100 } = {}) {
    const dir = this.#dir(table);
    const files = (await fsp.readdir(dir).catch(() => []))
      .filter((f) => f.endsWith('.json'))
      .slice(0, limit);
    const items = [];
    for (const f of files) {
      try {
        items.push(JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')));
      } catch { /* skip partial */ }
    }
    return items;
  }

  async count(table) {
    const dir = this.#dir(table);
    const files = await fsp.readdir(dir).catch(() => []);
    return files.filter((f) => f.endsWith('.json')).length;
  }
}

async function acquireLock(lockPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await fsp.open(lockPath, 'wx');
      await handle.close();
      return async () => { await fsp.unlink(lockPath).catch(() => {}); };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        // Stale lock from a killed process - take it over.
        await fsp.unlink(lockPath).catch(() => {});
        continue;
      }
      await sleep(5);
    }
  }
}

class DynamoStore {
  constructor(region, { documentClient = null, sdk = null } = {}) {
    this.region = region;
    this.writes = 0;
    this.conditionalFailures = 0;
    this._doc = documentClient;
    this._sdk = sdk;
  }

  async #doc() {
    if (!this._doc) {
      const core = await import('@aws-sdk/client-dynamodb');
      const lib = await import('@aws-sdk/lib-dynamodb');
      this._sdk = lib;
      this._doc = lib.DynamoDBDocumentClient.from(
        new core.DynamoDBClient({ region: this.region }),
        { marshallOptions: { removeUndefinedValues: true } },
      );
    }
    return { doc: this._doc, lib: this._sdk };
  }

  async put(table, item) {
    const { doc, lib } = await this.#doc();
    await doc.send(new lib.PutCommand({ TableName: table, Item: item }));
    this.writes += 1;
    return { written: true };
  }

  async putIfAbsent(table, item) {
    const { doc, lib } = await this.#doc();
    const key = keyNameFor(table);
    try {
      await doc.send(new lib.PutCommand({
        TableName: table,
        Item: item,
        ConditionExpression: 'attribute_not_exists(#pk)',
        ExpressionAttributeNames: { '#pk': key },
      }));
      this.writes += 1;
      return { written: true };
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        this.conditionalFailures += 1;
        return { written: false, reason: 'alreadyExists' };
      }
      throw err;
    }
  }

  async putIfNewer(table, item, timestampField = 'timestamp') {
    const { doc, lib } = await this.#doc();
    const key = keyNameFor(table);
    try {
      await doc.send(new lib.PutCommand({
        TableName: table,
        Item: item,
        ConditionExpression: 'attribute_not_exists(#pk) OR #ts < :ts',
        ExpressionAttributeNames: { '#pk': key, '#ts': timestampField },
        ExpressionAttributeValues: { ':ts': item[timestampField] },
      }));
      this.writes += 1;
      return { written: true };
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        this.conditionalFailures += 1;
        return { written: false, reason: 'staleTimestamp' };
      }
      throw err;
    }
  }

  async get(table, key) {
    const { doc, lib } = await this.#doc();
    const out = await doc.send(new lib.GetCommand({
      TableName: table,
      Key: { [keyNameFor(table)]: key },
    }));
    return out.Item ?? null;
  }

  async scan(table, { limit = 100 } = {}) {
    const { doc, lib } = await this.#doc();
    const out = await doc.send(new lib.ScanCommand({ TableName: table, Limit: limit }));
    return out.Items ?? [];
  }

  async count(table) {
    const { doc, lib } = await this.#doc();
    let count = 0;
    let exclusiveStartKey;
    do {
      const out = await doc.send(new lib.ScanCommand({
        TableName: table,
        Select: 'COUNT',
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }));
      count += out.Count ?? 0;
      exclusiveStartKey = out.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return count;
  }

  /** Counts a run's results through a GSI without a table-wide Scan. */
  async countByIndex(table, { indexName, keyName, keyValue }) {
    const { doc, lib } = await this.#doc();
    let count = 0;
    let exclusiveStartKey;
    do {
      const out = await doc.send(new lib.QueryCommand({
        TableName: table,
        IndexName: indexName,
        Select: 'COUNT',
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': keyName },
        ExpressionAttributeValues: { ':pk': keyValue },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }));
      count += out.Count ?? 0;
      exclusiveStartKey = out.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return count;
  }
}

let singleton = null;

export function getStore(options = {}) {
  const backend = options.backend || BACKENDS.store;
  if (options.fresh || !singleton) {
    const store = backend === 'aws' || backend === 'dynamodb'
      ? new DynamoStore(options.region || REGION)
      : new LocalStore(options.baseDir || path.join(LOCAL_DATA_DIR, 'tables'));
    if (options.fresh) return store;
    singleton = store;
  }
  return singleton;
}

export { LocalStore, DynamoStore };
