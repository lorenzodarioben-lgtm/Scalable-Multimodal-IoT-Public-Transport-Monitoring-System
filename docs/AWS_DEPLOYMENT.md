# AWS deployment

> **Status: NOT DEPLOYED.** No AWS resource has been created. The AWS CLI is
> installed and locally verified (`aws-cli/2.36.39`), but no credentials are
> configured and no authenticated call has been made, so nothing in this document
> has been executed. Everything below is written to be run as-is once access
> exists. See `docs/STATUS_4.2D.md` for the blocker.

## Prerequisites

```bash
node --version    # >= 20
aws --version     # aws-cli/2.36.39 - installed and verified
docker --version  # daemon must be running for image builds
npm run verify-env
```

The CLI is a per-user install under `%LOCALAPPDATA%\Programs\Amazon\AWSCLIV2\`.
If `aws --version` reports "command not found", the shell was opened before the
install — open a genuinely new terminal window, not a subprocess of the old
shell. `winget` updates the PATH stored for future sessions but does not repair
the environment inherited by an already-open terminal; use the full executable
path temporarily if a new window still inherits the stale PATH.

**Configure credentials.** This is the outstanding step. Do not create an IAM user
for this. Use an SSO profile, or the temporary credentials issued by an AWS
Academy lab:

```bash
aws configure sso           # preferred
# or paste the lab's temporary credentials into ~/.aws/credentials
aws sts get-caller-identity
```

## Estimated cost

Everything is pay-per-use and small. With the services idle at one task the
dominant cost is the single Fargate task.

| Service | Basis | Rough cost |
|---|---|---|
| Fargate 0.25 vCPU / 0.5 GB | ~USD 0.012/hour per task | ~USD 0.29/day for 1 task |
| SQS | first 1M requests/month free | ~0 at test scale |
| DynamoDB on-demand | per request | cents |
| AWS IoT Core | per message | cents at test scale |
| CloudWatch | 7-day log retention, few custom metrics | cents |
| Lambda (1/minute) | 43,200 invocations/month | within free tier |
| **NAT gateway** | **deliberately not used** | **USD 0** |
| **Load balancer** | **deliberately not used** | **USD 0** |

**Stop the ECS service when not testing** - that is where the money goes:

```bash
aws ecs update-service --cluster sit314-transport-cluster \
  --service sit314-transport-route-impact --desired-count 0
