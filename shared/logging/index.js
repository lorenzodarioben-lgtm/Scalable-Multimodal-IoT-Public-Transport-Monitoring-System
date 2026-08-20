/**
 * Structured logging with an evidence-friendly console format.
 *
 * What: every service logs one JSON object per significant event to a log file
 *       (machine readable, this is what CloudWatch Logs Insights would query)
 *       and a short human-readable line to the console (screenshot friendly).
 * Why:  the university report needs readable screenshots, while the experiment
 *       runner needs parsable records. Doing both avoids a trade-off.
 */
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

export function createLogger(service, options = {}) {
  const level = LEVELS[(options.level || process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 20;
  const jsonFile = options.jsonFile || process.env.LOG_JSON_FILE || null;
  const quiet = options.quiet ?? process.env.LOG_QUIET === 'true';
  let stream = null;
  if (jsonFile) {
    ensureDir(jsonFile);
    stream = fs.createWriteStream(jsonFile, { flags: 'a' });
  }

  function emit(lvl, tag, fields = {}, humanLine = null) {
    if (LEVELS[lvl] < level) return;
    const record = { timestamp: new Date().toISOString(), service, level: lvl, tag, ...fields };
    if (stream) stream.write(`${JSON.stringify(record)}\n`);
    if (quiet) return;
    const line = humanLine ?? formatHuman(tag, fields);
    if (lvl === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  return {
    service,
    debug: (tag, fields, human) => emit('debug', tag, fields, human),
    info: (tag, fields, human) => emit('info', tag, fields, human),
    warn: (tag, fields, human) => emit('warn', tag, fields, human),
    error: (tag, fields, human) => emit('error', tag, fields, human),
    /** Multi-line block used for incidents - deliberately easy to screenshot. */
    block: (tag, fields) => {
      const body = Object.entries(fields)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `  ${k}=${v}`)
        .join('\n');
      emit('info', tag, fields, `[${tag}]\n${body}`);
    },
    close: () => new Promise((resolve) => (stream ? stream.end(resolve) : resolve())),
  };
}

function formatHuman(tag, fields) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
    .map(([k, v]) => `${k}=${v}`);
  return `[${tag}] ${parts.join(' ')}`.trimEnd();
}

/** Banner used at the top of every long-running process. Screenshot friendly. */
export function banner(title, rows) {
  const width = 60;
  const lines = ['='.repeat(width), title.toUpperCase(), '='.repeat(width)];
  for (const [k, v] of Object.entries(rows)) {
    if (v === undefined || v === null) continue;
    lines.push(`${(`${k}:`).padEnd(22)}${v}`);
  }
  lines.push('='.repeat(width));
  return lines.join('\n');
}
