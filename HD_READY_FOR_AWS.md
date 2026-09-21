# SIT314 6.4HD AWS readiness gate — 24 September 2026

Scope: isolated HD deployment and one bounded 1,150-job smoke only. The 12 formal HD runs have **not** started. The frozen predictor and ramp/burst workloads were not changed. Distinction resources were not modified. This record is not permission to begin formal runs.

## Deployment and runtime

- Branch `hd/predictive-autoscaling`; starting HEAD `1074a6b`. Read the current HEAD with `git rev-parse HEAD`. No push or merge. The D tag `sit314-6.3d-final^{}` remains `06071c37c536e73fb036bb4f60279d7e595d23c2`.
- AWS Academy account `371985210444`, region `us-east-1`, assumed `voclabs` role. All seven `sit314-hd-transport-*` stacks (`queues`, `tables`, `hd-code`, `hd-signals`, `ecs`, `scaling`, `hd-predictor`) are `CREATE_COMPLETE`.
- Isolated ECR `sit314-hd-transport-route-impact-worker:hd-local` has verified digest `sha256:0e2c6ef6cbf2151c3de6d79161145e71bb6f3abdb53e3b563d90504684d7ce41`, pushed 2026-09-23T18:08:54Z. The prior stalls were during the 55.68 MB layer upload, not build, login, manifest verification or a permission denial. A freshly authenticated, bounded retry completed; the exact earlier transport slowdown remains undetermined.
- HD ECS task definition `sit314-hd-transport-route-impact:1` uses that image, 256 CPU / 512 MiB, 50 ms delay and zero CPU iterations. HD scalable target is 1–5, target tracking is BPT 75, and independent fast step scale-out is +4 with alarm `OK` in `SIT314/HDTransport`.
- Node.js 22 HD predictor Lambda is `Active`, mode `hybrid`, with enabled arrival FIFO mapping. Two isolated runtime-probe invocations loaded dependencies, read/wrote DynamoDB state, described ECS, emitted five CloudWatch metrics with no error and requested no scale change. Genuine probe arrival-rate metric and state version 2 were verified.

## One bounded smoke: live path exercised, not formal evidence

Run `hd-predictive-smoke-e56d7a2c-9b8e-4853-a76b-4b6326dc76c6` submitted **1,150/1,150** jobs in 11 post-enqueue signal groups. All 1,150 analysis results exist; duplicates, analysis failures, analysis DLQ and unaccounted jobs are zero. Eleven distinct signal IDs persisted; two duplicate logical deliveries were suppressed. The predictor retained eight history samples, published arrival rate (peak 25 jobs/s), a forecast (peak 37.5 jobs/s), and a bounded recommendation of two tasks. Exactly one predictive scale-out request to two occurred at 2026-09-23T18:26:34.032Z; the new task reached RUNNING at 18:26:56.602Z and `WORKER_READY` at 18:26:59.089Z (25.057 s request-to-ready). Sampled visible analysis backlog peaked at 145; genuine historical HD BPT peaked at 24. Analysis and arrival queues/DLQs drained to 0/0; recent genuine BPT returned to 0. The reactive target-tracking and fast +4 safeguards remained deployed and the alarm returned `OK`; the smoke did not inject a predictive failure or prove fallback by fault injection.

The original automatic `summary.json` marked `INCOMPLETE` **only** because the smoke harness attempted to parse Lambda log lines as bare JSON, ignoring their timestamp/request-id prefix. A local parser fix and focused regression test produced `summary-reviewed.json` from the **same saved AWS artifact without a second workload**; all smoke path checks pass. The original verdict remains preserved. The harness also corrected an observation-loop field path (`controllerState.lastRequestedTasks`), which previously caused an unnecessary full wait; no controller or formal parameter changed. See `artifacts/hd-smoke-runs/hd-predictive-smoke-e56d7a2c-9b8e-4853-a76b-4b6326dc76c6/` and the machine-readable readiness checkpoint in `artifacts/hd-smoke-readiness/2026-09-24-smoke-gate.json`.

## Final state and remaining blocker

- HD route-impact ECS naturally returned to **1/1/0**. HD target 1–5, BPT 75, fast +4 and hybrid predictor remain intact. HD analysis, analysis DLQ, arrival FIFO/DLQ, telemetry queue/DLQ and notification DLQ are 0/0. **HD notifications queue has 4,600 visible / 0 in-flight**: the route-impact worker emitted four downstream alerts per smoke job, but the prepared HD ECS deployment included no optional notification-worker service. No messages were purged.
- D ECS remains **1/1/0** on its original task definition; D target 1–5, BPT 75, fast +4 and analysis queue/DLQ 0/0 remain unchanged. No D cloud stack, policy, queue or tracked file was modified.
- The smoke establishes the live predictive path, but the user-required **all HD queues/DLQs clean** gate is not met. Decide whether to deploy the isolated optional HD notification consumer and let it drain the preserved 4,600 messages, then verify final 0/0 and its DLQ. Do not start a formal HD run or silently purge the queue. No further workload is authorised by this checkpoint.

NOT READY FOR AWS EXPERIMENT
