/**
 * CloudFormation template checks.
 *
 * These verify STRUCTURE and PROJECT RULES, not AWS semantics. Full semantic
 * validation needs `aws cloudformation validate-template`, which requires
 * credentials - see infrastructure/scripts/validate.ps1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFN_DIR = path.join(HERE, '..', 'cloudformation');

/** CloudFormation short-form intrinsics are custom YAML tags. */
const INTRINSICS = [
  'Ref', 'Sub', 'GetAtt', 'Join', 'Split', 'Select', 'ImportValue', 'If', 'Equals',
  'Not', 'And', 'Or', 'Condition', 'FindInMap', 'Base64', 'Cidr', 'GetAZs', 'Transform',
];
const customTags = INTRINSICS.flatMap((name) => [
  { tag: `!${name}`, collection: 'seq', resolve: (v) => v },
  { tag: `!${name}`, resolve: (v) => v },
]);

const templates = Object.fromEntries(
  fs.readdirSync(CFN_DIR).filter((f) => f.endsWith('.yaml')).map((f) => [
    f, YAML.parse(fs.readFileSync(path.join(CFN_DIR, f), 'utf8'), { customTags }),
  ]),
);

test('every template parses and declares a version, description and resources', () => {
  assert.ok(Object.keys(templates).length >= 5, 'expected at least five templates');
  for (const [name, doc] of Object.entries(templates)) {
    assert.equal(doc.AWSTemplateFormatVersion, '2010-09-09', `${name}: missing version`);
    assert.ok(doc.Description?.length > 40, `${name}: needs an explanatory description`);
    assert.ok(Object.keys(doc.Resources || {}).length > 0, `${name}: no resources`);
  }
});

