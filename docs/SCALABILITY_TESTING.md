# Scalability testing

## What is being measured

The route-impact / ETA worker is the primary autoscaling target, so the
experiment measures **how much analysis-job throughput the service can sustain**
and **whether autoscaling raises that number**.

## The breaking point is not a crash

A stage is **unstable** when the incident queue keeps growing through the final
window of the measurement period **and** at least one of:

1. p95 route-impact latency stays above 5 s;
2. age of the oldest message stays above 10 s;
3. the service is at 5 tasks and throughput is still below the arrival rate;
4. jobs are lost;
5. jobs are duplicated (two stored results for one job);
6. valid workload reaches a dead-letter queue.

These are preliminary thresholds, to be refined once baseline data exists.

The verdict is computed over the **injection phase only**. After injection stops
the queue always drains, so including the drain would let an overloaded
configuration finish at depth zero and score as stable.

## Volume vs Velocity

They are independent and stress different things.

- **Volume** - how many entities and how many records. Change with
  `--buses / --trams / --trains / --locations`, and with the fan-out sizes.
- **Velocity** - how fast events arrive. Change with `--interval-ms`.

100 vehicles reporting every 10 s and 100 vehicles reporting every 1 s are the
same Volume at ten times the Velocity. The first stresses storage and breadth;
the second stresses ingestion and queue arrival rate.

## The processing-cost test parameter

`WORKER_PROCESSING_DELAY_MS` and `WORKER_PROCESSING_CPU_ITERATIONS` add a
controlled service time to each job. **Both default to 0.**

A real route-impact calculation takes well under a millisecond, so at any
affordable job count the queue would never build up and there would be nothing
to scale. The parameter creates a documented, reproducible service time so that
backlog growth and worker scaling can be observed at 50-1500 jobs.

It does **not** manipulate results: the ETA is a pure function of the job, the
cost is applied around it, and a test asserts the calculated ETA is identical
with the cost on and off. Every run records the value used in `config.json`.

## The two experiments

| | Experiment A | Experiment B |
|---|---|---|
| Route-impact tasks | fixed at exactly 1 | autoscaled, min 1 max 5 |
| Purpose | baseline capacity of one worker | does scaling raise sustainable throughput? |
| Workload | identical stage, identical seed | identical stage, identical seed |

Each stage is intended to run for 10 minutes after a short warm-up, repeated
three times with the same seed.

## Formal AWS protocol (historical method)

The local runner remains useful for preliminary work. Formal cloud evidence uses
the separate `npm run experiment:aws` path, which never starts `LocalAutoscaler`
or a locally spawned route-impact worker. ECS is therefore the only consumer of
the real analysis queue during a cloud run.

### Calibration gate before formal evidence

Before the formal experiment, run the separate
`experiments/calibration/aws-stage-1-capacity.json` profile once in the fixed arm
and once in the autoscaled arm:

```bash
npm run experiment:aws -- --config experiments/calibration/aws-stage-1-capacity.json --worker-mode fixed --repeat 1
npm run experiment:aws -- --config experiments/calibration/aws-stage-1-capacity.json --worker-mode autoscale --repeat 1
```

**CALIBRATION ONLY — NOT FORMAL EVIDENCE.** This 30 s warm-up plus 150 s
measurement begins at 36 incidents every 5 s, or 1,800 analysis jobs per arm. It
measures actual one-task Fargate capacity and whether queue pressure survives
real metric periods long enough to drive real Application Auto Scaling. Its
artifacts are diagnostic and must not be reported as the final A/B result.

The live decision rule is deliberately simple:

- **Too light:** one task keeps up, visible backlog repeatedly returns close to
  zero, `BacklogPerTask` does not remain above 75 across real metric periods, or
  the autoscaled arm never genuinely scales out.
- **Useful:** the fixed arm sustains backlog, the autoscaled arm grows above one
  task due to the workload, backlog begins recovering as tasks arrive, and the
  service does not immediately remain pinned at five tasks.
- **Too heavy:** the autoscaled arm immediately reaches five tasks and backlog
  keeps growing rapidly even there.

