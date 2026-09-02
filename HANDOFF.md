# Handoff

Everything a fresh session needs to continue this project without any prior
conversation context. The repository on disk is the source of truth.

Last updated: 2026-09-04.

---

## 1. Project objective

**Scalable Multimodal IoT Public Transport Monitoring System** — SIT314 Distinction
Project, student Lorenzo Dario Ben.

A simulated public transport authority monitors buses, trams, trains, stops,
stations and passenger demand. It detects operational disruption (bus breakdown,
tram track blockage, train cancellation, multimodal corridor disruption, excessive
delay, crowding) and models the route impact of that disruption using a
queue-decoupled, automatically scaled microservice pipeline on AWS.

The academic point is **measurable scalability**: prove that automatic scaling of
one specific microservice raises sustainable throughput on an identical workload,
find the breaking point, identify the bottleneck, make one targeted improvement, and
repeat the identical workload.

The project must visibly demonstrate: simulated IoT data generation, Node.js,
Node-RED flow-based processing, AWS, MQTT, event-driven microservices, queue-based
buffering/decoupling, DynamoDB persistence, automatic scaling, secure deployment,
Volume, Velocity, Variety, controlled breaking-point testing, bottleneck
identification, and improvement with repeat testing.

---

## 2. Architecture

```
Node.js multimodal simulator
    -> MQTT over TLS
    -> AWS IoT Core                      [local substitute: aedes broker on :1883]
    -> Node-RED  validation + normalisation, four per-mode branches
    -> AWS IoT Rule                      [local substitute: normalised->queue bridge]
    -> SQS telemetry queue               [local substitute: file-backed queue]
    -> Telemetry processor
         -> DynamoDB current state (conditional, timestamp-guarded)
         -> disruption detection -> fan-out into many INDEPENDENT jobs
    -> SQS analysis queue
    -> Route-impact / ETA worker    <== PRIMARY AUTOSCALING TARGET
         ECS Fargate, min 1 task / max 5 tasks
         -> DynamoDB analysis results
         -> SQS notification queue
    -> Notification worker (simulated deliveries only)
         -> DynamoDB notification records

CloudWatch: queue depth, oldest-message age, processing latency, task count
Application Auto Scaling: backlog-per-task target-tracking on the route-impact service
```

The route-impact worker polls SQS, so it needs **no load balancer** — which is both
architecturally correct and the main cost saving.

Design rationale for each component: `docs/ARCHITECTURE.md`.
Every deviation from the original specification: `docs/IMPLEMENTATION_DECISIONS.md`.

---

## 3. VERIFIED working

Executed on this machine, output observed.

- **Full local end-to-end pipeline.** `npm run demo:local` with Node-RED running
  drove: simulator → MQTT → Node-RED validate/normalise → bridge → telemetry queue
  → telemetry processor → state table → disruption fan-out → analysis queue →
  route-impact worker → results table → notification queue → notification worker →
  notifications table. Observed result:

  ```
  Events processed (ProcessedEvents): 311
  Entities tracked (CurrentState):    27
  Route impact results:               362
  Simulated notifications:            1404
  Telemetry DLQ / Analysis DLQ / Notifications DLQ: 0 / 0 / 0
  ```

  Re-verified 2026-09-04. An earlier run gave 309 / 27 / 412 / 1604; the totals
  vary slightly because how many breakdown ticks fit in the fixed 24-second
  window depends on wall-clock timing. The DLQ counts are always zero.

- **Test suite: 159 tests, 159 pass, 0 fail** (`npm test`, ~8 s).
- **Static infrastructure validation clean**: `npm run lint:infra` (cfn-lint)
  reports no findings across all five CloudFormation stacks.
- **Reliability behaviour**, via `npm run demo:reliability`: duplicate event
  suppressed, stale write refused, failed message retained and retried, poison
  message dead-lettered while a healthy message alongside it completed.
- **Stage 2 incident A/B** on an identical 750-job workload (see section 8).
- **All four container images build, run real work, and shut down cleanly**, and
  the six-container Compose stack runs the full pipeline (section 7).
- **Telemetry-growth generation capacity**: the simulator sustains stage 8
  (1000 vehicles every 1 s) at 1088.8 of 1100 events/s with no failures, and the
  mode mix holds at exactly 60% bus / 25% tram / 15% train.
- Deterministic seeded RNG; identical seed reproduces the workload.
- All four generators produce schema-valid payloads (bus, tram, train, demand).
- Simulator CLI: entity counts, interval, duration, seed, scenario, target,
  invalid-rate, duplicate-rate, disrupt-vehicle, stage-file loading.
