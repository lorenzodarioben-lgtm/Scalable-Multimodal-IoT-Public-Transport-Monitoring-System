# Distinction AWS injector and capacity calibration

This is a dated technical record from 21–22 September 2026. It describes the
calibration performed before the final Distinction comparison, not the current
cloud state or a substitute for the [final Distinction results](../DISTINCTION_FINAL_RESULTS.md).

## Injector safeguards

The formal AWS runner sends each 50-job incident as five concurrent SQS batches
of ten. It schedules incidents from a fixed workload epoch; slow sends and status
sampling do not move the next planned incident. A dispatch-start lag guard marks
a run invalid when injection timing no longer matches the declared workload.
`dispatches.jsonl` and `injection-timing.json` record planned and actual dispatch
times. Before starting the epoch, the runner verifies capacity, queues and
processing cost, then waits for one running ECS task and its matching
`WORKER_READY` event. The local PID fallback applies only to local execution.

## Historical calibration observations

| Check | Observed result | Interpretation |
| --- | --- | --- |
| Injector timing sanity | 30 incidents; 1,500 jobs; 29.333 s injection; 51.137 jobs/s offered; dispatch-start lag mean/p95/max 11.7/28/43 ms | Valid timing check, not capacity evidence. |
| Fixed capacity calibration | 180 incidents; 9,000/9,000 jobs; 179.329 s injection; 50.187 jobs/s offered; peak visible backlog 1,544; 59.883 s drain | One worker throughout, with zero duplicate, error, DLQ or unaccounted jobs. This was not an autoscaling comparison. |

The fixed-capacity calibration did not establish that the genuine CloudWatch
`BacklogPerTask` threshold had been crossed: temporary Academy credentials were
cancelled before the historical metric was retrieved. The later formal results
use their own preserved CloudWatch history and review decisions. The calibration
profiles are in [`experiments/calibration/`](../../experiments/calibration/).

At this checkpoint the original Distinction AWS environment used the
`sit314-transport` prefix for CloudFormation stacks, SQS queues, DynamoDB tables,
the route-impact ECS service, ECR image, scheduled backlog metric Lambda and
CloudWatch scaling policy. The fast reactive policy was added and verified in
the later final Distinction experiment. Live resources must be inspected anew;
this dated record is not a current deployment status.
