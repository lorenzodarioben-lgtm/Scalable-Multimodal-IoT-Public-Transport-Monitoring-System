# SIT314 6.3D Distinction — Final Results

## Status and evidence boundary

This is the final recorded summary of the Distinction scalability experiment.
The formal workload was frozen in commit `fea9c93`; it was run three times at
fixed capacity and three times with Application Auto Scaling. Commit `7e3321e`
was then validly retested once with the same workload. The original Distinction
`artifacts/aws-runs/` directories are **not included in this public repository**;
the run IDs below are retained as provenance, but their raw summaries cannot be
opened here. The HD study has its own committed raw run evidence.

The original record classified these runs as `VALID`:

| Arm | Repeat | Run artifact |
| --- | --- | --- |
| Fixed | r1 | `2026-09-22T04-08-14-508Z-incident-stage-1-fixed-r1` |
| Fixed | r2 | `2026-09-22T05-04-16-365Z-incident-stage-1-fixed-r2` |
| Fixed | r3 | `2026-09-22T08-00-13-078Z-incident-stage-1-fixed-r3` |
| Autoscale | r1 | `2026-09-22T04-26-29-694Z-incident-stage-1-autoscale-r1` |
| Autoscale | r2 | `2026-09-22T05-22-47-142Z-incident-stage-1-autoscale-r2` |
| Autoscale | r3 | `2026-09-22T08-20-10-918Z-incident-stage-1-autoscale-r3` |
| Improved autoscale | Valid replacement | `2026-09-22T10-51-14-826Z-incident-stage-1-autoscale-r1` |

The earlier post-improvement artifact `2026-09-22T09-32-25-897Z-incident-stage-1-autoscale-r1` is explicitly excluded: its timing guard stopped injection at 3,150 of 31,500 jobs after a 1,109 ms dispatch-start lag. Its `TIMING-INVALID` status makes it diagnostic material only. Calibration artifacts are likewise not formal or final-improvement evidence.

`BacklogPerTask` (BPT) below is genuine historical CloudWatch evidence, never reconstructed from SQS depth: namespace `SIT314/Transport`, metric `BacklogPerTask`, dimension `ServiceName=sit314-transport-route-impact`, one-minute `Maximum` statistic. Oldest-message-age peaks are historical `AWS/SQS` `ApproximateAgeOfOldestMessage` one-minute maxima for `sit314-transport-analysis`. Visible backlog and task counts are from each run's samples. Standard deviation is sample SD (`n - 1`) across the three valid formal repeats.

## Frozen formal workload

| Property | Frozen value |
| --- | --- |
| Warm-up / measurement / scheduled arrivals | 30 s / 600 s / 630 s |
| Cadence and incidents | 1 second; 630 incidents |
| Jobs | 50 per incident; 31,500 per run |
| Offered intensity | Approximately 50 jobs/s |
| Worker cost | `WorkerProcessingDelayMs = 50`; `WorkerCpuIterations = 0` |
| Fixed arm | Exactly 1 ECS task |
| Autoscale arm | 1–5 ECS tasks |
| Scaling signal | `TargetBacklogPerTask = 75` |
| Repeats | Three per arm |

The seeded `bus-breakdown` scenario is defined in [`experiments/incident/stage-1.json`](../experiments/incident/stage-1.json). Each arm used distinct execution identities while retaining the same logical workload.

## Fixed-capacity results

| Metric | r1 | r2 | r3 |
| --- | ---: | ---: | ---: |
| Offered jobs/s | 50.057 | 50.058 | 49.967 |
| Completed / submitted jobs | 31,500 / 31,500 | 31,500 / 31,500 | 31,500 / 31,500 |
| Peak visible backlog | 3,726 | 3,664 | 4,036 |
| Peak BPT (genuine CloudWatch) | 3,486 | 3,644 | 3,906 |
| Peak oldest-message age | 133 s | 125 s | 102 s |
| Completion throughput | 43.350 jobs/s | 42.410 jobs/s | 41.640 jobs/s |
| Post-arrival drain | 95.642 s | 111.818 s | 120.641 s |
| Processing latency p95 | 52 ms | 52 ms | 52 ms |
| Peak running ECS tasks | 1 | 1 | 1 |
| Failures / duplicates / DLQ / unaccounted | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |

| Fixed summary | Mean | Median | Sample SD |
| --- | ---: | ---: | ---: |
| Offered jobs/s | 50.027 | 50.057 | 0.052 |
| Completed jobs | 31,500 | 31,500 | 0 |
| Peak visible backlog | 3,808.667 | 3,726 | 199.302 |
| Peak BPT | 3,678.667 | 3,644 | 212.135 |
| Peak oldest-message age | 120.000 s | 125 s | 16.093 s |
| Completion throughput | 42.467 jobs/s | 42.410 jobs/s | 0.856 jobs/s |
| Post-arrival drain | 109.367 s | 111.818 s | 12.678 s |
| Processing latency p95 | 52 ms | 52 ms | 0 ms |
| Peak running ECS tasks | 1 | 1 | 0 |

## Autoscale baseline results

| Metric | r1 | r2 | r3 |
| --- | ---: | ---: | ---: |
| Offered jobs/s | 50.060 | 50.060 | 50.058 |
| Completed / submitted jobs | 31,500 / 31,500 | 31,500 / 31,500 | 31,500 / 31,500 |
| Peak visible backlog | 1,726 | 1,549 | 1,240 |
| Peak BPT (genuine CloudWatch) | 1,366 | 1,361 | 1,130 |
| Peak oldest-message age | 42 s | 35 s | 38 s |
| Completion throughput | 49.910 jobs/s | 49.920 jobs/s | 49.660 jobs/s |
| Post-arrival drain | 0 s | 0 s | 0 s |
| Processing latency p95 | 52 ms | 52 ms | 52 ms |
| Peak running ECS tasks | 5 | 5 | 5 |
| Failures / duplicates / DLQ / unaccounted | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |

| Autoscale summary | Mean | Median | Sample SD |
| --- | ---: | ---: | ---: |
| Offered jobs/s | 50.059 | 50.060 | 0.001 |
| Completed jobs | 31,500 | 31,500 | 0 |
| Peak visible backlog | 1,505.000 | 1,549 | 245.970 |
| Peak BPT | 1,285.667 | 1,361 | 134.834 |
| Peak oldest-message age | 38.333 s | 38 s | 3.512 s |
| Completion throughput | 49.830 jobs/s | 49.910 jobs/s | 0.147 jobs/s |
| Post-arrival drain | 0 s | 0 s | 0 s |
| Processing latency p95 | 52 ms | 52 ms | 0 ms |
| Peak running ECS tasks | 5 | 5 | 0 |

## Fixed versus baseline autoscale

| Primary scalability metric | Fixed mean | Autoscale mean | Effect of autoscaling |
| --- | ---: | ---: | --- |
| Peak visible backlog | 3,808.667 | 1,505.000 | 60.5% lower |
| Peak BPT | 3,678.667 | 1,285.667 | 65.1% lower |
| Peak oldest-message age | 120.000 s | 38.333 s | 68.1% lower |
| Completion throughput | 42.467 jobs/s | 49.830 jobs/s | 17.3% higher |
| Post-arrival drain | 109.367 s | 0 s | Eliminated |
| Processing p95 | 52 ms | 52 ms | No change |
| Peak running tasks | 1 | 5 | Scale-out occurred in every repeat |

The autoscale arm completed the same 31,500 jobs in every repeat with the same reliability result as fixed capacity.

## Demonstrated first bottleneck

The evidence identifies **autoscaling response latency** as the first demonstrated scalability bottleneck, rather than worker processing latency or reliability.

- Fixed capacity developed sustained pressure (mean BPT 3,678.667 against target 75), yet all jobs completed with zero faults. This is load-induced queueing, not worker failure.
- Autoscale reached five running tasks in every repeat and materially reduced backlog, BPT, and message age while retaining 52 ms p95. Worker processing latency was not the first limiting factor at this workload.
- Baseline target tracking took roughly 3.5–4 minutes from pressure developing to the scale-out request (about 230.6 s over the baseline runs). Fargate start-up then added approximately 20–46 s before added tasks emitted `WORKER_READY`.

The first demonstrated delay was the sequence of one-minute custom-metric publication, target-tracking evaluation, and Fargate task start-up. It allowed a substantial queue to build before added capacity was usable; it was not a reliability regression.

## Targeted Distinction improvement

Commit `7e3321e` retained the original BPT target-tracking controller and added a fast scale-out path in [`infrastructure/cloudformation/scaling.yaml`](../infrastructure/cloudformation/scaling.yaml).

- `TargetBacklogPerTask = 75` and scalable-target min/max `1–5` were retained.
- A `SIT314/Transport` `BacklogPerTask` CloudWatch alarm for the same service dimension uses threshold **greater than 75**, one-minute period, `EvaluationPeriods = 1`, and `DatapointsToAlarm = 1`.
- The alarm invokes a step-scaling policy with `ChangeInCapacity = +4`.
- There is no step-scaling scale-in policy. Target tracking remains responsible for steady state and scale-in.

This is a response-latency intervention, not a change to the frozen workload, worker processing cost, target value, or capacity bounds.

## Valid improvement retest

The valid replacement retest submitted and completed 31,500/31,500 jobs at 49.909 offered jobs/s. Its schedule lag was 10.506 ms mean, 17 ms p95, and 234 ms maximum—inside the unchanged timing guard. It had zero failures, duplicates, DLQ messages, and unaccounted jobs.

| Metric | Baseline autoscale mean | Improved retest | Effect |
| --- | ---: | ---: | --- |
| Scale-request latency | 230.6 s | 62.512 s | 72.9% lower |
| Peak visible backlog | 1,505 | 1,042 | 30.8% lower |
| Peak BPT | 1,285.667 | 192 | 85.1% lower |
| Peak oldest-message age | 38.333 s | 24 s | 37.4% lower |
| Completion throughput | 49.830 jobs/s | 48.830 jobs/s | About 2.0% lower |
| Post-arrival drain | 0 s | 11.784 s | 11.784 s longer |
| Processing latency p95 | 52 ms | 53 ms | 1 ms higher |
| Peak running tasks | 5 | 5 | Earlier scale to full capacity |
| Reliability faults | 0 | 0 | No regression |

The first genuine above-target BPT minute was `2026-09-22T10:51:00Z`. The fast alarm entered `ALARM` at `10:52:02.284Z`; its step-scaling request was recorded at `10:52:02.512Z`. The four added workers emitted `WORKER_READY` between `10:52:34.902Z` and `10:52:42.559Z`, while arrivals continued until `11:01:56.900Z`. Added capacity was therefore operational while meaningful work was still arriving.

The improvement succeeded at its primary purpose: it materially reduced scale-out response delay and queue pressure without harming correctness. It did **not** improve every metric. The explicit trade-offs are approximately 2% lower completion throughput, an 11.784 s post-arrival drain, a 1 ms p95 increase, and temporary additional compute cost from reaching five tasks earlier.

## Reliability conclusion

Across every valid formal repeat and the valid improvement retest, the result was **zero failures, zero duplicates, zero DLQ messages, and zero unaccounted jobs**. The timing-invalid diagnostic run is excluded from this statement and from all reported comparisons.