Start at 5 seconds. Only if it is too light, change the calibration profile's
interval and matching count together: 10 s/18 incidents, 5 s/36, 3 s/60, or
2 s/90. These counts preserve the same 30 s + 150 s arrival window, and the AWS
runner rejects an inconsistent pair. Do not automatically run the whole ladder,
and do not lower `TargetBacklogPerTask=75` to force a scale-out. After inspecting
the calibration artifacts, choose and freeze the final formal cadence/count in a
separate reviewed change before formal runs begin.

Every incident stage now declares the full formal schedule: 30 s warm-up, 600 s
measurement, one incident each 10 s, **exactly 63 incidents**, a 300 s drain
deadline, and three repeats. The AWS runner rejects a stage whose count does not
equal `ceil((warm-up + measurement)/interval)`; it cannot silently return to a
time-bounded injector. That current formal configuration remains unchanged and
provisional until the AWS calibration decision is recorded.

Run each repeat in both arms after the live preflight in `docs/AWS_DEPLOYMENT.md`:

```bash
npm run experiment:aws -- --config experiments/incident/stage-1.json --worker-mode fixed --repeat 1
npm run experiment:aws -- --config experiments/incident/stage-1.json --worker-mode autoscale --repeat 1
```

The fixed arm registers min=max=1 and desired=1, so Application Auto Scaling
cannot change capacity. The autoscaled arm registers min=1, max=5 and desired=1,
then requires a live scaling policy before injection. The runner verifies the
clean analysis queue/DLQ, active ECS processing-cost setting, and one running ECS
task before it sends a job. It then waits for the `WORKER_READY` event from that
specific ECS task's known log stream; it never guesses the newest CloudWatch log
stream from `LastEventTime`.

### CloudWatch timing and valid scale evidence

The backlog metric Lambda publishes once per minute. A real scale-out therefore
needs a sustained workload long enough for metric publication, CloudWatch and
Application Auto Scaling evaluation, the configured cooldown, and Fargate task
startup. The 30-second warm-up plus **10-minute** measurement is deliberately
not a convenience timer: do not shorten the formal run or claim a shortened
run as autoscaling evidence. Allow two to three complete metric periods after
deployment before starting the formal measurement.

Never use `aws cloudwatch set-alarm-state`, manual desired-count changes, or a
temporary threshold change to create a scale event. Evidence must show the
committed workload causing the metric transition and the resulting real
Application Auto Scaling activity.

The canonical workload digest and business fields are equal for matching
stage/seed/repeat pairs. Each arm receives a unique execution namespace, which
changes the source event, incident and job idempotency identities; DynamoDB thus
does real work for both arms without making the logical workload unequal.

Each run writes `manifest.json`, `samples.jsonl`, `scaling-activities.json`,
`summary.json`, and raw CloudWatch worker-log references/events under
`artifacts/aws-runs/`. Queue arrivals are recoverable from the declared schedule
and `jobsInjected`; completions, latency, errors and `WORKER_READY` timing are
recoverable from the timestamped worker events. Results are accounted for via the
`SourceEventIdIndex` on `analysis-results`, rather than an unbounded first-page
Scan.

### Formal cloud processing cost

`WORKER_PROCESSING_CPU_ITERATIONS` was a local-harness calibration mechanism.
The deployed ECS task definition does not set it, and the formal AWS stage makes
that deliberate: **0 CPU iterations**. The formal cloud setting is a fixed
`WORKER_PROCESSING_DELAY_MS=50`, passed through the ECS CloudFormation parameter,
recorded in the manifest, and verified against the active task definition before
injection. It is identical in the fixed and autoscaled arms. A future approved
methodology change may choose a different explicit cost, but the runner rejects a
non-zero CPU iteration count until ECS has a separately reviewed implementation.

## The four incident stages

| Stage | Incident | Locations | Jobs/incident | Notifications/incident |
|---|---|---|---|---|
| 1 | bus breakdown | 5 bus stops | 50 | 200 |
| 2 | tram track blockage | 15 tram stops/segments | 250 | 1000 |
| 3 | train cancellation | 20 stations | 750 | 5000 |
| 4 | multimodal corridor disruption | 40 stops/stations | 1500 | 10000 |

