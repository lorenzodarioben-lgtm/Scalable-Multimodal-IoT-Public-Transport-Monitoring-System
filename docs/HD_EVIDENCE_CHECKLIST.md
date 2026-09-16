# Tomorrow's HD screenshot/evidence checklist

Status: **planned; no HD AWS evidence collected yet.** Capture each image with timestamp, region, HD prefix and run ID when possible. Preserve unedited raw JSON alongside screenshots. The main report gets the few charts needed to understand the causal comparison; the appendix stores setup and audit evidence.

| Capture | Placement | Verification target |
| --- | --- | --- |
| Distinction video completion marker before HD deployment | Appendix note | D was demonstrated before any HD cloud change. |
| HD CloudFormation stack list/details (`queues`, `tables`, `ecs`, `scaling`, `hd-code`, `hd-signals`, `hd-predictor`) | Appendix | Names all start `sit314-hd-transport`; D stacks untouched. |
| Predictive Lambda mode/config/event mapping, no predictive scale-in | Appendix | `reactive` vs `hybrid` arm setting, 8 samples/80 s, FIFO batch 1. |
| DynamoDB predictor state item for a run (redact identifiers) | Appendix | Recent bins, seen IDs, last request; no secrets. |
| CloudWatch `AnalysisArrivalRate` and `PredictedArrivalRate`, same run | Main chart; raw screenshot appendix | Prediction versus observed jobs/s, one y-axis and metric dimensions. |
| Genuine `BacklogPerTask` chart and datapoints | Main result chart; raw appendix | `SIT314/HDTransport`, `ServiceName` only, 60-second period; not computed from SQS. |
| Reactive-vs-hybrid visible queue traces for ramp and burst | Main charts | Same workload, aligned offset, raw SQS samples retained. |
| ECS running-task time traces and scaling activity | Main compact timeline; details appendix | Request timing, desired/running tasks and any target-tracking interaction. |
| Hybrid scale-out and WORKER_READY log events for each added task | Appendix | Request-to-ready latency and whether arrivals were still active. |
| Oldest-message-age CloudWatch timeline | Appendix; main table | Genuine AWS/SQS metric, period and queue name. |
| Analysis queue, analysis DLQ, signal queue and signal DLQ after each run | Appendix sample plus raw per-run data | Zero visible/in-flight at end; no hidden signal failures. |
| All twelve review decisions, raw metrics and aggregate comparison | Main tables; complete appendix | No omitted repeat; any excluded attempt explained. |
| Final Git commit/tag and local test/lint evidence | Appendix | Exact code associated with deployed resources and analyses. |

Do not infer missing metric points, crop away contradictory datapoints or label local simulator charts as final AWS evidence.
