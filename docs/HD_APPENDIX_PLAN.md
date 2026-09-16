# HD appendix and provenance plan

Only include HD AWS screenshots/data after those resources and runs actually exist. The 4–5 page main report should carry the compact design diagram, two matched outcome tables and one or two legible charts; the appendix carries implementation/deployment proof.

| Appendix item | Source to preserve | Required proof |
| --- | --- | --- |
| A. Source/config index | HD commit/tag, `experiments/hd/predictive-controller.js`, `experiments/hd/aws/`, `shared/hd/arrival-signal.js`, `experiments/hd/*.json` | Exact commit, frozen controller settings and both workload definitions. |
| B. Infrastructure | `hd-code.yaml`, `hd-signals.yaml`, `hd-predictor.yaml`, HD-prefixed `ecs.yaml`/`scaling.yaml` stacks | Stack IDs, HD-only prefix, separate queue/state/Lambda/ECS, reactive policy and target 75. |
| C. Local validation | `local-parameter-study.json/.csv`, `HD_LOCAL_EVALUATION.md`, test/lint output | Clearly mark LOCAL DESIGN/TUNING EVIDENCE — NOT FINAL AWS HD EVIDENCE. |
| D. Deployment screenshots | CloudFormation, ECS, Lambda, SQS, DynamoDB and scaling/alarm views | Same account/region, HD names, no D mutation; redact account identifiers if publishing. |
| E. Matched-run manifests | All twelve `manifest.json`, `injection-timing.json`, `review.json` | Fresh run ID, logical digest parity by repeat, schedule validity and explicit manual review. |
| F. Raw queues and scaling | `samples.jsonl`, `scaling-activities.json`, `predictor-logs.json`, worker logs | 10 s samples, scale request, RUNNING, WORKER_READY, end queue/DLQ. |
| G. Genuine metrics | `cloudwatch-history.json` | Historical BPT and oldest-age datapoints, metric dimensions, observation window and prediction-error series. Do not substitute inferred BPT. |
| H. Formal tables/charts | `experiments/hd/analysis/aggregate.js` output | All raw repeats, mean/median/SD, backlog, delay, task-seconds, forecast errors and reliability. |
| I. Final state and version | Final local Git commit/tag, clean HD and D states, cleanup proof when authorised | Distinguish cleanup after submission from tonight's no-cloud boundary. |

Do not put full console dumps or twelve near-identical screenshots in the main report. Retain the invalid-run artifacts in an explicitly labelled excluded section; never delete them to improve an average.
