# Project status — 4.2D checkpoint

Engineering status source for the progress report. This is **not** the report
itself.

Status labels used throughout:

| Label | Meaning |
|---|---|
| **VERIFIED** | Executed on this machine and the output was observed |
| **IMPLEMENTED, NOT YET DEPLOYED** | Code/templates written and unit-tested, but never run against the real service |
| **PARTIAL** | Works, with a stated limitation |
| **BLOCKED** | Cannot proceed because of an external dependency |
| **NOT STARTED** | No implementation |

Last updated: 2026-09-04. Commit: see `git log -1`.

---

## 1. Current architecture

```
Node.js multimodal simulator
    -> MQTT (TLS in AWS mode)
    -> AWS IoT Core            [local: aedes broker]
    -> Node-RED validation + normalisation (per-mode branches)
    -> AWS IoT Rule            [local: normalised->queue bridge]
    -> SQS telemetry queue     [local: file-backed queue]
    -> Telemetry processor -> DynamoDB current state
                           -> disruption detection -> fan-out
    -> SQS analysis queue
    -> Route-impact / ETA worker  (PRIMARY AUTOSCALING TARGET, ECS Fargate, min 1 max 5)
                           -> DynamoDB analysis results
                           -> SQS notification queue
    -> Notification worker -> DynamoDB simulated delivery records

CloudWatch: queue depth, oldest-message age, processing latency, task count
Application Auto Scaling: backlog-per-task on the route-impact service
```

The implemented architecture matches this diagram. The only substitution is the
local development path noted in brackets, which exists because no AWS account is
available on this machine — see section 11.

---

## 2. Implemented components

| Component | Status |
|---|---|
| JSON Schemas (8 message types, draft 2020-12) | **VERIFIED** |
| Deterministic seeded RNG | **VERIFIED** |
| Synthetic transport network (routes, stops, stations, fleet) | **VERIFIED** |
| Bus / tram / train / demand generators | **VERIFIED** |
| Simulator CLI + config resolution + stage-file loading | **VERIFIED** |
| Disruption scenarios (5) | **VERIFIED** |
| Invalid-event and duplicate-event injection | **VERIFIED** |
| MQTT client abstraction (local TCP + AWS TLS paths) | **PARTIAL** — local VERIFIED, AWS TLS path BLOCKED |
| Local MQTT broker (aedes) | **VERIFIED** |
| Node-RED flow with per-mode validation branches | **VERIFIED** |
| Node-RED function source + generated `flows.json` + sync check | **VERIFIED** |
| Local file-backed queue (visibility timeout, DLQ redrive, long poll) | **VERIFIED** |
| Real SQS adapter (AWS SDK v3) | **IMPLEMENTED, NOT YET DEPLOYED** |
| Local file-backed store with conditional writes | **VERIFIED** |
| Real DynamoDB adapter (conditional expressions) | **IMPLEMENTED, NOT YET DEPLOYED** |
| Metrics adapter (local CSV + CloudWatch) | **PARTIAL** — local VERIFIED, CloudWatch not deployed |
| Telemetry processor (idempotency, state, crowding, delay, fan-out) | **VERIFIED** |
| Route-impact / ETA worker | **VERIFIED** |
| Notification worker (simulated delivery) | **VERIFIED** |
| Graceful SIGTERM shutdown in all three services | **VERIFIED** |
| Dockerfiles for all three services + `.dockerignore` | **IMPLEMENTED, NOT YET DEPLOYED** — daemon down |
| `docker-compose.yml` | **IMPLEMENTED, NOT YET DEPLOYED** — daemon down |
| CloudFormation: queues, dynamodb, iot-rule, ecs, scaling | **IMPLEMENTED, NOT YET DEPLOYED** |
| Deployment scripts (PowerShell + bash) | **IMPLEMENTED, NOT YET DEPLOYED** |
| Local backlog-per-task autoscaler | **VERIFIED** |
| Experiment runner + 4 incident stages + 8 telemetry-growth stages | **VERIFIED** |
| Evidence tooling (`npm run evidence`) | **VERIFIED** |
| Dashboard / API | **NOT STARTED** — explicitly deprioritised for this checkpoint |

