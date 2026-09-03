# Implementation decisions

Every deviation from the original specification, and every non-obvious choice,
with the reason.

---

## 1. Local adapters exist alongside the AWS adapters

**Decision.** `shared/aws/queues.js`, `shared/aws/store.js` and
`shared/aws/metrics.js` each provide two implementations behind one interface,
selected by `QUEUE_BACKEND`, `STORE_BACKEND` and `METRICS_BACKEND`.

**Why.** No AWS CLI and no AWS credentials are available on the development
machine (see `docs/ENVIRONMENT.md`). Without local adapters the entire project
would have been unrunnable and untestable. With them, all the business logic -
validation, idempotency, disruption detection, fan-out, the ETA model,
notification handling - is exercised for real, and switching to AWS is a
configuration change rather than a rewrite.

**What this is not.** It is not a general AWS emulator. The local queue is one
file per message with the specific SQS semantics the workers depend on
(long polling, visibility timeout, receive count, redrive). The services contain
no local/AWS branching at all.

**Limit.** Local results measure the local harness. Anything measured locally is
labelled as local in the status document and the evidence checklist.

---

## 2. Node-RED function code lives in `.js` files, and `flows.json` is generated

**Decision.** Each function node's body is a real file under
`node-red/functions/`. `node-red/build-flows.js` assembles `flows.json` from
them; `npm run flows:check` fails if the two drift apart.

**Why.** Node-RED stores function code as escaped strings inside JSON, which is
unreadable and impossible to unit test. `node-red/test/flow.test.js` loads
`flows.json`, executes the **actual `func` strings** through the real `wires`
connections, and asserts the accept/reject behaviour. The deployed flow logic is
therefore covered by `npm test` without needing a Node-RED runtime.

**Consequence.** If you edit a node in the Node-RED editor, copy the change back
into `node-red/functions/` and re-run `npm run flows:build`.

---

## 3. Node-RED reaches SQS through an AWS IoT rule, not a contrib node

**Decision.** Node-RED republishes normalised events to
`transport/normalized/<mode>`; an AWS IoT rule
(`infrastructure/cloudformation/iot-rule.yaml`) forwards that topic to the
telemetry SQS queue.

**Why.** This is the specification's preferred design. It avoids depending on a
third-party Node-RED SQS contrib node, keeps queue delivery on a supported,
managed AWS integration, and keeps Node-RED as the processing stage immediately
before the queue. Locally, `scripts/normalized-bridge.js` stands in for the rule
and is clearly labelled as such in its own header.

---

## 4. `rename()` is not used as the local queue's claim primitive

**Decision.** Claiming a message means creating `inflight/<messageId>.json` with
the exclusive-create flag `wx`.

**Why.** The obvious implementation - `rename()` the message file from
`pending/` to `inflight/` - is wrong on Windows. Measured on the development
machine: eight concurrent `fs.rename()` calls on the same source file reported
**four successes** while producing only one destination file. That silently
delivered one message to several consumers. Exclusive create (`CREATE_NEW` on
Windows, `O_EXCL` on POSIX) is genuinely atomic, so exactly one claimant wins
and the losers get `EEXIST`.

`shared/test/local-queue.test.js` has a regression test: five concurrent
consumers, 200 messages, every message delivered exactly once.

---

## 5. The local queue scans a bounded window at a random offset

**Decision.** `#claim()` considers only the first `max(batchSize * 8, 64)`
sorted pending files and starts each consumer at a random offset within that
window.

**Why.** Real SQS hands each consumer a different set of messages; a shared
directory does not. With a naive scan, N consumers all start at the head of the
queue, race for the same few files, and N-1 lose every race. Delivery stays
approximately FIFO, which is all SQS guarantees anyway.

**Also.** Reaping expired in-flight messages is throttled to at most once per
half-visibility-timeout per consumer, because it reads every in-flight record
and doing that on every poll of every worker is pure overhead.

---

## 6. Fan-out sizes are configured as totals, not as per-location multipliers

**Decision.** `FANOUT` in `shared/config` specifies `affectedLocations`,
`targetJobs` and `targetNotifications`; the totals are distributed evenly.

**Why.** The approved stages require exactly 50/200, 250/1000, 750/5000 and
1500/10000. A per-location multiplier cannot hit 5000 notifications across 750
jobs (6.67 each). `distribute()` spreads any total across any number of buckets
exactly.

---

## 7. Job, alert and notification ids are derived, not random

**Decision.** `derivedId(prefix, ...parts)` hashes stable inputs.

**Why.** A retried telemetry event must regenerate exactly the same job ids, so
that the conditional write on `jobId` recognises them as already done. Random
ids would make every retry look like new work and defeat idempotency across the
stage boundary.

**Consequence for experiments.** Because ids are derived from the source event
id, the experiment runner includes the **run id** in the synthetic event id.
Without it, the second run of a stage would be recognised as a duplicate of the
first and would do no work - correct idempotency behaviour, but useless as an
experiment. The workload stays identical in size, shape and distribution.

---

## 8. A configurable processing cost exists, and it is a test parameter