- All five scenarios: `normal`, `bus-breakdown`, `tram-blockage`,
  `train-cancellation`, `multimodal-disruption`.
- Local MQTT broker (aedes) and real MQTT publish/subscribe.
- Node-RED running on :1880 with the flow loaded, four visible per-mode validation
  branches, normalisation, accepted and rejected outputs.
- `npm run flows:check` proves `flows.json` matches `node-red/functions/*.js`.
- Local file-backed queue: long polling, visibility timeout, receive count, DLQ
  redrive, depth and oldest-age attributes.
- Conditional-write idempotency: `putIfAbsent` on eventId/jobId/notificationId, and
  `putIfNewer` preventing an older telemetry event from overwriting newer state.
- Telemetry processor: crowding classification, delay evaluation, disruption
  detection, fan-out sizing, duplicate event creating no duplicate jobs.
- Route-impact worker: deterministic mode-specific ETA/impact, result write,
  duplicate job skipped, alert generation, failure does not delete the message.
- Notification worker: simulated delivery records, duplicate skipped, controlled
  failure handling.
- Graceful SIGTERM shutdown in all three services.
- Local backlog-per-task autoscaler spawning and stopping real worker processes
  between min 1 and max 5.
- **Preliminary A/B scalability experiments for stages 1 and 2** — see section 8.
- `npm run demo:local -- --check` reports prerequisites without touching state.
- `npm run verify-env`, `npm run queue:stats`, `npm run state:dump`,
  `npm run evidence`, `npm run demo:checkpoint --check` all run correctly.

---

## 4. IMPLEMENTED but not externally verified

Written and unit-tested, never executed against the real service.

- Real SQS adapter (AWS SDK v3): send/batch/receive/delete/visibility/attributes.
- Real DynamoDB adapter with `attribute_not_exists` and timestamp conditional
  expressions.
- CloudWatch metrics adapter (namespace `SIT314/Transport`).
- AWS IoT MQTT-over-TLS path in the simulator's MQTT client, including the explicit
  failure message when TLS configuration is absent.
- All five CloudFormation stacks (see section 11).
- PowerShell and bash deployment/describe/cleanup scripts.

- ECS task definitions at 0.25 vCPU / 0.5 GB.
- Application Auto Scaling configuration, min 1 / max 5, backlog-per-task target
  tracking, with a documented queue-depth fallback.

---

## 5. What remains

Priority order:

1. Install and configure the AWS CLI; `aws sts get-caller-identity`.
2. Deploy `queues` and `tables` stacks; verify with `describe.sh`.
3. Create the AWS IoT thing, certificate and policy; populate `.env`; verify the
   simulator publishes over TLS using the IoT MQTT test client.
4. Deploy the `iot-rule` stack; verify a normalised message reaches the telemetry
   queue.
5. Build and push the three images to ECR (they already build and run locally).
6. Deploy the `ecs` stack; confirm the route-impact service consumes analysis jobs.
7. Deploy the `scaling` stack; confirm min 1 / max 5 and the scaling policy.
8. Re-run stage 1 A/B against AWS; then stages 2–3 if budget allows.
9. Repeat each stage three times at the full 10-minute duration, same seed.
10. Identify the AWS bottleneck from CloudWatch, apply **one** targeted improvement,
    repeat the identical workload, compare.
11. Capture outstanding evidence (`docs/EVIDENCE_CHECKLIST.md`).
12. Optional, lowest priority: read-only dashboard. Not needed for this checkpoint.

---

## 6. BLOCKER — AWS CLI and credentials unavailable

**No AWS resource has been created. Nothing about AWS has been verified.**

Observed on this machine:

- `aws` is not on PATH in PowerShell or bash — `aws --version` fails with
  "command not found".
- `~/.aws` does not exist.
- No `AWS_*` environment variables are set.
- Therefore `aws sts get-caller-identity` cannot be run; the account ID and region
  are unknown.

`npm run verify-env` reports:

```
[WARN] AWS CLI          not found - AWS deployment is blocked
[WARN] AWS credentials  no usable credentials - the project still runs fully in local mode
```

**Do not install the AWS CLI without the user asking.** The previous session was
explicitly instructed not to. When the user is ready, they should install it and
supply AWS Academy lab credentials themselves; credentials must never be committed,
printed, or written into tracked files.

Everything else in the project runs without AWS, which is why the local pipeline is
fully verified.

---

## 7. Docker — VERIFIED (no longer a blocker)

Docker Desktop 4.47.0 (engine 28.4.0, Linux engine) was started by the user on
2026-09-04. Everything container-related has now been built and run.

**Images built** (`docker images`):

