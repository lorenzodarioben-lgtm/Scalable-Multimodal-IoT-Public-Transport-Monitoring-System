# AWS deployment

> **Status: NOT DEPLOYED.** No AWS resource has been created. The AWS CLI is not
> installed on the development machine and no credentials are configured, so
> nothing in this document has been executed. Everything below is written to be
> run as-is once access exists. See `docs/STATUS_4.2D.md` for the blocker.

## Prerequisites

```bash
node --version    # >= 20
aws --version     # not currently installed - see below
docker --version  # daemon must be running for image builds
npm run verify-env
```

**Install the AWS CLI (Windows):**

```bash
winget install --id Amazon.AWSCLI -e
```

or download the MSI from
<https://awscli.amazonaws.com/AWSCLIV2.msi>. Reopen the terminal afterwards.

**Configure credentials.** Do not create an IAM user for this. Use an SSO
profile, or the temporary credentials issued by an AWS Academy lab:

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
short version**: sixteen numbered steps to execute in one deliberate AWS session,
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
$LabRole        = ""                   # e.g. "arn:aws:iam::<account-id>:role/LabRole"
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
aws ecr describe-images --repository-name "$Prefix-route-impact-worker" --query "imageDetails[].imageTags"
```

Expect the `latest` tag. Record the image URI for the next step.

### 10. ECS deployment

```powershell
$Image   = "<accountid>.dkr.ecr.$env:AWS_REGION.amazonaws.com/$Prefix-route-impact-worker:latest"
$Vpc     = aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query "Vpcs[0].VpcId" --output text
$Subnets = (aws ec2 describe-subnets --filters "Name=vpc-id,Values=$Vpc" --query "Subnets[].SubnetId" --output text) -split "\s+"

./infrastructure/scripts/deploy.ps1 -Stacks ecs -Prefix $Prefix -RouteImpactImage $Image -VpcId $Vpc -SubnetIds $Subnets -ExistingExecutionRoleArn $LabRole -ExistingTaskRoleArn $LabRole
```

### 11. Verify the route-impact service

```powershell
aws ecs describe-services --cluster "$Prefix-cluster" --services "$Prefix-route-impact" --query "services[0].{Desired:desiredCount,Running:runningCount,Status:status}"
aws logs tail "/ecs/$Prefix-route-impact" --since 5m
```

Expect `Running: 1`, `Status: ACTIVE`, and `[ANALYSIS]` lines once jobs exist. A
task that starts then immediately stops is almost always a missing task-role
permission — read the reason rather than guessing:

```powershell
aws ecs describe-tasks --cluster "$Prefix-cluster" --tasks (aws ecs list-tasks --cluster "$Prefix-cluster" --desired-status STOPPED --query "taskArns[0]" --output text) --query "tasks[0].stoppedReason"
```

### 12. Autoscaling deployment

```powershell
./infrastructure/scripts/deploy.ps1 -Stacks scaling -Prefix $Prefix -ScalingMode BacklogPerTask -MinTasks 1 -MaxTasks 5 -TargetBacklogPerTask 75 -ExistingLambdaRoleArn $LabRole
```

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
scale on.

### 14. Controlled workload

```powershell
$env:QUEUE_BACKEND = "aws"; $env:STORE_BACKEND = "aws"; $env:METRICS_BACKEND = "aws"
npm run experiment -- --config experiments/incident/stage-1.json --worker-mode autoscale
```

Start with stage 1 only. Do not run stages 3 or 4 until stage 1 has completed
cleanly against AWS.

### 15. Evidence collection

```powershell
aws ecs describe-services --cluster "$Prefix-cluster" --services "$Prefix-route-impact" --query "services[0].{Running:runningCount,Desired:desiredCount}"
aws cloudwatch get-metric-statistics --namespace SIT314/Transport --metric-name BacklogPerTask --start-time (Get-Date).AddMinutes(-30).ToString("s") --end-time (Get-Date).ToString("s") --period 60 --statistics Average
npm run evidence -- --promote latest
```

Capture the SQS console graphs for `$Prefix-analysis`
(`ApproximateNumberOfMessagesVisible` and `ApproximateAgeOfOldestMessage`) and the
ECS task-count graph — evidence items E10 and E11.

### 16. Scale down and clean up

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
# -> AWS_IOT_ENDPOINT=xxxxxxxx-ats.iot.<region>.amazonaws.com
```

Create a device certificate (see `certs/README.md`):

```bash
aws iot create-keys-and-certificate --set-as-active \
  --certificate-pem-outfile certs/device-certificate.pem.crt \
  --public-key-outfile certs/device-public.pem.key \
  --private-key-outfile certs/device-private.pem.key
curl -o certs/AmazonRootCA1.pem https://www.amazontrust.com/repository/AmazonRootCA1.pem
```

Attach a **least-privilege** policy. Save as `iot-policy.json`, substituting your
region and account:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "iot:Connect",
      "Resource": "arn:aws:iot:REGION:ACCOUNT:client/sit314-*" },
    { "Effect": "Allow", "Action": "iot:Publish",
      "Resource": "arn:aws:iot:REGION:ACCOUNT:topic/transport/raw/*" },
    { "Effect": "Allow", "Action": "iot:Publish",
      "Resource": "arn:aws:iot:REGION:ACCOUNT:topic/transport/normalized/*" },
    { "Effect": "Allow", "Action": "iot:Subscribe",
      "Resource": "arn:aws:iot:REGION:ACCOUNT:topicfilter/transport/*" },
    { "Effect": "Allow", "Action": "iot:Receive",
      "Resource": "arn:aws:iot:REGION:ACCOUNT:topic/transport/*" }
  ]
}
```

```bash
aws iot create-policy --policy-name sit314-transport-device \
  --policy-document file://iot-policy.json
aws iot attach-policy --policy-name sit314-transport-device \
  --target <certificateArn>
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
EXISTING_IOT_RULE_ROLE_ARN=arn:aws:iam::...:role/LabRole ./infrastructure/scripts/deploy.sh iot-rule
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
aws ec2 describe-subnets --filters Name=vpc-id,Values=<vpc> --query "Subnets[].SubnetId"
```

```bash
ROUTE_IMPACT_IMAGE=<account>.dkr.ecr.<region>.amazonaws.com/sit314-transport-route-impact-worker:latest \
VPC_ID=vpc-xxxx SUBNET_IDS=subnet-a,subnet-b \
EXISTING_EXECUTION_ROLE_ARN=arn:aws:iam::...:role/LabRole \
EXISTING_TASK_ROLE_ARN=arn:aws:iam::...:role/LabRole \
./infrastructure/scripts/deploy.sh ecs
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
export QUEUE_BACKEND=aws STORE_BACKEND=aws METRICS_BACKEND=aws AWS_REGION=<region>
npm run experiment -- --config experiments/incident/stage-1.json
```

The runner injects jobs into the real analysis queue; the ECS service consumes
them. Task counts come from `describe.sh` and CloudWatch rather than from the
local autoscaler.

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
aws iot update-certificate --certificate-id <id> --new-status INACTIVE
aws iot delete-certificate --certificate-id <id>
```