**Decision.** `WORKER_PROCESSING_DELAY_MS` (a sleep) and
`WORKER_PROCESSING_CPU_ITERATIONS` (deterministic arithmetic). Both default to
**0** and are recorded in every experiment's `config.json`.

**Why.** A real route-impact calculation on a student-sized workload takes under
a millisecond, so queue build-up would never occur at any affordable job count.
Giving each job a controlled, documented service time makes backlog growth and
worker scaling observable at 50-1500 jobs instead of millions.

**This does not manipulate results.** The ETA calculation is a pure function of
the job; the cost is applied around it and changes no output. A test asserts
that the calculated ETA is identical with the cost on and off.

---

## 9. Crowding alone rarely raises an incident

**Decision.** `CROWDING_INCIDENT_LEVEL` defaults to `critical`.

**Why.** Buses are routinely 85% full at peak. Raising an incident for every
moderately crowded vehicle would generate constant fan-out and make the incident
signal meaningless. Crowding is always computed and stored; it only becomes an
incident at or above the configured level.

---

## 10. Four single-key DynamoDB tables, not one clever table

**Decision.** `processed-events` (eventId), `current-state` (entityId),
`analysis-results` (jobId), `notifications` (notificationId). All on-demand.

**Why.** Each table has one purpose that can be explained in a sentence. A
single-table design with composite keys and overloaded attributes would look
more sophisticated and be harder to justify in a viva. On-demand billing means
an idle project costs nothing and a load test needs no capacity planning.

---

## 11. Workers run in public subnets with no load balancer

**Decision.** `ecs.yaml` places tasks in public subnets with
`AssignPublicIp: ENABLED`, a security group with **no inbound rules**, and no
load balancer.

**Why.** These workers poll SQS; nothing connects to them, so a load balancer
would be pure cost. They need outbound HTTPS to reach SQS, DynamoDB and
CloudWatch. The two ways to provide that from a private subnet are a NAT gateway
(roughly USD 32/month plus data - more than the rest of this project combined)
or VPC endpoints (three interface endpoints, also billed hourly).

**Honest trade-off.** A private-subnet design is preferable in production. The
mitigation here is that the security group accepts no inbound traffic at all, so
the tasks are not reachable even though they have public IPs. This is recorded
in `docs/SECURITY.md` as a known, deliberate compromise.

---

## 12. Autoscaling has a documented fallback

**Decision.** `scaling.yaml` takes a `ScalingMode` parameter:
`BacklogPerTask` (preferred, needs Lambda + EventBridge) or `QueueDepth`
(fallback, uses the built-in `AWS/SQS` metric).

**Why.** A restricted student account may deny Lambda or role creation. The
fallback keeps autoscaling working, but raw queue depth is **not** backlog per
active task, and the report must say so rather than relabelling one as the
other.

---

## 13. Deliveries are simulated, and the schema enforces it

**Decision.** The notification record schema requires `"simulated": true` as a
`const`.

**Why.** No SMS, email or paid third-party service is ever contacted. Making it
a required constant means a record cannot later be mistaken for a real delivery,
and nothing in the codebase can produce a record claiming otherwise.

---

## 14. The stability verdict ignores the drain phase

**Decision.** `evaluateStability()` considers only samples taken while load was
still being injected.

**Why.** After injection stops the queue always drains, so including the drain
would let a badly overloaded configuration finish at queue depth zero and be
scored stable. The question the breaking-point definition asks is whether the
system kept up *while load was arriving*.

---

## 15. Blockers encountered, and what was done about them

| Blocker | Effect | Response |
|---|---|---|
| No AWS credentials configured (the CLI itself is installed and verified, `aws-cli/2.36.39`) | No AWS resource can be created or verified | Everything built and tested locally; complete IaC written and structurally tested; exact deployment commands documented |
| Docker daemon not running (`com.docker.service` stopped, starting it needed elevation) | Images could not be built; `docker compose` could not run | **Resolved 2026-09-04** once the user started Docker Desktop. Building and running then exposed four real defects, all fixed - see section 19 |
| Node-RED settings must be CommonJS | `settings.js` failed to load under `"type": "module"` | Renamed to `settings.cjs` |
| Node-RED substitutes env vars as strings | `usetls: "${MQTT_USE_TLS}"` was truthy and forced `mqtts://` against the local broker | TLS is a literal boolean in the flow; switching to AWS IoT is a documented editor step |
| Local file I/O saturates under 5 concurrent workers | Local runs cannot show positive throughput scaling with an I/O-heavy job mix | Measured and reported honestly; the A/B comparison was re-run with a CPU-bound service time, where task-level parallelism is the real constraint |

---

## 16. Experiment injection is bounded by incident count, not by time

Injection was originally bounded by elapsed time: inject incidents for
`warmup + duration` seconds. That is the natural way to express an arrival rate,
and it is correct for a single soak run.

