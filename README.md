# Scalable Multimodal IoT Public Transport Monitoring System

> **Repository snapshot:** The inherited README below describes the earlier Distinction baseline. The completed High Distinction predictive-scaling study has 12 valid AWS runs; see [HD formal progress](HD_FORMAL_PROGRESS.md), [HD report draft](docs/HD_REPORT_DRAFT.md), and [final data](docs/hd-final-data/). Saved run artifacts are included. See [GitHub preparation notes](GITHUB_PREP_NOTES.md) for the export scope.

SIT314 Distinction Project — Lorenzo Dario Ben

A simulated public transport authority monitors buses, trams, trains and passenger
demand, detects operational disruption, and models the route impact of that
disruption using a queue-decoupled, automatically scaled microservice pipeline.

The system is built so that the scalability claims can be **measured**, not asserted:
a seeded workload generator, per-stage experiment configurations, and a
backlog-per-task autoscaler that can be run with a fixed worker count or with
autoscaling enabled, using an identical workload for both.

---

## Architecture

```mermaid
flowchart LR
    SIM[Node.js Multimodal Simulator]
    IOT[AWS IoT Core]
    NR[Node-RED<br/>validation + normalisation]
    RULE[AWS IoT Rule]
    TQ[SQS Telemetry Queue]
    TP[Telemetry Processor]
    DB[(DynamoDB)]
    AQ[SQS Analysis Queue]
    ETA[Route Impact / ETA Workers<br/>ECS Fargate, min 1 / max 5]
    NQ[SQS Notification Queue]
    NW[Notification Worker]
    CW[CloudWatch]

    SIM -->|MQTT/TLS| IOT
    IOT --> NR
    NR -->|normalised| IOT
    IOT --> RULE
    RULE --> TQ
    TQ --> TP
    TP --> DB
    TP -->|disruption fan-out| AQ
    AQ --> ETA
    ETA --> DB
    ETA --> NQ
    NQ --> NW
    NW --> DB
    TP --> CW
    ETA --> CW
```

The **route-impact / ETA worker is the primary autoscaling target**. It polls the
analysis queue, so it needs no load balancer — which also keeps the cost near zero.

Full detail, including why each component exists: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Repository structure

```
schemas/            JSON Schema (draft 2020-12) for all 8 message types
simulator/          Configurable multimodal IoT simulator (Volume/Velocity/Variety)
node-red/           Flow-based validation + normalisation, with per-mode branches
shared/             Config, logging, validation, queue/store/metrics adapters
services/
  telemetry-processor/   SQS -> DynamoDB state + disruption fan-out
  route-impact-worker/   SQS -> deterministic ETA/impact -> results + alerts
  notification-worker/   SQS -> simulated delivery records
experiments/        Incident stages 1-4, telemetry-growth stages, experiment runner
infrastructure/     CloudFormation stacks + PowerShell/bash deployment scripts
scripts/            Local broker, bridge, autoscaler, demos, evidence tooling
docs/               Architecture, deployment, scalability, security, status
evidence/           Curated measurements cited by the report
```

---

## Prerequisites

| Tool | Required | Notes |
|---|---|---|
| Node.js 20+ | Yes | Developed on v22.19.0 |
| npm | Yes | Workspaces are used |
| Docker | For containers only | Verified with Docker Desktop 4.47.0 |
| AWS CLI | For AWS deployment only | Installed and verified, `aws-cli/2.36.39` |
| AWS credentials | For AWS deployment only | Not configured on this machine |

Everything except container builds and AWS deployment runs with Node.js alone.

```bash
npm install
npm run verify-env
```

`verify-env` prints exactly which capabilities are available and which are blocked.

---

## Local setup and the full pipeline

The whole pipeline runs locally with no AWS account. Node-RED is a long-running
editor process, so it is started separately:

```bash
npm run node-red
```

Then, in a second terminal:

```bash
npm run demo:local
```

This starts the local MQTT broker, the normalised→queue bridge, the telemetry
processor and both workers, runs the checkpoint scenario through them, and prints
what ended up in each queue and table.

Node-RED's editor is at <http://127.0.0.1:1880> and the flow is importable from
`node-red/flows.json`.

---

## Simulator examples

