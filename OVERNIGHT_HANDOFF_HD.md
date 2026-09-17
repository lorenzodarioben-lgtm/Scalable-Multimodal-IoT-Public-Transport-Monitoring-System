# SIT314 6.4HD overnight handoff — 23 September 2026

**Single source of truth for the next HD session. LOCAL DEVELOPMENT ONLY. FINAL AWS HD EVIDENCE NOT YET COLLECTED.** Do not treat any simulator number as a cloud result. Record the Distinction demonstration video **before** any HD AWS deployment. Then follow [`docs/HD_AWS_RUNBOOK.md`](docs/HD_AWS_RUNBOOK.md) one guarded step at a time.

## 1. Safety and version checkpoint

- Frozen Distinction checkout: `C:\Users\lorenzodario\Documents\UNI\UNI_T3\CLoud\Distinction`, branch `prep/aws-experiment-readiness`, HEAD `06071c37c536e73fb036bb4f60279d7e595d23c2`. Annotated tag `sit314-6.3d-final^{}` peels to the **same** commit. No tracked D changes. Its pre-existing untracked `HighDistinction/`, `ISSUESANDSOLUTIONS.md`, `Tasks/` and extended calibration profile were not altered or moved.
- HD nested worktree: `C:\Users\lorenzodario\Documents\UNI\UNI_T3\CLoud\Distinction\HighDistinction`, branch `hd/predictive-autoscaling`. Starting HEAD `a1559cfe160f931c1b45470fda4988753573de92`; ending **implementation/report commit before this handoff file** `563ad15`. The handoff commit itself is the final HD HEAD; obtain its exact hash with `git rev-parse HEAD` (a Git commit cannot contain its own hash).
- Local commits made tonight, oldest first: `2c3d3a1` simulator/controller sensitivity; `001717d` isolated predictor integration; `7be0308` matched AWS harness; `28010bc` review-gated analysis/charts; `563ad15` report/runbook/evidence. The final handoff/package cleanup commit follows these. No push, merge, remote tag, AWS API, STS, deployment, workload or cloud cleanup was performed.
- The live final-D fast-reactive system is the **design calibration**. The older target-tracking-only three-run mean is **not** the HD reactive comparison arm. Tomorrow's matched reactive and hybrid HD runs must use the same separately deployed HD environment.

## 2. What changed locally

Major added/changed locations: `experiments/hd/predictive-controller.js`; `experiments/hd/simulator/`, `experiments/hd/artifacts/local-parameter-study.json/.csv`, `experiments/hd/baselines/distinction-reactive-baseline.json`; `shared/hd/arrival-signal.js`; `experiments/hd/aws/` (signal processor, AWS ports, Lambda handler, control plane, matched workload, runner, explicit-flag CLI and smoke); `services/telemetry-processor/src/hd-arrival-observer.js` and its optional post-fanout hook; HD-prefixed `infrastructure/cloudformation/hd-code.yaml`, `hd-signals.yaml`, `hd-predictor.yaml`, plus HD-safe parameters in existing templates/scripts; `experiments/hd/analysis/`; new focused tests; and `docs/HD_REFERENCES.md`, `HD_LOCAL_EVALUATION.md`, `HD_PREDICTIVE_DESIGN.md`, `HD_EXPERIMENT_PLAN.md`, `HD_THREATS_TO_VALIDITY.md`, `HD_REPORT_DRAFT.md`, `HD_APPENDIX_PLAN.md`, `HD_AWS_RUNBOOK.md`, `HD_EVIDENCE_CHECKLIST.md`. No frozen D file/tag was edited in the D checkout.

## 3. Final predictive algorithm and parameters