| Image | Size | Notes |
|---|---|---|
| `sit314-transport-route-impact-worker` | 285 MB | primary autoscaling target |
| `sit314-transport-telemetry-processor` | 285 MB | |
| `sit314-transport-notification-worker` | 285 MB | |
| `sit314-transport-broker` | 484 MB | local dev only, never pushed to ECR |

All four run as the unprivileged `app` user, contain no `.env`, certificate, key
or credential file, and no test files or Dockerfiles. The service images contain
no dev dependencies: `aedes`, `node-red`, `yaml` and `hyperid` are all absent.

**Containers verified functionally**, not merely started:

- telemetry processor consumed a normalised breakdown event, stored state, and
  fanned out `analysisJobs=50`
- route-impact worker processed 12 seeded jobs (received=12 processed=12
  failed=0) and wrote 12 results plus 48 alerts
- notification worker consumed those alerts and wrote 48 delivery records

**Compose stack**: `docker compose --profile workers up -d` brings up six
containers (broker, node-red, bridge, telemetry-processor, route-impact-worker,
notification-worker). Driven by the host simulator publishing 270 events to the
containerised broker, the full pipeline ran end to end: processor 270/270, 8
incidents including the BUS-007 breakdown at 50 jobs, 356 analysis results, 1372
simulated notifications, and **no DLQ was ever created**.

**Graceful shutdown verified via `docker stop`.** With 40 jobs queued, a 1 s
per-job cost and concurrency 4:

```
[SHUTDOWN] SIGTERM received - no new messages will be claimed (inFlight=2)
   ... the 2 in-flight jobs then completed ...
[ROUTE-IMPACT-WORKER-FINAL] received=20 processed=20 failed=0 inFlight=0
docker stop returned in 1s, exit code 0
queue afterwards: pending=20 inflight=0, results=20, DLQ=0
```

20 processed + 20 still queued = the 40 seeded, so nothing was lost, nothing was
left claimed, and nothing was dead-lettered. That is the ECS scale-in safety
property. All three services exit 0 within the grace period; `docker compose
stop` stops the whole stack in 3 s with every container at exit code 0.

**Still blocked (AWS only):** no ECR repository exists, no image has been pushed,
and nothing has run on ECS Fargate. The images are proven locally, not deployed.

**One environment note:** the Compose `node-red` service publishes host port
1880, which collides with a host `npm run node-red`. Stop the host one first.

## 8. Preliminary A/B scalability experiments (LOCAL PRELIMINARY)

### Methodology

Two runs of incident **stage 1** with an **identical seed (3142026)** and an
**identical 550-job workload**, differing only in how the route-impact worker was
scaled:

- **Arm A:** exactly 1 worker task, fixed, no scaling.
- **Arm B:** the backlog-per-task autoscaler, min 1 / max 5.

Configuration common to both arms (from `config.json` in each run directory):

```
incident:  bus-breakdown, BUS-007, route 703, 5 affected locations
           50 analysis jobs and 200 notifications per incident
arrival:   sustained, one incident every 5 s
duration:  45 s injection, 10 s warm-up   (shortened from the planned 600 s)
worker:    concurrency 4, processingDelayMs 50, processingCpuIterations 15,000,000
scaling:   targetBacklogPerTask 75, evaluation every 10 s,
           scale-out cooldown 30 s, scale-in cooldown 60 s
SLA:       p95 latency 5000 ms, oldest-message age 10 s
```

The autoscaler computes, every evaluation interval:

```
BacklogPerTask = ApproximateNumberOfMessagesVisible / max(RunningTaskCount, 1)
```

and scales out when that exceeds the target, in toward the minimum when it falls
well below, respecting the cooldowns.

### Results (measured, not estimated)

| Metric | A: fixed 1 task | B: autoscaled 1→5 |
|---|---|---|
| Jobs injected / processed | 550 / 550 | 550 / 550 |
| Incidents injected | 11 | 11 |
| Throughput | 3.20 jobs/s | **5.41 jobs/s** |
| Elapsed to full drain | 171.7 s | **101.7 s** |
| Mean processing | 485.12 ms | 545.05 ms |
| p95 processing | 750 ms | 857 ms |
| Peak queue depth | 380 | **290** |
| Peak oldest-message age | 140 s | **51 s** |
| Ending queue depth | 0 | 0 |
| Tasks observed | 1 → 1 | 1 → 4 |
| Scale-out / scale-in events | 0 / 0 | 2 / 1 |
| Jobs lost | 0 | 0 |
| Duplicate results | 0 | 0 |
| Duplicate jobs skipped | 0 | 4 |
| DLQ depth | 0 | 0 |
| Stability verdict | UNSTABLE | UNSTABLE |

