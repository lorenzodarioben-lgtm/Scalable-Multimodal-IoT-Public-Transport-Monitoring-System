# Evidence

Curated measurements that the progress report cites. Everything here was produced
by an actual run on the development machine.

Raw experiment output is written to `artifacts/runs/<timestamp>-<stage>-<mode>/`,
which is gitignored because runs can be large. A run is promoted into this
directory with:

```bash
npm run evidence -- --promote latest
```

Promotion copies only `config.json`, `summary.json`, `metrics.csv`, `scaling.csv`
and `errors.log`. The full `events.jsonl` is deliberately left behind.

List what is stored, with headline numbers:

```bash
npm run evidence
```

---

## `preliminary-scalability/`

All results in this directory are **LOCAL PRELIMINARY SCALABILITY RESULTS**. They
are not AWS ECS measurements and are not the final cloud breaking point.

Each stage below is the local equivalent of Experiment A (one fixed worker) versus
Experiment B (autoscaled, min 1 / max 5), run on an identical workload and seed.

### Stage 1 — bus breakdown

Two runs of incident stage 1 with an **identical seed (3142026) and an identical
550-job workload**, differing only in how the route-impact worker was scaled.

| Directory | Arm |
|---|---|
| `2026-09-03T16-54-39-664Z-incident-stage-1-fixed` | A — exactly 1 worker task |
| `2026-09-03T16-57-39-857Z-incident-stage-1-autoscale` | B — autoscaled, min 1 / max 5 |

#### Headline comparison

| Metric | A: fixed 1 | B: autoscaled |
|---|---|---|
| Jobs injected / processed | 550 / 550 | 550 / 550 |
| Throughput | 3.20 jobs/s | **5.41 jobs/s** |
| Elapsed to full drain | 171.7 s | **101.7 s** |
| Mean processing | 485 ms | 545 ms |
| p95 processing | 750 ms | 857 ms |
| Peak queue depth | 380 | **290** |
| Peak oldest-message age | 140 s | **51 s** |
| Ending queue depth | 0 | 0 |
| Tasks observed | 1 | 1 → 4 |
| Scale-out / scale-in events | 0 / 0 | 2 / 1 |
| Jobs lost | 0 | 0 |
| Duplicate results | 0 | 0 |
| Duplicate jobs skipped | 0 | 4 |
| DLQ depth | 0 | 0 |
| Stability verdict | UNSTABLE | UNSTABLE |

### Stage 2 — tram track blockage

| Directory | Arm |
|---|---|
| `2026-09-04T12-00-15-443Z-incident-stage-2-fixed` | A — exactly 1 worker task |
| `2026-09-04T12-03-55-929Z-incident-stage-2-autoscale` | B — autoscaled, min 1 / max 5 |

Stage 2 is a tram track blockage: 15 affected stops, **250 analysis jobs and 1000
notifications per incident**. Both arms injected **exactly 3 incidents = 750 jobs**
with seed 3142026 and identical worker settings, differing only in scaling.

| Metric | A: fixed 1 | B: autoscaled |
|---|---|---|
| Jobs injected | 750 | 750 |
| Results produced | 474 | **750** |
| Left unprocessed at drain timeout | 280 | **0** |
| Throughput | 2.93 jobs/s | **7.38 jobs/s** |
| Elapsed | 161.8 s | **101.6 s** |
| Mean processing | 511 ms | 548 ms |
| p95 processing | 1040 ms | **874 ms** |
| Peak queue depth | 710 | 610 |
| Peak oldest-message age | 145 s | **83 s** |
| Ending queue depth | 270 | **0** |
| Tasks observed | 1 | 1 → 5 |
| Scale-out / scale-in events | 0 / 0 | 2 / 1 |
| Jobs lost | 0 | 0 |
| Duplicate results | 0 | 0 |
| Duplicate jobs skipped | 0 | 4 |
| DLQ depth | 0 | 0 |
| Stability verdict | UNSTABLE | UNSTABLE |

This is a stronger result than stage 1. The single worker **never finished the
workload at all**: 280 of 750 jobs were still unprocessed when the drain timeout
was reached, and the queue was still 270 deep. The autoscaled arm completed every
job and ended with an empty queue, at **2.5× the throughput**, while cutting peak
oldest-message age by 43%. Nothing was lost or duplicated in either arm.

Both arms are still classed UNSTABLE at this arrival rate by the
oldest-message-age criterion, so stage 2 sits beyond the local sustainable point
for both configurations — autoscaling moved the ceiling up substantially without
reaching the 10-second target.

#### A methodology correction made during this run

The first stage-2 attempt bounded injection by elapsed time, as stage 1 had been.
That produced **1500 jobs in the fixed arm but only 750 in the autoscaled arm**,
because enqueuing an incident is itself work and slows down when five workers are
competing for the same queue. Those two runs are not comparable and were **not**
promoted into this directory.

The experiment runner now accepts `--incidents N`, which bounds injection by
count so both arms inject an identical workload regardless of timing. The stage 2
results above use it. Any future fixed-vs-autoscale comparison must use
`--incidents`; the time bound remains appropriate for a single soak run where
only the arrival rate matters.

---

### What these files are

- `config.json` — the exact stage configuration, including seed, fan-out sizes,
  worker settings and SLA thresholds. This is what makes the two arms comparable.
- `summary.json` — computed results, the scaling event log, and the stability
  verdict with the specific criteria that were breached.
- `metrics.csv` — one sample per second: queue depth, oldest-message age, active
  task count.
- `scaling.csv` — autoscaler evaluations, including the backlog-per-task value at
  each decision point.

#### How to read the stage 1 result

Autoscaling raised sustainable throughput by about **69%** and cut peak
oldest-message age by **64%** on an identical workload, with **no job loss and no
duplicate results**. The 4 duplicate jobs skipped in the autoscaled arm are
positive evidence: redelivery occurred during scaling activity and the conditional
write absorbed it instead of producing duplicate work.

Both arms were still classed **UNSTABLE** at this arrival rate, because the age of
the oldest message stayed above the 10-second threshold. That is the intended
outcome — the experiment is designed to locate a breaking point, not to be passed.

### Important limitations that apply to every run here

- These runs used the **local file-backed queue and store**, not SQS and DynamoDB,
  and the **local autoscaler**, not ECS Application Auto Scaling. They demonstrate
  the scaling algorithm, real multi-process concurrency and the idempotency
  guarantees — not AWS behaviour.
- A **processing-cost test parameter** was active: 50 ms delay plus fixed CPU work
  per job. It was applied identically to both arms so the comparison remains fair.
  It exists so queue build-up is observable at an affordable workload size.
- Runs were shortened: stage 1 injected for 45 seconds and stage 2 injected 3
  incidents, rather than the planned 10-minute stages. Each arm was run once
  rather than the planned three repeats.

---

## Screenshots

Screenshots are not stored in this repository. `docs/EVIDENCE_CHECKLIST.md` lists
each required capture (E01–E12), the exact command or console page, what must be
visible, and whether it has actually been captured yet.
