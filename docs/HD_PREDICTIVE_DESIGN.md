# HD Predictive-Reactive Controller Design

## Local-only implementation status

[`experiments/hd/predictive-controller.js`](../experiments/hd/predictive-controller.js)
is a deterministic, side-effect-free controller. It imports no AWS SDK and
does not invoke AWS. Its only output is a scale-out recommendation; a future
HD-only deployment adapter would be responsible for acting on that output.

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
| History | 6 samples / 60 s | Enough points for a small linear fit without a training dataset. |
| Forecast method | Rolling ordinary least-squares linear regression | Deterministic, inspectable slope and intercept; no opaque model or framework. |
| Prediction horizon | 110 s | The final D fast-reactive evidence measured 62.512 s from first above-target BPT minute to scale request, plus up to 40.047 s request-to-ready. The 110 s horizon covers the observed 102.559 s path with a small margin. |
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
r̂ = max(0, r(now + 110 s))
B̂ = visibleBacklog + max(0, r̂ - currentTasks × 42.467) × 110
requiredTasks = clamp(1, 5,
  max(reactiveFloor, currentTasks, ceil(r̂ / 42.467), ceil(B̂ / 75)))
```

The controller recommends predictive scale-out only when all of the following
are true:

1. six chronological samples are available;
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
matched to prior forecasts at the declared horizon. End-of-run forecasts that
lack a future observation are excluded rather than guessed.

## Future deployment adapter, explicitly out of scope now

The local controller is intentionally vendor-neutral. A later HD deployment
must add an HD-only adapter that reads the current ECS desired/running counts,
supplies the reactive floor, and performs an increase only when the controller
returns `shouldRequestScaleOut`. It must never issue a scale-in request.

No such adapter is deployed or called in this phase.
