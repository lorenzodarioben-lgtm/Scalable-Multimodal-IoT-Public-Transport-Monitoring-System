# SIT314 6.4HD pre-AWS handoff — 23 September 2026

**24 September post-smoke update:** The D report/video are completed/submitted. All seven isolated HD stacks are deployed, the HD ECR image digest is verified, and exactly one 1,150-job predictive smoke exercised the live path with 1,150/1,150 analysis results. No formal HD run was started. The HD notification queue retains 4,600 expected downstream alerts without a deployed notification consumer. `HD_READY_FOR_AWS.md` and `artifacts/hd-smoke-readiness/2026-09-24-smoke-gate.json` supersede the historical pre-AWS status below. **Current status: NOT READY FOR AWS EXPERIMENT.** Preserve the queue messages and do not start a formal repeat.

**LOCAL WORK COMPLETE; NO HD AWS EXPERIMENT RUN.** The Distinction demonstration video is still unrecorded. Do not call AWS, deploy, run workloads or clean cloud resources until that prerequisite and a new explicit authorisation are satisfied. Read `HD_READY_FOR_AWS.md` and `docs/HD_AWS_RUNBOOK.md` before later cloud work. The readiness gate currently concludes **NOT READY FOR AWS EXPERIMENT** because of the video.

## Version and D safety

- HD worktree: `C:\Users\lorenzodario\Documents\UNI\UNI_T3\CLoud\Distinction\HighDistinction`, branch `hd/predictive-autoscaling`. Starting sprint HEAD `7182220`; local hardening commit `05c9741 chore(hd): harden pre-AWS experiment and evidence pipeline`; this handoff has its own final local commit. Use `git rev-parse HEAD` for the exact final hash (a commit cannot include its own hash). No push or merge.
- D checkout/tag: `C:\Users\lorenzodario\Documents\UNI\UNI_T3\CLoud\Distinction`, branch `prep/aws-experiment-readiness`. HEAD and `sit314-6.3d-final^{}` both `06071c37c536e73fb036bb4f60279d7e595d23c2`. No tracked D edit; pre-existing untracked nested `HighDistinction/`, `ISSUESANDSOLUTIONS.md`, `Tasks/` and extended calibration profile remain untouched. Nested worktree is therefore not a tracked D change.
- `git worktree list` shows the D main checkout plus this HD worktree. All this sprint's changes and commits are on HD only.

## Frozen treatment and local verification

Authoritative `experiments/hd/final-controller-config.json`: 10 s arrival bins; eight bins/80 s history; OLS 80 s horizon; 42.467 jobs/s/task capacity; safety factor 1; slope gate 0.02 jobs/s²; two consecutive decisions; 60 s same-or-lower cooldown; BPT target 75; min/max 1–5; predictive **scale-out only**. Times are seconds, rates jobs/s, slope jobs/s² and projected queue jobs. `r̂=max(0,a+b(t_now+80))`; `B̂=B+max(0,r̂−n×42.467)×80`; recommendation is `clamp(1,5,max(n,reactive floor,ceil(r̂/42.467),ceil(B̂/75)))`. Independent D-equivalent BPT target tracking and 60 s +4 fast alarm remain in both HD arms. Three hand-calculated histories and configuration-synchronisation tests pass. Do not retune based on final cloud outcomes.

The read-only replay of the final-D fast-reactive 630-incident/31,500-job trace uses 63 actual dispatch-completion ten-second bins plus sampled D queue/task state. It proposed **zero extra requests** on an effectively flat 50 jobs/s observed trajectory already at desired five. This is plausible but is an **OFFLINE SANITY CHECK ONLY, NOT FINAL HD EVIDENCE**; the original D artifact was not modified. Details and timing caveats: `docs/HD_D_TRACE_REPLAY.md`.

