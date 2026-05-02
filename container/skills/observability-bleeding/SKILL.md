---
name: observability-bleeding
description: >
  Bleeding detection monitor. Runs every 15 minutes: detects strategies
  trading in anti-regime conditions and logs events to
  knowledge/observability/bleeding-events.jsonl. Purely observational —
  does NOT pause or retire bots.
  Trigger on: "bleeding monitor", "regime bleed", "anti-regime signals",
  "bleeding check", "check bleeding".
---

# Observability Bleeding Monitor

Detects strategies currently in anti-regime exposure and logs bleeding
events for BDL (Bleeding Detection Latency) computation.

This skill is purely observational. It does NOT modify deployments.json,
pause signals, or retire bots. That responsibility belongs to monitor-health.

## Dependencies

| Tool / Skill | Purpose |
|--------------|---------|
| Bash | Execute Python bleeding detection script |

## Files Read

| Path | Purpose |
|------|---------|
| `auto-mode/deployments.json` | Active strategies with anti_regimes |
| `auto-mode/market-prior.json` | Current regime per pair/horizon |
| `knowledge/observability/bleeding-events.jsonl` | Existing events for deduplication |

## Files Written

| Path | Purpose |
|------|---------|
| `knowledge/observability/bleeding-events.jsonl` | Append new bleeding events |

## Algorithm

### Step 1: Run bleeding detection

```bash
python /app/kata/observability/compute_kpis.py \
  --workspace "$(pwd)" \
  --mode bleeding
```

### Step 2: Report results

Parse JSON stdout and report:

```
Bleeding check: {active_deployments_checked} bots checked, {new_bleeding_events} new events
```

If new events were detected, list them:

```
  - {strategy} on {pair}/{timeframe}: current regime {current_regime} is anti-regime
```

### Step 3: Done

No further action. Bleeding events are consumed by:
- observability-collector (BDL computation)
- observability-dashboard (competition dashboard, action items)
- observability-reflection (daily reflection context)
