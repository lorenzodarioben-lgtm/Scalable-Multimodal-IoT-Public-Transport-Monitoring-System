# Evidence checklist

Every item lists what it proves, the exact command or page, what must be visible in
the capture, and whether it has actually been captured.

**Rule:** `captured` is only `yes` when the output was genuinely produced and
stored. It is never set optimistically.

Stored evidence lives in `evidence/`. Raw experiment output lives in
`artifacts/runs/` (gitignored) and is promoted with
`npm run evidence -- --promote latest`.

---

## Summary

| ID | Proves | Captured |
|---|---|---|
| E01 | Variety + configurable simulation | **yes** (reproducible on demand) |
| E02 | MQTT ingestion into AWS IoT Core | **no — BLOCKED (no AWS account)** |
| E03 | Node-RED flow with per-mode branches | **yes** (flow runs locally) |
| E04 | Validation and rejection with reasons | **yes** |
| E05 | SQS telemetry queue buffering | **partial** — local queue yes, AWS SQS no |
| E06 | DynamoDB current-state records | **partial** — local store yes, DynamoDB no |
| E07 | Disruption fan-out into many analysis jobs | **yes** |
| E08 | Route-impact worker on ECS Fargate | **no — BLOCKED** |
| E09 | Application Auto Scaling min 1 / max 5 | **no — BLOCKED** (template written) |
| E10 | Queue growth under load | **yes** (local metrics.csv, stages 1 and 2) |
| E11 | Task count increasing under backlog | **partial** — local autoscaler yes, ECS no |
| E12 | Idempotency / retry / DLQ behaviour | **yes** — `npm run demo:reliability` |

---

## E01 — Simulator running with buses, trams, trains and demand

**Proves:** Variety (four distinct payload types) and configurable simulation
(Volume and Velocity from the command line).

**Command:**
```bash
npm run simulate -- --buses 10 --trams 5 --trains 2 --locations 10 --interval-ms 2000 --seed 3142026 --duration-seconds 30
```

**Must be visible:** the startup banner showing seed, per-mode counts, interval and
scenario; `[PUBLISHED]` lines for `bus`, `tram`, `train` and demand events; a
`[SUMMARY]` block with published count, failure count, rate and elapsed time.

**Captured:** yes — reproducible on demand, no AWS needed.

**Second capture worth taking:** the same command with
`--buses 100 --trams 25 --trains 15 --locations 100 --interval-ms 1000` beside the
first, to show Volume and Velocity changing without any source edit.

---

## E02 — AWS IoT MQTT test client receiving raw telemetry

**Proves:** genuine IoT ingestion over MQTT/TLS into AWS IoT Core.

**Page:** AWS IoT Core console → MQTT test client → subscribe to `transport/raw/#`.

**Command driving it:**
```bash
npm run simulate -- --target mqtt --mqtt-mode aws --duration-seconds 60
```

**Must be visible:** the subscribed topic filter, and arriving messages on
`transport/raw/bus/...`, `.../tram/...`, `.../train/...` and `.../demand/...`.

**Captured:** **no — BLOCKED.** The AWS CLI is not installed and no credentials
exist on this machine, so no IoT endpoint, thing or certificate has been created.

---

## E03 — Node-RED flow

**Proves:** flow-based processing with mode-specific branches before normalisation.

**Page:** <http://127.0.0.1:1880> after `npm run node-red`.

**Must be visible:** the MQTT input node, the identify-mode node, the four separate
validation branches (bus, tram, train, demand), the shared normalise node, the
accepted MQTT output, and the reject path.

**Captured:** yes — Node-RED runs locally and the flow loads from
`node-red/flows.json`.

**Supporting evidence:** `npm run flows:check` proves `flows.json` is in sync with
the reviewed function source in `node-red/functions/`, and
`node-red/test/flow.test.js` executes that same source in the test suite.

---

## E04 — Valid and malformed event behaviour

**Proves:** validation and rejection with a stated reason; invalid data never
reaches the telemetry queue.

**Command:**
```bash
npm run simulate -- --invalid-rate 0.2 --target mqtt --duration-seconds 30
```
with the Node-RED debug pane open, and optionally `npm run tap` subscribed to
`transport/rejected/#`.