```

## Live session runbook (PowerShell)

The sections after this one explain each stack in detail. **This runbook is the
short version**: seventeen numbered steps to execute in one deliberate AWS session,
each with the verification that must actually be read before moving on. AWS
Academy credit is limited, so the goal is to spend as little live time as
possible.

Nothing in this runbook has been executed — the project has never contacted AWS.
Treat each verification as a gate: if the output is not what the step says to
expect, stop and diagnose rather than continuing.

Set these once at the start of the session:

```powershell
$env:AWS_REGION = "us-east-1"          # or the region your lab provides
$Prefix         = "sit314-transport"
$LabRole        = Read-Host 'Paste the LabRole ARN supplied by the lab; press Enter only if role creation is allowed'
```

Leave `$LabRole` empty if the account allows role creation. In AWS Academy it
usually does not — fill it in and pass it to every `-Existing*RoleArn`.

### 1. Identity check

```powershell
aws sts get-caller-identity
```

Expect an Account, UserId and Arn. **Do not paste this output into the repository**
— the account id must not be committed.

### 2. Region verification

```powershell
aws configure get region
$env:AWS_REGION
```

Both should agree. If `aws configure get region` is empty the CLI falls back to
`$env:AWS_REGION`, so make sure that is set.

### 2a. AWS Academy preflight (read-only)

Run this before creating any project resource. It makes non-mutating identity,
IAM/authorization-simulation and CloudWatch Logs inspection requests only; it
never creates a role, service-linked role, repository, stack or log stream. A
denied IAM read or simulation means *unknown*, not that the permission is absent
or present.

```powershell
./infrastructure/scripts/aws-academy-preflight.ps1 -Prefix $Prefix -Region $env:AWS_REGION -LabRoleArn $LabRole
```

Read its LabRole trust result especially carefully. The role used by the
project must be assumable by the relevant service (`ecs-tasks.amazonaws.com`,
`iot.amazonaws.com`, or `lambda.amazonaws.com`); a single Academy LabRole may
not be valid for all three uses. Also treat Application Auto Scaling's first
registration as a separate live gate after ECS: the account may need the
`AWSServiceRoleForApplicationAutoScaling_ECSService` service-linked role and
Academy may deny its creation. Stop on that denial rather than attempting to
work around it.

Where Academy permits `iam:SimulatePrincipalPolicy`, the preflight also reports
the LabRole's evaluated `sqs:SendMessage`, CloudWatch Logs writer and ECR pull
permissions against this project's resolved ARNs. It is advisory: it cannot
prove role trust, `iam:PassRole`, service-control policies or an actual service
write, so retain the isolated live gates.

### 3. Deploy the queues

```powershell
./infrastructure/scripts/deploy.ps1 -Stacks queues -Prefix $Prefix
```

### 4. Verify the queues

```powershell
aws sqs list-queues --queue-name-prefix $Prefix
aws sqs get-queue-attributes --attribute-names All --queue-url (aws sqs get-queue-url --queue-name "$Prefix-analysis" --output text)
```

Expect six queues (three working, three DLQ) and a `RedrivePolicy` on the analysis
queue naming `$Prefix-analysis-dlq` with a finite `maxReceiveCount`.

### 5. Deploy the tables

```powershell
./infrastructure/scripts/deploy.ps1 -Stacks tables -Prefix $Prefix
```

### 6. Verify the tables

```powershell
aws dynamodb list-tables
aws dynamodb describe-table --table-name "$Prefix-current-state" --query "Table.{Status:TableStatus,Keys:KeySchema,Billing:BillingModeSummary.BillingMode}"
```

Expect four tables, `ACTIVE`, `PAY_PER_REQUEST`, and `entityId` as the single
partition key.

### 7. IoT integration

```powershell
aws iot describe-endpoint --endpoint-type iot:Data-ATS
```

Put the returned endpoint in `.env` as `AWS_IOT_ENDPOINT`, create the certificate
and policy (see the AWS IoT Core section below), then deploy the rule:

```powershell
./infrastructure/scripts/deploy.ps1 -Stacks iot-rule -Prefix $Prefix -ExistingIotRuleRoleArn $LabRole
```

Verify ingestion — subscribe to `transport/raw/#` in the IoT MQTT test client, then:

```powershell
$env:MQTT_MODE = "aws"
npm run simulate -- --buses 3 --trams 2 --trains 1 --locations 2 --duration-seconds 20 --target mqtt
```

Expect messages in the test client. Then confirm the rule is delivering, with
Node-RED pointed at AWS IoT Core:

```powershell
aws sqs get-queue-attributes --attribute-names ApproximateNumberOfMessages --queue-url (aws sqs get-queue-url --queue-name "$Prefix-telemetry" --output text)
```

Expect a non-zero depth.

### 8. Docker build

Docker Desktop must already be running — see the blocker note in `HANDOFF.md`.

```powershell
docker info --format "{{.ServerVersion}}"
docker build -f services/route-impact-worker/Dockerfile -t "$Prefix-route-impact-worker" .
```

Confirm no secret entered the image:

```powershell
docker run --rm "$Prefix-route-impact-worker" sh -c "ls -a /app | grep -E '(^|/)\.env$|(^|/)certs$' || echo CLEAN"
```

Expect `CLEAN`.

### 9. ECR push

```powershell
./infrastructure/scripts/build-and-push.ps1 -Services route-impact-worker -Prefix $Prefix
aws ecr describe-images --repository-name "$Prefix-route-impact-worker" --image-ids imageTag=latest --query "imageDetails[0].imageDigest"
```

The script enforces this exact ordering: create or verify the repository,
authenticate Docker, build, tag, push, then verify an ECR image digest. Expect
a digest. It fails before ECS can be deployed with a nonexistent or empty image.

### 10. ECS deployment

```powershell
$AccountId = aws sts get-caller-identity --query Account --output text
$Image     = "$AccountId.dkr.ecr.$env:AWS_REGION.amazonaws.com/$Prefix-route-impact-worker:latest"
$Vpc     = aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query "Vpcs[0].VpcId" --output text
$Subnets = (aws ec2 describe-subnets --filters "Name=vpc-id,Values=$Vpc" --query "Subnets[].SubnetId" --output text) -split "\s+"

./infrastructure/scripts/deploy.ps1 -Stacks ecs -Prefix $Prefix -RouteImpactImage $Image -VpcId $Vpc -SubnetIds $Subnets -WorkerProcessingDelayMs 50 -ExistingExecutionRoleArn $LabRole -ExistingTaskRoleArn $LabRole
```

