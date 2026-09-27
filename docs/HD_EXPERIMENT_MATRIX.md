# Frozen matched HD experiment matrix

This is the precommitted design for the subsequently completed 12-run AWS
comparison. Results and validity reviews are in [HD_REPORT.md](HD_REPORT.md)
and [the run log](experiments/HD_AWS_RUN_LOG.md). The future-tense rules below
record the controls that were fixed before execution.

The intervention is **only** the predictive scale-out request path. Both HD arms retain the final-D reactive target tracking (BPT 75) and fast 60-second 1-of-1 BPT>75 +4 alarm. The same isolated HD queues, DynamoDB job semantics, worker image and task CPU/memory, 50 ms processing delay, zero CPU iterations, 1–5 bounds, fresh per-run execution namespace strategy, 10 s sampling, 30 s warm-up/600 s measurement, timing guard, drain/accounting checks and CloudWatch collection apply to both arms. A local processing-cost preflight checks the actual task definition; aggregate analysis rejects differing image/CPU/memory or unmatched logical digests. No mid-run capacity change by the operator.

| Class | Reactive baseline | Hybrid treatment | Frozen workload |
| --- | --- | --- | --- |
| Predictable ramp | r1, r2, r3 | r1, r2, r3 | 330 incidents; 16,500 jobs; 10→16.667→25→33.333→50 jobs/s segments. |
| Sudden burst | r1, r2, r3 | r1, r2, r3 | 366 incidents; 18,300 jobs; 10 jobs/s until 210 s, 50 until 510 s, then 10 until 630 s. |

Total **12** full runs, each 630 s scheduled arrivals. Absolute lower bound is **126 min** injection plus at least 12 min historical-metric grace; deployment, 100-job smoke, drain, scale-in, reset and manual review make **3–5+ hours** plausible. Budget/lab time may force stopping with an incomplete study, never silently reducing repeats. Within each class use alternating reactive/hybrid r1, r2, r3, with a documented clean one-task baseline between every run. `invoke-hd-run.ps1` sets/verifies the mode and refuses an already-attempted arm/repeat; an invalid attempt requires explicit review before a replacement.

Primary metrics: scale-request delay/lead relative to declared high-load onset, peak visible queue, genuine historical BPT and oldest-message age. Secondary: request→RUNNING→WORKER_READY, throughput/drain, measured-window running-task integral (task-seconds), p50/p95, forecast MAE/bias, extra scale-outs and reliability. Every repeat, mean, median, sample SD and descriptive change must be shown; n=3 does not establish statistical significance. `experiments/hd/final-controller-config.json` and both AWS profile JSON files are frozen before cloud evaluation.