Volume and Velocity are both command-line controlled — no source edits:

```bash
npm run simulate -- --buses 10 --trams 5 --trains 2 --locations 10 --interval-ms 5000
```

```bash
npm run simulate -- --buses 100 --trams 25 --trains 15 --locations 100 --interval-ms 1000
```

Publish to the local broker instead of stdout, with a disruption scenario:

```bash
npm run simulate -- --scenario bus-breakdown --disrupt-vehicle BUS-007 --target mqtt --duration-seconds 60
```

Prove Node-RED's rejection path by deliberately corrupting 5% of events:

```bash
npm run simulate -- --invalid-rate 0.05 --target mqtt --duration-seconds 30
```

Key flags: `--buses --trams --trains --locations --interval-ms --duration-seconds
--seed --scenario --target --mqtt-mode --invalid-rate --duplicate-rate
--disrupt-vehicle --out`. Run `npm run simulate -- --help` for the full list.

Scenarios: `normal`, `bus-breakdown`, `tram-blockage`, `train-cancellation`,
`multimodal-disruption`.

**Determinism:** the same `--seed` plus the same configuration reproduces the same
logical workload. This is what makes the fixed-worker and autoscaled experiments
comparable.

---

## The three Vs

**Volume** — the number of buses, trams, trains and demand locations, the run
duration, and the incident fan-out size are all runtime configuration. One incident
fans out into 50, 250, 750 or 1500 independent analysis jobs depending on stage.

**Velocity** — the reporting interval is a flag. The same fleet reporting every
10s, 5s or 1s produces three different arrival rates against identical Volume.

**Variety** — four genuinely different payload shapes, not four renamed copies.
Buses carry `roadSegmentId`/`nextStopId`, trams carry
`trackSegmentId`/`direction`, trains carry `stationId`/`platform`/`carriageCount`,
and location-demand events have no vehicle, speed or capacity at all. Health
vocabularies differ per mode (`breakdown` / `blocked` / `cancelled`). Node-RED has a
separate, visible validation branch per mode before normalisation.

---

## Node-RED

The flow implements:

```
MQTT in (transport/raw/#)
   -> identify mode
      -> validate bus     -\
      -> validate tram     |-> normalise -> MQTT out (transport/normalized/<mode>)
      -> validate train    |
      -> validate demand  -/
      -> reject -> MQTT out (transport/rejected/<mode>) + debug
```

Function-node source lives in `node-red/functions/*.js` and `flows.json` is
generated from it by `npm run flows:build` (`npm run flows:check` verifies they are
in sync). This keeps the flow visually inspectable in the editor **and**
unit-testable — `node-red/test/flow.test.js` executes the real function-node source
against fixtures.

See [node-red/README.md](node-red/README.md).

---

## AWS configuration

Copy `.env.example` to `.env` and fill in the endpoint and certificate paths:

```
AWS_REGION=us-east-1
AWS_IOT_ENDPOINT=xxxxxxxx-ats.iot.us-east-1.amazonaws.com
AWS_IOT_CERT_PATH=certs/device.pem.crt
AWS_IOT_PRIVATE_KEY_PATH=certs/private.pem.key
AWS_IOT_CA_PATH=certs/AmazonRootCA1.pem
QUEUE_BACKEND=aws
STORE_BACKEND=aws
METRICS_BACKEND=aws
```

`.env` and `certs/*` are gitignored. Nothing secret is ever committed or logged.
The simulator fails with an explicit message if `--mqtt-mode aws` is selected but
the TLS configuration is missing.

Deployment sequence: [docs/AWS_DEPLOYMENT.md](docs/AWS_DEPLOYMENT.md).

---

## Testing

```bash
npm test
```

169 tests currently pass, covering the RNG determinism, all four generators, CLI
and config resolution, corruption injection, schema validation, the real Node-RED
function-node source, the local queue's visibility-timeout and DLQ redrive
behaviour, conditional-write idempotency, the telemetry processor's disruption
detection and fan-out, the route-impact ETA model, the notification worker, and the
CloudFormation templates.

Static infrastructure validation is a separate gate (requires `cfn-lint`, which is
installed with `pip install --user cfn-lint`):

```bash
npm run lint:infra
```