`deploy.ps1` independently verifies that this exact ECR image tag has a digest
before it creates or updates the ECS service. Do not bypass that gate with a
hand-written CloudFormation command.

### 11. Verify the route-impact service

```powershell
aws ecs describe-services --cluster "$Prefix-cluster" --services "$Prefix-route-impact" --query "services[0].{Desired:desiredCount,Running:runningCount,Status:status}"
aws logs tail "/ecs/$Prefix-route-impact" --since 5m
```

Expect `Running: 1`, `Status: ACTIVE`, and a `[WORKER_READY]` line once queue
access has been established. A
task that starts then immediately stops is almost always a missing task-role
permission — read the reason rather than guessing:

```powershell
aws ecs describe-tasks --cluster "$Prefix-cluster" --tasks (aws ecs list-tasks --cluster "$Prefix-cluster" --desired-status STOPPED --query "taskArns[0]" --output text) --query "tasks[0].stoppedReason"
```

For startup-delay evidence, correlate to the known running task rather than
asking CloudWatch Logs for the "latest" stream. `LastEventTime` is eventually
consistent and can select the wrong worker:

```powershell
$TaskArn = aws ecs list-tasks --cluster "$Prefix-cluster" --service-name "$Prefix-route-impact" --desired-status RUNNING --query "taskArns[0]" --output text
$TaskId = ($TaskArn -split '/')[-1]
$LogStream = "route-impact/route-impact-worker/$TaskId"
aws logs get-log-events --log-group-name "/ecs/$Prefix-route-impact" --log-stream-name $LogStream --start-from-head
```

### 12. Autoscaling deployment

```powershell
./infrastructure/scripts/deploy.ps1 -Stacks scaling -Prefix $Prefix -ScalingMode BacklogPerTask -MinTasks 1 -MaxTasks 5 -TargetBacklogPerTask 75 -ExistingLambdaRoleArn $LabRole
```

Keep this as its own step — do not combine it with the ECS deployment. It makes
the Application Auto Scaling first-use/service-linked-role outcome observable
and cheap to stop on. A successful stack does not prove scaling yet; wait for
the metric and a workload-driven transition below.

If Lambda or EventBridge creation is denied, redeploy with the documented fallback
and record the deviation in `docs/IMPLEMENTATION_DECISIONS.md`:

```powershell
./infrastructure/scripts/deploy.ps1 -Stacks scaling -Prefix $Prefix -ScalingMode QueueDepth
```

### 13. Verify min 1 / max 5

```powershell
aws application-autoscaling describe-scalable-targets --service-namespace ecs --query "ScalableTargets[?contains(ResourceId,'$Prefix')].{Id:ResourceId,Min:MinCapacity,Max:MaxCapacity}"
aws application-autoscaling describe-scaling-policies --service-namespace ecs --query "ScalingPolicies[?contains(ResourceId,'$Prefix')].{Name:PolicyName,Target:TargetTrackingScalingPolicyConfiguration.TargetValue}"
```

Expect `Min: 1`, `Max: 5`, and the `backlog-per-task` policy with target 75. This
output is evidence item E09 — capture it.

Confirm the custom metric is actually arriving before trusting the policy:

```powershell
aws cloudwatch list-metrics --namespace SIT314/Transport --metric-name BacklogPerTask
```

An empty result means the Lambda is not publishing and the policy has nothing to
scale on. The metric is published once per minute, so allow at least two to
three complete periods before treating the policy as ready or starting the
calibration or formal run.

### 14. AWS injector timing sanity check, then calibration gate

Run the short injector check first. It is **NOT CALIBRATION EVIDENCE** and **NOT
FORMAL EVIDENCE**: it proves only that the external SQS injector can sustain the
configured arrivals without metric collection slowing it down.

```powershell
npm run experiment:aws -- --config experiments/calibration/aws-injector-timing-sanity.json --worker-mode fixed --repeat 1
```

The sanity configuration sends 30 incidents at one-second cadence, with 50 jobs
per incident (1,500 jobs). The runner records each planned/actual dispatch,
schedule lag, actual duration and effective jobs/s in `dispatches.jsonl` and
`injection-timing.json`. It marks the run `TIMING-INVALID` and stops injecting if
a dispatch starts a whole interval behind schedule, or if three consecutive
dispatches start at least half an interval late. Completion lag is retained as
evidence but does not reject a cold first request that can recover on schedule.
Do not start the full calibration
unless this artifact is `VALID`, has no guard event, and is approximately 50 jobs/s.

