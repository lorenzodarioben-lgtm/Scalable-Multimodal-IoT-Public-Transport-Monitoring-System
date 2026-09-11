# SIT314 Distinction — Final D Handoff

## Repository checkpoint

- Branch: `prep/aws-experiment-readiness`
- HEAD: `7e3321e0a4eb2aeea4215938f636be15f09f26ae`
- Improvement commit: `7e3321e feat: add fast backlog scale-out`

## Validated formal baseline

All six formal runs are complete and valid. The demonstrated bottleneck was
autoscale response latency. Three-run autoscale means: peak visible backlog
1,505; genuine BacklogPerTask peak 1,285.667; oldest-message age 38.333 s;
completion throughput 49.830 jobs/s; drain 0 s; p95 processing 52 ms; peak
tasks 5; and zero failures, duplicates, DLQ jobs, or unaccounted jobs.

## Validated targeted improvement

The fast BacklogPerTask step-scaling scale-out path is deployed alongside the
original target-tracking policy. The valid replacement retest completed
31,500/31,500 jobs with zero failures, duplicates, DLQ jobs, and unaccounted
jobs.

- Scale-request latency: 62.512 s (baseline mean 230.6 s)
- Peak visible backlog: 1,042 (baseline 1,505)
- Genuine BPT peak: 192 (baseline 1,285.667)
- Oldest-message age: 24 s (baseline 38.333 s)
- Completion throughput: 48.830 jobs/s (baseline 49.830)
- Drain: 11.784 s (baseline 0 s)
- Processing p95: 53 ms (baseline 52 ms)

The improvement materially reduced scale-out response delay and queue pressure
without a reliability regression.

## Current AWS state

- ECS route-impact: desired/running/pending = 1/1/0
- Scalable target: min 1, max 5
- Original target tracking: BacklogPerTask target 75
- Fast scale-out alarm: OK
- Analysis queue and DLQ: 0 visible / 0 in flight
- Recent genuine BacklogPerTask: zero

## Exact next task — do not start yet

Complete final Distinction verification, then create
`DISTINCTION_FINAL_RESULTS.md`, create a local tag, capture video/screenshots,
and write the final report.
