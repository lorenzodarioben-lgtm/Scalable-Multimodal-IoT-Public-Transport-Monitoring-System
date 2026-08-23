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
| AWS CLI not installed, no credentials | No AWS resource can be created or verified | Everything built and tested locally; complete IaC written and structurally tested; exact deployment commands documented |
| Docker daemon not running (`com.docker.service` is stopped and starting it needs elevation) | Images cannot be built; `docker compose` cannot run | Dockerfiles and compose file written but **unverified**; recorded as a blocker with the exact command to fix |
| Node-RED settings must be CommonJS | `settings.js` failed to load under `"type": "module"` | Renamed to `settings.cjs` |
| Node-RED substitutes env vars as strings | `usetls: "${MQTT_USE_TLS}"` was truthy and forced `mqtts://` against the local broker | TLS is a literal boolean in the flow; switching to AWS IoT is a documented editor step |
| Local file I/O saturates under 5 concurrent workers | Local runs cannot show positive throughput scaling with an I/O-heavy job mix | Measured and reported honestly; the A/B comparison was re-run with a CPU-bound service time, where task-level parallelism is the real constraint |