**CALIBRATION ONLY — NOT FORMAL EVIDENCE.** After a passing injector check, run
the fixed arm of the full 1-second candidate:

```powershell
npm run experiment:aws -- --config experiments/calibration/aws-stage-1-capacity.json --worker-mode fixed --repeat 1
```

This is a 30 s warm-up plus 150 s measurement: 180 incidents every second and
50 analysis jobs per incident (**9,000 jobs**). The fixed pass is exactly one
task; it keeps the worker at 50 ms delay and zero CPU-burn iterations. It must
both be `VALID` and actually deliver approximately 50 jobs/s before its queue
metrics can be interpreted as capacity evidence.

Inspect the raw artifacts, CloudWatch `BacklogPerTask` periods, real Application
Auto Scaling activities, and ECS desired/running task counts before proceeding.
Run the matched autoscaled arm only when the valid fixed arm has sustained pressure
and `BacklogPerTask` genuinely exceeds 75:

```powershell
npm run experiment:aws -- --config experiments/calibration/aws-stage-1-capacity.json --worker-mode autoscale --repeat 1
```

| Calibration result | Interpretation and next action |
|---|---|
| Too light | One fixed task keeps up, the queue repeatedly drains close to zero, or `BacklogPerTask` does not stay above 75 for enough real metric periods. Stop for review; do not automatically run autoscale or another cadence. |
| Useful | The fixed pass develops sustained backlog; the autoscaled pass rises above one task from real workload-driven metrics; backlog begins recovering as tasks arrive; it does not immediately remain pinned at five tasks. Freeze the formal intensity after recording this decision. |
| Too heavy | The autoscaled pass immediately reaches five tasks and backlog continues growing rapidly there. Select a lower intensity; the run does not reveal a scaling curve. |

The phase order is mandatory: **injector timing sanity check → fixed calibration
→ inspect results → choose and freeze final formal intensity → formal experiment**.
A later, separately reviewed
formal-stage edit may change only the chosen cadence/count; it must preserve the
30 s warm-up, 600 s measurement, 300 s drain deadline, three repeats, matched
canonical work, 50 ms delay, zero CPU burn, fixed one-task arm and autoscale
one-to-five arm.

### 15. Formal controlled workload: fixed arm then autoscaled arm

```powershell
# Repeat 1 shown; run repeats 1, 2 and 3 for each arm.
npm run experiment:aws -- --config experiments/incident/stage-1.json --worker-mode fixed --repeat 1
npm run experiment:aws -- --config experiments/incident/stage-1.json --worker-mode autoscale --repeat 1
```

The formal runner is AWS-only: it configures min=max=1 for the fixed arm and
min=1/max=5 for the autoscaled arm, waits for exactly one running ECS task, and
waits for that task's exact `[WORKER_READY]` log event before injection. It
refuses to inject into a non-empty analysis queue or DLQ. It uses the committed
63-incident count-bounded schedule (30 s warm-up + 10-minute measurement), not
the local runner. Do not shorten a formal run for convenience: one-minute
metric publication, CloudWatch evaluation, scale-out cooldown and Fargate task
startup must all fit within the evidence window. It does not purge queues
automatically: inspect and resolve leftover work before retrying. Start with
stage 1 only; do not run stages 3 or 4 until stage 1 has completed cleanly
against AWS.

Never use `aws cloudwatch set-alarm-state`, temporary alarm thresholds, or any
other forced state as autoscaling evidence. The formal evidence is valid only
when the committed workload causes real metric transitions and the resulting
Application Auto Scaling activities are recorded.

### 16. Evidence collection and drain

```powershell
aws ecs describe-services --cluster "$Prefix-cluster" --services "$Prefix-route-impact" --query "services[0].{Running:runningCount,Desired:desiredCount}"
$MetricEndUtc = [DateTime]::UtcNow
$MetricStartUtc = $MetricEndUtc.AddMinutes(-30)
aws cloudwatch get-metric-statistics --namespace SIT314/Transport --metric-name BacklogPerTask --start-time $MetricStartUtc.ToString('yyyy-MM-ddTHH:mm:ssZ') --end-time $MetricEndUtc.ToString('yyyy-MM-ddTHH:mm:ssZ') --period 60 --statistics Average
npm run evidence -- --promote latest
```

