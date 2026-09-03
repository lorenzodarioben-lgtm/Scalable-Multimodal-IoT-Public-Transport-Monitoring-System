/** File-backed, machine-readable evidence emitted by each AWS experiment run. */
import fs from 'node:fs';
import path from 'node:path';

export function createAwsArtifactWriter(runDir) {
  const logsDir = path.join(runDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const samplesPath = path.join(runDir, 'samples.jsonl');

  return {
    runDir,
    logsDir,
    samplesPath,
    writeJson(name, value) {
      fs.writeFileSync(path.join(runDir, name), `${JSON.stringify(value, null, 2)}\n`);
    },
    appendSample(sample) {
      fs.appendFileSync(samplesPath, `${JSON.stringify(sample)}\n`);
    },
    writeLogReference(value) {
      fs.writeFileSync(path.join(logsDir, 'references.json'), `${JSON.stringify(value, null, 2)}\n`);
    },
    appendLogEvent(event) {
      fs.appendFileSync(path.join(logsDir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
    },
  };
}
