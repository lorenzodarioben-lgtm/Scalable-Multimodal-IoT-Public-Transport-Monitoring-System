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

Two runs of incident stage 1 with an **identical seed (3142026) and an identical
550-job workload**, differing only in how the route-impact worker was scaled. This
is the local equivalent of Experiment A versus Experiment B.

| Directory | Arm |
|---|---|
| `2026-09-03T16-54-39-664Z-incident-stage-1-fixed` | A — exactly 1 worker task |
| `2026-09-03T16-57-39-857Z-incident-stage-1-autoscale` | B — autoscaled, min 1 / max 5 |

### Headline comparison

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

### What these files are

- `config.json` — the exact stage configuration, including seed, fan-out sizes,
  worker settings and SLA thresholds. This is what makes the two arms comparable.
- `summary.json` — computed results, the scaling event log, and the stability
  verdict with the specific criteria that were breached.
- `metrics.csv` — one sample per second: queue depth, oldest-message age, active
  task count.
- `scaling.csv` — autoscaler evaluations, including the backlog-per-task value at
  each decision point.

### How to read the result honestly

Autoscaling raised sustainable throughput by about **69%** and cut peak
oldest-message age by **64%** on an identical workload, with **no job loss and no
duplicate results**. The 4 duplicate jobs skipped in the autoscaled arm are
positive evidence: redelivery occurred during scaling activity and the conditional
write absorbed it instead of producing duplicate work.

Both arms were still classed **UNSTABLE** at this arrival rate, because the age of
the oldest message stayed above the 10-second threshold. That is the intended
outcome — the experiment is designed to locate a breaking point, not to be passed.

### Important limitations

- These runs used the **local file-backed queue and store**, not SQS and DynamoDB,
  and the **local autoscaler**, not ECS Application Auto Scaling. They demonstrate
  the scaling algorithm, real multi-process concurrency and the idempotency
  guarantees — not AWS behaviour.
- A **processing-cost test parameter** was active: 50 ms delay plus fixed CPU work
  per job. It was applied identically to both arms so the comparison remains fair.
  It exists so queue build-up is observable at an affordable workload size.
- Injection ran for 45 seconds, not the planned 10 minutes, and each arm was run
  once rather than the planned three repeats.

---

## Screenshots

Screenshots are not stored in this repository. `docs/EVIDENCE_CHECKLIST.md` lists
each required capture (E01–E12), the exact command or console page, what must be
visible, and whether it has actually been captured yet.
