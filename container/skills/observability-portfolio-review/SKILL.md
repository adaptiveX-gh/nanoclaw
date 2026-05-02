---
name: observability-portfolio-review
description: >
  Weekly portfolio review. Runs Sunday 22:00 UTC. Reads portfolio state,
  correlation structure, and regime alignment, then answers three structured
  questions about portfolio composition, correlation risk, and regime exposure.
  Trigger on: "weekly reflection", "weekly review", "portfolio review",
  "system weekly", "weekly portfolio".
---

# Observability Weekly Portfolio Review

Weekly discipline mechanism: three structured questions about portfolio
composition, risk concentration, and regime alignment.

## Dependencies

| Tool / Skill | Purpose |
|--------------|---------|
| Read | Load portfolio state, correlations, deployments |
| Write | Write weekly review markdown and JSONL |
| Bash | Query data files |

## Files Read

| Path | Purpose |
|------|---------|
| `auto-mode/deployments.json` | Active strategies, groups, regime fit |
| `auto-mode/campaigns.json` | Lifecycle, per-regime performance |
| `auto-mode/market-prior.json` | Current regime classifications |
| `reports/portfolio-correlation.json` | Pairwise return correlations |
| `knowledge/observability/kpi-snapshots.jsonl` | 7-day KPI history |
| `knowledge/observability/reflection-journal.jsonl` | Previous reviews for continuity |

## Files Written

| Path | Purpose |
|------|---------|
| `observability/reflections/weekly/YYYY-WW.md` | Prose weekly review |
| `knowledge/observability/reflection-journal.jsonl` | Structured JSONL (append) |

## Algorithm

### Step 1: Gather portfolio context

```bash
# Active deployments with group assignment
cat auto-mode/deployments.json | jq '[.[] | select(.state == "active") | {strategy, pair, timeframe, correlation_group, preferred_regimes, slot_state, pnl_pct}]'

# Current regime per symbol
cat auto-mode/market-prior.json | jq '.regimes | to_entries[] | {symbol: .key, regimes: .value}'

# Correlation data
cat reports/portfolio-correlation.json | jq '.daily_returns | keys | length' 2>/dev/null || echo "No correlation data"

# 7-day KPI trend
tail -14 knowledge/observability/kpi-snapshots.jsonl 2>/dev/null
```

### Step 2: Answer the three questions

#### Question 1: Portfolio Composition

> "If we had to drop one bot from the portfolio right now, which would we
> drop and why — and conversely, what type of bot is the portfolio most missing?"

To answer:
1. List all active bots with their P&L, correlation group, and regime fit
2. Identify the weakest performer (lowest P&L, highest eviction_priority,
   or worst regime fit)
3. Check group balance: trend/range/vol/carry groups
4. Identify which group is underrepresented or empty

#### Question 2: Correlation Structure

> "What's our current correlation structure across active bots? Are any pairs
> above 0.7 correlation? What's our 'effective strategy count' after
> correlation deduplication?"

To answer:
1. Read `reports/portfolio-correlation.json` for daily returns
2. Compute pairwise correlations (or use latest observability diagnostic)
3. Flag any pairs > 0.7
4. Compute effective N = N / (1 + (N-1) * avg_correlation)

If no correlation data exists, state: "No correlation data available.
Portfolio correlation tracking not yet generating daily_returns."

#### Question 3: Regime Alignment

> "Given current regime classification, which active bots are in their
> preferred regime, which are in anti-regime exposure, and is our deployment
> logic actually disabling anti-regime bots?"

To answer:
1. For each active bot, check if `market-prior.regimes[symbol][horizon].regime`
   is in `preferred_regimes` (good) or `anti_regimes` (bad)
2. List bots by category: preferred / neutral / anti-regime
3. Check if anti-regime bots have `signals_active: false` (deployment logic working)
   or `signals_active: true` (deployment logic failing)

### Step 3: Write weekly review

Create directory and write to `observability/reflections/weekly/YYYY-WW.md`:

```markdown
# Weekly Portfolio Review — Week WW, YYYY

## Portfolio Composition
[Answer to Q1]

## Correlation Structure
[Answer to Q2]

## Regime Alignment
[Answer to Q3]

## KPI Trend Summary (7-day)
- RCCE: [trend]
- BDL: [trend]
- LVEQ: [trend]
```

### Step 4: Write structured JSONL

Append to `knowledge/observability/reflection-journal.jsonl`:

```json
{
  "ts": "YYYY-MM-DDTHH:MM:SSZ",
  "period": "weekly",
  "question_id": "portfolio_composition",
  "drop_candidate": {"strategy": "...", "reason": "..."},
  "missing_type": {"group": "...", "reason": "..."},
  "group_balance": {"trend": 0, "range": 0, "vol": 0, "carry": 0}
}
```

```json
{
  "ts": "YYYY-MM-DDTHH:MM:SSZ",
  "period": "weekly",
  "question_id": "correlation_structure",
  "effective_n": 0.0,
  "high_correlation_pairs": [],
  "avg_correlation": 0.0
}
```

```json
{
  "ts": "YYYY-MM-DDTHH:MM:SSZ",
  "period": "weekly",
  "question_id": "regime_alignment",
  "in_preferred": [],
  "in_anti_regime": [],
  "anti_regime_signals_disabled": true
}
```

### Step 5: Report completion

```
Weekly portfolio review written:
  - observability/reflections/weekly/YYYY-WW.md
  - 3 entries appended to reflection-journal.jsonl
```
