# HD Predictive-Reactive Controller Design

## Implementation status

[`experiments/hd/predictive-controller.js`](../experiments/hd/predictive-controller.js)
is a deterministic, side-effect-free controller. It imports no AWS SDK and
does not invoke AWS. Its only output is a scale-out recommendation. The HD-only
adapter in [`experiments/hd/aws/`](../experiments/hd/aws/) is prepared locally
and tested with fake clients; it has not been deployed or invoked against AWS.

The existing Distinction formal runner remains untouched because it is a
carefully validated experiment harness. Its `controller` interface is the
existing side-effect boundary for a future HD runner/adapter.

## Integration audit

The cleanest future input hook is immediately **after successful analysis-job
publication** in `TelemetryProcessor.#publishJobs`:

1. The telemetry processor has already applied idempotency.
2. It knows the exact number of analysis jobs that were successfully accepted
   by the analysis queue.
3. It can emit one arrival observation `{timestamp, publishedJobCount}` without
   estimating fan-out from raw telemetry.

The current once-per-minute BacklogPerTask Lambda is intentionally retained as
the reactive signal, but it is unsuitable as the only predictive input: it
observes queue state after work arrives and publishes on a one-minute schedule.

## Predictor configuration

| Parameter | Value | Rationale |
| --- | ---: | --- |
| Arrival-rate sample interval | 10 s (planned) | Short enough to observe the workload profile while keeping observations explainable. |
| History | 8 samples / 80 s | Selected from the 40/60/80 s local sensitivity grid for lower task-seconds with the same modelled ramp backlog result. |
| Forecast method | Rolling ordinary least-squares linear regression | Deterministic, inspectable slope and intercept; no opaque model or framework. |
| Prediction horizon | 80 s | Selected from the 80/100/110/120 s local sensitivity grid. In the planned ramp, the selected predictor requests at 420 s and the modelled worker is ready at 460.5 s, before the 50 jobs/s segment at 510 s. This is a local result, not an AWS guarantee. |
| Per-task capacity assumption | 42.467 jobs/s | Conservative initial value from the final D fixed-arm mean completion throughput. It is a control assumption to be sensitivity-tested, not a claim of intrinsic task capacity. |
| Target | 75 jobs/task | Unchanged from final D. |
| Bounds | 1–5 tasks | Unchanged from final D. |
| Rising-trend threshold | 0.02 jobs/s² | Filters flat/noisy samples before proactive action. |
| Hysteresis | 2 consecutive positive recommendations | Prevents a one-sample spike becoming a predictive request. |
| Duplicate-request cooldown | 60 s | Stops repeated requests for the same desired capacity while control-plane state catches up. |

## Decision logic

For rate samples `(t, r)`, the controller fits:

```text
r(t) = a + b t
r̂ = max(0, r(now + 80 s))
B̂ = visibleBacklog + max(0, r̂ - currentTasks × 42.467) × 80
requiredTasks = clamp(1, 5,
  max(reactiveFloor, currentTasks, ceil(r̂ / 42.467), ceil(B̂ / 75)))
```

The controller recommends predictive scale-out only when all of the following
are true:

1. eight chronological samples are available;
2. `b >= 0.02 jobs/s²`;
3. the bounded recommendation is above the observed reactive/current capacity
   floor;
4. the positive recommendation is observed twice consecutively; and
5. it is not a duplicate request for the same-or-lower task count within 60 s.

It never recommends scale-in. `reactiveRequiredTasks`, current desired count,
and running count form a lower bound, so prediction cannot reduce capacity
already required by the final D reactive system. If BPT is above 75, the output
marks the reactive fallback active; the independently deployed target tracking
and fast step-scaling path remain responsible for that reactive action.

## Tested boundary behaviour

Focused local tests cover:

- insufficient history: hold the reactive capacity floor;
- flat/noisy traffic: no predictive request;
- rising traffic: bounded proactive recommendation after hysteresis;
- falling traffic: no predictive scale-in;
- sudden burst: safe hold while reactive fallback is marked active;
- duplicate recommendation: suppressed during cooldown;
- deterministic linear model and prediction MAE;
- no AWS SDK/control-plane import.

`predictionMae` reports mean absolute error over future rate observations
matched to prior forecasts at the declared horizon. The controller supplies a
forecast for flat and falling traffic too, while withholding proactive action.
End-of-run forecasts that lack a future observation are excluded rather than
guessed. State serialization supports deterministic restoration across events.

The local tuning record is in [HD_LOCAL_EVALUATION.md](HD_LOCAL_EVALUATION.md).

## Prepared HD AWS boundary — local code only

The optional HD telemetry-processor hook emits an analysis-job count only
after a successful fan-out. Each signal has a stable event ID. The matched HD
experiment injector will emit the same schema because the formal runner sends
analysis jobs directly and bypasses the telemetry processor. Its signal send
must fail the experiment if it fails; application traffic logs
`HD_ARRIVAL_SIGNAL_FAILED` and retains the independent reactive safety path.

The HD-specific FIFO signal queue invokes a packaged Lambda one message at a
time. A per-run DynamoDB item stores the 10 s arrival bin, recent signal IDs,
controller samples, pending forecasts, and a pending scale request. A
version-conditional write commits the signal before the ECS update. If ECS
fails, the FIFO message retries and resumes the pending request without
counting the signal again. If ECS succeeds but the final state write fails,
the retry checks live desired capacity and avoids a second increase.

The adapter reads live desired/running capacity and requests only an increase
bounded to five tasks. It does not perform predictive scale-in. The HD
CloudFormation templates prepare the FIFO queue, DLQ, state table, Lambda,
event mapping and metric namespace `SIT314/HDTransport` under an HD prefix.
The existing target-tracking and fast reactive definitions remain intact in
the separate HD environment. Genuine reactive `BacklogPerTask` uses only the
`ServiceName` dimension; predictor-observed queue/BPT metrics also carry
`RunId` and must not be substituted for the reactive CloudWatch series.

The application signal hook is best-effort after business job publication:
an unavailable signal queue can omit a predictor observation without losing
analysis jobs. A validity gate must inspect this log and the signal DLQ.
SQS approximate depth and a direct ECS desired-count request can race with
the independent target-tracking controller. The first cloud smoke test must
verify permissions, signal throughput, metric publication and that predictive
capacity persists long enough to become `WORKER_READY`.
