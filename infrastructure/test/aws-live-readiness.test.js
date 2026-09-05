import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('ECR push workflow verifies repositories and image digests before ECS deployment', () => {
  const push = read('infrastructure/scripts/build-and-push.ps1');
  const deploy = read('infrastructure/scripts/deploy.ps1');
  assert.ok(push.indexOf('Ensure-EcrRepository') < push.indexOf('Login-DockerToEcr'));
  assert.ok(push.indexOf('Login-DockerToEcr') < push.indexOf('docker build'));
  assert.match(push, /ecr describe-images/);
  assert.match(deploy, /function Assert-RouteImpactImageExists/);
  assert.match(deploy, /Assert-RouteImpactImageExists -ImageUri \$RouteImpactImage/);
});

test('AWS guidance uses genuine UTC and rejects alarm-state simulation as evidence', () => {
  const runbook = read('docs/AWS_DEPLOYMENT.md');
  const scripts = [
    read('infrastructure/scripts/aws-academy-preflight.ps1'),
    read('experiments/aws/control-plane.js'),
    read('experiments/aws/runner.js'),
  ].join('\n');
  assert.match(runbook, /\[DateTime\]::UtcNow/);
  assert.doesNotMatch(runbook, /\(Get-Date\).*ToString\([^\n]*Z/);
  assert.match(runbook, /set-alarm-state/);
  assert.doesNotMatch(scripts, /describe-log-streams[\s\S]*LastEventTime/i);
});

test('Academy preflight is explicitly read-only and checks the service-linked-role risk', () => {
  const preflight = read('infrastructure/scripts/aws-academy-preflight.ps1');
  assert.match(preflight, /read-only/i);
  assert.match(preflight, /AWSServiceRoleForApplicationAutoScaling_ECSService/);
  assert.match(preflight, /ecs-tasks\.amazonaws\.com/);
  assert.match(preflight, /iot\.amazonaws\.com/);
  assert.match(preflight, /lambda\.amazonaws\.com/);
  assert.match(preflight, /simulate-principal-policy/);
  assert.match(preflight, /logs:CreateLogStream/);
  assert.match(preflight, /logs:PutLogEvents/);
  assert.doesNotMatch(preflight, /create-role|create-service-linked-role|create-stack|register-scalable-target/i);
});
