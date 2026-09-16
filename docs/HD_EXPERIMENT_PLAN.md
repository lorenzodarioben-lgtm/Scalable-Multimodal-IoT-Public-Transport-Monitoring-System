# HD Experiment Plan — Proposed, Not Executed

## Evidence separation and comparison arms

This plan is **HD PLANNED EXPERIMENT** material only. It creates no new
Distinction evidence and has not run on AWS.

For each workload class, the matched comparison is:

| Arm | Controller |
| --- | --- |
| Baseline | Final Distinction reactive system: BPT target tracking plus fast BPT greater-than-75 step scale-out. |
| Treatment | Same reactive system plus the HD local predictor/controller and future HD-only scale-out adapter. |

Both arms will use the same worker image, 50 ms worker processing delay, zero
CPU-iteration setting, one-to-five task range, BPT target of 75, queues,
correctness accounting, and a precomputed incident schedule. Each class should
run three valid repeats per arm with fresh execution identities and a clean
queue/DLQ starting state. No alarm state, desired count, or capacity may be
manually forced after arrivals start.

## Workload A — predictable ramp

Configuration: [`experiments/hd/predictable-ramp.json`](../experiments/hd/predictable-ramp.json).
The 30 s warm-up is inside the first segment; scheduled arrivals span the full
630 s, with the measurement window covering offsets 30–630 s, as in final D.

| Offset | Incident interval | Analysis-job arrival rate | Incidents |
| --- | ---: | ---: | ---: |
| 0–150 s | 5 s | 10 jobs/s | 30 |
| 150–270 s | 3 s | 16.667 jobs/s | 40 |
| 270–390 s | 2 s | 25 jobs/s | 60 |
| 390–510 s | 1.5 s | 33.333 jobs/s | 80 |
| 510–630 s | 1 s | 50 jobs/s | 120 |

Each incident contains 50 analysis jobs: 330 incidents and 16,500 expected
jobs. The gradual trend lets an 80 s forecast identify sustained pressure
before the final 50 jobs/s segment. This is the primary predictive hypothesis
test.

## Workload B — sudden burst

Configuration: [`experiments/hd/sudden-burst.json`](../experiments/hd/sudden-burst.json).

| Offset | Incident interval | Analysis-job arrival rate | Incidents |
| --- | ---: | ---: | ---: |
| 0–210 s | 5 s | 10 jobs/s | 42 |
| 210–510 s | 1 s | 50 jobs/s | 300 |
| 510–630 s | 5 s | 10 jobs/s | 24 |

Each incident contains 50 analysis jobs: 366 incidents and 18,300 expected
jobs. The step at 210 s deliberately has no preceding ramp. The prediction
should not be credited for anticipating it; the final D reactive safeguard is
the intended safety path.

## Metrics and collection rules

| Category | Metric | Definition / collection |
| --- | --- | --- |
| Primary | Scale-request latency | From the declared workload reference point to the first controller/scaling activity request; also report predictive lead time where a treatment request occurs before actual pressure. |
| Primary | Peak visible backlog, BPT, oldest-message age, post-arrival drain | Preserve raw queue samples; obtain BPT from genuine historical `SIT314/HDTransport` CloudWatch datapoints for the isolated HD service, not queue-depth inference. |
| Secondary | Completion throughput and processing p95 | Existing summary/log collection. |
| Secondary | Task-seconds | Existing sampled running-task integration; compare as capacity-time cost. |
| Secondary | Prediction MAE | Match each 80 s rate forecast to the actual later 10 s arrival-rate observation; exclude unmatched tail forecasts. |
| Reliability | Failures, duplicates, DLQ, unaccounted jobs | Existing DynamoDB/SQS/log accounting, with zero required for a valid run. |
| Timing | Task RUNNING and `WORKER_READY` | Existing ECS and log evidence, correlated to both reactive and predictive requests. |

The predetermined rate-change offset is the common workload reference for each
class. If treatment prevents BPT from crossing 75, report that fact and report
the pre-pressure predictive lead time instead of inventing a reactive-threshold
latency for treatment.

## Threats to validity and safeguards

- A linear predictor may be useful for a ramp but not for a discontinuity; the
  second class explicitly tests that limit.
- One measured fixed-worker throughput is a provisional control parameter, so
  sensitivity analysis is required before final claims.
- CloudWatch/SQS observations are approximate and may be delayed. Preserve
  timestamps, raw samples, genuine CloudWatch data, scaling activities, and
  worker-ready events rather than inferring missing points.
- Predictor benefits may exchange queue delay for capacity-time. Task-seconds
  are therefore a required outcome, not an optional cost anecdote.
- Repeat all arms; do not generalise from one HD run or compare a treatment
  result with a cherry-picked Distinction repeat.

## AWS work that would be required later — not authorised or performed

The safest eventual deployment is a **separate HD-prefixed environment**, not
a mutation of the live `sit314-transport` Distinction deployment. It would
require all of the following after explicit authorisation:

1. HD-specific CloudFormation resources and a distinct resource prefix,
   including queues, ECS service, scalable target, and the unchanged final-D
   target-tracking plus fast reactive policies.
2. An HD arrival-observation path after successful telemetry-processor fan-out
   to send idempotent `{timestamp, publishedJobCount}` samples to a new HD
   controller Lambda or equivalent compute component.
3. Predictor-state persistence for the rolling sample window and idempotency,
   with least-privilege IAM for that state, CloudWatch evidence metrics, ECS
   `DescribeServices`, and scale-out-only `UpdateService` calls.
4. HD metrics for observed arrival rate, forecast rate, forecast error,
   recommendation, and predictive scale request, plus logs that associate
   requests with task `RUNNING` and `WORKER_READY` evidence.
5. An adapter that reads current desired/running capacity and only increases
   desired count to `max(current, reactive floor, recommendation)`, bounded
   1–5. It must not scale in and must not replace the reactive policy.

The HD-prefixed templates, Lambda adapter, matched runner and review-gated
analysis are now prepared locally. They have not been deployed or invoked
against AWS. No AWS API, deployment, workload, cleanup, push, or merge was
performed for this plan.