Configured in `experiments/incident/stage-{1..4}.json`. The arrival rate is
`jobsPerIncident / incidentIntervalSeconds`.

## The telemetry-growth sequence

Secondary to the incident experiment. Eight stages in
`experiments/telemetry-growth/`, from 10 vehicles every 10 s (1.5 events/s) to
1000 vehicles every 1 s (1100 events/s), holding roughly 60% bus, 25% tram,
15% train. Driven by the simulator:

```bash
npm run simulate -- --config experiments/telemetry-growth/stage-5.json --target mqtt
```

### Measured generation capacity (LOCAL PRELIMINARY, dry run)

Before the ingestion path can be blamed for anything, the generator itself has to
be able to produce the load. Measured with `--target stdout` (no broker, no
Node-RED, no queue), 20 seconds per stage:

| Stage | Vehicles | Interval | Target rate | Achieved | Published / failed |
|---|---|---|---|---|---|
| 4 | 100 | 5000 ms | 24 ev/s | 23.96 ev/s | 480 / 0 |
| 6 | 250 | 2000 ms | 145 ev/s | 144.4 ev/s | 2900 / 0 |
| 8 | 1000 | 1000 ms | 1100 ev/s | 1088.8 ev/s | 22000 / 0 |

The simulator sustains the top of the approved sequence — 1000 vehicles reporting
every second — at 99% of nominal, with no failed events. The small shortfall is
timer drift, not saturation.

Variety holds at that scale. A 5-second stage-8 capture written with `--out`
contained 5500 events:

| Type | Count | Share of vehicle events |
|---|---|---|
| bus | 3000 | 60.0% |
| tram | 1250 | 25.0% |
| train | 750 | 15.0% |
| locationDemand | 500 | n/a |

**These are generation-capacity measurements only.** They say nothing about AWS
IoT Core ingestion, Node-RED throughput, or SQS. They establish that the
simulator is not the bottleneck in any later ingestion test.

## Running an incident stage

```bash
# Experiment A - one fixed worker
npm run experiment -- --config experiments/incident/stage-1.json --worker-mode fixed --fixed-tasks 1

# Experiment B - identical workload, autoscaled
npm run experiment -- --config experiments/incident/stage-1.json --worker-mode autoscale --max-tasks 5

# Short checkpoint version
npm run experiment -- --config experiments/incident/stage-1.json \
  --duration-seconds 45 --warmup-seconds 10 --incident-interval-seconds 5 \
  --processing-cpu-iterations 15000000 --worker-mode autoscale --max-tasks 5
```

Each run writes a timestamped directory under `artifacts/runs/`:

| File | Contents |
|---|---|
| `config.json` | the fully resolved stage, including seed and test parameters |
| `metrics.csv` | one row per second: queue depth, in-flight, oldest age, task count, backlog per task |
| `scaling.csv` | autoscaler evaluations and scale-out/scale-in actions |
| `workers.jsonl` | structured worker logs, the source of the latency percentiles |
| `summary.json` | computed results and the stability verdict |

`artifacts/` is git-ignored. Curated samples live in `evidence/`.

---

## Preliminary results (measured)

**These are LOCAL results.** The queue and store are the file-backed local
adapters and the "tasks" are worker processes managed by
`scripts/local-autoscaler.js`, which implements the same control law as the AWS
policy. They are not ECS measurements. The later AWS comparisons are reported
in [DISTINCTION_FINAL_RESULTS.md](DISTINCTION_FINAL_RESULTS.md) and
[HD_REPORT.md](HD_REPORT.md). The earlier blocked state remains documented in
the [historical status](STATUS_4.2D.md).

Both runs: stage 1 workload, 50 jobs every 5 s (10 jobs/s arrival), 45 s
injection after a 10 s warm-up, `WORKER_PROCESSING_CPU_ITERATIONS=15000000`
(about 190 ms of CPU per job), concurrency 4, seed 3142026.

Raw data: `evidence/preliminary-scalability/`.

