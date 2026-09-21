import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('HD CloudFormation templates restrict resource prefixes and import only supplied HD stacks', () => {
  for (const name of ['hd-code', 'hd-signals', 'hd-predictor']) {
    const source = read(`infrastructure/cloudformation/${name}.yaml`);
    assert.match(source, /Default: sit314-hd-transport/);
    assert.match(source, /AllowedPattern: '\^sit314-hd-/);
    assert.doesNotMatch(source, /Default: sit314-transport(?:\s|$)/m);
  }
});

test('HD deployment/image/mode wrappers require explicit switches before AWS and fix the HD prefix', () => {
  for (const [file, switchName] of [
    ['deploy-hd.ps1', 'ExecuteHdDeployment'],
    ['build-hd-image.ps1', 'ExecuteHdImagePush'],
    ['set-hd-mode.ps1', 'ExecuteHdModeChange'],
    ['invoke-hd-run.ps1', 'ExecuteHdRun'],
  ]) {
    const source = read(`infrastructure/scripts/${file}`);
    assert.ok(source.includes(`if (-not $${switchName})`));
    assert.match(source, /sit314-hd-transport/);
    assert.doesNotMatch(source, /-Prefix 'sit314-transport'/);
  }
  assert.match(read('infrastructure/scripts/deploy-hd.ps1'), /Prefix = \$hdPrefix/);
  assert.match(read('infrastructure/scripts/build-hd-image.ps1'), /-Prefix 'sit314-hd-transport'/);
  assert.match(read('experiments/hd/aws/run-hd-aws-experiment.js'), /HD-only resource prefix required/);
});

test('optional HD notification consumer is guarded by its exact image repository and digest', () => {
  const build = read('infrastructure/scripts/build-hd-image.ps1');
  const deploy = read('infrastructure/scripts/deploy-hd.ps1');
  assert.match(build, /ValidateSet\('route-impact-worker', 'notification-worker'\)/);
  assert.match(build, /-Services @\(\$Service\)/);
  assert.match(deploy, /\$hdPrefix-notification-worker:/);
  assert.match(deploy, /HD notification image has no verified ECR digest/);
  assert.match(deploy, /\$arguments\.NotificationWorkerImage = \$NotificationWorkerImage/);
  assert.match(deploy, /\$arguments\.WhatIfOnly = \$true/);
});