---

## 3. Working end-to-end paths

**VERIFIED** — the complete local pipeline, run via `npm run demo:local` with
Node-RED running:

```
simulator -> MQTT broker -> Node-RED (validate + normalise) -> bridge
   -> telemetry queue -> telemetry processor -> current-state table
   -> disruption detected -> analysis queue
   -> route-impact worker -> analysis-results table
   -> notification queue -> notification worker -> notifications table
```

Observed result of the most recent run:

```
Events processed (ProcessedEvents): 309
Entities tracked (CurrentState):    27
Route impact results:               412
Simulated notifications:            1604
Telemetry DLQ / Analysis DLQ / Notifications DLQ: 0 / 0 / 0
```

Zero messages reached any dead-letter queue, which is the expected behaviour under
normal load.

**BLOCKED** — the AWS path (IoT Core → IoT Rule → SQS → DynamoDB → ECS) has never
been executed, because no AWS credentials exist on this machine.

---

## 4. Volume implementation

**VERIFIED.** Entity counts, run duration and incident fan-out size are all runtime
configuration; no source edit is required to change them.

```bash
npm run simulate -- --buses 10  --trams 5  --trains 2  --locations 10  --interval-ms 5000
npm run simulate -- --buses 100 --trams 25 --trains 15 --locations 100 --interval-ms 1000
```

Incident fan-out totals are configured as totals (not per-location multipliers) so
each stage lands exactly on its approved figure:

| Stage | Incident | Locations | Analysis jobs | Notifications |
|---|---|---|---|---|
| 1 | bus breakdown | 5 | 50 | 200 |
| 2 | tram blockage | 15 | 250 | 1000 |
| 3 | train cancellation | 20 | 750 | 5000 |
| 4 | multimodal corridor | 40 | 1500 | 10000 |

Volume also covers the downstream totals: DynamoDB writes, ETA records, alerts and
notification records all scale with the fan-out.

---

## 5. Velocity implementation

**VERIFIED.** The reporting interval is a flag, so the same fleet can be driven at
different arrival rates:

```
100 vehicles / 10 s   ->  10 events/s
100 vehicles /  5 s   ->  20 events/s
100 vehicles /  1 s   -> 100 events/s
```

The simulator reports attempted, published and failed events, events per second and
elapsed time in its periodic `[SUMMARY]` block. Workers record messages processed,
processing failures, per-message processing latency and jobs per second.

Velocity is also controlled independently on the incident side: the experiment
runner's `incidentIntervalSeconds` sets how often an incident arrives, which sets
the analysis-job arrival rate that the autoscaler reacts to.

---

## 6. Variety implementation

**VERIFIED.** Four structurally different payloads sharing a common core:

| | Bus | Tram | Train | Demand |
|---|---|---|---|---|
| Mode-specific fields | `roadSegmentId`, `nextStopId`, `doorsOpen`, `wheelchairRampOk` | `trackSegmentId`, `direction`, `nextStopId`, `couplingCount` | `stationId`, `platform`, `carriageCount`, `nextStationId`, `expressService` | `locationType`, `routeIds`, `passengerCount`, `demandLevel`, `shelterCapacity` |
| Health vocabulary | normal / degraded / **breakdown** | normal / degraded / **blocked** | normal / degraded / **cancelled** | n/a |
| Has vehicle / speed / capacity | yes | yes | yes | **no** |

The demand event is the strongest evidence that this is not four renamed copies of
one payload: it describes people at a place and has no vehicle, speed or capacity
at all.

Node-RED handles Variety with **four separate, visible validation branches** before
a single normalisation node. Normalisation preserves the mode-specific fields under
`modeData`, so downstream services get a uniform envelope without information being
destroyed.

---

## 7. Scalability / autoscaling progress

**Autoscaling design — IMPLEMENTED, NOT YET DEPLOYED on AWS.**

Primary target: the route-impact / ETA ECS service, min 1 / max 5 tasks. The
scaling signal is backlog per active task:

```
BacklogPerTask = ApproximateNumberOfMessagesVisible / max(RunningTaskCount, 1)
```

