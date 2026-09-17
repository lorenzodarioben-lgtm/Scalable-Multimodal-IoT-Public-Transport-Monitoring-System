# HD predictive-path failure modes — local audit

**No AWS call was made.** The predictive path only raises HD desired capacity. The independent BPT target-tracking and fast +4 alarm remain installed in both arms; a predictor failure does not remove or alter them. A failure during a formal run still makes its evidence suspect and requires review, not a quiet replacement.

| Case | Local behaviour and test | Formal-run consequence |
| --- | --- | --- |
| Fewer than eight rate bins; zero, flat or falling traffic; noisy small slope | Controller holds current/reactive floor, makes no predictive request. Controller and signal-processor tests cover these paths. | Reactive policies remain available. |
| Missing/late/out-of-order arrival signal | A closed missing bin has zero arrivals; a late count is assigned to the current bin without rewriting history. Invalid numeric fields are rejected. Signal-processor tests cover all cases. | Inspect FIFO/DLQ and rate continuity; do not assert an accurate forecast if arrivals are incomplete. |
| Duplicate FIFO delivery or persisted state conflict | Per-run signal ID suppresses duplicate count; conditional DynamoDB write conflict fails invocation for retry. Fake-port tests cover both. | No duplicate job enqueue; unexpected signal DLQ invalidates the attempt. |
| Forecast overshoots, capacity already sufficient or current/reactive floor higher | Recommendation is clamped to 1–5 and at least current desired/running/reactive floor. No predictive scale-in; equal/lower requests are suppressed, with 60 s cooldown. | Additional task-seconds are a measurable trade-off, not hidden. |
| Abrupt unforecastable burst | Controller cannot anticipate its onset; unchanged BPT target tracking and fast alarm provide independent fallback. Local simulator/controller tests cover the missed forecast case. | Report burst as safety/robustness test, not pre-burst prediction success. |
| ECS UpdateService fails | Pending request remains in persisted state and duplicate delivery retries against live ECS desired count. Fake end-to-end tests cover failure/retry. | Retain Lambda error/log chronology; do not declare a valid run without accounting and review. |
| DynamoDB read/write or CloudWatch PutMetricData fails | State-read/write errors fail Lambda and trigger SQS retry; metric publication error is recorded but does not reverse a successful scale-out. Fake-port tests cover transient failures. | Missing required historical metrics prevent automatic validity. |
| Timing guard, job accounting, task-state or required metric fails | Runner labels timing, reliability, task-state or missing-metric validity and preserves the artifact. Aggregator refuses these as a reviewed valid run. | Stop and diagnose; never silently include or automatically rerun. |

Cloud-only gates remain: Academy role permissions, Lambda SDK/module loading, event-source mapping, actual ECS and metric publication timing. The bounded HD smoke must prove these before a formal run. Do not weaken reactive settings or redirect the predictor to D when a gate fails.
