# Research-Informed Hybrid Predictive–Reactive Autoscaling for a Bursty IoT Pipeline

**Draft for SIT314 6.4HD — not a final result.** The main report should be typeset to 4–5 pages, excluding references and appendix. All HD AWS results remain uncollected. Local model outcomes below are design evidence only.

## 1. Problem and question

The Distinction system processes simulated multimodal transport incidents through SQS and ECS Fargate. Each incident fans out into analysis jobs; a queue-based BacklogPerTask (BPT) metric controls a one-to-five-worker service. The final D deployment retains target tracking at BPT 75 and adds a fast reactive alarm (>75, one 60-second period, +4 tasks). In one valid final-D retest, the fast request followed the first above-target BPT minute by 62.512 s. The retest completed 31,500 jobs reliably but still reached 1,042 visible queued jobs and a 24 s oldest-message age. These are **calibration observations**, not a matched HD comparison.

Research question: can a lightweight short-horizon arrival predictor, combined with the unchanged reactive safeguards, reduce scale-out delay and queue pressure under a learnable traffic ramp without compromising abrupt-burst safety or reliability? The treatment is deliberately scale-out only. It may consume more task-seconds, so a capacity-time trade-off is part of the answer.

## 2. Research context

Wang, Chandra and Weissman's *Jingle* investigates IoT-informed hybrid predictive/reactive resource management at the edge [1]. That motivates looking at a domain-proximate signal—successfully published analysis jobs—before queue pressure becomes severe. This project does not reproduce Jingle's system, model or evaluation. Masdari and Khoshnevis survey workload forecasting methods for proactive cloud management [2]. Kumar, Goomer and Singh investigate LSTM-based cloud workload forecasting [3], and Mogal and Sonaje publish a related container autoscaling study [4]. Their existence supports treating prediction as a research design choice, not assuming any particular model wins here. With two planned workload classes, three repeats per arm and an explainability requirement, a rolling linear trend is a more auditable first intervention than a trained neural network. No LSTM is implemented or benchmarked.

## 3. Design and implementation

The HD environment is separately prefixed `sit314-hd-transport`; live Distinction infrastructure and evidence remain unchanged. After successful analysis-job fan-out, an idempotent `{runId, signalId, publishedJobCount, atMs}` observation enters an HD FIFO SQS queue. A Lambda aggregates 10-second bins into per-run DynamoDB state. The matched experiment injector uses the same signal schema because it sends analysis jobs directly. The Lambda records observed arrival rate, forecast, error, task recommendation, scale request and task count in `SIT314/HDTransport`. Genuine reactive BPT retains only the service dimension; it is not the predictor's queue-depth-derived BPT.

For eight chronological rates \((t_i,r_i)\), ordinary least squares fits \(r(t)=a+bt\), with \(b=\sum(t_i-\bar t)(r_i-\bar r)/\sum(t_i-\bar t)^2\) and \(a=\bar r-b\bar t\). The bounded 80-second forecast is \(\hat r=\max(0,a+b(t_{now}+80))\). Using observed single-task capacity \(c=42.467\) jobs/s, current running/desired/reactive floor \(n\), queue \(B\), target 75, and horizon \(H=80\), the controller computes \(\hat B=B+\max(0,\hat r-nc)H\) and \(n'=\operatorname{clamp}_{1,5}\{\max[n,\lceil\hat r/c\rceil,\lceil\hat B/75\rceil]\}\). A rising slope of at least 0.02 jobs/s² and two consecutive positive recommendations are required; same-or-lower duplicate requests are suppressed for 60 s. The adapter checks live desired count and never reduces it. Existing target tracking and the 60-second +4 alarm remain active in **both** arms.

All selected parameters were fixed after a 48-candidate deterministic local sensitivity study. The study modelled the final-D reactive timing and observed fixed-worker throughput, but did not model AWS publication jitter, Fargate contention or permission failures. In that **local model only**, hybrid requests during the ramp at 420 s (reactive 603 s), with a 50-job peak versus 946.427, at a 22.3% task-second increase. In the burst, prediction only reacts **after** the 210 s onset; this is a fallback test, not a pre-burst forecasting success. These values are explicitly not final HD evidence.

## 4. Matched AWS method (planned)

Two deterministic workload classes each have a 30 s warm-up and 600 s measurement. The ramp rises from 10 to 16.667, 25, 33.333 and 50 jobs/s, producing 16,500 jobs. The burst stays at 10 jobs/s, jumps to 50 jobs/s from 210–510 s, then returns to 10 jobs/s, producing 18,300 jobs. Each class has reactive and hybrid arms, each with valid r1/r2/r3: 12 planned runs. The logical jobs, seed, per-job processing delay (50 ms), 1–5 capacity bounds, target 75 and fast reactive policy are identical across arms. Each run uses a fresh execution ID and a clean one-task start. No alarm is forced and no capacity is manually changed during arrivals. The unchanged schedule-lag guard invalidates tardy injection; a failed run is retained and not silently rerun.

The primary outcomes are first scale request relative to the declared high-load offset, proactive lead if before it, peak visible SQS backlog, **genuine historical CloudWatch BPT**, and oldest-message age. Worker-ready latency, throughput, drain, task-seconds, p50/p95 processing latency, forecast MAE/bias, reliability and false predictive requests are secondary. A review-gated analysis script must show every repeat, mean, median, sample SD and descriptive percentage change. Three repeats cannot justify a significance claim.

## 5. Results and interpretation

[TBD: AWS RAMP RESULTS]

[TBD: AWS BURST RESULTS]

[TBD: TASK-SECONDS RESULT]

Interpret benefit only if the HD hybrid makes additional workers ready earlier and reduces queue pressure in the matched ramp, with reliable job accounting. Assess the burst separately: a non-anticipatory controller should not be presented as predicting an abrupt jump. Explain any backlog benefit that coincides with higher task-seconds or extra scale-outs. Compare HD arms with one another, not with an unmatched D single run. No final claim is made here.

## 6. Threats and conclusion

The synthetic two-shape workload, 1–5 task range, single Academy region, approximate CloudWatch/SQS observations, Fargate startup variability, small repeat count and capacity assumption bound external and internal validity. The local sensitivity grid can overfit the designed ramp; the parameters are therefore frozen before cloud evaluation. Task-seconds approximate worker use, not AWS charges. The full mitigation table is in `HD_THREATS_TO_VALIDITY.md`.

[TBD: FINAL CONCLUSION AFTER AWS]

## References

[1] Y. Wang, A. Chandra, J. Weissman, “Jingle: IoT-Informed Autoscaling for Efficient Resource Management in Edge Computing,” CCGrid 2024, doi:10.1109/CCGrid59990.2024.00052.

[2] M. Masdari, A. Khoshnevis, “A survey and classification of the workload forecasting methods in cloud computing,” *Cluster Computing* 23(4), 2399–2424, 2020, doi:10.1007/s10586-019-03010-3.

[3] J. Kumar, R. Goomer, A. K. Singh, “Long Short Term Memory Recurrent Neural Network (LSTM-RNN) Based Workload Forecasting Model for Cloud Datacenters,” *Procedia Computer Science* 125, 676–682, 2018, doi:10.1016/j.procs.2017.12.087.
[4] A. K. Mogal, V. P. Sonaje, “Predictive Autoscaling for Containerized Applications Using Machine Learning,” IC-CGU 2024, doi:10.1109/IC-CGU58078.2024.10530773.