`infrastructure/cloudformation/scaling.yaml` implements this with a configurable
`TargetBacklogPerTask` (default 75) and a documented fallback to a queue-depth
policy if the custom-metric path is denied by account restrictions. The fallback is
selected by the `ScalingMode` parameter and is **labelled honestly** — queue depth
is never described as backlog-per-task.

**Local autoscaler — VERIFIED.** `scripts/local-autoscaler.js` implements the same
backlog-per-task arithmetic and spawns/stops real worker processes between min 1 and
max 5. This is what produced the measured A/B comparison below. It is a genuine
demonstration of the scaling *algorithm* and of concurrent workers competing for one
queue; it is not a demonstration of ECS.

**Measured preliminary A/B result — VERIFIED** (local backends, stage 1, seed
3142026, identical 550-job workload):

| Metric | A: fixed 1 task | B: autoscaled 1→5 |
|---|---|---|
| Jobs injected / processed | 550 / 550 | 550 / 550 |
| Throughput | 3.20 jobs/s | **5.41 jobs/s** |
| Elapsed (to full drain) | 171.7 s | **101.7 s** |
| Mean processing | 485 ms | 545 ms |
| p95 processing | 750 ms | 857 ms |
| Peak queue depth | 380 | **290** |
| Peak oldest-message age | 140 s | **51 s** |
| Ending queue depth | 0 | 0 |
| Tasks observed | 1 → 1 | 1 → 4 |
| Scale-out / scale-in events | 0 / 0 | 2 / 1 |
| Jobs lost | 0 | 0 |
| Duplicate results | 0 | 0 |
| Duplicate jobs skipped by idempotency | 0 | 4 |
| DLQ depth | 0 | 0 |

Interpretation: autoscaling raised sustainable throughput by **~69%** and cut peak
oldest-message age by **64%** on an identical workload, with no job loss and no
duplicate results. The 4 duplicate jobs skipped in run B are positive evidence —
they show that redelivery during scaling activity was absorbed by the conditional
write rather than producing duplicate work.

Both runs were classed **UNSTABLE** at this arrival rate by the
oldest-message-age criterion. That is the intended, useful outcome: it locates a
breaking point rather than declaring success.

---

## 8. Reliability / security progress

**VERIFIED:**
- Event idempotency via conditional write on `eventId`; a duplicate event does not
  create duplicate analysis jobs.
- Job idempotency via conditional write on `jobId`; a redelivered job does not
  create a duplicate result.
- Notification idempotency via `notificationId`.
- Out-of-order protection: an older telemetry timestamp cannot overwrite newer
  current state.
- A message is deleted from the queue **only** after successful processing;
  failures leave it for visibility-timeout retry and eventual DLQ redrive.
- DLQ redrive after a finite max receive count.
- Graceful SIGTERM handling: stop receiving, finish in-flight work, exit cleanly.
- Failure injection exists and is **off by default**.
- No secrets in Git; `.gitignore` covers `.env`, `certs/*`, `*.pem`, `*.key`, `*.crt`.
- `.dockerignore` prevents `.env` and `certs/` entering an image.

**IMPLEMENTED, NOT YET DEPLOYED:** mutual TLS to AWS IoT Core, IAM-role-only access
to queues and tables, ECS task roles, and CloudWatch log groups.

**Deliberate trade-off, documented:** ECS tasks are placed in public subnets with
public IPs rather than private subnets behind a NAT Gateway, because a NAT Gateway
would dominate the cost of a student project. Recorded in
`docs/IMPLEMENTATION_DECISIONS.md` and `docs/SECURITY.md`.

---

## 9. Tests completed

**VERIFIED — 150 tests, 0 failures**, via `npm test`.

Coverage by area:
- RNG determinism and stream independence
- All four generators produce schema-valid payloads
- CLI/config resolution, stage-file loading, validation of bad configuration
- Corruption injection: every corruption yields a rejection with a reason, and the
  corruption choice is deterministic for a seed
- Duplicate-rate republishes the same `eventId`
- Schema validation: valid and invalid cases for all four modes plus malformed
  payloads