Scaling events recorded in arm B:

```
16:58:00  scaleOut 1 -> 2   backlogPerTask=130
16:58:30  scaleOut 2 -> 4   backlogPerTask=120
16:58:40  scaleIn  4 -> 3   backlogPerTask=50
```

### Interpretation

Autoscaling raised sustainable throughput by **~69%** and cut peak oldest-message
age by **64%** on an identical workload, with **no job loss and no duplicate
results**. The 4 duplicate jobs skipped in arm B are positive evidence: redelivery
happened during scaling activity and the conditional write absorbed it.

Both arms were classed UNSTABLE by the oldest-message-age criterion. That is the
intended outcome — the experiment locates a breaking point rather than being passed.

### Stage 2 results (measured, 2026-09-04)

Tram track blockage, 250 jobs and 1000 notifications per incident. Both arms
injected **exactly 3 incidents = 750 jobs** with `--incidents 3`, seed 3142026.

| Metric | A: fixed 1 task | B: autoscaled 1→5 |
|---|---|---|
| Jobs injected | 750 | 750 |
| Results produced | 474 | **750** |
| Left unprocessed at drain timeout | 280 | **0** |
| Throughput | 2.93 jobs/s | **7.38 jobs/s** |
| Elapsed | 161.8 s | **101.6 s** |
| p95 processing | 1040 ms | **874 ms** |
| Peak queue depth | 710 | 610 |
| Peak oldest-message age | 145 s | **83 s** |
| Ending queue depth | 270 | **0** |
| Tasks observed | 1 | 1 → 5 |
| Scale-out / scale-in events | 0 / 0 | 2 / 1 |
| Jobs lost / duplicate results / DLQ | 0 / 0 / 0 | 0 / 0 / 0 |
| Verdict | UNSTABLE | UNSTABLE |

The single worker **did not finish the workload**; the autoscaled service
completed every job and drained the queue at 2.5x the throughput. The autoscaled
arm reached the cap of 5 tasks and was still UNSTABLE, which is criterion 3 of the
breaking-point definition. **The LOCAL preliminary breaking point therefore lies
between stage 1 and stage 2.** This is a local-harness result, not a prediction of
the AWS breaking point.

### A methodology defect found and fixed

Injection had been bounded by elapsed time. That gave the two arms *different*
workloads — 1500 jobs fixed versus 750 autoscaled — because enqueuing an incident
is itself work and slows when five workers compete for the same queue. Those runs
were discarded, not promoted. The runner now takes `--incidents N` to bound
injection by count. **Every fixed-vs-autoscale comparison must use it**, including
on AWS; the time bound is only appropriate for a single soak run.

### Stored at

```
evidence/preliminary-scalability/2026-09-03T16-54-39-664Z-incident-stage-1-fixed/
evidence/preliminary-scalability/2026-09-03T16-57-39-857Z-incident-stage-1-autoscale/
evidence/preliminary-scalability/2026-09-04T12-00-15-443Z-incident-stage-2-fixed/
evidence/preliminary-scalability/2026-09-04T12-03-55-929Z-incident-stage-2-autoscale/
```

Each contains `config.json`, `summary.json`, `metrics.csv` (per-second queue depth,
oldest age, task count) and `scaling.csv` (autoscaler decisions).

### Caveats that must be stated in the report

- Local file-backed queue and store, **not** SQS and DynamoDB.
- Local autoscaler, **not** ECS Application Auto Scaling.
- A processing-cost test parameter was active (50 ms + fixed CPU work per job),
  applied identically to both arms.
- Shortened workloads: stage 1 injected for 45 s, stage 2 injected 3 incidents,
  rather than the planned 10-minute stages. One repeat per arm, not three.
- Stages 3 and 4 are configured and runnable but have not been executed.

---

## 9. Known limitations of the local file-backed queue harness

`shared/aws/local-queue.js` is roughly 200 lines that reproduce the parts of the SQS
contract the workers depend on. It is deliberately **not** a general AWS emulator.

What it does reproduce: long polling, per-message visibility timeout, receive count,
redrive to a DLQ after a finite max receive count, atomic single-consumer claim
across OS processes, and SQS-shaped depth/oldest-age attributes.

What it does **not** reproduce:

1. **Durability and distribution.** One machine, one filesystem. No replication, no
   server-side encryption, no cross-AZ behaviour.
2. **Throughput characteristics.** Its ceiling is local disk I/O — which is itself
   the bottleneck identified in the preliminary experiment. AWS SQS will have a
   completely different performance profile, so the local breaking point does **not**
   predict the AWS breaking point.