**Must be visible:** accepted events flowing to `transport/normalized/<mode>`, and
rejected events showing mode, eventId and a concrete reason, for example:

```
[REJECTED]
mode=bus
eventId=evt-...
reason=occupancy must be >= 0
```

**Captured:** yes — verified locally, and covered by automated tests asserting that
every corruption yields a rejection with a reason.

---

## E05 — Telemetry queue buffering

**Proves:** the queue decouples ingestion from processing, absorbing bursts.

**Local command:**
```bash
npm run queue:stats
```

**AWS page:** SQS console → `sit314-transport-telemetry` → Monitoring →
`ApproximateNumberOfMessagesVisible`.

**Must be visible:** a non-zero visible-message count while the processor is
stopped, then the depth falling once it starts; and the paired DLQ at depth 0.

**Captured:** **partial.** The local file-backed queue has been exercised
extensively and depth/age/DLQ figures are recorded in
`evidence/preliminary-scalability/*/metrics.csv`. The real SQS queue does not exist
yet.

---

## E06 — DynamoDB current-state records

**Proves:** persistent processing and per-entity state.

**Local command:**
```bash
npm run state:dump -- --table current-state --limit 5
```

**AWS page:** DynamoDB console → `sit314-transport-current-state` → Explore items.

**Must be visible:** one item per vehicle/location with `entityId`, timestamp,
metrics, health, and crowding level.

**Captured:** **partial.** 27 entities were tracked in the verified local run. The
DynamoDB table does not exist yet.

---

## E07 — Disruption detection producing many analysis jobs

**Proves:** event-driven fan-out — one incident becomes many independent units of
work, which is the basis of parallelism across workers.

**Command:**
```bash
npm run demo:local
```
or directly:
```bash
npm run simulate -- --scenario bus-breakdown --disrupt-vehicle BUS-007 --target mqtt --duration-seconds 60
```

**Must be visible:** the processor's incident block, for example:

```
[INCIDENT_DETECTED]
sourceEventId=evt-...
mode=bus
vehicle=BUS-007
reason=breakdown
severity=high
analysisJobs=50
```

followed by the analysis queue depth rising, and `[ANALYSIS]` lines from the
route-impact worker showing job id, mode, location, impact, ETA and `processingMs`.

**Captured:** yes — the verified local run produced 412 route-impact results and
1604 simulated notifications from the checkpoint scenario.

---

## E08 — Route-impact worker running on ECS Fargate

**Proves:** AWS microservice deployment.

**Page:** ECS console → cluster `sit314-transport-cluster` → service
`sit314-transport-route-impact` → Tasks; plus CloudWatch Logs for the task.

**Must be visible:** at least one RUNNING task, and log lines showing `[ANALYSIS]`
jobs being consumed from the analysis queue.

**Captured:** **no — BLOCKED.** No AWS account, and the Docker daemon is not
running so no image has been built or pushed.

---

## E09 — Application Auto Scaling configuration

**Proves:** the required scaling envelope, min 1 / max 5.

**Page:** ECS console → service → Auto Scaling tab; or
```bash
aws application-autoscaling describe-scalable-targets --service-namespace ecs
aws application-autoscaling describe-scaling-policies --service-namespace ecs
```

**Must be visible:** `MinCapacity: 1`, `MaxCapacity: 5`, and the scaling policy with
its target value and cooldowns.

**Captured:** **no — BLOCKED.** `infrastructure/cloudformation/scaling.yaml` is
written with min 1 / max 5, a configurable `TargetBacklogPerTask`, and a documented
queue-depth fallback, but it has never been deployed.

---

## E10 — Queue growth under a controlled workload

**Proves:** backlog accumulates faster than a single worker can drain it, which is
what justifies scaling out.

**Local artefact:** `evidence/preliminary-scalability/*/metrics.csv`
(per-second queue depth, oldest-message age, task count).

**AWS page:** CloudWatch → SQS metrics → `ApproximateNumberOfMessagesVisible` and
`ApproximateAgeOfOldestMessage` for `sit314-transport-analysis`.

**Must be visible:** depth climbing during injection, peaking, then draining.

**Captured:** yes, locally — peak depth 380 (fixed) versus 290 (autoscaled) on an
identical workload. CloudWatch equivalent not captured.