- Inputs: 10-second analysis-job arrival-rate bin, SQS visible backlog, desired/running tasks, reactive capacity floor, BPT observation, timestamp, persisted controller state. Signal is **analysis jobs successfully published**, not raw sensor events. FIFO + per-run DynamoDB version/seen IDs deduplicate signals and make ECS-update retry safe.
- Eight chronological samples = 80 s history. OLS regression: `b = Σ((tᵢ−t̄)(rᵢ−r̄)) / Σ((tᵢ−t̄)²)`; `a = r̄ − b t̄`; `r̂ = max(0, a + b(t_now + 80 s))`. Sample times are elapsed seconds and rates jobs/s. No neural network or model training.
- Capacity assumption `c=42.467 jobs/s/task` (mean of three valid final-D fixed runs; observed range 41.640–43.350). Safety factor **1.00**. Horizon **80 s**. `B̂ = B + max(0, r̂ − n×c)×80`; `recommendation = clamp(1,5,max(n,reactiveFloor,ceil(r̂/c),ceil(B̂/75)))`. `n` is current desired/running safe floor. Scale-out only, never predictive scale-in. Target BPT remains **75**, task bounds **1–5**.
- A rising slope of **0.02 jobs/s²**, **two** consecutive positive recommendations and **60 s** same-or-lower duplicate-request cooldown gate action. Insufficient, flat, falling, invalid, duplicate and max-capacity cases are explicit and tested. Independent final-D target tracking and fast +4 BPT alarm remain the reactive safeguard.

## 4. LOCAL SIMULATION RESULT — NOT FINAL AWS HD EVIDENCE

The deterministic 0.5 s fluid/FIFO simulator uses an assumed constant 42.467 jobs/s/task, fixed 60 s reactive metric sampling, 62.512 s from an above-target sample to fast request, and 40.047 s request-to-worker readiness. It omits publication jitter, SQS in-flight details, contention, real AWS scaling conflicts and reliability. Complete 48-candidate grid: history 4/6/8 bins; horizon 80/100/110/120 s; capacity factor 0.85/1; hysteresis 1/2. Cooldown60 and slope0.02 fixed. Eight-bin/80-second/factor1/hysteresis2 selected for equal modelled ramp backlog suppression with lower task-seconds and no flat/noisy false requests.

| Local trace | Final-D-reactive model | Selected hybrid model |
| --- | ---: | ---: |
| Ramp first request / first ready | 603 s / 643.5 s | 420 s / 460.5 s (before 510 s high segment) |
| Ramp peak visible backlog / drain | 946.427 jobs / 15.5 s | 50 jobs / 0 s |
| Ramp task-seconds | 653.5 | 799.5 (**+22.3%**) |
| Abrupt burst first request / first ready | 303 s / 343.5 s | 230 s / 270.5 s (**after** 210 s onset) |
| Burst peak backlog / task-seconds | 1,051.889 / 1,776 | 501.980 / 2,068 (**+16.4%**) |
| Flat/noisy false predictive scale-outs / task-seconds | n/a / 630 | **0** / 630 |

Ramp prediction MAE **9.138 jobs/s**, signed bias **−1.395** over 48 matched forecast pairs; burst MAE **20.694**, bias **+5.972**. Local stress cases over 41.640–43.350 jobs/s/task and 32.390–46 s startup kept the modelled ramp request at 420 s and first readiness 452.5–466 s. These are design/tuning checks only. See `docs/HD_LOCAL_EVALUATION.md` for caveats and reproducibility.

## 5. Prepared HD AWS architecture and experiments — NOT DEPLOYED

