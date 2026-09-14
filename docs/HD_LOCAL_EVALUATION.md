# HD local controller evaluation

**LOCAL DESIGN/TUNING EVIDENCE — NOT FINAL AWS HD EVIDENCE.** No AWS call, deployment, or HD cloud workload produced these results. The reproducible inputs and complete 48-candidate grid are in [`experiments/hd/simulator/`](../experiments/hd/simulator/) and [`experiments/hd/artifacts/`](../experiments/hd/artifacts/). Run `node experiments/hd/simulator/run-study.js` from the HD root to regenerate the JSON and CSV.

## Model and grid

Both arms receive the identical precomputed incident schedule. The model uses 0.5 s ticks, a FIFO visible backlog, fluid service at 42.467 jobs/s per running task, 60 s reactive metric samples, a 62.512 s delay from an above-target sample to the fast reactive request, and 40.047 s from request to added worker readiness. It stops after arrivals finish and the queue drains. In-flight SQS messages, CloudWatch publication variation, polling, network delay, per-task contention, and target-tracking scale-in are not simulated. These are explicit assumptions in `assumptions.json`, not measured outcomes for HD.

The grid varies history 40/60/80 s (four/six/eight 10 s samples), forecast horizon 80/100/110/120 s, service-capacity factor 0.85/1, and one/two consecutive positive recommendations. The slope threshold stays 0.02 jobs/s² and same-or-lower request cooldown stays 60 s. All 48 candidates run on the planned ramp, abrupt burst, and alternating 8.33–10 jobs/s flat/noisy diagnostic. The diagnostic is local only.

## Selected settings and local outcomes

Eight samples, 80 s horizon, factor 1, two positive recommendations, 0.02 slope threshold, and 60 s duplicate cooldown were selected. Every candidate eliminated modelled ramp backlog beyond a single incident batch; the selected setting used the fewest ramp task-seconds (799.5) of that set, kept zero flat/noisy scale-outs, and retained the independent reactive path. A lower factor of 0.85 starts some capacity earlier but did not improve the selected modelled ramp peak. This is a balanced model choice, not a claim of global optimality.

| Local outcome | Final-D-reactive model | Selected hybrid model |
| --- | ---: | ---: |
| Ramp first above-target BPT equivalent | 514 s | None (peak 50) |
| Ramp first scale request | 603 s reactive | 420 s predictive |
| Ramp first new worker ready | 643.5 s | 460.5 s |
| Ramp peak visible backlog / BPT equivalent | 946.427 / 946.427 | 50 / 50 |
| Ramp peak oldest age | 21 s | 1 s |
| Ramp post-arrival drain | 15.5 s | 0 s |
| Ramp task-seconds | 653.5 | 799.5 (+22.3%) |
| Burst first scale request | 303 s reactive | 230 s predictive, **after** 210 s burst onset |
| Burst first new worker ready | 343.5 s | 270.5 s |
| Burst peak visible backlog | 1,051.889 | 501.980 |
| Burst task-seconds | 1,776 | 2,068 (+16.4%) |
| Flat/noisy predictive requests | — | 0 |
| Flat/noisy task-seconds | 630 | 630 |

The 80 s ramp forecast has 9.138 jobs/s MAE and −1.395 jobs/s signed bias across 48 matched forecast/actual rate pairs. For the burst it has 20.694 jobs/s MAE and +5.972 jobs/s bias; the discontinuity is a substantial forecasting limitation. No pre-burst forecast earns credit for foreseeing the burst. These statistics are deterministic trace comparisons, not general forecast accuracy claims.

The selected setting was also rerun over the observed one-task completion-throughput range 41.640–43.350 jobs/s and request-to-ready times 32.390–46 s (the upper end is a conservative sensitivity case from the D narrative). Its modelled ramp first request stayed at 420 s; first readiness was 452.5–466 s, before the 510 s high segment. Modelled ramp baseline peaks ranged 841.350–1,044.840 jobs; hybrid peaks stayed at one 50-job batch. This limited stress test does not establish real AWS robustness.

## Interpretation limits

The model's BPT equivalent is visible queue divided by running tasks; it is **not** genuine CloudWatch BPT. The fixed service rate extrapolates a one-task D measurement to five tasks without empirical proof of linear scaling. The fixed reactive sample phase and fixed startup delay omit known cloud variability. The simulator excludes all reliability side effects and cannot validate idempotency or AWS permissions. Tomorrow's matched AWS runs must decide whether the early request, backlog benefit, task-second cost, and forecast errors occur in the real system.
