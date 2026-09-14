#!/usr/bin/env node
/**
 * Static CloudFormation validation.
 *
 * WHAT IT DOES
 * Runs cfn-lint over every template in infrastructure/cloudformation.
 *
 * WHY A WRAPPER
 * cfn-lint is a Python tool. `pip install --user cfn-lint` puts `cfn-lint.exe`
 * in a per-user Scripts directory that is often NOT on PATH on Windows, so
 * calling `cfn-lint` directly from an npm script fails with a confusing
 * "not recognized as an internal or external command". This tries the PATH
 * entry first and falls back to invoking the library through Python, which
 * works regardless of PATH.
 *
 * IMPORTANT: cfn-lint is entirely offline. It validates against bundled
 * resource specifications and never calls AWS, unlike
 * `aws cloudformation validate-template`, which does and is therefore not used.
 *
 * Usage: npm run lint:infra
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TEMPLATES = 'infrastructure/cloudformation';
const args = process.argv.slice(2);
const targets = args.length ? args : [`${TEMPLATES}/queues.yaml`,
  `${TEMPLATES}/dynamodb.yaml`, `${TEMPLATES}/iot-rule.yaml`,
  `${TEMPLATES}/ecs.yaml`, `${TEMPLATES}/scaling.yaml`];
if (!args.length) targets.push(`${TEMPLATES}/hd-signals.yaml`, `${TEMPLATES}/hd-predictor.yaml`);

/**
 * Invokes the cfn-lint console script if it happens to be on PATH.
 * No `shell: true` here on purpose: with a shell, a missing command exits 1 with
 * a noisy message and looks like a lint failure, whereas a direct spawn fails
 * cleanly with ENOENT so the Python fallback can be detected reliably.
 */
function viaPath() {
  return spawnSync('cfn-lint', targets, { stdio: 'inherit' });
}

/** Find Windows per-user console scripts without depending on one Python PATH. */
function installedConsoleScripts() {
  const roots = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Python') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Python') : null,
  ].filter(Boolean);
  const names = process.platform === 'win32' ? ['cfn-lint.exe', 'cfn-lint'] : ['cfn-lint'];
  return roots.flatMap((root) => {
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => names.map((name) => path.join(root, entry.name, 'Scripts', name)))
        .filter((candidate) => fs.existsSync(candidate));
    } catch {
      return [];
    }
  });
}

function viaConsoleScript(executable) {
  return spawnSync(executable, targets, { stdio: 'inherit' });
}

/** Invokes the installed library directly, bypassing PATH entirely. */
function viaPython(python) {
  const code = 'import sys; from cfnlint.runner import main; '
    + `sys.argv = ['cfn-lint'] + ${JSON.stringify(targets)}; sys.exit(main())`;
  return spawnSync(python, ['-c', code], { stdio: 'inherit' });
}

function notInstalled() {
  process.stderr.write(
    '\ncfn-lint is not installed.\n\n'
    + 'Install it locally (it is a small, offline Python tool):\n'
    + '    pip install --user cfn-lint\n\n'
    + 'It never contacts AWS. Do not substitute\n'
    + '`aws cloudformation validate-template`, which does.\n',
  );
  process.exit(127);
}

let result = viaPath();
if (result.error || result.status === 127 || result.status === 9009) {
  for (const executable of installedConsoleScripts()) {
    result = viaConsoleScript(executable);
    if (!result.error && result.status !== 127 && result.status !== 9009) break;
  }
}
if (result.error || result.status === 127 || result.status === 9009) {
  const candidates = [
    process.env.CFN_LINT_PYTHON,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python311', 'python.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python313', 'python.exe'),
    'python', 'python3', 'py',
  ].filter(Boolean);
  for (const python of candidates) {
    result = viaPython(python);
    if (!result.error && result.status !== 127 && result.status !== 9009) break;
  }
}

if (result.error || result.status === null) notInstalled();

// cfn-lint exit codes: 0 clean, 2 errors, 4 warnings, 6 informational, and
// combinations thereof. Anything non-zero is surfaced to the caller.
if (result.status === 0) process.stdout.write('cfn-lint: no findings across all templates.\n');
// Let the success line flush on Windows rather than cutting it off with an
// immediate process.exit().
process.exitCode = result.status;
