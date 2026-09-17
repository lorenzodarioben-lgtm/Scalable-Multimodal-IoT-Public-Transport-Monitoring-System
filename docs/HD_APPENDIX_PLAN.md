# HD appendix structure — evidence to collect later

The main report target is 4–5 pages excluding references and appendix. Put only two matched outcome tables and the most explanatory 2–3 figures in the main text. The appendix carries raw provenance; it must not manufacture cloud screenshots or treat mock charts as results.

## A. Research-informed algorithm and frozen configuration

Include a compact source excerpt for OLS slope/intercept, non-negative 80 s forecast, projected backlog, `ceil`/1–5 recommendation, rising-slope gate, two-decision hysteresis, 60 s cooldown and scale-out-only adapter. Cite `experiments/hd/predictive-controller.js`, `experiments/hd/final-controller-config.json`, `docs/HD_CONTROLLER_FREEZE.md` and the four checked references. Label the 48-candidate sensitivity table and D-trace replay **LOCAL DESIGN / SANITY EVIDENCE, NOT FINAL HD AWS EVIDENCE**.

## B. Isolated HD AWS deployment

Later capture the seven `sit314-hd-transport-*` CloudFormation stacks, HD ECR image digest, ECS task CPU/memory, SQS working/signal queues and DLQs, predictor DynamoDB table, Lambda mode/event mapping and HD-only scaling policies/alarm. Record account/region/timestamp while redacting sensitive identifiers for publication. Show D tag/check-out safety and the D-video-before-HD gate. Resource mapping is in `docs/HD_RESOURCE_ISOLATION.md`; no AWS screenshots exist yet.

## C. Predictor metrics and scaling chronology

For each arm and workload class preserve historical CloudWatch `AnalysisArrivalRate`, `PredictedArrivalRate`, `PredictionError`, genuine `BacklogPerTask` and SQS oldest-age JSON with namespace, dimensions, statistic, period and collection window. Preserve Lambda logs, Application Auto Scaling activities, ECS desired/running/pending samples, new task IDs, RUNNING and `WORKER_READY` timestamps. Show which policy requested the first scale-out. **Never compute a replacement BPT from raw SQS depth.**

## D. Raw predictable-ramp results

List reactive and hybrid r1/r2/r3 manifests, logical digests, exact injection timing, all raw outcomes, review decisions, excluded/invalid attempts, matching-image/CPU/memory proof, final queue/DLQ state and common-axis comparison charts. Give raw values plus mean/median/sample SD and descriptive percentage changes; include measured-window task-seconds.

## E. Raw sudden-burst results

Use the same fields and chart scales/definitions as D. Explicitly distinguish pre-burst prediction from post-onset reaction and note any false proactive requests or degraded reliability. Do not suppress null or adverse results.

## F. Reproducibility and verification

Record frozen profile/config hashes, HD commit and local tag when created, reviewed run IDs, command sequence, `npm test`, infra lint, production audit and script/package verification outputs. Link `artifacts/hd-aws-runs/`, aggregate JSON/Markdown/SVG, and the local-only mock/test artifacts as **separate** classifications. State that n=3 supports descriptive, not significance, claims. Preserve HD-only cleanup plan but execute cleanup only after explicit authorisation.