3. **SQS API limits.** No 10-message batch ceiling, no 256 KB message size limit, no
   120,000 in-flight message cap, no 14-day retention enforcement.
4. **Delivery semantics detail.** It is at-least-once like SQS, but the duplication
   patterns differ; AWS duplicates arise from distributed visibility, here they arise
   from timeout expiry.
5. **Ordering.** Messages are claimed from a bounded scan window at a random offset
   to reduce contention, so ordering is approximate — as with standard SQS, but for a
   different reason.
6. **No server-side metrics.** Depth and age are computed by reading the directory,
   not published by a service.

The important property is that **the workers contain no local/AWS branching**. They
only see the adapter interface, so the business logic verified locally is literally
the same code that will run against SQS.

---

## 10. Test results

```
Command: npm test
Result:  tests 158 | pass 158 | fail 0 | duration ~8 s
```

The suite was previously intermittently red (roughly 1 run in 3). Two tests were
wall-clock dependent and failed under the parallel test-file load: the simulator
determinism test bounded its runs by duration so two same-seed runs completed a
different number of ticks, and the processing-cost test compared an un-delayed run
against a delayed one on the clock. Both are fixed, and the suite has since been
verified green five consecutive times.

Static infrastructure validation is a separate gate:

```
Command: npm run lint:infra
Result:  cfn-lint: no findings across all templates.
```

cfn-lint is a Python tool (`pip install --user cfn-lint`) and is entirely
offline — it never calls AWS, unlike `aws cloudformation validate-template`.
`scripts/lint-infra.js` falls back to invoking it through Python when the
console script is not on PATH, which is the normal situation on Windows after a
`--user` install. It exits 0 on the current templates and non-zero on a broken
one, so it is usable as a gate.

Areas covered: RNG determinism and stream independence; all four generators against
their schemas; CLI/config resolution and rejection of bad configuration; corruption
injection (every corruption yields a rejection with a reason, deterministic per
seed); duplicate-rate republishing the same eventId; schema validation valid/invalid
for all four modes; **the real Node-RED function-node source executed against
fixtures**; local queue claim/visibility/receive-count/DLQ/attributes; store
conditional-write semantics; telemetry processor state update, crowding, disruption
detection, fan-out size, duplicate suppression, stale-event rejection;
route-impact worker deterministic ETA, mode-specific impact, duplicate job skipped,
alert generation, failure does not delete the message; notification worker delivery
record, duplicate skipped, controlled failure; CloudFormation templates parse and
contain required resources.

---

## 11. Infrastructure templates already created

`infrastructure/cloudformation/`

| Template | Creates | Key parameters |
|---|---|---|
| `queues.yaml` | 3 queues + 3 DLQs with redrive policies, long polling, per-queue visibility timeouts | `ResourcePrefix`, `MaxReceiveCount`, `TelemetryVisibilityTimeout`, `AnalysisVisibilityTimeout`, `NotificationVisibilityTimeout`, `MessageRetentionSeconds`, `Owner`, `Environment` |
| `dynamodb.yaml` | 4 on-demand tables: processed-events, current-state, analysis-results, notifications | `ResourcePrefix`, `Owner`, `Environment` |
| `iot-rule.yaml` | IoT rule `transport/normalized/+` → telemetry queue, plus error log group | `ResourcePrefix`, `QueuesStackName`, `ExistingIotRuleRoleArn`, `Owner`, `Environment` |
| `ecs.yaml` | Fargate cluster, 3 task definitions, services, log groups | `ResourcePrefix`, `QueuesStackName`, `TablesStackName`, `VpcId`, `SubnetIds`, `RouteImpactImage`, `TelemetryProcessorImage`, `NotificationWorkerImage`, `ExistingExecutionRoleArn`, `ExistingTaskRoleArn`, `TaskCpu`, … |
| `scaling.yaml` | Application Auto Scaling target + policy on the route-impact service | `ResourcePrefix`, `EcsStackName`, `QueuesStackName`, `ScalingMode`, `MinTasks`, `MaxTasks`, `TargetBacklogPerTask`, `TargetQueueDepth`, `ScaleOutCooldown`, `ScaleInCooldown`, `MetricNamespace` |

Every template takes `ExistingRoleArn`-style parameters so a restricted account can
supply lab roles and the stack never attempts role creation. No template hardcodes
an account ID. No template creates an IAM user or an access key.

`infrastructure/lambda/` holds the Node.js function that publishes the custom
`BacklogPerTask` metric, for the preferred scaling path.

`infrastructure/test/templates.test.js` validates the templates in the test suite.

---

