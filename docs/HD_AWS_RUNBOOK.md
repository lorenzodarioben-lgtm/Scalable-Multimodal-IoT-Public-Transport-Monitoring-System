# HD AWS execution runbook — TOMORROW ONLY

**Do not execute this runbook during the local-only sprint.** It contains live AWS calls and HD workload injection. The Distinction demonstration video must be recorded **before** starting any HD deployment. All stacks here use `sit314-hd-transport`; never use `sit314-transport` as the deployment prefix. Stop on any failed preflight, unexpectedly dirty D resources, missing Academy permission, timing-invalid run, queue/DLQ residue, or budget concern. Do not alter the D stacks or tag.

## A. Preconditions and first checks

1. Record the D video and confirm the D live deployment and formal evidence are safe. Start a fresh Academy session and configure fresh `academy` credentials in `us-east-1`.
2. In PowerShell, from the **HD worktree** (`C:\Users\lorenzodario\Documents\UNI\UNI_T3\CLoud\Distinction\HighDistinction`), run:

```powershell
git status --short
git -C .. status --short
git -C .. rev-parse 'sit314-6.3d-final^{}'
$env:AWS_PROFILE = 'academy'
$env:AWS_REGION = 'us-east-1'
aws sts get-caller-identity
```

3. Confirm the peeled D tag is `06071c37c536e73fb036bb4f60279d7e595d23c2`, D has no tracked edits, and this HD branch is clean. Check AWS Academy budget/remaining lab time, then inspect **D only read-only** for video completeness. Do not deploy until this gate passes.
4. Use these variables for every HD command; verify the account and role rather than assuming them:

```powershell
$hdPrefix = 'sit314-hd-transport'
$hdRegion = 'us-east-1'
$hdAccount = aws sts get-caller-identity --query Account --output text
$hdLabRoleArn = "arn:aws:iam::${hdAccount}:role/LabRole"
aws iam get-role --role-name LabRole --region $hdRegion
$hdCodeBucket = "${hdPrefix}-${hdAccount}-${hdRegion}-code"
$hdImage = "${hdAccount}.dkr.ecr.${hdRegion}.amazonaws.com/${hdPrefix}-route-impact-worker:hd-local"
```

Record the selected VPC and **two public subnets** as `$hdVpcId` and `$hdSubnetIds` after `aws ec2 describe-vpcs` and `aws ec2 describe-subnets`; verify public IP routing. These are account-specific and deliberately not hard-coded. If LabRole lacks required permissions, stop rather than widen D roles.

## B. Deploy isolated HD resources in dependency order

All commands below are for a later, explicitly authorised AWS session only. Review each stack change set before committing to long-lived resources, and preserve outputs. Existing D resources should not change. Use the HD-only guarded wrappers; the generic deployment scripts default to the D prefix and must not be called directly.

```powershell
./infrastructure/scripts/deploy-hd.ps1 -Stage queues -ExecuteHdDeployment -Region $hdRegion
./infrastructure/scripts/deploy-hd.ps1 -Stage tables -ExecuteHdDeployment -Region $hdRegion
aws cloudformation deploy --region $hdRegion --stack-name "$hdPrefix-hd-code" --template-file infrastructure/cloudformation/hd-code.yaml --parameter-overrides "ResourcePrefix=$hdPrefix"
aws cloudformation deploy --region $hdRegion --stack-name "$hdPrefix-hd-signals" --template-file infrastructure/cloudformation/hd-signals.yaml --parameter-overrides "ResourcePrefix=$hdPrefix"
./infrastructure/scripts/build-hd-image.ps1 -ExecuteHdImagePush -Region $hdRegion -Tag hd-local
./infrastructure/scripts/package-hd-predictor.ps1
aws s3 cp artifacts/hd-predictor.zip "s3://$hdCodeBucket/hd-predictor.zip" --region $hdRegion
$hdSignalUrl = aws cloudformation describe-stacks --region $hdRegion --stack-name "$hdPrefix-hd-signals" --query "Stacks[0].Outputs[?OutputKey=='ArrivalSignalQueueUrl'].OutputValue | [0]" --output text
./infrastructure/scripts/deploy-hd.ps1 -Stage ecs -ExecuteHdDeployment -Region $hdRegion -RouteImpactImage $hdImage -VpcId $hdVpcId -SubnetIds $hdSubnetIds -ExistingExecutionRoleArn $hdLabRoleArn -ExistingTaskRoleArn $hdLabRoleArn -ArrivalSignalQueueUrl $hdSignalUrl
./infrastructure/scripts/deploy-hd.ps1 -Stage scaling -ExecuteHdDeployment -Region $hdRegion -ExistingLambdaRoleArn $hdLabRoleArn
aws cloudformation deploy --profile academy --region $hdRegion --stack-name "$hdPrefix-hd-predictor" --template-file infrastructure/cloudformation/hd-predictor.yaml --parameter-overrides "ResourcePrefix=$hdPrefix" "SignalsStackName=$hdPrefix-hd-signals" "QueuesStackName=$hdPrefix-queues" "EcsStackName=$hdPrefix-ecs" "ControllerMode=hybrid" "LambdaCodeBucket=$hdCodeBucket" "LambdaCodeKey=hd-predictor.zip" "ExistingLambdaRoleArn=$hdLabRoleArn" --capabilities CAPABILITY_NAMED_IAM
```