The runner writes `manifest.json`, `samples.jsonl`, `scaling-activities.json`,
`summary.json`, and raw CloudWatch log references/events in
`artifacts/aws-runs/<run-id>/`; these are the source data. It waits for an empty
visible and in-flight analysis queue, up to the committed 300 s drain deadline.
Run the fixed and autoscaled arms for repeats 1, 2 and 3 before comparing them.
Capture the SQS console graphs for `$Prefix-analysis`
(`ApproximateNumberOfMessagesVisible` and `ApproximateAgeOfOldestMessage`) and the
ECS task-count graph — evidence items E10 and E11.

### 17. Scale down and clean up

**Do this before ending the session.** Leaving five tasks running burns credit.

```powershell
aws ecs update-service --cluster "$Prefix-cluster" --service "$Prefix-route-impact" --desired-count 1
```

When the project is finished, delete the project's own stacks in reverse order:

```powershell
bash ./infrastructure/scripts/cleanup.sh      # lists what it will delete first
```

Then confirm nothing is left running:

```powershell
aws ecs list-services --cluster "$Prefix-cluster"
aws cloudformation describe-stacks --query "Stacks[?starts_with(StackName,'$Prefix')].StackName"
```

---

## Deployment order

Stacks depend on each other, so deploy in this order:

```
queues -> tables -> iot-rule -> (build & push images) -> ecs -> scaling
```

### 1. Queues and tables

```powershell
./infrastructure/scripts/deploy.ps1 -Stacks queues,tables
```

```bash
./infrastructure/scripts/deploy.sh queues tables
```

Verify:

```bash
./infrastructure/scripts/describe.sh
```

### 2. AWS IoT Core

Get the endpoint and put it in `.env`:

```bash
aws iot describe-endpoint --endpoint-type iot:Data-ATS
```

Create a device certificate (see `certs/README.md`):

```bash
aws iot create-keys-and-certificate --set-as-active \
  --certificate-pem-outfile certs/device-certificate.pem.crt \
  --public-key-outfile certs/device-public.pem.key \
  --private-key-outfile certs/device-private.pem.key
curl.exe -L -o certs/AmazonRootCA1.pem https://www.amazontrust.com/repository/AmazonRootCA1.pem
```

Attach a **least-privilege** policy. The command resolves the current account
and configured region instead of requiring hand-edited policy placeholders:

```bash
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
cat > iot-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "iot:Connect", "Resource": "arn:aws:iot:${AWS_REGION}:${ACCOUNT_ID}:client/sit314-*" },
    { "Effect": "Allow", "Action": "iot:Publish", "Resource": "arn:aws:iot:${AWS_REGION}:${ACCOUNT_ID}:topic/transport/raw/*" },
    { "Effect": "Allow", "Action": "iot:Publish", "Resource": "arn:aws:iot:${AWS_REGION}:${ACCOUNT_ID}:topic/transport/normalized/*" },
    { "Effect": "Allow", "Action": "iot:Subscribe", "Resource": "arn:aws:iot:${AWS_REGION}:${ACCOUNT_ID}:topicfilter/transport/*" },
    { "Effect": "Allow", "Action": "iot:Receive", "Resource": "arn:aws:iot:${AWS_REGION}:${ACCOUNT_ID}:topic/transport/*" }
  ]
}
EOF
aws iot create-policy --policy-name sit314-transport-device \
  --policy-document file://iot-policy.json
read -r -p 'Paste the certificate ARN returned by the create command: ' CERTIFICATE_ARN
aws iot attach-policy --policy-name sit314-transport-device \
  --target "$CERTIFICATE_ARN"
```

Test publishing, then subscribe in the AWS IoT MQTT test client to
`transport/raw/#`:

```bash
MQTT_MODE=aws npm run simulate -- --buses 3 --trams 2 --trains 1 --locations 2 \
  --duration-ms 20000 --target mqtt
```

### 3. The IoT rule

```bash
./infrastructure/scripts/deploy.sh iot-rule
# restricted account:
read -r -p 'Paste the Academy LabRole ARN: ' EXISTING_IOT_RULE_ROLE_ARN
export EXISTING_IOT_RULE_ROLE_ARN
./infrastructure/scripts/deploy.sh iot-rule
```

Now anything Node-RED publishes to `transport/normalized/+` lands in the
telemetry queue. Point Node-RED at AWS IoT Core (see `node-red/README.md`), run
the simulator, and watch the queue fill:

```bash
./infrastructure/scripts/describe.sh
```

### 4. Build and push images

Requires a running Docker daemon.

```powershell
./infrastructure/scripts/build-and-push.ps1 -Services route-impact-worker
```

Prioritise the route-impact worker; it is the service that autoscales.

### 5. ECS

Find a VPC and two subnets (the default VPC is fine):

```bash
aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query "Vpcs[0].VpcId"
VPC_ID="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query "Subnets[].SubnetId"
```

```bash
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
VPC_ID="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
SUBNET_IDS="$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[].SubnetId' --output text | tr '\t' ',')"
ROUTE_IMPACT_IMAGE="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/sit314-transport-route-impact-worker:latest"
read -r -p 'Paste the Academy LabRole ARN: ' EXISTING_EXECUTION_ROLE_ARN
export ROUTE_IMPACT_IMAGE VPC_ID SUBNET_IDS EXISTING_EXECUTION_ROLE_ARN
EXISTING_TASK_ROLE_ARN="$EXISTING_EXECUTION_ROLE_ARN" ./infrastructure/scripts/deploy.sh ecs
```

Confirm one task is running and consuming the analysis queue:

```bash
aws logs tail /ecs/sit314-transport-route-impact --follow
```

### 6. Autoscaling

```bash
./infrastructure/scripts/deploy.sh scaling
# if Lambda or role creation is denied:
SCALING_MODE=QueueDepth ./infrastructure/scripts/deploy.sh scaling
```

Verify min 1 / max 5 and the policy:

```bash
./infrastructure/scripts/describe.sh
```

Check the metric is arriving (it publishes once a minute):

```bash
aws logs tail /aws/lambda/sit314-transport-backlog-metric --follow
```

## Running an experiment against AWS

```bash
npm run experiment:aws -- --config experiments/incident/stage-1.json --worker-mode fixed --repeat 1
npm run experiment:aws -- --config experiments/incident/stage-1.json --worker-mode autoscale --repeat 1
```

The runner injects jobs into the real analysis queue; ECS is the only consumer.
It stores the machine-readable evidence locally and uses the service, SQS,
DynamoDB, Application Auto Scaling and CloudWatch Logs APIs only after the user
has supplied temporary credentials. Do not use `npm run experiment` for a formal
AWS comparison: that is the local harness and starts local workers.

### AWS Academy LabRole preflight

When supplying `ExistingIotRuleRoleArn`, confirm that the LabRole trust policy
allows `iot.amazonaws.com` to assume it and that its permissions include
`sqs:SendMessage` for the telemetry queue plus `logs:CreateLogStream` and
`logs:PutLogEvents` for the rule-error log stream.
The generated role has those least-privilege permissions; an externally supplied
role is not changed by the template and must be checked in the live session.

## If a deployment is denied

Restricted accounts commonly deny `iam:CreateRole` and `iam:PassRole`.

1. **Capture the exact error** - it goes in the report.
2. **Do not retry the same forbidden call.**
3. **Do not widen permissions to get around it.**
4. Re-run with the existing role ARNs:
   `EXISTING_EXECUTION_ROLE_ARN`, `EXISTING_TASK_ROLE_ARN`,
   `EXISTING_IOT_RULE_ROLE_ARN`, `EXISTING_LAMBDA_ROLE_ARN`.
5. If Lambda creation is denied, use `SCALING_MODE=QueueDepth` and record the
   deviation - queue depth is **not** backlog per active task.

## Cleanup

```bash
./infrastructure/scripts/cleanup.sh --scale-in-only   # cheap: back to 1 task
./infrastructure/scripts/cleanup.sh                   # delete this project's stacks
```

`cleanup.sh` deletes only CloudFormation stacks named `sit314-transport-*`,
prints the plan, and requires you to type `DELETE`. It never enumerates or
deletes account resources by type. ECR repositories and IoT certificates are
left alone - remove those manually if you want them gone:

```bash
aws ecr delete-repository --repository-name sit314-transport-route-impact-worker --force
read -r -p 'Paste the device certificate ARN: ' CERTIFICATE_ARN
CERTIFICATE_ID="${CERTIFICATE_ARN##*/}"
aws iot update-certificate --certificate-id "$CERTIFICATE_ID" --new-status INACTIVE
aws iot delete-certificate --certificate-id "$CERTIFICATE_ID"
```