test('no template hard-codes an account id, region or credential', () => {
  for (const file of Object.keys(templates)) {
    const text = fs.readFileSync(path.join(CFN_DIR, file), 'utf8');
    assert.ok(!/\b\d{12}\b/.test(text), `${file}: looks like a hard-coded AWS account id`);
    assert.ok(!/AKIA[0-9A-Z]{16}/.test(text), `${file}: looks like an access key id`);
    assert.ok(!/aws_secret_access_key/i.test(text), `${file}: mentions a secret key`);
    // Regions must come from AWS::Region or a parameter, never be baked in.
    assert.ok(!/['"](us|eu|ap)-[a-z]+-\d['"]/.test(text), `${file}: hard-coded region`);
  }
});

test('every resource name is derived from the project prefix', () => {
  for (const [name, doc] of Object.entries(templates)) {
    assert.ok(doc.Parameters?.ResourcePrefix, `${name}: missing ResourcePrefix parameter`);
    assert.equal(doc.Parameters.ResourcePrefix.Default,
      name.startsWith('hd-') ? 'sit314-hd-transport' : 'sit314-transport');
  }
});

test('queues: every working queue has a DLQ and a finite redrive policy', () => {
  const doc = templates['queues.yaml'];
  const working = ['TelemetryQueue', 'AnalysisQueue', 'NotificationsQueue'];
  for (const key of working) {
    const q = doc.Resources[key];
    assert.ok(q, `missing ${key}`);
    assert.ok(q.Properties.RedrivePolicy, `${key}: no redrive policy`);
    assert.ok(q.Properties.RedrivePolicy.deadLetterTargetArn, `${key}: no DLQ target`);
    assert.ok(q.Properties.ReceiveMessageWaitTimeSeconds > 0, `${key}: long polling not enabled`);
    assert.ok(q.Properties.SqsManagedSseEnabled === true, `${key}: encryption at rest not enabled`);
  }
  for (const key of ['TelemetryDlq', 'AnalysisDlq', 'NotificationsDlq']) {
    assert.ok(doc.Resources[key], `missing ${key}`);
  }
  const max = doc.Parameters.MaxReceiveCount;
  assert.ok(max.Default >= 1 && max.Default <= 10, 'maxReceiveCount must be finite and small');
});

test('dynamodb: on-demand billing, single keys, and the documented partition keys', () => {
  const doc = templates['dynamodb.yaml'];
  const expected = {
    ProcessedEventsTable: 'eventId',
    CurrentStateTable: 'entityId',
    AnalysisResultsTable: 'jobId',
    NotificationsTable: 'notificationId',
  };
  for (const [resource, key] of Object.entries(expected)) {
    const table = doc.Resources[resource];
    assert.ok(table, `missing ${resource}`);
    assert.equal(table.Properties.BillingMode, 'PAY_PER_REQUEST', `${resource}: must be on-demand`);
    assert.equal(table.Properties.KeySchema.length, 1, `${resource}: keep it a single-key table`);
    assert.equal(table.Properties.KeySchema[0].AttributeName, key);
    assert.equal(table.Properties.SSESpecification.SSEEnabled, true);
  }
  // The idempotency ledger should expire its own records.
  assert.equal(doc.Resources.ProcessedEventsTable.Properties.TimeToLiveSpecification.Enabled, true);
  const resultIndex = doc.Resources.AnalysisResultsTable.Properties.GlobalSecondaryIndexes?.[0];
  assert.equal(resultIndex?.IndexName, 'SourceEventIdIndex');
  assert.equal(resultIndex?.KeySchema?.[0]?.AttributeName, 'sourceEventId');
});

test('ecs: smallest Fargate size, no load balancer, no NAT-dependent design', () => {
  const doc = templates['ecs.yaml'];
  assert.equal(doc.Parameters.TaskCpu.Default, '256', 'use the smallest sensible task size');
  assert.equal(doc.Parameters.TaskMemory.Default, '512');
  assert.equal(doc.Parameters.RouteImpactDesiredCount.Default, 1,
    'services must start at the autoscaling minimum');

  const text = fs.readFileSync(path.join(CFN_DIR, 'ecs.yaml'), 'utf8');
  assert.ok(!/AWS::ElasticLoadBalancingV2/.test(text), 'queue workers must not need a load balancer');
  assert.ok(!/AWS::EC2::NatGateway/.test(text), 'a NAT gateway would dominate the project cost');

  // Restricted-account compatibility: roles must be overridable.
  assert.ok(doc.Parameters.ExistingExecutionRoleArn, 'must accept an existing execution role');
  assert.ok(doc.Parameters.ExistingTaskRoleArn, 'must accept an existing task role');

  const sg = doc.Resources.WorkerSecurityGroup;
  assert.ok(!sg.Properties.SecurityGroupIngress, 'workers must accept no inbound traffic');
});

test('ecs: no IAM users are ever created', () => {
  for (const [name, doc] of Object.entries(templates)) {
    for (const [resName, res] of Object.entries(doc.Resources || {})) {
      assert.notEqual(res.Type, 'AWS::IAM::User', `${name}/${resName}: IAM users are forbidden`);
      assert.notEqual(res.Type, 'AWS::IAM::AccessKey',
        `${name}/${resName}: long-lived access keys are forbidden`);
    }
  }
});

test('scaling: min 1, max 5, on the route-impact service', () => {
  const doc = templates['scaling.yaml'];
  assert.equal(doc.Parameters.MinTasks.Default, 1);
  assert.equal(doc.Parameters.MaxTasks.Default, 5);
  assert.equal(doc.Parameters.MaxTasks.MaxValue, 5, 'cost cap must be enforced by the template');

  const target = doc.Resources.RouteImpactScalableTarget;
  assert.equal(target.Properties.ServiceNamespace, 'ecs');
  assert.equal(target.Properties.ScalableDimension, 'ecs:service:DesiredCount');

  const policy = doc.Resources.BacklogPerTaskPolicy;
  assert.equal(policy.Properties.PolicyType, 'TargetTrackingScaling');
  const spec = policy.Properties.TargetTrackingScalingPolicyConfiguration;
  assert.equal(spec.CustomizedMetricSpecification.MetricName, 'BacklogPerTask');
  assert.equal(spec.DisableScaleIn, false, 'the service must be able to scale back in');
  // The cooldowns are !Ref parameters, so assert on the parameter defaults.
  assert.ok(
    doc.Parameters.ScaleInCooldown.Default > doc.Parameters.ScaleOutCooldown.Default,
    'scale in more slowly than out, to avoid oscillation',
  );

  // The fallback must exist and must be clearly labelled as a different signal.
  assert.ok(doc.Resources.QueueDepthPolicy, 'the restricted-account fallback is required');
  assert.equal(
    doc.Resources.QueueDepthPolicy.Properties.TargetTrackingScalingPolicyConfiguration
      .CustomizedMetricSpecification.MetricName,
    'ApproximateNumberOfMessagesVisible',
  );
});

test('scaling: fast BacklogPerTask step-out accelerates scale-out only', () => {
  const doc = templates['scaling.yaml'];
  const targetTracking = doc.Resources.BacklogPerTaskPolicy;
  const trackingSpec = targetTracking.Properties.TargetTrackingScalingPolicyConfiguration;
  assert.equal(targetTracking.Properties.PolicyType, 'TargetTrackingScaling');
  assert.equal(trackingSpec.TargetValue, 'TargetBacklogPerTask',
    'the original target-tracking target must remain unchanged');
  assert.equal(trackingSpec.DisableScaleIn, false,
    'target tracking must retain responsibility for scale-in');

  const alarm = doc.Resources.FastBacklogScaleOutAlarm;
  assert.equal(alarm.Type, 'AWS::CloudWatch::Alarm');
  assert.equal(alarm.Condition, 'UseBacklogPerTask');
  assert.equal(alarm.Properties.Namespace, 'MetricNamespace');
  assert.equal(alarm.Properties.MetricName, 'BacklogPerTask');
  assert.deepEqual(alarm.Properties.Dimensions, [{
    Name: 'ServiceName',
    Value: { 'Fn::ImportValue': '${EcsStackName}-RouteImpactServiceName' },
  }]);
  assert.equal(alarm.Properties.Statistic, 'Average');
  assert.equal(alarm.Properties.Period, 60);
  assert.equal(alarm.Properties.EvaluationPeriods, 1);
  assert.equal(alarm.Properties.DatapointsToAlarm, 1);
  assert.equal(alarm.Properties.Threshold, 'TargetBacklogPerTask');
  assert.equal(alarm.Properties.ComparisonOperator, 'GreaterThanThreshold');
  assert.equal(alarm.Properties.TreatMissingData, 'notBreaching');
  assert.deepEqual(alarm.Properties.AlarmActions, ['FastBacklogScaleOutPolicy']);

  const policy = doc.Resources.FastBacklogScaleOutPolicy;
  assert.equal(policy.Type, 'AWS::ApplicationAutoScaling::ScalingPolicy');
  assert.equal(policy.Condition, 'UseBacklogPerTask');
  assert.equal(policy.Properties.PolicyType, 'StepScaling');
  assert.equal(policy.Properties.ScalingTargetId, 'RouteImpactScalableTarget');
  const step = policy.Properties.StepScalingPolicyConfiguration;
  assert.equal(step.AdjustmentType, 'ChangeInCapacity');
  assert.equal(step.MetricAggregationType, 'Average');
  assert.equal(step.Cooldown, 60);
  assert.deepEqual(step.StepAdjustments, [{
    MetricIntervalLowerBound: 0,
    ScalingAdjustment: 4,
  }]);

  const stepPolicies = Object.entries(doc.Resources)
    .filter(([, resource]) => resource.Type === 'AWS::ApplicationAutoScaling::ScalingPolicy'
      && resource.Properties.PolicyType === 'StepScaling');
  assert.deepEqual(stepPolicies.map(([name]) => name), ['FastBacklogScaleOutPolicy']);
  assert.ok(stepPolicies[0][1].Properties.StepScalingPolicyConfiguration.StepAdjustments
    .every((adjustment) => adjustment.ScalingAdjustment > 0),
  'no step-scaling scale-in policy or negative adjustment may be added');
});

test('scaling: the backlog metric is computed as visible messages per running task', () => {
  const text = fs.readFileSync(path.join(CFN_DIR, 'scaling.yaml'), 'utf8');
  assert.match(text, /visible \/ running/, 'the backlog formula must be visible in the Lambda');
  assert.match(text, /Math\.max\(svc\.services\?\.\[0\]\?\.runningCount \?\? 0, 1\)/,
    'running task count must be clamped to avoid divide-by-zero');
  assert.match(text, /rate\(1 minute\)/, 'the metric must be published frequently enough to scale on');
});

test('iot rule: forwards the normalised topic to the telemetry queue', () => {
  const doc = templates['iot-rule.yaml'];
  const payload = doc.Resources.NormalisedToTelemetryQueueRule.Properties.TopicRulePayload;
  assert.match(payload.Sql, /transport\/normalized\/\+/);
  assert.equal(payload.RuleDisabled, false);
  assert.ok(payload.Actions[0].Sqs, 'the rule action must deliver to SQS');
  assert.ok(payload.ErrorAction, 'rule failures must be recorded, not dropped');
  assert.ok(doc.Parameters.ExistingIotRuleRoleArn, 'must accept an existing role');
  const policies = doc.Resources.IotRuleRole.Properties.Policies;
  const errorPolicy = policies.find((policy) => policy.PolicyName === 'WriteRuleErrors');
  assert.ok(errorPolicy, 'generated role must permit its CloudWatch Logs ErrorAction');
  const actions = errorPolicy.PolicyDocument.Statement.flatMap((statement) => statement.Action);
  assert.ok(actions.includes('logs:CreateLogStream'));
  assert.ok(actions.includes('logs:PutLogEvents'));
});

test('every template tags its resources for the project', () => {
  for (const [name, doc] of Object.entries(templates)) {
    const text = fs.readFileSync(path.join(CFN_DIR, name), 'utf8');
    assert.match(text, name.startsWith('hd-') ? /SIT314-HD-Transport-IoT/ : /SIT314-Transport-IoT/,
      `${name}: resources must carry the project tag`);
  }
});

// ---------------------------------------------------------------- deployability

test('every template Description is within the CloudFormation 1024-char limit', () => {
  // A longer Description is rejected at create-stack time, so this is a deploy
  // blocker rather than a style issue.
  for (const [name, doc] of Object.entries(templates)) {
    const length = String(doc.Description ?? '').length;
    assert.ok(length <= 1024, `${name}: Description is ${length} chars, limit is 1024`);
  }
});

/** Walks a parsed template collecting every Fn::ImportValue string. */
function collectImports(node, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectImports(item, found);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'Fn::ImportValue' && typeof value === 'string') found.push(value);
      else collectImports(value, found);
    }
  }
  return found;
}