Resource map: `$hdPrefix-queues` contains analysis SQS/DLQ; `$hdPrefix-tables` contains analysis state; `$hdPrefix-ecs` contains cluster/service; `$hdPrefix-scaling` contains BPT target tracking and fast +4 alarm; `$hdPrefix-hd-signals` contains FIFO arrival queue/DLQ and predictor-state DynamoDB; `$hdPrefix-hd-code` holds the packaged Lambda zip; `$hdPrefix-hd-predictor` contains Lambda and FIFO mapping. All HD metric names live in `SIT314/HDTransport`. The predictor Lambda may reuse LabRole **only if** it can read/write HD DynamoDB and SQS, describe/update the HD ECS service and put custom metrics. A permission error is a stop condition, not a reason to mutate D.

## C. Smoke, observability and baseline reset

First verify stacks `CREATE_COMPLETE`/`UPDATE_COMPLETE`, service one running task, target min/max 1–5, target tracking BPT 75, fast alarm OK, analysis and signal queues/DLQs 0/0, recent genuine BPT zero, exact current `WORKER_READY`. The HD runner's preflight checks these again. Verify Lambda mode `hybrid` and event source mapping enabled. Then run the explicitly bounded **1,150-job predictive smoke**. The prior 100-job/two-signal smoke was an implementation defect in the gate: it could not fill the frozen eight-bin predictor history or test scale-out. The replacement smoke changes no controller or formal-workload parameter.

```powershell
node experiments/hd/aws/smoke-hd-aws.js --execute-hd-smoke
```

The smoke sends eleven post-enqueue signals over ~105 s: seven 50-job bins, three 250-job bins and a closing 50-job signal. It also redelivers the first and last logical signal under fresh FIFO transport IDs to prove persisted deduplication. It writes machine-readable evidence under `artifacts/hd-smoke-runs/`; inspect `summary.json`, `predictor-state.json`, Lambda/worker logs, sampled task IDs, scaling activities and genuine CloudWatch histories. Require 1,150/1,150 results, a forecast and bounded recommendation, one genuine predictive request, new ECS task and exact `WORKER_READY`, zero unexpected faults/duplicates/DLQ. An `INCOMPLETE` smoke is a stop gate, not a formal result. Then wait for queue/signal queues 0/0, BPT near zero and ECS 1/1/0. Only after clean idle, set mode back to `reactive` with the guarded `set-hd-mode.ps1` wrapper for the first formal arm; **do not start that arm in this readiness task**.

Between *every* full run, wait for the natural scale-in and clean queues. If necessary **only after the previous run is fully finished and drained**, an operator may set HD ECS desired count back to one before the next preflight; do not change scalable target or policies. Never influence capacity after a run starts:

```powershell
aws ecs update-service --region $hdRegion --cluster "$hdPrefix-cluster" --service "$hdPrefix-route-impact" --desired-count 1
```

Use that command only for a verified HD service in the post-run reset window. Inspect genuine recent BPT and wait for the fast alarm to return OK; do not force alarm state. Never delete messages from either DLQ merely to pass preflight. Preserve the fault artifact and stop.

## D. Matched run sequence

Controller mode is an HD Lambda stack parameter. Switch **between** runs only; wait for `LastUpdateStatus=Successful` before injection. The guarded wrapper preserves all stack parameters and verifies the Lambda update. `invoke-hd-run.ps1` calls it automatically before exactly one run; never hand-edit a config or directly invoke the generic D-default script.

```powershell
./infrastructure/scripts/set-hd-mode.ps1 -Mode reactive -CodeBucket $hdCodeBucket -ExistingLambdaRoleArn $hdLabRoleArn -ExecuteHdModeChange -Region $hdRegion
```

Execute **one command at a time** after clean preflight/reset. For each `r=1,2,3`, use reactive then hybrid (or another predeclared alternation), but never omit or cherry-pick a repeat. Use distinct execution IDs; the CLI generates them. The runner verifies workload, policy, queue, BPT, readiness and controller mode before injection, records all artifacts in `artifacts/hd-aws-runs/`, and leaves technically clean runs `PENDING_MANUAL_TIMELINE_REVIEW`.

