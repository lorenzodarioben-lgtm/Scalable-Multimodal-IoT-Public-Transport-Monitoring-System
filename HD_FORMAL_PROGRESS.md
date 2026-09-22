# SIT314 6.4HD formal AWS progress

Frozen 12-row matrix: predictable ramp reactive/hybrid r1–r3, then sudden burst reactive/hybrid r1–r3. Do not repeat a row with a `VALID` review. Never include smoke or local mock data in the formal aggregate. Before every next workload verify all HD analysis, arrival and notification queues/DLQs 0/0, route-impact ECS 1/1/0, notification ECS healthy, genuine HD BPT idle, current exact worker readiness, target 1–5/BPT 75/fast +4 intact, predictor mode and no pending request. The historical D notification queue is explicitly out of scope and must not be touched.

## Completed rows

| Class | Arm | Repeat | Review | Run artifact |
|---|---|---:|---|---|
| Predictable ramp | Reactive | r1 | VALID | `artifacts/hd-aws-runs/2026-09-23T19-48-33-633Z-hd-predictable-ramp-reactive-r1-d5300e39/` |
| Predictable ramp | Hybrid | r1 | VALID | `artifacts/hd-aws-runs/2026-09-23T20-18-35-936Z-hd-predictable-ramp-hybrid-r1-cc19b00e/` |

Ramp reactive r1 completed 330/330 incidents and 16,500/16,500 analysis jobs in 630.133 s (26.185 jobs/s). Schedule-start lag mean/p95/max 7.609/16/109 ms passed the frozen guard. No failures, duplicate results, DLQ or unaccounted jobs. Genuine historical BPT peak 728, oldest-message age 29 s; sampled visible backlog peak 828; reactive scale request 19:58:45.554Z, first new `WORKER_READY` 19:59:17.988Z. Processing p50/p95 50/52 ms; drain 12.67 s; measurement task-seconds 600 from sampled chronological integration.

The original `summary.json` is preserved with `PENDING_REQUIRED_METRICS` because the asynchronous sampler appended one 19:59:19 sample before a 19:59:18 measurement-complete sample. This is a reduction-order error, not an injection/evidence gap. `summary-recovered.json` is hash-bound to the original summary and raw samples and corrects only task-seconds/validity; `review.json` marks the run VALID after chronology and accounting review. **Do not reinject or replace r1.** The reducer now sorts valid timestamps and rejects ties; focused and full tests pass.

Ramp hybrid r1 completed the same logical digest `015ac2e011dc63cc1f0c964645a0297539aba00523da64af4eab67c147caf593` on the same worker image/Fargate size. All 330 incidents and 16,500/16,500 jobs completed; maximum start lag 756 ms passed the unchanged guard; zero failures, duplicates, DLQ or unaccounted jobs. Genuine historical BPT peak **40** (reactive r1 **728**), visible backlog **63** (reactive **828**), oldest age **17 s** (reactive **29 s**), drain **0 s** (reactive **12.67 s**). One predictive request to five at 20:26:39.632Z preceded defined overload by 45.872 s; first new worker ready 26.641 s after request. Prediction MAE 8.816 jobs/s, bias -1.157 jobs/s, 48 error points. Hybrid measurement task-seconds **1139.196** versus reactive **600**; this cost increase is retained as measured. `review.json` marks hybrid r1 VALID. **Do not reinject or replace either r1 arm.**

## Exact next row

Predictable ramp **reactive r2** after the HD-only clean baseline. At the last inspection, hybrid r1 had just completed; verify every HD queue/DLQ 0/0, recent genuine BPT zero, fast alarm OK, notification worker healthy and route-impact ECS back to 1/1/0. Wait for natural scale-in or use the runbook's authorised *between-runs-only* HD desired-count reset only after full drain. Never change capacity after the next workload starts. The HD wrapper changes only predictor mode before injection and creates a fresh execution identity.