/** Export names declared by a template, as `${AWS::StackName}-<suffix>` suffixes. */
function collectExports(doc) {
  const suffixes = new Set();
  for (const output of Object.values(doc.Outputs || {})) {
    const name = output?.Export?.Name;
    if (typeof name !== 'string') continue;
    const match = name.match(/^\$\{AWS::StackName\}-(.+)$/);
    if (match) suffixes.add(match[1]);
  }
  return suffixes;
}

test('every cross-stack import is matched by an export in the producing stack', () => {
  // The stacks are deployed in dependency order and pass values by export name.
  // A typo here only surfaces as a failed create-stack, so it is checked here.
  const producedBy = {
    QueuesStackName: 'queues.yaml',
    TablesStackName: 'dynamodb.yaml',
    EcsStackName: 'ecs.yaml',
    HdSignalsStackName: 'hd-signals.yaml',
    SignalsStackName: 'hd-signals.yaml',
  };
  const exportsByTemplate = Object.fromEntries(
    Object.entries(templates).map(([name, doc]) => [name, collectExports(doc)]),
  );

  let checked = 0;
  for (const [name, doc] of Object.entries(templates)) {
    for (const imported of collectImports(doc)) {
      const match = imported.match(/^\$\{(\w+)\}-(.+)$/);
      assert.ok(match, `${name}: import "${imported}" is not of the form \${StackNameParam}-Suffix`);
      const [, param, suffix] = match;
      const source = producedBy[param];
      assert.ok(source, `${name}: import uses unknown stack parameter ${param}`);
      assert.ok(
        doc.Parameters?.[param],
        `${name}: imports \${${param}} but does not declare it as a parameter`,
      );
      assert.ok(
        exportsByTemplate[source].has(suffix),
        `${name}: imports ${suffix} from ${param}, but ${source} does not export it`,
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 10, `expected the stacks to be linked by imports, found ${checked}`);
});