---

## E11 — Task count increasing during a controlled workload

**Proves:** scale-out actually happens, and scale-in returns toward the minimum.

**Local artefact:** `evidence/preliminary-scalability/*-autoscale/scaling.csv` and
the `scaling.events` array in `summary.json`.

**Recorded scaling events from the verified run:**

```
16:58:00  scaleOut 1 -> 2   backlogPerTask=130
16:58:30  scaleOut 2 -> 4   backlogPerTask=120
16:58:40  scaleIn  4 -> 3   backlogPerTask=50
```

**AWS page:** ECS service → Tasks count over time, alongside the CloudWatch
`BacklogPerTask` metric.

**Captured:** **partial.** Scale-out to 4 workers and scale-in were genuinely
observed with the local autoscaler. This proves the algorithm and real worker
concurrency, **not** ECS. The ECS capture is still required.

---

## E12 — DLQ, retry and idempotency evidence

**Proves:** at-least-once delivery is handled safely — retries do not duplicate
results, and poison messages end up in the DLQ instead of being lost.

**Single best command — no AWS needed, about 30 seconds:**

```bash
npm run demo:reliability
```

This runs four controlled scenarios against the real processor, the real worker
loop, the real queue and the real store, and prints a labelled block per scenario
plus a PASS/FAIL summary. It works in its own scratch directory and removes it
afterwards, so it cannot disturb pipeline state or committed evidence.

**Must be visible:**

```
[INCIDENT_DETECTED] ... analysisJobs=50          (first delivery fans out)
[DUPLICATE_SKIPPED] eventId=evt-demo-breakdown-0001
RESULT  jobs after 1st delivery = 50
RESULT  jobs after 2nd delivery = 50
VERDICT PASS - duplicate suppressed by conditional write on eventId

[STALE_STATE_SKIPPED] entity=BUS-007 eventTimestamp=... (newer state already stored)
VERDICT PASS - stale write refused by conditional timestamp check

[PROCESSING-FAILED] messageId=... attempt=1/5 error=simulated downstream failure
VERDICT PASS - message retained on failure, redelivered, then completed

[PROCESSING-FAILED] ... attempt=2/2 error=permanent processing failure
RESULT  in DLQ: jobId=job-demo-poison-0001 redrivenFrom=dlq-work receiveCount=2
VERDICT PASS - poison dead-lettered, valid workload untouched
```

and the closing summary:

```
Duplicate suppressed: PASS
Stale write refused:  PASS
Retry after failure:  PASS
DLQ redrive:          PASS
Valid work safe:      PASS
Failure injection:    OFF by default
```

**Captured: yes.** All four scenarios pass. This single capture covers duplicate
suppression, out-of-order protection, retry-after-failure, and DLQ redrive with a
healthy message proven untouched alongside the poison one.

**Supporting evidence already recorded:** the stage 1 and stage 2 autoscaled runs
each recorded `duplicateJobsSkipped: 4` with `duplicateResults: 0`, `jobsLost: 0`
and `dlqDepth: 0` — redelivery during real scaling activity, absorbed by the
conditional write rather than producing duplicate work.

**Alternative live variants** (useful for a second screenshot, both local):
```bash
npm run simulate -- --duplicate-rate 0.1 --target mqtt --duration-seconds 30
FAILURE_INJECTION_ENABLED=true FAILURE_RATE=1 npm run route-worker
npm run queue:stats
```

---

## Still to capture, in priority order

Everything capturable without AWS now has a single command behind it.

1. **E04 side-by-side** accepted vs rejected in the Node-RED debug pane —
   `npm run simulate -- --invalid-rate 0.2 --target mqtt --duration-seconds 30`
   with the debug pane open.
2. **E01 two-configuration comparison** showing Volume and Velocity changing
   without a source edit (10/5/2 at 5000 ms beside 100/25/15 at 1000 ms).
3. **E03** the Node-RED flow canvas showing the four per-mode branches.
4. E02, E05, E06 (the AWS halves) — after credentials are available.
5. E08, E09, E11 (ECS and autoscaling) — after images are pushed and the stacks
   deploy. Step 13 of the runbook in `docs/AWS_DEPLOYMENT.md` produces E09
   directly.
