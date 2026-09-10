# AWS recovery handoff

Last updated: 2026-09-22. This replaces the superseded pre-AWS handoff. It is an
evidence-preserving checkpoint after the Academy credentials were cancelled.

## Repository checkpoint

- Branch: `prep/aws-experiment-readiness`
- HEAD: `5000b68` — `fix: harden AWS experiment injection timing`
- Latest relevant commits:
  - `5000b68 fix: harden AWS experiment injection timing`
  - `691f9dd chore: prepare 3-second AWS calibration`
  - `a94bb26 fix: start AWS workload timing after preflight`
  - `c6aeab7 fix: pass ECS subnet lists to CloudFormation`
  - `901e4d2 fix: use valid SQS queue attributes`
  - `4a9f00d docs: add AWS workload calibration gate`
  - `7ae4ccb fix: harden local compose smoke guidance`
  - `50f3837 chore: harden AWS preflight and deployment safeguards`
- Working tree at this checkpoint: only the intentionally untracked
  `ISSUESANDSOLUTIONS.md` and `Tasks/` paths. Do not add, edit, or delete them.
- `npm test`: 184 passing tests.
- `npm run lint:infra`: passing.
- `git diff --check`: passing.

## AWS resources already deployed

The following was completed in account `371985210444`, region `us-east-1`, using
the Academy profile and LabRole
`arn:aws:iam::371985210444:role/LabRole`:

- CloudFormation stacks: `sit314-transport-queues`, `sit314-transport-tables`,
  `sit314-transport-iot-rule`, `sit314-transport-ecs`, and
  `sit314-transport-scaling`.
- SQS working queues and DLQs: `sit314-transport-telemetry`,
  `sit314-transport-analysis`, `sit314-transport-notifications`, and their
  respective `-dlq` queues.
- DynamoDB tables: `sit314-transport-processed-events`,
  `sit314-transport-current-state`, `sit314-transport-analysis-results`, and
  `sit314-transport-notifications`.
- IoT rule `sit314_transport_normalized_to_telemetry`, forwarding
  `transport/normalized/+` to the telemetry queue; error logs use
  `/aws/iot/sit314-transport-rule-errors`.
- ECR repository `sit314-transport-route-impact-worker` and the verified
  route-impact image used by ECS.
- ECS/Fargate cluster `sit314-transport-cluster` and route-impact service
  `sit314-transport-route-impact`; its log group is
  `/ecs/sit314-transport-route-impact`.
- Application Auto Scaling target and target-tracking policy
  `sit314-transport-backlog-per-task` for
  `service/sit314-transport-cluster/sit314-transport-route-impact`, using
  `SIT314/Transport:BacklogPerTask` with dimension
  `ServiceName=sit314-transport-route-impact`.
- Backlog metric Lambda `sit314-transport-backlog-metric` and enabled EventBridge
  rule `sit314-transport-backlog-metric-schedule` (one-minute schedule), plus the
  CloudWatch Logs resources and analysis-DLQ alarm.

No topology expansion was introduced: no load balancer, NAT gateway, private
subnet complexity, Cloud Map, VPC endpoint, SSM, or Secrets Manager.

## Credential failure and current live-state limitation

Academy credentials were cancelled with `voc-cancel-cred`. All subsequent AWS
read calls were denied by the explicit `voc-cancel-cred` policy, so no further AWS
verification was possible.

- The current live scaling-target state is therefore **UNKNOWN**.
- The final fixed-runner sample showed min/max capacity **1–1**, but live
  restoration to the intended **1–5** range could not be performed or confirmed.
- Do not infer the current ECS count, queue state, target range, policy, or metric
  history from earlier observations.

## Injector hardening in `5000b68`

The AWS injector now provides the following safeguards:

- Each incident's 50 analysis jobs are sent as five concurrent
  `SendMessageBatch` requests of ten messages each.
- Incidents are scheduled from a non-blocking epoch schedule; a slow send does not
  delay the next planned incident.
- Queue/status sampling runs independently and cannot block dispatch.
- A dispatch-start schedule-lag guard invalidates an unrealistically delayed run.
- `dispatches.jsonl` and `injection-timing.json` capture planned versus actual
  dispatch timing and the validity verdict.
- The runner configures capacity, verifies clean queues and the processing cost,
  then waits for exactly one running task and that task's exact ECS-correlated
  `WORKER_READY` event. Only after this readiness preflight completes does it set
  the workload epoch. A Fargate run therefore uses ECS task/container identity;
  local PID fallback is only for local execution.

## Valid injector timing sanity — not calibration evidence

Artifact:
`artifacts/aws-runs/2026-09-21T18-15-29-799Z-aws-injector-timing-sanity-fixed-r1`