It reports no findings across all five stacks. It is fully offline — it never
contacts AWS.

Reliability behaviour has its own one-command demonstration:

```bash
npm run demo:reliability
```

It runs four controlled scenarios — duplicate event, stale telemetry, retry after
worker failure, and DLQ redrive with a healthy message proven untouched — and
prints a PASS/FAIL summary.

---

## Docker

Ingestion only (broker + Node-RED):

```bash
docker compose up -d
```

The whole pipeline, six containers:

```bash
docker compose --profile workers up -d
docker compose ps
```

That brings up the broker, Node-RED, the normalised-to-queue bridge (the local
stand-in for the AWS IoT rule) and the three services, all sharing one volume.
Before publishing, wait until the Node-RED logs say both `Started flows` and
`Connected to broker`; `docker compose up -d` only confirms that the container
started, not that the MQTT subscription is ready. Then drive it from the host:

```bash
docker compose logs --tail 30 node-red
npm run simulate -- --scenario bus-breakdown --disrupt-vehicle BUS-007 --target mqtt --duration-seconds 20
docker compose logs telemetry-processor route-impact-worker
```

If another local MQTT broker already owns loopback port 1883, select a different
**host** port while leaving the Compose services on their internal port 1883:

```powershell
$env:MQTT_HOST_PORT = '1884'
docker compose --profile workers up -d
$env:MQTT_LOCAL_PORT = '1884'
npm run simulate -- --scenario bus-breakdown --disrupt-vehicle BUS-007 --target mqtt --duration-seconds 20
```

**Verified**, not just written: all four images build, run as a non-root `app`
user, contain no secrets and no dev dependencies, process real work, and exit 0
on `docker stop` after finishing in-flight jobs. A run of the full stack
processed 270 events into 356 route-impact results and 1372 simulated
notifications with nothing dead-lettered.

Note that the Compose `node-red` service publishes host port 1880, so stop a host
`npm run node-red` first.

**Not yet done:** no image has been pushed to ECR and nothing has run on ECS
Fargate — that is AWS deployment, which remains outstanding.

---

## Deployment

```powershell
./infrastructure/scripts/deploy.ps1 -Stacks queues,tables
./infrastructure/scripts/deploy.ps1 -Stacks iot-rule
./infrastructure/scripts/build-and-push.ps1
$AccountId = aws sts get-caller-identity --query Account --output text
$Image = "$AccountId.dkr.ecr.$env:AWS_REGION.amazonaws.com/sit314-transport-route-impact-worker:latest"
$Vpc = aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query "Vpcs[0].VpcId" --output text
$Subnets = (aws ec2 describe-subnets --filters "Name=vpc-id,Values=$Vpc" --query "Subnets[].SubnetId" --output text) -split "\s+"
./infrastructure/scripts/deploy.ps1 -Stacks ecs -RouteImpactImage $Image -VpcId $Vpc -SubnetIds $Subnets
./infrastructure/scripts/deploy.ps1 -Stacks scaling
```

Stacks are `queues`, `tables`, `iot-rule`, `ecs`, `scaling`, deployed in that
dependency order. Every stack is scoped by `-Prefix sit314-transport`. In a
restricted account, pass the existing lab role ARNs (`-ExistingExecutionRoleArn`
and friends) so the templates never attempt role creation. The image-push
script creates or verifies ECR, logs Docker in, builds, tags, pushes and verifies
the image digest before the ECS command is allowed to run. See the full
read-only Academy preflight and live gates in `docs/AWS_DEPLOYMENT.md`.

---

## Scalability experiments

```bash
# Experiment A - one fixed worker
npm run experiment -- --config experiments/incident/stage-1.json --worker-mode fixed

# Experiment B - identical seed and workload, autoscaled 1..5
npm run experiment -- --config experiments/incident/stage-1.json --worker-mode autoscale
```

Each run writes `config.json`, `summary.json`, `metrics.csv` and `scaling.csv` to a
timestamped directory under `artifacts/runs/`. Promote a run into the committed
evidence set with `npm run evidence -- --promote latest`.

**Preliminary measured result** (local backends, stage 1, seed 3142026, identical
550-job workload, 50 ms processing cost + fixed CPU work per job):

