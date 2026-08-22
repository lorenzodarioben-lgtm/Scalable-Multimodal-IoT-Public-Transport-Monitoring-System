/**
 * Minimal Node-RED flow executor used by the tests.
 *
 * What: loads node-red/flows.json, and runs messages through the real function
 *       node code following the real `wires` connections.
 * Why:  the Node-RED flow is a deployed component of the architecture, so its
 *       logic has to be tested rather than assumed. Executing the exact `func`
 *       strings from flows.json means the tests cannot drift from what Node-RED
 *       actually runs, and no Node-RED runtime is required in CI.
 *
 * It supports only what this flow uses: function nodes with multiple outputs,
 * plus mqtt-out/debug nodes treated as terminals that capture the message.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FLOWS_PATH = path.join(HERE, '..', 'flows.json');

export function loadFlows() {
  return JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
}

export class FlowRunner {
  constructor(flows = loadFlows()) {
    this.flows = flows;
    this.byId = new Map(flows.map((n) => [n.id, n]));
    this.warnings = [];
    this.errors = [];
    this.statuses = [];
  }

  node(idOrName) {
    return this.byId.get(idOrName) || this.flows.find((n) => n.name === idOrName);
  }

  /** Builds the sandboxed callable for one function node. */
  #compile(node) {
    const runner = this;
    const nodeApi = {
      warn: (m) => runner.warnings.push(String(m)),
      error: (m) => runner.errors.push(String(m)),
      log: () => {},
      debug: () => {},
      status: (s) => runner.statuses.push(s),
      send: () => {},
      done: () => {},
    };
    // eslint-disable-next-line no-new-func -- executing the flow's own code is the point
    const compiled = new Function('msg', 'node', 'flow', 'global', 'RED', 'context', 'env', node.func);
    const ctx = new Map();
    const store = {
      get: (k) => ctx.get(k),
      set: (k, v) => ctx.set(k, v),
    };
    return (msg) => compiled(msg, nodeApi, store, store, {}, store, { get: (k) => process.env[k] });
  }

  /**
   * Run one message from a starting node and return every terminal message,
   * keyed by terminal node name.
   * @returns {{terminals: Record<string, object[]>, visited: string[]}}
   */
  run(startId, message) {
    const terminals = {};
    const visited = [];
    const queue = [{ id: startId, msg: message }];

    while (queue.length) {
      const { id, msg } = queue.shift();
      const node = this.node(id);
      if (!node) throw new Error(`unknown node: ${id}`);
      visited.push(node.name || node.id);

      if (node.type !== 'function') {
        // mqtt out / debug: terminal for the purposes of these tests.
        const key = node.name || node.id;
        (terminals[key] ||= []).push(msg);
        continue;
      }

      const result = this.#compile(node)(msg);
      const outputs = Array.isArray(result) ? result : [result];
      outputs.forEach((out, index) => {
        if (!out) return;
        for (const next of node.wires[index] || []) queue.push({ id: next, msg: out });
      });
    }
    return { terminals, visited };
  }

  /** Runs a raw MQTT payload through the whole flow from the ingest node. */
  ingest(payload, topic = 'transport/raw/bus/BUS-001') {
    this.warnings = [];
    this.errors = [];
    this.statuses = [];
    return this.run('keep-raw-topic', { topic, payload: structuredClone(payload) });
  }
}

export default FlowRunner;
