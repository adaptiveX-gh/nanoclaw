---
name: observability-collector
description: >
  Observability KPI collector. Runs every 30 minutes: computes RCCE, BDL, MTTD,
  LVEQ primary KPIs plus 7 secondary diagnostics. Appends snapshot to
  knowledge/observability/kpi-snapshots.jsonl and writes daily JSON.
  Trigger on: "observability", "kpi", "system health", "pipeline metrics",
  "how is the system doing", "meta health", "compute kpis".
---

# Observability Collector — KPI & Diagnostics Engine

Computes the four primary KPIs and seven secondary diagnostics by running
the observability Python module against workspace state files.

## Dependencies

| Tool / Skill | Purpose |
|--------------|---------|
| Bash | Execute Python computation script |
| Read | Verify output files |

## Files Read

| Path | Purpose |
|------|---------|
| `auto-mode/deployments.json` | Active strategies, preferred_regimes, anti_regimes |
| `auto-mode/market-prior.json` | Current regime per pair/horizon |
| `auto-mode/campaigns.json` | Strategy lifecycle, paper_pnl by regime |
| `auto-mode/tick-log.jsonl` | Per-step timing, detection freshness |
| `knowledge/evolution-events.jsonl` | Evolution commit/rollback for LVEQ |
| `knowledge/live-outcomes.jsonl` | Graduation/retirement outcomes |
| `knowledge/discoveries.jsonl` | Knowledge store counts |
| `knowledge/anti-patterns.jsonl` | Knowledge store counts |
| `knowledge/graduations.jsonl` | Knowledge store counts |
| `reports/portfolio-correlation.json` | Pairwise return correlations |
| `knowledge/observability/kpi-snapshots.jsonl` | Previous snapshots for trend |
| `knowledge/observability/bleeding-events.jsonl` | BDL computation |

## Files Written

| Path | Purpose |
|------|---------|
| `knowledge/observability/kpi-snapshots.jsonl` | Append KPI snapshot |
| `knowledge/observability/diagnostic-snapshots.jsonl` | Append diagnostics |
| `observability/metrics/YYYY-MM-DD.json` | Daily metric snapshot |

## Algorithm

### Step 1: Run KPI computation

```bash
python /app/kata/observability/compute_kpis.py \
  --workspace "$(pwd)" \
  --mode all
```

The script outputs a JSON object to stdout with keys:
- `kpis`: `{rcce, rcce_status, bdl_minutes, bdl_status, mttd, lveq, lveq_status, ...}`
- `diagnostics`: `{live_backtest_divergence, per_regime_breakdown, ...}`
- `bleeding`: `{new_bleeding_events, active_deployments_checked}`

### Step 2: Log summary

Parse the JSON output and report:

```
KPI Snapshot:
  RCCE:  {rcce} ({rcce_status})
  BDL:   {bdl_minutes}min ({bdl_status})
  MTTD:  {mttd.aggregate}min
  LVEQ:  {lveq} ({lveq_status})
  Missed bleeders: {missed_bleeders}
  Active deployments: {active_deployments}
```

### Step 3: Verify output

Confirm the daily snapshot file was written:

```bash
ls observability/metrics/$(date -u +%Y-%m-%d).json
```

If the script fails (non-zero exit), log the error and report:
"KPI computation failed: {error}". Do not retry — the next scheduled run
will attempt again.
