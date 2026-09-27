# Research-Informed Hybrid Predictive–Reactive Autoscaling for a Bursty IoT Pipeline

This report summarizes the completed 12-run matched AWS study. Raw run records,
manual validity reviews and the [reviewed aggregate](../artifacts/hd-analysis/comparison.md)
remain the primary evidence. The [final data](hd-final-data/) and
[figures](hd-final-figures/) are derived from those records. Local simulation
results below are design evidence and are clearly separated from AWS outcomes.

## 1. Problem and question

The Distinction system processes simulated multimodal transport incidents through SQS and ECS Fargate. Each incident fans out into analysis jobs; a queue-based BacklogPerTask (BPT) metric controls a one-to-five-worker service. The final D deployment retains target tracking at BPT 75 and adds a fast reactive alarm (>75, one 60-second period, +4 tasks). In one valid final-D retest, the fast request followed the first above-target BPT minute by 62.512 s. The retest completed 31,500 jobs reliably but still reached 1,042 visible queued jobs and a 24 s oldest-message age. These are **calibration observations**, not a matched HD comparison.

Research question: can a lightweight short-horizon arrival predictor, combined with the unchanged reactive safeguards, reduce scale-out delay and queue pressure under a learnable traffic ramp without compromising abrupt-burst safety or reliability? The treatment is deliberately scale-out only. It may consume more task-seconds, so a capacity-time trade-off is part of the answer.

The research gap is practical and bounded: the final-D fast alarm remains reactive to a delayed backlog metric. It cannot request workers before a predictable rise has created measured pressure. This study tests whether analysis-job arrivals—available immediately after successful fan-out—provide useful lead time in this particular IoT pipeline, while holding the final-D reactive control and worker cost constant across the new matched arms. It is not a claim of a generally superior autoscaler.

## 2. Research context

Wang, Chandra and Weissman's *Jingle* investigates IoT-informed hybrid predictive/reactive resource management at the edge [1]. That motivates looking at a domain-proximate signal—successfully published analysis jobs—before queue pressure becomes severe. This project does not reproduce Jingle's system, model or evaluation. Masdari and Khoshnevis survey workload forecasting methods for proactive cloud management [2]. Kumar, Goomer and Singh investigate LSTM-based cloud workload forecasting [3], and Mogal and Sonaje publish a related container autoscaling study [4]. Their existence supports treating prediction as a research design choice, not assuming any particular model wins here. With two workload classes, three repeats per arm and an explainability requirement, a rolling linear trend is a more auditable first intervention than a trained neural network. No LSTM is implemented or benchmarked.

## 3. Design and implementation

The HD environment is separately prefixed `sit314-hd-transport`; live Distinction infrastructure and evidence remain unchanged. After successful analysis-job fan-out, an idempotent `{runId, signalId, publishedJobCount, atMs}` observation enters an HD FIFO SQS queue. A Lambda aggregates 10-second bins into per-run DynamoDB state. The matched experiment injector uses the same signal schema because it sends analysis jobs directly. The Lambda records observed arrival rate, forecast, error, task recommendation, scale request and task count in `SIT314/HDTransport`. Genuine reactive BPT retains only the service dimension; it is not the predictor's queue-depth-derived BPT.