| | Fixed 1 worker | Autoscaled 1→5 |
|---|---|---|
| Throughput | 3.20 jobs/s | **5.41 jobs/s** |
| Time to drain | 171.7 s | **101.7 s** |
| Peak queue depth | 380 | **290** |
| p95 processing | 750 ms | 857 ms |
| Tasks observed | 1 | 1 → 4 (2 scale-outs, 1 scale-in) |
| Jobs lost / duplicated results / DLQ | 0 / 0 / 0 | 0 / 0 / 0 |

Autoscaling raised sustainable throughput by ~69% on an identical workload with no
job loss and no duplicate results.

**Stage 2** (tram blockage, identical 750-job workload in both arms via
`--incidents 3`) is the clearer result:

| | Fixed 1 worker | Autoscaled 1→5 |
|---|---|---|
| Results produced | 474 of 750 | **750 of 750** |
| Left queued at drain timeout | 280 | **0** |
| Throughput | 2.93 jobs/s | **7.38 jobs/s** |
| Peak oldest-message age | 145 s | **83 s** |
| Tasks observed | 1 | 1 → 5 |
| Jobs lost / duplicated / DLQ | 0 / 0 / 0 | 0 / 0 / 0 |

The single worker never finished the workload at all, while the autoscaled service
completed every job and drained the queue. Both stages are still classed UNSTABLE
by the oldest-message-age criterion, which is the expected and useful outcome — it
locates a breaking point rather than declaring success. The autoscaled stage 2 arm
reached the cap of 5 tasks and was still behind, so the **local preliminary
breaking point lies between stage 1 and stage 2** (local harness only, not a
prediction of the AWS breaking point).

Formal AWS comparisons use the separate count-bounded runner, which never starts
local consumers of SQS:

```bash
npm run experiment:aws -- --config experiments/incident/stage-1.json --worker-mode fixed --repeat 1
npm run experiment:aws -- --config experiments/incident/stage-1.json --worker-mode autoscale --repeat 1
```

It requires temporary AWS credentials and creates raw evidence under
`artifacts/aws-runs/`; see `docs/SCALABILITY_TESTING.md` and
`docs/AWS_DEPLOYMENT.md`. The existing `npm run experiment` command remains the
local preliminary harness.

Methodology, thresholds and the breaking-point definition:
[docs/SCALABILITY_TESTING.md](docs/SCALABILITY_TESTING.md).

---

## Security

- MQTT to AWS IoT Core uses mutual TLS on port 8883.
- No credentials, keys, certificates or account IDs are committed; `.gitignore`
  covers `.env`, `certs/*`, `*.pem`, `*.key`, `*.crt`.
- No IAM users and no long-lived access keys are created. Templates accept
  existing role ARNs so restricted accounts are supported.
- Queues and tables are never public; access is by IAM role only.
- Failure injection is off by default and must be switched on explicitly.
- Notifications are simulated — no SMS, email or paid service is ever contacted.

Full detail: [docs/SECURITY.md](docs/SECURITY.md).

---

## Cleanup

AWS resources are removed by deleting the project's own CloudFormation stacks, in
reverse dependency order. The cleanup script is scoped exclusively to resources
carrying this project's prefix and is never run automatically:

```bash
./infrastructure/scripts/cleanup.sh
```

Local state is disposable: delete `local-data/` and `artifacts/`.

---

## Current project status

The complete pipeline is **verified working locally**, end to end, including
Node-RED, MQTT, queueing, idempotent processing, disruption fan-out, the ETA
worker, simulated notifications, and a measured autoscaling comparison.

**Not yet deployed to AWS.** The AWS CLI is installed and locally verified
(`aws-cli/2.36.39`), but no credentials are configured and no authenticated call
has been made, so no AWS resource has been created. The CloudFormation templates,
deployment scripts and AWS SDK adapters are written and tested but remain
unverified against a real account.

Precise, per-component status with VERIFIED / IMPLEMENTED-NOT-DEPLOYED / PARTIAL /
BLOCKED labels: [docs/STATUS_4.2D.md](docs/STATUS_4.2D.md).
Handoff for continuing the work: [HANDOFF.md](HANDOFF.md).
