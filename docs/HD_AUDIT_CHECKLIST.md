# Pre-AWS HD implementation audit

Status: local-only; no final HD AWS evidence. Paths below are relative to the HD worktree. A passing test is not proof of live AWS permissions or timing.

| Requirement | Implementation | Local verification | Documentation | Remaining concern |
| --- | --- | --- | --- | --- |
| Explainable bounded prediction, no scale-in | `experiments/hd/predictive-controller.js`, `final-controller-config.json` | `hd-predictive-controller.test.js` hand calculations, state gates | `HD_CONTROLLER_FREEZE.md` | Single-task capacity may not extrapolate linearly. |
| Deterministic alternative traces | `experiments/hd/simulator/`, ramp/burst profiles | `hd-simulator.test.js` and full suite | `HD_LOCAL_EVALUATION.md` | Simulator omits cloud jitter/contention. |
| Post-fanout arrivals, idempotent signal | `shared/hd/arrival-signal.js`, `services/telemetry-processor/src/hd-arrival-observer.js` | Arrival-observer and fake chain tests | `HD_PREDICTIVE_DESIGN.md` | Last unclosed bin and delayed signals need smoke observation. |
| Persistent prediction and HD-only ECS request | `experiments/hd/aws/{signal-processor,ports,handler}.js` | `hd-aws-signal-processor.test.js` | `HD_FAILURE_MODES.md` | Academy permissions and Lambda SDK load unverified. |
| Matched workload/guard/accounting | `experiments/hd/aws/{workload,runner,control-plane}.js`, both AWS profile JSON | `hd-aws-runner.test.js`, task-second and workload tests | `HD_EXPERIMENT_MATRIX.md` | Actual cloud schedule/metric lag unknown. |
| Genuine metric and complete 12-run analysis | `experiments/hd/analysis/{metrics,aggregate,charts}.js` | `hd-aws-analysis*.test.js`, mock dry run | `HD_EVIDENCE_CHECKLIST.md` | Manual chronology review required. |
| Isolated stacks/images/policies | HD templates, `deploy-hd.ps1`, `build-hd-image.ps1`, `set-hd-mode.ps1`, `invoke-hd-run.ps1` | `hd-isolation.test.js`, infra lint, script parser | `HD_RESOURCE_ISOLATION.md`, `HD_AWS_RUNBOOK.md` | LabRole capability and deployment remain untested. |
| Academic argument and reproducibility | Report, references, appendix/checklist | Local source/provenance audit | `HD_REPORT_DRAFT.md`, `HD_APPENDIX_PLAN.md` | AWS tables/screenshots deliberately blank. |

The D trace replay at `HD_D_TRACE_REPLAY.md` is a sanity check only. Frozen D tag/checkout are read-only. Cloud smoke and all 12 formal HD runs are explicitly deferred until after the D video and separate authorisation.