```powershell
./infrastructure/scripts/invoke-hd-run.ps1 -Profile ramp -Arm reactive -Repeat 1 -CodeBucket $hdCodeBucket -ExistingLambdaRoleArn $hdLabRoleArn -ExecuteHdRun -Region $hdRegion
# After reviewing this artifact and re-establishing the clean one-task baseline:
./infrastructure/scripts/invoke-hd-run.ps1 -Profile ramp -Arm hybrid -Repeat 1 -CodeBucket $hdCodeBucket -ExistingLambdaRoleArn $hdLabRoleArn -ExecuteHdRun -Region $hdRegion
# Repeat the paired sequence for r2/r3, then Profile burst for both arms r1/r2/r3.
```

Execution ledger (each row is a separate, manually gated wrapper call; the wrapper sets and verifies the row's mode, then runs once):

The wrapper refuses an existing artifact for the same class/arm/repeat. An aborted or invalid attempt must first receive a `review.json` with its exact run ID, `status: "INVALID"`, a dated review and a substantive basis. Only then may an operator add `-AllowReviewedReplacement` for that one row; retain the old artifact. This is never an automatic rerun.

| Order | Config | Arm | `--repeat` | Clean reset required before |
| ---: | --- | --- | ---: | --- |
| 1 | `aws-ramp.json` | reactive | 1 | yes, after smoke |
| 2 | `aws-ramp.json` | hybrid | 1 | yes |
| 3 | `aws-ramp.json` | reactive | 2 | yes |
| 4 | `aws-ramp.json` | hybrid | 2 | yes |
| 5 | `aws-ramp.json` | reactive | 3 | yes |
| 6 | `aws-ramp.json` | hybrid | 3 | yes |
| 7 | `aws-sudden-burst.json` | reactive | 1 | yes |
| 8 | `aws-sudden-burst.json` | hybrid | 1 | yes |
| 9 | `aws-sudden-burst.json` | reactive | 2 | yes |
| 10 | `aws-sudden-burst.json` | hybrid | 2 | yes |
| 11 | `aws-sudden-burst.json` | reactive | 3 | yes |
| 12 | `aws-sudden-burst.json` | hybrid | 3 | yes |

Rough lower-bound runtime: 12 × 630 s = 126 min of scheduled arrivals, plus at least 12 × 60 s = 12 min CloudWatch grace and ~60 s post-injection/log checks per run. Smoke, deployment, startup, reset and review likely make this a **3–5+ hour** session. Stop if Academy time or budget is insufficient; keep completed valid artifacts. Fargate worker task-seconds are a relative cost proxy, not full AWS billing. Before starting, check current Academy budget and official regional prices if a currency estimate is needed; do not rely on a stale estimate.

## E. Review, metrics and final analysis

For each run inspect `manifest.json`, `injection-timing.json`, `summary.json`, `samples.jsonl`, `scaling-activities.json`, `predictor-logs.json`, `cloudwatch-history.json`, worker logs and both queue/DLQ states. Confirm same logical digest per matched repeat, actual offered rate and timing guard, expected/submitted/completed jobs, zero faults and signal DLQ, genuine BPT/oldest-age timelines, request → RUNNING → WORKER_READY, and prediction error. Inspect which policy requested scale-out. Keep invalid attempts labelled and excluded. Only after manual chronology/reliability review create `review.json` in the run directory:

```json
{ "runId": "EXACT_MANIFEST_RUN_ID", "status": "VALID", "reviewedAt": "ISO-8601", "basis": "timing, accounting, cloud metrics, signal queue and task timeline checked" }
```

With exactly twelve **reviewed** valid runs, run the offline aggregate (no AWS calls):

```powershell
node experiments/hd/analysis/aggregate.js --input artifacts/hd-aws-runs --output artifacts/hd-analysis
```

It writes raw per-run metrics, descriptive comparison tables and single-axis SVG charts (arrival vs prediction, backlog, tasks, scale timeline, peak backlog and task-seconds). `--preview` can inspect an incomplete/unreviewed set only after all 12 artifact directories exist, but output is explicitly preliminary. Do not claim statistical significance from n=3. Insert actual results into `HD_REPORT_DRAFT.md`, use `HD_EVIDENCE_CHECKLIST.md`, render the final 4–5 page report, verify citations, code commit and video, then submit.

## F. Failure and cleanup

If any timing guard fires, results are incomplete, an AWS metric is missing, signal queue/DLQ is dirty, permission fails, Lambda mode mismatches, or task/metric chronology is ambiguous: **stop that run, retain its artifact, diagnose before any replacement**. Do not loosen workload/guard, force alarm or secretly adjust capacity. If the whole study cannot fit the Academy budget, report the valid subset as incomplete rather than collapsing repeats.

After submission/video and only with explicit user authorisation, delete **HD-prefixed** resources in reverse dependency order: predictor stack, scaling, ECS, signals, tables/queues, ECR image/repository, code-bucket objects and code stack. First list exact stack and bucket names and verify none match `sit314-transport` D. S3 bucket objects must be removed before the HD code stack can delete its bucket. Never run broad wildcard deletion or clean D resources as part of HD cleanup.
