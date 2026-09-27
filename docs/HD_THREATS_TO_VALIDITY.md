# HD threats to validity and mitigation

This threat register was written before the completed AWS comparison. It
remains applicable to the [final report](HD_REPORT.md): the results are a
bounded engineering comparison, not a general proof that prediction improves
IoT autoscaling.

| Threat | Consequence | Mitigation / reporting rule |
| --- | --- | --- |
| Only a gradual ramp and one abrupt burst | Other transport patterns may reverse the outcome. | State the scope explicitly; retain a flat/noisy local-only diagnostic; do not generalise to all IoT workloads. |
| Synthetic bus incidents and fixed 50-job fan-out | Production sensor mixtures may have different arrival and processing distributions. | Use the same deterministic logical jobs, processing cost and schedule in both AWS arms; report synthetic nature. |
| Only 1–5 Fargate tasks | At larger scales the control interaction and costs may differ. | Bound claims to this small Academy deployment. |
| One Academy account/region (`us-east-1`) | Shared-account limits, transient throttling and regional conditions may dominate. | Preserve timestamps, run identity, task events and permission failures; do not generalise across regions. |
| Fargate image-pull and startup variation | A forecast that leads one run may fail in another. | Record request, ECS RUNNING and exact WORKER_READY per task, report all three repeats and range. |
| CloudWatch publication/evaluation cadence and SQS queue-depth estimates | BPT, age, queue and trigger timestamps have limited temporal precision. | Preserve genuine historical CloudWatch BPT and raw sampled SQS data separately; never derive one from the other; report source and period. |
| Three repeats per arm/class | Means and sample SD are descriptive, not a powered significance test. | Show all raw values, median and range; avoid p-values or significance claims. |
| Single-task capacity assumption (42.467 jobs/s fixed-arm mean) | Capacity may not scale linearly with tasks or under a new image. | Use one worker image/cost for both arms, verify actual task definition, compare observed throughput and show local capacity sensitivity. |
| Rolling linear forecast | Abrupt changes are intrinsically hard to foresee; stale/late signals can reduce lead. | Treat burst as a safety/fallback test, record error/lead and false requests; do not credit pre-burst anticipation without a timestamp. |
| Parameter selection on designed workloads | The ramp could be overfit. | Publish the 48-candidate grid, preselect one configuration before AWS, do not retune on test results, preserve invalid attempts. |
| Hybrid may trade queue delay for resource time | Better backlog may cost more capacity. | Show task-seconds beside backlog and latency; make no monetary savings claim from task-seconds alone. |
| Task-seconds are not AWS billing | Fargate minimums, vCPU/memory, logs, Lambda, SQS, DynamoDB, metric charges and data transfer are omitted. | Use task-seconds only as a transparent worker-capacity proxy; check actual Academy budget before deployment. |
| Separate HD environment may differ from live D | HD baselines may not reproduce the final D fast-reactive run. | Compare HD reactive and hybrid on the **same HD resources**; cite D only as design calibration, not as a matched HD arm. |
| Direct injection bypasses telemetry processor | Generator-sent signal may differ from normal post-fanout traffic. | Use identical schema and post-success count; separately smoke-test optional application hook if deployed; disclose that matched AWS study uses direct injector. |

Validity gates: never include timing-invalid, incomplete, nonzero-DLQ, unaccounted, or unreviewed runs in final tables. A clean technical run is only `PENDING_MANUAL_TIMELINE_REVIEW` until `review.json` records a justified `VALID` decision for the exact run ID. If a run fails, retain its artifact and stop to diagnose; no silent replacement or cherry-picking.