The fake AWS chain exercises post-fanout 50-job signal, FIFO body, sequential persisted state, correct rolling rate and forecast, bounded request to a fake ECS service, metrics, duplicate suppression and retry. Tests also cover missing/late/invalid bins, conditional-write/read faults, ECS failure, metric failure, no scale-in, cooldown, flat/noisy/falling rates and burst fallback. These are injected fakes, not AWS calls. `docs/HD_FAILURE_MODES.md` records expected fail-safe behaviour.

## Isolation, matrix and evidence

HD-only prefix `sit314-hd-transport` is fixed by guarded deployment, image, mode and single-run wrappers; generic D-default scripts are not used directly. Separate HD queues/tables/ECS/scaling/Lambda/state/S3/ECR/metrics are mapped in `docs/HD_RESOURCE_ISOLATION.md`. The shared Academy LabRole is only a reference and needs later permission verification. Lambda AWS SDK v3 module availability is another cloud-smoke gate.

Frozen matrix: predictable ramp and sudden burst × reactive/hybrid × r1/r2/r3 = **12 full runs**, 630 s scheduled arrivals each; 16,500 ramp jobs or 18,300 burst jobs per run. Same worker image/CPU/memory, 50 ms delay, bounds/policies/queues/DynamoDB semantics, workload digest, guard and measurement method for both arms. Minimum injection time **126 min**, plus at least 12 min metric grace; with deployment/smoke/resets/review budget **3–5+ hours**. Do not silently reduce repeats. `docs/HD_EXPERIMENT_MATRIX.md` and the guarded `docs/HD_AWS_RUNBOOK.md` define the order. A reviewed invalid attempt may be explicitly replaced with `-AllowReviewedReplacement`; it is never auto-rerun.

The runner now measures running-task-seconds over the common 600 s measurement window via a piecewise integral, not from preflight through drain. Task-seconds are a **resource-use proxy, not measured AWS cost**. It gates missing genuine historical BPT/arrival/prediction/oldest-age metrics, inconsistent task counts, timing, accounting and signal queues. The mock 12-run aggregation verifies all-repeat mean/median/sample SD/change, exclusion of timing-invalid and incomplete attempts, matched digest/image/CPU/memory and `MOCK DATA — NOT EXPERIMENTAL EVIDENCE` SVG watermark. Common-axis comparison charts, report placeholders, A–F appendix and evidence checklist are ready. Do not insert mock charts into the final report.

## Completed local checks and remaining gates

- Focused HD tests: **44/44 passed**. Full `npm test`: **231/231 passed**. `npm run lint:infra`: **cfn-lint no findings**. `npm audit --omit=dev --json`: **0 production vulnerabilities** across 118 production dependencies. PowerShell wrapper parser check passed; local Lambda source zip packaged; nine mock layout SVGs generated; `git diff --check` clean.
- `docs/HD_REPORT_DRAFT.md` is near-final in introduction, cautious related work, baseline, design, method and threats. Structured ramp/burst/task-second/error/discussion/conclusion placeholders require genuine reviewed AWS evidence. Research citations and caveats are in `docs/HD_REFERENCES.md`.
- Unverified until later cloud smoke: Academy role actions, Lambda SDK v3 modules (especially `@aws-sdk/lib-dynamodb`), SQS/Lambda mapping, real metric and scale timing, regional budget/time and clean HD start. Stop on any failure; never point HD at D or weaken methodology. The D video itself remains the blocking prerequisite.

## Exact later order — not authorised in this local sprint

**First command in this HD worktree after the D video and fresh explicit AWS authorisation:**

```powershell
git status --short
```

Then verify D tag/checkout and current HD commit, fresh Academy identity and budget, reread the readiness gate/runbook, deploy isolated HD stacks, run the bounded 100-job smoke, establish a clean one-task baseline, execute/review each of the twelve matched runs one at a time, aggregate only twelve manually reviewed valid artifacts, fill/render the 4–5 page report and appendix, then decide on a final local tag. Cloud cleanup is HD-only and only after separate explicit authorisation. **Nothing in this handoff authorises those cloud actions now.**