## 12. Scripts already created

**Root npm scripts** (`package.json`):

| Script | Purpose |
|---|---|
| `npm test` / `test:all` | Full suite, 150 tests |
| `npm run verify-env` | Capability/blocker report |
| `npm run simulate` | The simulator CLI |
| `npm run broker` | Local aedes MQTT broker |
| `npm run node-red` | Node-RED with project settings and flow |
| `npm run bridge` | Normalised MQTT → telemetry queue (local IoT-rule substitute) |
| `npm run tap` | Subscribe to MQTT topics for evidence |
| `npm run processor` | Telemetry processor |
| `npm run route-worker` | Route-impact / ETA worker |
| `npm run notification-worker` | Notification worker |
| `npm run autoscaler` | Local backlog-per-task autoscaler |
| `npm run experiment` | Experiment runner |
| `npm run queue:stats` | Depth / in-flight / DLQ for all queues |
| `npm run state:dump` | Dump items from a table |
| `npm run evidence` | List or promote experiment evidence |
| `npm run demo:local` | Whole local pipeline in one command |
| `npm run demo:checkpoint` | Checkpoint demo with backend preflight |
| `npm run demo:reliability` | Duplicate / stale / retry / DLQ evidence (E12) |
| `npm run lint:infra` | cfn-lint over the CloudFormation stacks |
| `npm run flows:build` / `flows:check` | Generate / verify `node-red/flows.json` |

**Infrastructure scripts** (`infrastructure/scripts/`): `deploy.ps1`, `deploy.sh`,
`describe.sh`, `build-and-push.ps1`, `cleanup.sh`.

`deploy.ps1` takes `-Stacks queues,tables,iot-rule,ecs,scaling`, a `-Prefix`
(default `sit314-transport`), a `-Region`, and the `-Existing*RoleArn` parameters
for restricted accounts.

**Experiment configurations:** `experiments/incident/stage-{1..4}.json` and
`experiments/telemetry-growth/stage-{1..8}.json`.

---

## 13. Exact next commands for a fresh session

Reconstruct state and confirm nothing regressed:

```bash
cd "C:/Users/lorenzodario/Documents/UNI/UNI_T3/CLoud/Distinction"
git status
git log --oneline --decorate -10
npm install
npm run verify-env
npm test
```

Re-run the verified local pipeline (needs two terminals):

```bash
npm run node-red          # terminal 1, leave running
npm run demo:local        # terminal 2
```

Re-run the A/B experiment locally (about 5 minutes total):

```bash
npm run experiment -- --config experiments/incident/stage-1.json --worker-mode fixed --duration-seconds 45
npm run experiment -- --config experiments/incident/stage-1.json --worker-mode autoscale --duration-seconds 45
npm run evidence
```

**Only when the user explicitly asks**, begin AWS work:

```bash
aws --version
aws sts get-caller-identity      # never print or commit the output
```

---

## 14. AWS deployment order

1. **AWS IoT Core** — create thing, certificate, policy; download certs into
   `certs/` (gitignored); record the endpoint in `.env`. Verify by subscribing to
   `transport/raw/#` in the IoT MQTT test client while the simulator publishes with
   `--target mqtt --mqtt-mode aws`.
2. **SQS + DLQs** — `deploy.ps1 -Stacks queues`. Verify with `describe.sh` and the
   SQS console; confirm each redrive policy points at the right DLQ.
3. **DynamoDB** — `deploy.ps1 -Stacks tables`. Verify all four tables exist and are
   on-demand.
4. **IoT Rule** — `deploy.ps1 -Stacks iot-rule`. Verify by publishing a normalised
   message and confirming the telemetry queue depth increases.
5. **ECR + images** — start Docker Desktop, then `build-and-push.ps1`. Verify the
   image URIs exist in ECR.
6. **ECS Fargate** — `deploy.ps1 -Stacks ecs -RouteImpactImage <uri> -VpcId … -SubnetIds …`.
   Verify a RUNNING task and `[ANALYSIS]` lines in CloudWatch Logs.
7. **CloudWatch** — confirm log groups, and that the `SIT314/Transport` namespace
   receives metrics once `METRICS_BACKEND=aws`.
8. **Application Auto Scaling** — `deploy.ps1 -Stacks scaling`. Verify with
   `describe-scalable-targets` and `describe-scaling-policies` that min is 1 and max
   is 5.
9. Other workers only if time and budget allow. The route-impact worker is the
   priority.

**Verify every step. Never assume a deployment succeeded because the command
returned.** Capture the actual describe output.

---

## 15. AWS Academy restrictions to watch for

