# Frozen HD controller configuration

**Historical freeze before the completed AWS study.** `experiments/hd/final-controller-config.json` is the authoritative treatment configuration. Tests assert its values against the pure controller defaults, Lambda configuration and AWS profiles. The configuration was fixed before the reviewed runs; the [final report](HD_REPORT.md) evaluates it without retrospective tuning. A demonstrable implementation/configuration defect would require affected runs to be invalidated and repeated.

| Setting | Frozen value | Reason |
| --- | ---: | --- |
| Arrival observation interval | 10 s | Resolves the scheduled ramp while allowing cheap event-driven sampling. |
| History length | 8 bins / 80 s | Balanced lower modelled task-seconds at the same ramp backlog suppression in the prior small grid. |
| Forecast horizon | 80 s | Aimed to give Fargate readiness lead against the observed ~32–40 s request-to-ready range without using the longer 110/120 s extrapolation. |
| Capacity estimate / safety factor | 42.467 jobs/s/task / 1.00 | The valid D fixed-arm three-run mean. It is an assumption, not a measured HD multi-task law. |
| Trend gate | 0.02 jobs/s² | Rejects small alternating fluctuations in the local flat/noisy trace. |
| Hysteresis | 2 positive decisions | One spike cannot trigger proactive scale-out. |
| Same-or-lower cooldown | 60 s | Suppresses duplicate requests while AWS desired count catches up. |
| BPT target, tasks | 75, 1–5 | Identical to final D reactive control. |
| Direction/fallback | Predictive scale-out only; independent target tracking + fast +4 alarm retained | Prediction cannot suppress reactive safety or initiate scale-in. |

The previously completed sensitivity grid evaluated 4/6/8 bins, 80/100/110/120 s horizons, 0.85/1.00 capacity factors and 1/2-step hysteresis: 48 candidates on ramp, burst and flat/noisy traces. The choice was made before any HD AWS result, and this hardening pass did **not** run another optimisation sweep. See `HD_LOCAL_EVALUATION.md` for full model assumptions and local outcomes. This is **LOCAL DESIGN/TUNING EVIDENCE — NOT FINAL AWS HD EVIDENCE**.

Mathematical units: sample `r_i` is analysis jobs/s = jobs accepted into SQS within the bin ÷ 10 s; `t_i` is elapsed seconds; OLS `b` has jobs/s² and `a` jobs/s. The 80 s forecast `r̂=max(0,a+b(t_now+80))` remains jobs/s. Estimated excess `max(0,r̂−n×42.467)×80` has units jobs; adding visible backlog gives jobs. `ceil(r̂/42.467)` and `ceil(B̂/75)` both yield tasks. Final `clamp(1,5,max(current desired/running/reactive floor, both task estimates))` is integer tasks. Negative forecasts become zero; no negative capacity or scale-in request is emitted. Hysteresis/cooldown can intentionally defer an otherwise monotonic recommendation.

Hand calculations used in deterministic tests (sample times 0,10,20 s; one running/desired task, no backlog, target75, horizon10 s and capacity20 jobs/s/task for pedagogical examples):

| Rates (jobs/s) | OLS slope (jobs/s²) | 10 s-ahead rate (jobs/s) | Projected excess jobs | Raw recommended tasks | Action |
| --- | ---: | ---: | ---: | ---: | --- |
| 10,20,30 | +1 | 40 | `(40−20)×10=200` | `max(1,ceil(40/20)=2,ceil(200/75)=3)=3` | Scale to 3 if hysteresis=1. |
| 10,10,10 | 0 | 10 | 0 | 1 | Hold: flat slope. |
| 20,10,0 | −1 | 0 (raw −10 clamped) | 0 | 1 | Hold: falling slope. |

Those small-number examples explain the formula, not the frozen treatment values; the deployed configuration remains the JSON above. The Lambda was later exercised in the [HD smoke validation](experiments/HD_SMOKE_READINESS.md). Any new deployment should verify its environment and output against this file before a formal run.