- HD prefix `sit314-hd-transport`. Separate HD queues/tables/ECS/scaling stacks; HD code bucket, FIFO arrival queue + DLQ, DynamoDB predictor state and event-driven Lambda (batch size one). Lambda writes high-resolution predictor metrics to `SIT314/HDTransport`; genuine reactive `BacklogPerTask` is `ServiceName`-dimensioned only and must come from historical CloudWatch. The predictor may call ECS UpdateService **only to raise** desired capacity; target tracking controls scale-in, fast +4 step policy remains. Academy LabRole can be supplied after tomorrow's permission check; no IAM action tonight.
- Optional production telemetry-processor post-fanout observer sends the idempotent signal. Matched HD runner injects analysis jobs directly, so it sends the same signal **after** successful queue publication. Signal-send failure invalidates the run. Predictor state and current task/queue snapshots are injected ports in local tests.
- `experiments/hd/aws-ramp.json`: 30 s warm-up + 600 s measurement, 630 s arrivals, 330 incidents, **16,500 jobs**; 10→16.667→25→33.333→50 jobs/s segments. `experiments/hd/aws-sudden-burst.json`: 366 incidents, **18,300 jobs**; 10 jobs/s to 210 s, 50 to 510 s, 10 to 630 s. Each has reactive/hybrid r1/r2/r3, matched seed/digest and fresh execution identity. Same 50 ms processing delay, zero CPU iterations, one-to-five capacity and BPT75. Timing guard remains 1 interval or three sustained half-interval lags. No alarm forcing or mid-run manual desired count.
- Runner records scheduled/actual injection, queue/task samples with ECS task IDs and `startedAt`, Application Auto Scaling activities, Lambda logs, WORKER_READY, accounting, historical BPT/oldest-age and predictor metrics, signal queue/DLQ final state. Exact D-style BPT inference from raw queue depth is prohibited.
- Analysis: `experiments/hd/analysis/aggregate.js` requires exactly three manually `VALID` reviewed runs per arm/class, retains excluded attempts, shows raw/mean/median/sample SD/% change and outputs SVGs. It cannot pronounce the HD result before real run artifacts. `docs/HD_REPORT_DRAFT.md` is a 4–5-page-target draft with required result placeholders; threats, appendix, screenshots and PowerShell runbook are prepared.

## 6. Validation, cost and blockers

- Full local test suite: **220/220 passed** after final ECS task-timeline test; focused post-change tests **9/9 passed**. Re-run full `npm test` tomorrow before deployment. `npm run lint:infra`: cfn-lint no findings. `npm audit --omit=dev --json`: zero production vulnerabilities (118 production dependencies). `git diff --check` must be clean at final commit. Local Lambda zip packaged under ignored `artifacts/hd-predictor.zip`; repackage after final source edit. No Docker/cloud smoke happened tonight.
- Minimum 12×630 s = **126 min** arrival time plus at least ~12 min CloudWatch grace, with deployment/smoke/startup/resets/manual review likely **3–5+ hours**. Worker task-seconds are a relative capacity cost only. An exact monetary AWS estimate is not defensible without tomorrow's account/budget, region price and actual task durations; check Academy remaining budget before deployment. Do not silently reduce the three repeats.
- Known limitations: simulator idealisations and workload-specific tuning; abrupt burst cannot be foreseen; only two synthetic shapes, one region and 1–5 tasks; cloud metrics approximate; n=3 descriptive only; LabRole permissions, Lambda SDK availability, actual metric/event timings and IAM are **unverified until cloud smoke**. No unresolved local test or lint defect is known. If any live preflight/smoke step fails, stop rather than touch D resources.
- Research metadata was audited in `docs/HD_REFERENCES.md`: Jingle (Wang/Chandra/Weissman), Mogal/Sonaje, Masdari/Khoshnevis, Kumar/Goomer/Singh. The Masdari citation uses the corrected DOI `10.1007/s10586-019-03010-3`. The project is **research-informed**, not a reproduction of Jingle, LSTM or another published model.

## 7. Exact next session order

**FIRST command after opening a PowerShell in this HD worktree, and after recording the D video:**

```powershell
git status --short
```

Then: (1) re-check D peeled tag/clean tracked checkout; (2) fresh Academy credentials and read-only STS/region/budget/permissions; (3) local `npm test`, infrastructure lint and Lambda package; (4) deploy **isolated HD-prefixed** stacks in `docs/HD_AWS_RUNBOOK.md` order, never D; (5) bounded 100-job HD smoke and verify arrival metric/state and clean idle; (6) run twelve matched ramp/burst reactive/hybrid repeats with manual clean reset and mode verification before each; (7) preserve all artifacts, manual `review.json` decisions, then offline aggregate/charts; (8) fill `[TBD: AWS RAMP RESULTS]`, `[TBD: AWS BURST RESULTS]`, `[TBD: TASK-SECONDS RESULT]`, `[TBD: FINAL CONCLUSION AFTER AWS]`; (9) render/check five-page report, appendix/screenshots, final commit/local tag/video/submission; (10) only after submission and explicit approval, clean up **HD-only** AWS resources. Stop if lab time/budget or evidence validity prevents a complete study.