| Metric | A: fixed 1 task | B: autoscale 1-5 | Change |
|---|---|---|---|
| Jobs injected | 550 | 550 | identical workload |
| Results produced | 550 | 550 | - |
| **Sustained throughput** | **3.20 jobs/s** | **5.41 jobs/s** | **+69%** |
| Peak queue depth | 380 | 290 | -24% |
| Peak age of oldest message | 140 s | 51 s | -64% |
| Mean processing latency | 485 ms | 545 ms | +12% |
| p95 processing latency | 750 ms | 857 ms | +14% |
| Time to process all 550 jobs | 171.7 s | 101.7 s | -41% |
| Tasks observed (min/max) | 1 / 1 | 1 / 4 | scaled out |
| Scale-out / scale-in events | 0 / 0 | 2 / 1 | scaled back in |
| Jobs lost | 0 | 0 | - |
| Duplicate results | 0 | 0 | - |
| Redeliveries suppressed | 0 | 4 | idempotency exercised |
| DLQ messages | 0 | 0 | - |
| Verdict | UNSTABLE | UNSTABLE | both below 10 jobs/s |

### What this shows

1. **Autoscaling raised sustainable throughput** from 3.20 to 5.41 jobs/s (+69%)
   on an identical workload with the same seed.
2. **Backlog was contained.** Peak depth fell 24% and the oldest message aged
   51 s instead of 140 s.
3. **The service scaled back in.** One scale-in event was recorded as the
   backlog drained, so capacity is released rather than held.
4. **Nothing was lost and nothing was duplicated** in either run: 550 injected,
   550 results, 0 lost, 0 duplicate results, 0 DLQ messages.
5. **Idempotency was genuinely exercised.** Under autoscaling, SQS-style
   redelivery occurred 4 times (a task was terminated mid-job by scale-in) and
   all 4 were suppressed by the conditional write on `jobId`. This is the
   mechanism working, not a fault.
6. **Both configurations are below the 10 jobs/s arrival rate**, so the breaking
   point for this service time lies below stage 1's arrival rate in the local
   harness. Autoscaling moved capacity up but not past the arrival rate, which
   is why both verdicts are UNSTABLE. That is the honest reading.

### Latency rose slightly under scaling

Mean latency went from 485 ms to 545 ms with more tasks. Expected: five
processes contend for CPU cores and for the shared local queue/store files, so
each individual job is marginally slower even though aggregate throughput is
much higher. Throughput, not per-job latency, is what scaling buys.

## Stage 2 (LOCAL PRELIMINARY, measured)

Tram track blockage: 15 affected stops, 250 jobs and 1000 notifications per
incident. Both arms injected **exactly 3 incidents = 750 jobs** using
`--incidents 3`, seed 3142026, identical worker settings.

| Metric | A: fixed 1 task | B: autoscale 1-5 | Change |
|---|---|---|---|
| Jobs injected | 750 | 750 | identical workload |
| Results produced | 474 | **750** | completed vs abandoned |
| Left unprocessed at drain timeout | 280 | **0** | — |
| **Sustained throughput** | **2.93 jobs/s** | **7.38 jobs/s** | **+152%** |
| Elapsed | 161.8 s | 101.6 s | -37% |
| Mean processing latency | 511 ms | 548 ms | +7% |
| p95 processing latency | 1040 ms | 874 ms | -16% |
| Peak queue depth | 710 | 610 | -14% |
| Peak age of oldest message | 145 s | 83 s | -43% |
| Ending queue depth | 270 | **0** | drained |
| Tasks observed (min/max) | 1 / 1 | 1 / 5 | reached the cap |
| Scale-out / scale-in events | 0 / 0 | 2 / 1 | scaled both ways |
| Jobs lost | 0 | 0 | — |
| Duplicate results | 0 | 0 | — |
| Redeliveries suppressed | 0 | 4 | idempotency exercised |
| DLQ messages | 0 | 0 | — |
| Verdict | UNSTABLE | UNSTABLE | both |

Stage 2 is the clearer result of the two. The single worker **did not finish the
workload at all** — 280 of 750 jobs were still queued when the drain timeout was
reached — while the autoscaled service completed every job and ended with an
empty queue at 2.5x the throughput. Unlike stage 1, this is not a "faster"
result but a "possible versus impossible" one.

