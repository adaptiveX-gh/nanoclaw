---
name: observability-reflection
description: >
  Daily structured reflection on system performance. Runs at 23:50 UTC.
  Reads KPI snapshots, deployments, and knowledge stores, then answers
  three structured questions about backtest-live divergence, learning
  captured, and graduation confidence. Outputs markdown reflection and
  structured JSONL for trend analysis.
  Trigger on: "daily reflection", "system reflection", "daily review",
  "how did the system do today", "reflect on today".
---

# Observability Daily Reflection

Daily discipline mechanism: three structured questions that force examination
of system performance with specific evidence.

## Dependencies

| Tool / Skill | Purpose |
|--------------|---------|
| Read | Load KPI snapshots, deployments, campaigns, knowledge |
| Write | Write reflection markdown and JSONL |
| Bash | Run Python context loader if needed |

## Files Read

| Path | Purpose |
|------|---------|
| `knowledge/observability/kpi-snapshots.jsonl` | Last 24h KPI values |
| `knowledge/observability/bleeding-events.jsonl` | Today's bleeding events |
| `auto-mode/deployments.json` | Active strategies and metrics |
| `auto-mode/campaigns.json` | Lifecycle state, paper_pnl |
| `auto-mode/market-prior.json` | Today's regime |
| `knowledge/discoveries.jsonl` | Recent discoveries |
| `knowledge/anti-patterns.jsonl` | Recent anti-patterns |
| `knowledge/live-outcomes.jsonl` | Recent graduations/retirements |
| `knowledge/observability/reflection-journal.jsonl` | Previous reflections for calibration |

## Files Written

| Path | Purpose |
|------|---------|
| `observability/reflections/YYYY-MM-DD.md` | Prose reflection |
| `knowledge/observability/reflection-journal.jsonl` | Structured JSONL (append) |

## Algorithm

### Step 1: Gather context

Read the following files and note the key facts:

```bash
# Latest KPI snapshot
cat knowledge/observability/kpi-snapshots.jsonl | tail -5

# Active deployments
cat auto-mode/deployments.json | jq '[.[] | select(.state == "active")] | length'

# Today's regime
cat auto-mode/market-prior.json | jq '.regimes'

# Recent knowledge
tail -5 knowledge/discoveries.jsonl 2>/dev/null || echo "No discoveries"
tail -5 knowledge/anti-patterns.jsonl 2>/dev/null || echo "No anti-patterns"
```

### Step 2: Answer the three questions

Answer each question below using specific evidence from the files you read.
Do NOT give vague answers. Every claim must cite a specific file or data point.

#### Question 1: Divergence

> "Of the strategies that were active today, which had the largest gap between
> backtest Sharpe and today's live performance, and what's the explanation?
> Reference specific evidence from knowledge stores."

To answer:
1. Read `auto-mode/campaigns.json` — for each campaign with `state != "retired"`,
   compare `wfo_metrics.favorable_sharpe` vs `paper_trading.live_sharpe`
2. Identify the strategy with the largest absolute gap
3. Check `knowledge/anti-patterns.jsonl` for entries matching that strategy's archetype
4. Hypothesize the cause (anti-regime exposure? overfitting? insufficient data?)

#### Question 2: Learning

> "What did we learn today that wasn't already in the knowledge stores,
> and where did we record it? If we observed something but didn't record it,
> why not?"

To answer:
1. Check if any new entries were added to `knowledge/discoveries.jsonl` or
   `knowledge/anti-patterns.jsonl` today (filter by `ts` field)
2. Check if any evolution events occurred today in `knowledge/evolution-events.jsonl`
3. If nothing was recorded, identify whether any notable events happened
   (retirements, regime changes, bleeding) that should have generated learning

#### Question 3: Graduation Confidence

> "If today were a graduation day, which strategies would have graduated,
> and what's our confidence they'd survive 30 days of live trading?
> Include calibration self-check against recent similar predictions."

To answer:
1. Read `auto-mode/campaigns.json` — find trials approaching deadline
2. Check their `graduation_gates` — which gates are met?
3. Compare to `knowledge/observability/reflection-journal.jsonl` —
   what confidence did we express for previously graduated strategies?
4. Were those predictions correct? (Did they survive or get evicted?)

### Step 3: Write reflection

Write the prose reflection to `observability/reflections/YYYY-MM-DD.md`:

```markdown
# Daily Reflection — YYYY-MM-DD

## Divergence
[Answer to Q1]

## Learning
[Answer to Q2]

## Graduation Confidence
[Answer to Q3]
```

### Step 4: Write structured JSONL

Append a structured entry to `knowledge/observability/reflection-journal.jsonl`:

```json
{
  "ts": "YYYY-MM-DDTHH:MM:SSZ",
  "period": "daily",
  "question_id": "divergence",
  "top_divergence_strategies": [
    {
      "strategy_id": "...",
      "backtest_sharpe": 0.0,
      "live_sharpe": 0.0,
      "gap_pct": 0.0,
      "hypothesis": "..."
    }
  ]
}
```

```json
{
  "ts": "YYYY-MM-DDTHH:MM:SSZ",
  "period": "daily",
  "question_id": "learning",
  "new_discoveries_today": 0,
  "new_anti_patterns_today": 0,
  "unrecorded_observations": ["..."]
}
```

```json
{
  "ts": "YYYY-MM-DDTHH:MM:SSZ",
  "period": "daily",
  "question_id": "graduation_confidence",
  "candidates": [
    {
      "strategy_id": "...",
      "gates_met": 0,
      "gates_total": 6,
      "confidence_30d_survival": 0.0
    }
  ],
  "calibration_check": "..."
}
```

Write each as a separate JSONL line (3 appends total).

### Step 5: Report completion

```
Daily reflection written:
  - observability/reflections/YYYY-MM-DD.md
  - 3 entries appended to reflection-journal.jsonl
```