- The **real Node-RED function-node source**, executed against fixtures
- Local queue: claim, visibility timeout, receive count, DLQ redrive, attributes
- Store: `putIfAbsent` and `putIfNewer` conditional semantics
- Telemetry processor: state update, crowding, disruption detection, fan-out size,
  duplicate event produces no duplicate jobs, stale event does not overwrite state
- Route-impact worker: deterministic ETA, mode-specific impact, result write,
  duplicate job skipped, alert generation, failure does not delete the message
- Notification worker: delivery record, duplicate skipped, controlled failure
- CloudFormation templates parse and contain the required resources

---

## 10. Current limitations

1. **No AWS deployment has occurred.** Every AWS-specific claim in this document is
   labelled IMPLEMENTED, NOT YET DEPLOYED. Nothing has been verified against a real
   AWS account.
2. **The local queue is not SQS.** It reproduces long polling, visibility timeout,
   receive count, DLQ redrive and depth attributes, but it is a single-machine
   filesystem queue. It has no cross-region durability, no server-side encryption,
   and its throughput ceiling is local disk I/O — which is itself the bottleneck
   identified in the preliminary experiment.
3. **The local autoscaler is not ECS Application Auto Scaling.** It proves the
   backlog-per-task algorithm and real worker concurrency, not AWS scaling
   behaviour, IAM, or task placement latency.
4. **CloudWatch metrics have never been published.** The adapter is written; the
   namespace `SIT314/Transport` does not yet exist.
5. **The processing-cost test parameter is active in experiments.** A 50 ms delay
   plus fixed CPU work per job is applied so queue build-up is observable at
   affordable workload sizes. This is a documented test parameter, applied
   identically to both A and B runs, not a manipulation of the comparison.
6. **Only stage 1 has been run**, and at a shortened duration (45 s injection, not
   the full 10 minutes), once per arm rather than the planned three repeats.
7. **Docker images have never been built**, so the Dockerfiles are unproven.
8. **No dashboard or API exists.** Deliberately deprioritised.

---

## 11. AWS blockers

**BLOCKED — AWS CLI is not installed and no credentials are present.**

Evidence from `npm run verify-env` on this machine:

```
[WARN] AWS CLI              not found - AWS deployment is blocked
[WARN] AWS credentials      no usable credentials - the project still runs fully in local mode
[WARN] Docker daemon        not reachable - image builds and docker compose are blocked
```

- `aws` is not on PATH in either PowerShell or bash.
- `~/.aws` does not exist; no `AWS_*` environment variables are set.
- Therefore `aws sts get-caller-identity` cannot be run, the account and region are
  unknown, and no CloudFormation stack has been created.

**Secondary blocker — Docker daemon not running.** The Docker CLI (28.4.0) is
installed but `docker info` fails with
`open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`.
Docker Desktop requires manual start by the user. No image build or `docker compose`
run has been attempted beyond confirming this.

Neither blocker was worked around by weakening security, and no credentials were
fabricated.

---

## 12. Remaining work

In priority order:

1. Install and configure the AWS CLI; confirm identity and region with
   `aws sts get-caller-identity`.
2. Deploy `queues` and `tables` stacks; verify with `describe.sh`.
3. Create the AWS IoT thing, certificate and policy; populate `.env`; verify the
   simulator publishes over TLS with the MQTT test client.
4. Deploy the `iot-rule` stack; verify a normalised message lands in the telemetry
   queue.
5. Start Docker Desktop; build and push the three images to ECR.
6. Deploy the `ecs` stack; confirm the route-impact service reaches steady state
   and consumes analysis jobs.
7. Deploy the `scaling` stack; confirm min 1 / max 5 and the backlog-per-task
   policy; fall back to queue-depth scaling only if the custom metric is denied,
   and document the deviation.
8. Re-run stage 1 A/B against AWS; then stages 2 and 3 if budget allows.
9. Repeat each stage three times at the full 10-minute duration with the same seed.
10. Identify the AWS-side bottleneck from CloudWatch, apply **one** targeted
    improvement, and repeat the identical workload.
11. Capture the outstanding evidence items (see `docs/EVIDENCE_CHECKLIST.md`).
12. Optional, lowest priority: a read-only dashboard.