Note that the autoscaled arm reached the **maximum of 5 tasks** and was still
classed UNSTABLE. Under the approved definition that is criterion 3 territory:
at stage 2's arrival rate the service is at its cap and still behind, so the
local breaking point for this service time lies **between stage 1 and stage 2**.

### A methodology correction, and why it matters

The first stage-2 attempt bounded injection by elapsed time, as stage 1 had
been. That produced **1500 jobs in the fixed arm but only 750 in the autoscaled
arm**: enqueuing an incident is itself work, and it slows down when five workers
are competing for the same queue, so fewer incidents fit into the same
wall-clock window. Those runs were discarded, not promoted.

The runner now takes `--incidents N`, bounding injection by count so both arms
receive an identical workload regardless of timing. **Every fixed-vs-autoscale
comparison must use it.** The time bound remains correct for a single soak run
where only the arrival rate matters. This is exactly the kind of defect that
would have invalidated the final report's headline comparison if it had gone
unnoticed on AWS.

---

## Bottleneck identified: local file I/O

An earlier A/B pair at stage 2 (250 jobs per incident, 100 ms sleep-based
service time) produced **negative** scaling: 9.51 jobs/s with one task versus
5.72 jobs/s with five. Investigated rather than accepted:

- Per-job file operations: 1 claim + 1 delete on the analysis queue, 2 writes to
  the results store, and 2-4 writes to the notification queue.
- A micro-benchmark of the local queue measured **~10-12 ms of file I/O per
  message** for receive plus delete, and only ~330 message writes/second.
- Adding processes does not add disks. With an I/O-heavy job mix the shared
  local disk is the constraint, so more workers simply contend harder.

Two harness fixes were applied (a bounded, randomly offset scan window, and
throttled in-flight reaping - see `docs/IMPLEMENTATION_DECISIONS.md` items 4-5),
which removed the pathological claim contention but not the underlying I/O
ceiling.

**Conclusion.** The local harness is disk-bound and cannot demonstrate positive
throughput scaling for an I/O-heavy job mix. This is a property of the local
substitutes, not of the architecture: real SQS and DynamoDB are distributed
services and do not share one local disk. The A/B comparison above was therefore
re-run with a CPU-bound service time, which is the regime where the number of
tasks is the real constraint - and there scaling behaves as designed.

This is exactly the improvement cycle the assessment asks for: run the workload,
find the limiting component from the measurements, make one targeted change,
re-run the identical workload, compare.

---

## Next improvement cycle (planned)

1. Run the identical stages against real SQS/DynamoDB on ECS, where the local
   disk ceiling does not apply.
2. Find the first stage where autoscaled throughput still falls below the
   arrival rate.
3. Inspect CloudWatch: if ECS `CPUUtilization` is saturated the bottleneck is
   task size; if `BacklogPerTask` lags the queue the bottleneck is scaling
   reaction time; if DynamoDB throttles the bottleneck is the write path.
4. Make **one** targeted change (task CPU/memory, worker concurrency, backlog
   target, or batching).
5. Re-run the identical stage with the same seed and compare.

## How CloudWatch identifies the bottleneck

| Symptom | Metric that shows it | Likely bottleneck |
|---|---|---|
| Queue grows, tasks at max, CPU high | `ECS CPUUtilization`, `RunningTaskCount` | Worker compute - raise task size or max tasks |
| Queue grows, tasks at max, CPU low | `ProcessingLatencyP95` | Waiting on a downstream call, not compute |
| Backlog spikes before task count moves | `BacklogPerTask` vs `RunningTaskCount` | Scaling reaction time - lower the target or shorten evaluation |
| Write errors or retries | DynamoDB `ThrottledRequests` | Storage write path |
| Messages appear in a DLQ | `ApproximateNumberOfMessagesVisible` on the DLQ | Genuine processing failure |
| Oldest message age climbs while depth is flat | `ApproximateAgeOfOldestMessage` | Starvation or an unbalanced consumer |

## Why identical workloads matter

Comparing "before" and "after" only means something if the workload is the same.
That is why the simulator is seeded, the stage files are committed, job ids are
derived from stable inputs, and every run records its full resolved
configuration next to its results.