For eight chronological 10-second rates \((t_i,r_i)\), ordinary least squares fits \(r(t)=a+bt\), with \(b=\sum(t_i-\bar t)(r_i-\bar r)/\sum(t_i-\bar t)^2\) and \(a=\bar r-b\bar t\). Time is seconds, rate is jobs/s, and slope is jobs/s². The bounded 80-second forecast is \(\hat r=\max(0,a+b(t_{now}+80))\). Using observed single-task capacity \(c=42.467\) jobs/s, current running/desired/reactive floor \(n\), queue \(B\), target 75, and horizon \(H=80\), the controller computes \(\hat B=B+\max(0,\hat r-nc)H\) jobs and \(n'=\operatorname{clamp}_{1,5}\{\max[n,\lceil\hat r/c\rceil,\lceil\hat B/75\rceil]\}\) tasks. A rising slope of at least 0.02 jobs/s² and two consecutive positive recommendations are required; same-or-lower duplicate requests are suppressed for 60 s. The adapter checks live desired count and never reduces it. Existing target tracking and the 60-second +4 alarm remain active in **both** arms. `HD_CONTROLLER_FREEZE.md` explains every parameter and three hand-calculated histories.

All selected parameters were fixed after a 48-candidate deterministic local sensitivity study. The study modelled the final-D reactive timing and observed fixed-worker throughput, but did not model AWS publication jitter, Fargate contention or permission failures. In that **local model only**, hybrid requests during the ramp at 420 s (reactive 603 s), with a 50-job peak versus 946.427, at a 22.3% task-second increase. In the burst, prediction only reacts **after** the 210 s onset; this is a fallback test, not a pre-burst forecasting success. These values are explicitly not final HD evidence.

## 4. Matched AWS method

Two deterministic workload classes each have a 30 s warm-up and 600 s measurement. The ramp rises from 10 to 16.667, 25, 33.333 and 50 jobs/s, producing 16,500 jobs. The burst stays at 10 jobs/s, jumps to 50 jobs/s from 210–510 s, then returns to 10 jobs/s, producing 18,300 jobs. Each class has reactive and hybrid arms with valid r1/r2/r3: 12 reviewed valid runs. The logical jobs, seed, per-job processing delay (50 ms), 1–5 capacity bounds, target 75 and fast reactive policy are identical across arms. Each run uses a fresh execution ID and a clean one-task start. No alarm was forced and no capacity was manually changed during arrivals. The schedule-lag guard invalidates tardy injection; one partial attempt is preserved with an INVALID review and excluded from the aggregate.

The primary outcomes are first scale request relative to the declared high-load offset, proactive lead if before it, peak visible SQS backlog, **genuine historical CloudWatch BPT**, and oldest-message age. Worker-ready latency, throughput, drain, task-seconds, p50/p95 processing latency, forecast MAE/bias, reliability and false predictive requests are secondary. Task-seconds integrate sampled *running* tasks over the common 600 s measurement interval; they are a resource-use proxy, **not measured AWS cost**. The review-gated analysis shows every repeat, mean, median, sample SD and descriptive percentage change. Three repeats cannot justify a significance claim. The frozen matrix, stop rules and confound checks are in [HD_EXPERIMENT_MATRIX.md](HD_EXPERIMENT_MATRIX.md).

## 5. Reviewed AWS results

Every planned row has three manually reviewed VALID repeats. The table gives
descriptive means; [all individual values and sample SDs](../artifacts/hd-analysis/comparison.md)
and [per-run records](hd-final-data/all-reviewed-runs.csv) are available. All
valid runs submitted and completed the full declared workload with zero errors,
duplicate results, DLQ jobs or unaccounted jobs. One invalid partial burst
attempt remains in [raw artifacts](../artifacts/hd-aws-runs/) with its exclusion
review and does not enter these means.

| Workload and metric | Reactive mean | Hybrid mean | Descriptive difference |
| --- | ---: | ---: | ---: |
| Ramp first request relative to high-load onset | +83.883 s | −61.259 s | Hybrid requests before onset; reactive after. |
| Ramp peak visible backlog | 913 jobs | 51.667 jobs | 94.3% lower. |
| Ramp peak genuine BPT | 796.333 | 43.000 | 94.6% lower. |
| Ramp oldest-message age | 33.333 s | 20.000 s | 40.0% lower. |
| Ramp worker task-seconds | 633.952 | 1,055.815 | 66.5% higher. |
| Burst first request after onset | 100.877 s | 23.762 s | Hybrid reacts after, not before, the burst. |
| Burst peak visible backlog | 879.333 jobs | 432.000 jobs | 50.9% lower. |
| Burst peak genuine BPT | 766.333 | 222.833 | 70.9% lower. |
| Burst oldest-message age | 35.333 s | 23.333 s | 34.0% lower. |
| Burst worker task-seconds | 1,759.971 | 2,067.700 | 17.5% higher. |

The ramp supports the bounded claim that the arrival signal created useful
scale-out lead under this learnable workload. Three hybrid requests preceded the
declared high-load onset by 45.872, 76.300 and 61.604 seconds. The
[ramp backlog](hd-final-figures/figure-1-ramp-peak-bpt.svg) and
[capacity-time](hd-final-figures/figure-3-ramp-task-seconds.svg) figures show
the trade-off. Request-to-first-ready time was **not** faster for the hybrid
arm (29.698 versus 26.436 s mean); the advantage came from requesting earlier,
not from accelerating Fargate startup. Completion throughput was similar
(25.673 versus 25.757 jobs/s), and mean post-arrival drain was slightly longer
for hybrid (8.787 versus 8.337 s). These contrary results remain in the report.

The sudden burst was not predicted in advance. Hybrid requests occurred about
23–25 seconds **after** the 210-second onset, compared with 93–111 seconds for
reactive requests. Queue pressure decreased, but worker task-seconds rose and
mean drain time was longer (8.337 versus 4.147 s). The
[burst BPT](hd-final-figures/figure-5-burst-peak-bpt.svg) and
[capacity-time](hd-final-figures/figure-6-burst-task-seconds.svg) figures keep
both effects visible. No false proactive scale-outs were recorded. Hybrid
forecast MAE averaged 8.730 jobs/s in the ramp and 22.470 jobs/s in the burst;
the abrupt step is substantially harder to forecast. The measured comparison
supports a quicker **post-onset** response, not burst anticipation.

## 6. Limits and conclusion

This is a synthetic two-shape workload, one Academy region, a 1–5 task range
and three repeats per arm. SQS queue-depth estimates, CloudWatch publication
cadence and Fargate startup variation limit timestamp precision. The local
parameter grid may favor the designed ramp; its configuration was fixed before
the AWS runs. Means and percentage changes are descriptive, not statistical
significance claims. Worker task-seconds indicate relative capacity use,
not complete AWS billing. The [threats table](HD_THREATS_TO_VALIDITY.md)
explains the controls and remaining limits.

Within these bounds, hybrid predictive scale-out reduced ramp and burst queue
pressure without an observed reliability regression, at the cost of more worker
time. It gave genuine lead on the gradual ramp. On the abrupt burst, it acted
only after traffic changed. The [aggregate](../artifacts/hd-analysis/aggregate.json),
[machine-readable statistics](hd-final-data/all-aggregate-statistics.csv) and
[run review log](experiments/HD_AWS_RUN_LOG.md) provide the detailed audit trail.

## References

[1] Y. Wang, A. Chandra, J. Weissman, “Jingle: IoT-Informed Autoscaling for Efficient Resource Management in Edge Computing,” CCGrid 2024, doi:10.1109/CCGrid59990.2024.00052.

[2] M. Masdari, A. Khoshnevis, “A survey and classification of the workload forecasting methods in cloud computing,” *Cluster Computing* 23(4), 2399–2424, 2020, doi:10.1007/s10586-019-03010-3.

[3] J. Kumar, R. Goomer, A. K. Singh, “Long Short Term Memory Recurrent Neural Network (LSTM-RNN) Based Workload Forecasting Model for Cloud Datacenters,” *Procedia Computer Science* 125, 676–682, 2018, doi:10.1016/j.procs.2017.12.087.
[4] A. K. Mogal, V. P. Sonaje, “Predictive Autoscaling for Containerized Applications Using Machine Learning,” IC-CGU 2024, doi:10.1109/IC-CGU58078.2024.10530773.