It is **wrong for an A/B comparison**, and this was caught empirically. Stage 2
run time-bounded produced **1500 jobs in the fixed arm but only 750 in the
autoscaled arm**. Enqueuing an incident is itself work, and it slows down when
five worker processes are competing for the same queue, so fewer injection cycles
fit into the same wall-clock window. Comparing throughput between two runs that
received different amounts of work is meaningless, and it would have flattered the
fixed arm.

The runner now accepts `--incidents N`, which bounds injection by count while
still pacing at the configured interval. Both arms then receive an identical
workload regardless of how contention affects timing.

**Rule for every future comparison, local or on AWS: use `--incidents`.** The two
discarded time-bounded stage 2 runs were deliberately not promoted into
`evidence/`.

This matters beyond this project: the same trap exists on AWS, where the injector
competes with the workers for network and API throughput.

## 17. `aedes` is a development dependency, not a runtime one

The local MQTT broker is a development stand-in for AWS IoT Core. It was declared
in the root `dependencies`, which meant `npm ci --omit=dev` inside the three
service Dockerfiles installed it — and its transitive `hyperid` → `uuid`
advisories — into images that never import it.

It is now a `devDependency`. `npm audit --omit=dev`, which is the tree that
actually ships in the ECS worker images, reports **0 vulnerabilities**.
`node-red/Dockerfile.broker` installs dev dependencies deliberately, because that
image *is* the broker and is never pushed to ECR.

The remaining 10 moderate advisories in the full tree all belong to `aedes` and
`node-red`. They are documented in `docs/SECURITY.md` rather than force-upgraded:
`npm audit fix --force` would install `aedes@1.1.2`, a breaking major change to a
local development convenience, for no benefit to the deployed system.

## 18. One cfn-lint rule is suppressed, with the reasoning recorded

`cfn-lint` reports no findings across all five stacks, with one deliberate
suppression declared in `scaling.yaml`'s template `Metadata`.

W1030 claims `ExistingLambdaRoleArn`'s default (`''`) is not a valid role ARN
where it is used in `BacklogMetricFunction.Role`. That `Fn::If` branch is
unreachable when the parameter is empty: `CreateLambdaRole` is true exactly when
the parameter *is* empty, so the `!Ref` branch is only ever taken with a real ARN.
The linter cannot see that.

The real safeguard is the parameter's `AllowedPattern` — empty, or a valid IAM
role ARN — which CloudFormation enforces at deploy time and which catches a
mistyped AWS Academy LabRole ARN before a stack is attempted. The same pattern was
added to the existing-role parameters in `ecs.yaml` and `iot-rule.yaml`.

Static validation also caught two genuine defects that would have failed a live
deployment: `scaling.yaml`'s `Description` was 1193 characters against
CloudFormation's 1024-character limit, and the task role granted
`sqs:SendMessageBatch` and `sqs:DeleteMessageBatch`, which are not real IAM
actions — SQS authorises the batch APIs under the singular action names.


---

## 19. What building the containers actually exposed

The Dockerfiles and `docker-compose.yml` had been written and reviewed but never
executed, because the Docker daemon was down. Running them for the first time
found four genuine defects that no amount of reading would have caught:

1. **No writable directory.** `/app` is root-owned and the services run as the
   unprivileged `app` user, so the local queue/store/metrics adapters died at
   startup with `EACCES: permission denied, mkdir '/app/local-data/...'`. Each
   service image now creates `/data` owned by `app` and points `LOCAL_DATA_DIR`
   and `ARTIFACTS_DIR` there. In AWS mode nothing is written locally, so this
   only ever affected local and Compose runs — which is exactly the mode used for
   every local experiment.

2. **Development files in the production images.** The services `COPY` whole
   directories, so `shared/test/`, `services/<name>/test/` and the service's own
   `Dockerfile` were shipped. `.dockerignore` now excludes `**/test/`,
   `**/*.test.js` and `**/Dockerfile*`.

3. **Node-RED could not start under Compose.** A named volume on `/data/lib` is
   created root-owned, and the official image runs as uid 1000, so Node-RED
   exited with `EACCES: permission denied, mkdir '/data/lib/flows'`. The volume
   was removed: the authoritative flow is mounted read-only from the repository
   and nothing in the Node-RED library needs to persist.

4. **Compose could not demonstrate the pipeline at all.** There was no service
   for the normalised-to-queue bridge — the local stand-in for the AWS IoT rule —
   so validated events reached `transport/normalized/+` and stopped there, and
   the telemetry queue stayed empty. A `bridge` service was added, reusing the
   broker image, which in turn needed the simulator source it imports.

A fifth issue was found and deliberately left: the broker image is 484 MB because
it installs all dev dependencies to get `aedes`, which drags in the unused
`node-red` package. Installing production dependencies and then `aedes` alone was
tried and does not work — `npm install <pkg>` reconciles the whole workspace and
restores every devDependency, and adding `--omit=dev` drops the requested package
too. Trimming it properly needs a separate manifest for the broker, which is not
worth it for an image that is only built locally and never pushed to ECR.

The general lesson for the report: a Dockerfile that has never been built is not
evidence of anything. Three of these four defects would have surfaced as a
crash-looping ECS task with an opaque `EACCES`, during a paid AWS session.