- 30 incidents, producing 1,500 analysis jobs.
- Injection duration: 29.333 s; effective offered rate: 51.137 jobs/s.
- Dispatch-start lag mean/p95/max: 11.7 / 28 / 43 ms.
- Timing verdict: valid.

This is an injector sanity check only. It is **not calibration evidence** and is
**not formal evidence**.

## Valid fixed calibration — not an autoscale result

Artifact:
`artifacts/aws-runs/2026-09-21T18-19-20-887Z-aws-stage-1-capacity-calibration-fixed-r1`

- 180 incidents; 9,000 of 9,000 jobs injected.
- Injection duration: 179.329 s; effective offered rate: 50.187 jobs/s.
- Peak visible backlog: 1,544; peak in-flight: 10.
- One worker throughout.
- Drain time: 59.883 s.
- Zero duplicate, error, DLQ, or unaccounted jobs; final sampled queue: 0 visible
  / 0 in-flight.
- Timing verdict: valid.

Do **not** claim that the formal CloudWatch `BacklogPerTask` threshold was verified.
Credentials expired before genuine historical CloudWatch evidence for this window
could be retrieved.

**AUTOSCALE CALIBRATION HAS NOT BEEN RUN.** No fixed-versus-autoscale conclusion,
scale-out observation, or formal experiment may be claimed from these artifacts.

## Recovery procedure after fresh Academy credentials

Use profile `academy` and `us-east-1` explicitly. First perform only the following
read-only recovery checks. Do not start a workload or change scaling capacity yet.

```powershell
aws --profile academy --region us-east-1 sts get-caller-identity

aws --profile academy --region us-east-1 ecs describe-services `
  --cluster sit314-transport-cluster `
  --services sit314-transport-route-impact `
  --query 'services[0].{Status:status,Desired:desiredCount,Running:runningCount,Pending:pendingCount}' `
  --output json

aws --profile academy --region us-east-1 application-autoscaling describe-scalable-targets `
  --service-namespace ecs `
  --resource-ids service/sit314-transport-cluster/sit314-transport-route-impact `
  --scalable-dimension ecs:service:DesiredCount `
  --output json

aws --profile academy --region us-east-1 application-autoscaling describe-scaling-policies `
  --service-namespace ecs `
  --resource-id service/sit314-transport-cluster/sit314-transport-route-impact `
  --scalable-dimension ecs:service:DesiredCount `
  --output json

$AnalysisQueueUrl = aws --profile academy --region us-east-1 sqs get-queue-url `
  --queue-name sit314-transport-analysis --query QueueUrl --output text
aws --profile academy --region us-east-1 sqs get-queue-attributes `
  --queue-url $AnalysisQueueUrl `
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible `
  --output json

$AnalysisDlqUrl = aws --profile academy --region us-east-1 sqs get-queue-url `
  --queue-name sit314-transport-analysis-dlq --query QueueUrl --output text
aws --profile academy --region us-east-1 sqs get-queue-attributes `
  --queue-url $AnalysisDlqUrl `
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible `
  --output json

aws --profile academy --region us-east-1 cloudwatch get-metric-statistics `
  --namespace SIT314/Transport `
  --metric-name BacklogPerTask `
  --dimensions Name=ServiceName,Value=sit314-transport-route-impact `
  --statistics Average Maximum `
  --period 60 `
  --start-time 2026-09-21T18:18:00Z `
  --end-time 2026-09-21T18:25:00Z `
  --output json
```

The CloudWatch query deliberately covers the valid fixed-run window associated
with `2026-09-21T18-19-20-887Z-aws-stage-1-capacity-calibration-fixed-r1` and uses
genuine UTC timestamps. Inspect the returned data before deciding that the
autoscale gate passed.

If the scalable target is still min/max 1–1, restore the normal intended 1–5 range
through the existing project control path, whose `AwsControlPlane.configureCapacity('autoscale')`
uses this exact target registration:

```powershell
aws --profile academy --region us-east-1 application-autoscaling register-scalable-target `
  --service-namespace ecs `
  --resource-id service/sit314-transport-cluster/sit314-transport-route-impact `
  --scalable-dimension ecs:service:DesiredCount `
  --min-capacity 1 `
  --max-capacity 5
```

Then wait until ECS is desired/running 1/1 with pending 0, the analysis queue and
DLQ are empty, and `BacklogPerTask` is near zero. Only after the historical metric
confirms that the valid fixed workload genuinely crossed
`TargetBacklogPerTask = 75` may the matching autoscale calibration be authorised.
Do not use `set-alarm-state` as evidence or to force any scaling action.

## Proposed next command — do not execute in this checkpoint

```powershell
aws --profile academy --region us-east-1 sts get-caller-identity
```

Run this only after fresh Academy credentials are configured. It is the first
read-only recovery check; do not proceed to autoscale calibration before the full
recovery procedure above is satisfied.
