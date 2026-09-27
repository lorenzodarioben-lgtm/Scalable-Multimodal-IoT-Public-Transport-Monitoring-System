# SIT314 6.4HD Research Plan — Hybrid Predictive-Reactive Autoscaling

Historical pre-AWS research plan. The later matched AWS study is complete;
see [HD_REPORT.md](HD_REPORT.md) for the observed results. Statements below
about what had not yet been deployed describe the planning checkpoint.

## Status and separation from Distinction

This document records **local-only HD design and implementation work**. It is
not Distinction evidence, has not been deployed, and has not executed an AWS
workload. The frozen Distinction baseline is tag `sit314-6.3d-final` at
`06071c37c536e73fb036bb4f60279d7e595d23c2`; it must remain unchanged.

The HD research question is:

> Can a lightweight short-horizon workload predictor combined with reactive
> backlog safeguards reduce scaling delay and queue pressure compared with the
> validated reactive autoscaling baseline in a bursty multimodal IoT processing
> pipeline?

The baseline is the **final Distinction reactive system**, not the earlier
target-tracking-only system:

- ECS Fargate route-impact service, minimum 1 and maximum 5 tasks.
- BacklogPerTask (BPT) target tracking at 75.
- Fast reactive safeguard: BPT greater than 75, one-minute period, one of one
  datapoints, step scale-out by four tasks.
- Target tracking remains the normal steady-state and scale-in controller.

Its valid fast-reactive retest is the comparison point: 62.512 s scale-request
latency, peak visible backlog 1,042, genuine BPT peak 192, oldest age 24 s,
48.830 jobs/s completion throughput, 11.784 s drain, and zero correctness or
reliability faults.

## Research basis and bounded adaptation

| Source | Verified, relevant idea | HD adaptation | Not claimed |
| --- | --- | --- | --- |
| Y. Wang, A. Chandra, and J. Weissman, [*Jingle: IoT-Informed Autoscaling for Efficient Resource Management in Edge Computing*](https://doi.org/10.1109/CCGrid59990.2024.00052), CCGrid 2024. | The paper describes an edge autoscaler using application metrics and IoT-domain insights in a hybrid predictive-reactive model with lightweight learning. | Use the high-level idea of combining domain-proximate arrival information with an independent reactive safety path. | This project does not reproduce Jingle, its edge deployment, its model, its scheduler, its datasets, or its reported results. |
| A. K. Mogal and V. P. Sonaje, [*Predictive Autoscaling for Containerized Applications Using Machine Learning*](https://doi.org/10.1109/IC-CGU58078.2024.10530773), IC-CGU 2024. | Verified publication metadata establishes predictive ML autoscaling as a directly relevant containerised-systems research direction. | Evaluate an explainable predictor before adopting a heavier ML model. | No implementation detail or quantitative result is attributed to this paper without its full text. |
| M. Masdari and A. Khoshnevis, [*A Survey and Classification of the Workload Forecasting Methods in Cloud Computing*](https://doi.org/10.1007/s10586-019-03010-3), *Cluster Computing*, 23(4), 2399–2424, 2020. | The survey classifies workload forecasting methods for cloud computing and frames forecasting as an input to proactive resource management. | Select a short-horizon, low-complexity method whose assumptions and errors can be inspected. | No survey taxonomy is claimed as this project's new contribution. |
| J. Kumar, R. Goomer, and A. K. Singh, [*Long Short Term Memory Recurrent Neural Network (LSTM-RNN) Based Workload Forecasting Model for Cloud Datacenters*](https://doi.org/10.1016/j.procs.2017.12.087), *Procedia Computer Science*, 125, 676–682, 2018. | The paper studies LSTM-based cloud workload forecasting. | Use it as a contrast: the small, controlled HD experiment does not justify a stateful deep-learning model. | This project does not implement, train, benchmark, or claim LSTM performance. |

The research-informed contribution is therefore an **adaptation**, not a
reproduction: a transparent rolling linear predictor uses the analysis-job
arrival signal already meaningful to this IoT pipeline, while final reactive
protection remains in place for unexpected traffic.

## Hypotheses

- **H1 — predictable ramp.** Against the final reactive baseline, the hybrid
  treatment will request scale-out earlier and reduce peak visible backlog,
  genuine BPT, oldest-message age, and post-arrival drain without reducing
  correctness.
- **H2 — sudden burst.** A discontinuous burst cannot be reliably predicted
  before it appears. The retained reactive path should therefore remain the
  safety mechanism; treatment must not regress on reliability or violate the
  1–5 capacity bounds.
- **H3 — trade-off.** Earlier scale-out may increase task-seconds. It is a
  measured capacity-time trade-off, not an assumed universal improvement.

## Scope limits

- No HD workload has run and no AWS resource has been created, changed, or
  queried for this work.
- The HD treatment will not claim better per-job compute performance: worker
  image and 50 ms processing delay remain matched to baseline.
- The first HD evaluation must use matched baseline/treatment profiles and
  fresh execution identities. It must not reuse Distinction artifacts as HD
  evidence.
- Prediction quality, controller decisions, queue outcomes, and task-seconds
  will be recorded separately so a forecast is not confused with an observed
  benefit.