- **Do not create IAM users or long-lived access keys.** Ever.
- Role creation is commonly denied. Pass the lab role (usually `LabRole`) via
  `-ExistingExecutionRoleArn`, `-ExistingTaskRoleArn`, `-ExistingIotRuleRoleArn`,
  `-ExistingLambdaRoleArn` so the templates skip role creation.
- `iam:PassRole` may be denied. If so: capture the exact error, do not retry the
  same forbidden call repeatedly, leave the template ready, and record the blocker.
- Lambda creation may be denied. If the `BacklogPerTask` custom-metric Lambda cannot
  be created, switch `scaling.yaml`'s `ScalingMode` to the queue-depth fallback and
  **document the deviation honestly** in `docs/IMPLEMENTATION_DECISIONS.md`. Never
  describe queue-depth scaling as backlog-per-task.
- Lab sessions expire; credentials are temporary and must be refreshed.
- Some regions are restricted. Respect any already-configured CLI region rather than
  assuming one.
- Never weaken security to get past a restriction.

---

## 16. Cost precautions

- SQS, DynamoDB on-demand, and IoT Core at test scale are effectively free at this
  volume.
- Fargate tasks are 0.25 vCPU / 0.5 GB — the smallest sensible size.
- **No NAT Gateway.** Tasks run in public subnets with public IPs. This is a
  deliberate, documented cost/security trade-off (`docs/SECURITY.md`).
- **No load balancer.** The worker polls SQS, so it does not need one.
- Do not leave 5 tasks running. Return the service toward min 1 after a test.
- Keep CloudWatch log retention short.
- No SMS, email or paid notification service is ever contacted — deliveries are
  simulated and the schema enforces `simulated: true`.
- Run `infrastructure/scripts/cleanup.sh` when finished. It is scoped exclusively to
  stacks carrying this project's prefix and must never be run automatically.

---

## 17. Evidence still needed

Full detail in `docs/EVIDENCE_CHECKLIST.md` (E01–E12). Outstanding, in order:

1. **E12** — terminal capture of a deliberate DLQ redrive. No AWS needed:
   `FAILURE_INJECTION_ENABLED=true FAILURE_RATE=1 npm run route-worker`, then
   `npm run queue:stats`.
2. **E04** — Node-RED debug pane showing accepted and rejected side by side, driven
   by `npm run simulate -- --invalid-rate 0.2 --target mqtt`.
3. **E01** — two simulator configurations side by side showing Volume and Velocity
   changing without a source edit.
4. **E02, E05, E06** — AWS IoT MQTT test client, SQS console, DynamoDB console.
   Blocked on credentials.
5. **E08, E09, E11** — ECS task running, autoscaling min 1 / max 5, task count
   rising under backlog. Blocked on credentials and Docker.

Already captured: E01, E03, E04, E07, E10, E12 (idempotency half), and the local
halves of E05, E06, E11.

---

## 18. Volume, Velocity and Variety

**Volume** — entity counts, duration and incident fan-out are all runtime
configuration:

```bash
npm run simulate -- --buses 100 --trams 25 --trains 15 --locations 100 --interval-ms 1000
```

Fan-out per stage: 50 / 250 / 750 / 1500 analysis jobs and 200 / 1000 / 5000 / 10000
notifications. Configured as **totals**, so each stage lands exactly on its figure.

**Velocity** — the reporting interval is a flag, so the same fleet can be driven at
10, 20 or 100 events/s. Independently, `incidentIntervalSeconds` in the stage files
controls the analysis-job arrival rate that drives scaling. Volume is *how much*;
Velocity is *how fast it arrives*.

**Variety** — four structurally different payloads: buses have
`roadSegmentId`/`nextStopId`, trams have `trackSegmentId`/`direction`, trains have
`stationId`/`platform`/`carriageCount`, and demand events have **no vehicle, speed
or capacity at all**. Health vocabularies differ per mode: `breakdown` / `blocked` /
`cancelled`. Node-RED has four separate visible validation branches before a single
normalisation node, and normalisation preserves mode-specific fields under
`modeData`.

---

## 19. Breaking point definition

The breaking point is **the lowest sustained workload at which the system can no
longer maintain its preliminary performance and reliability targets**. It is *not*
where the application crashes.

A stage is **unstable** when the incident queue keeps growing during the final
window **and at least one** of these holds:

1. p95 route-impact latency stays above 5 s;
2. age of the oldest message stays above 10 s;
3. the service is at 5 tasks and throughput is still below arrival rate;
4. jobs are lost;
5. jobs are duplicated;
6. valid workload lands in the DLQ.

These are preliminary thresholds, refinable once baseline data exists. The runner
evaluates them automatically and records which specific criteria were breached — in
both preliminary runs the breach was criterion 2 (oldest-message age).

---

## 20. Autoscaling design

**Primary target: the route-impact / ETA ECS service. Min 1 task, max 5 tasks.**
The notification worker is secondary.

Signal:

```
BacklogPerTask = ApproximateNumberOfMessagesVisible / max(RunningTaskCount, 1)
```

Preliminary target ≈ 50–100 queued jobs per active task; the implementation
defaults to 75 and is configurable.

Preferred implementation: a small Node.js Lambda publishes `BacklogPerTask` to
CloudWatch, and a target-tracking policy on the ECS service scales against it.
Fallback if Lambda or the custom metric is denied: a queue-depth policy, selected by
`ScalingMode` and **labelled as queue depth, not backlog per task**.

Intended behaviour: backlog rises → scale out → extra workers drain the queue →
queue stabilises → scale back toward the minimum. Cooldowns (30 s out, 60 s in in
the experiment configs) are set so the behaviour is visible in a demo without
oscillating.

Why the route-impact worker is the right target: one incident fans out into many
**independent** jobs, so the work is embarrassingly parallel; the worker is
stateless and polls SQS, so adding tasks needs no load balancer and no coordination;
and idempotent conditional writes make redelivery during scaling safe.

---

## 21. Git state

```
Branch:  main
Remote:  none configured — nothing has been or should be pushed
Status:  clean at the end of the 2026-09-04 hardening session
```

Confirm the current commit with `git rev-parse HEAD`. Commit history, newest
first:

```
818dcc3 fix: make the infrastructure lint script work when cfn-lint is not on PATH
f60923c docs: record stage 2 results, reliability evidence and the new engineering decisions
651d54a feat: add a non-destructive --check mode to the local pipeline demo
afdbb60 test: make the concurrent-consumer queue test terminate on the workload, not on empty polls
c0678ad fix: make the simulator --out flag actually write events, and record telemetry-growth results
a85c8ca chore: move aedes to devDependencies and record the dependency audit
c8f1e69 feat: bound experiment injection by incident count, and add stage 2 A/B evidence
c54b234 docs: add a sixteen-step PowerShell runbook for the live AWS session
4c707c3 infra: fix deploy-blocking template defects found by static validation
e7dd8f9 feat: add reliability demonstration for duplicate, stale, retry and DLQ evidence
f7f9fbe test: cover the shared worker loop's delete, retry and DLQ redrive guarantees
dbf4d83 test: remove wall-clock flakiness from simulator and worker tests
6dba859 docs: add README, project status, evidence checklist and handoff
```

Git identity is already configured on this machine, so commits are possible. **Do
not change the global Git identity, and do not falsify commit dates.** No remote
exists; leave the repository local unless the user configures one.

`local-data/`, `artifacts/`, `node-red/data/`, `.env` and `certs/*` are gitignored.
No secret, key, certificate or account ID is in the repository.

---

## 22. What changed in the 2026-09-04 hardening session

No AWS was contacted. Summary of substantive changes:

- Fixed three timing-dependent tests that made the suite intermittently red
  (about one run in three). Suite is now 159 tests, green.
- Added integration tests for the shared worker loop, covering the delete /
  retain / redrive guarantees that were previously only tested at each end.
- Added `npm run demo:reliability`, a one-command E12 evidence producer.
- Static CloudFormation validation found and fixed two genuine deploy blockers:
  `scaling.yaml`'s Description exceeded CloudFormation's 1024-character limit,
  and the task role granted non-existent `sqs:*Batch` IAM actions.
- Constrained the optional existing-role parameters to "empty or a valid role
  ARN", and updated the metric Lambda off the deprecated nodejs20.x runtime.
- Found and fixed a methodology defect: time-bounded injection gave the two A/B
  arms different workloads. Added `--incidents N`.
- Ran the stage 2 A/B and promoted it to evidence.
- Moved `aedes` to devDependencies; `npm audit --omit=dev` is now clean.
- Fixed the simulator's `--out` flag, which parsed but never wrote a file.
- Added a sixteen-step PowerShell runbook for the live AWS session.

## 23. Working practice for the next session

- The repository on disk is the source of truth. Inspect before changing.
- Do not rebuild components that already work — check first.
- Keep this file updated **as you go**, not at the end. The first session died with
  its handoff unwritten.
- Run `npm test` after each coherent phase and fix failures rather than documenting
  them.
- Never claim an AWS deployment, a test result, a measurement or a screenshot that
  was not actually produced.
- Do not mention automated tooling in repository files, documentation, comments or
  commit messages.
