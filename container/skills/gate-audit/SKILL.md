---
name: gate-audit
description: >
  Level 2 Discover — analyzes retirement and deployment decisions to find
  gate misfires. Reads live-attribution data and campaign history to
  identify false positives (good strategies retired too early), false
  negatives (bad strategies not caught soon enough), and threshold drift.
  Trigger on: "gate audit", "audit gates", "gate health", "check gates",
  "gate misfires", "are gates working", "gate effectiveness".
---

# Gate Audit — Level 2 Discover

The Discover stage for the Gates layer of the Product stack. Analyzes
whether the 10 retirement triggers (A-J) and deployment thresholds are
calibrated correctly, using live trade attribution data as evidence.

**Purpose:** Find gate misfires so the gate kata (Level 2 Improve) can
fix them. Without this, gate thresholds drift and either kill good
strategies too early or let bad ones bleed capital too long.

## Dependencies

| Skill | Purpose |
|-------|---------|
| `attribution` | `knowledge/live-attribution.jsonl` — per-trade diagnostics |
| `monitor` | `auto-mode/campaigns.json` — deployment + retirement history |
| `archetype-taxonomy` | Archetype definitions for expected performance ranges |

## When This Runs

- **Scheduled:** Daily at 06:00 UTC (after overnight trades settle)
- **On-demand:** User says "audit gates" or "check gate health"
- **Auto-triggered:** Monitor Step 7 checks gate_health_score and routes
  to gate kata when it drops below 0.60

## Inputs

| File | What we read |
|------|-------------|
| `knowledge/live-attribution.jsonl` | Per-trade data with regime, gate state, exit reason |
| `knowledge/live-attribution-rollup.json` | 30-day aggregates by archetype, regime, exit reason |
| `auto-mode/campaigns.json` | Full deployment lifecycle: retire reasons, trigger IDs, timing |
| `scoring-config.json` | Current gate threshold values |
| `setup/scoring-config-defaults.json` | Default gate threshold values |

## Analysis

### A. False Positive Detection (good strategies retired too early)

A false positive is a strategy that was retired by a trigger but was
actually performing well or had insufficient data to judge.

```
For each retired campaign in last 90 days:
  trigger = campaign.eviction_reason

  false_positive_signals = []

  # 1. Premature retirement: retired with < min_trades for the timeframe
  min_trades = {5m: 20, 15m: 15, 1h: 10, 4h: 5}
  if campaign.paper_trading.current_trade_count < min_trades[campaign.timeframe]:
    false_positive_signals.append("premature_sample_size")

  # 2. Regime-specific retirement: strategy was profitable in its
  #    preferred regime but retired due to anti-regime losses
  if trigger starts with "anti_regime" or trigger == "regime_shift":
    attr = load attribution entries for this campaign
    preferred_regime = archetype.preferred_regimes[0]
    pnl_in_preferred = sum(t.pnl_pct for t in attr if t.regime_at_entry == preferred_regime)
    if pnl_in_preferred > 0:
      false_positive_signals.append("profitable_in_preferred_regime")

  # 3. Recovery trajectory: strategy was improving when retired
  if campaign.paper_trading.sharpe_trajectory exists:
    last_3 = sharpe_trajectory[-3:]
    if all(last_3[i+1] > last_3[i] for i in range(len(last_3)-1)):
      false_positive_signals.append("improving_trajectory")

  # 4. Similar strategy succeeded: another strategy with same archetype
  #    on different pair graduated in the same period
  sibling_graduates = [c for c in campaigns
    if c.archetype == campaign.archetype
    and c.slot_state == "graduated"
    and abs(c.graduated_at - campaign.evicted_at) < 7 days]
  if sibling_graduates:
    false_positive_signals.append("sibling_graduated")

  if len(false_positive_signals) >= 2:
    classify as false_positive with {trigger, signals, campaign_id}
```

### B. False Negative Detection (bad strategies not caught early enough)

A false negative is a strategy that accumulated significant losses
before a trigger finally caught it.

```
For each retired campaign in last 90 days:
  total_loss_pct = abs(campaign.paper_trading.current_pnl_pct)

  false_negative_signals = []

  # 1. Excessive bleed: lost more than archetype's expected max DD
  archetype_max_dd = archetype_taxonomy[campaign.archetype].max_drawdown
  if total_loss_pct > archetype_max_dd * 1.5:
    false_negative_signals.append("excessive_bleed")

  # 2. Delayed trigger: trigger fired at deadline, not earlier
  if campaign.eviction_reason == "trial_deadline_expired":
    # Check if earlier triggers should have fired
    attr = load attribution entries for this campaign
    # 5 consecutive losses happened at trade N but trigger fired at deadline
    streaks = find_consecutive_loss_streaks(attr)
    if any(s.length >= 5 and s.end_index < len(attr) * 0.7):
      false_negative_signals.append("delayed_consecutive_loss_trigger")

  # 3. Obvious regime mismatch ignored: strategy deployed into anti-regime
  if campaign.paper_trading.deployed_regime in archetype.anti_regimes:
    false_negative_signals.append("deployed_into_anti_regime")

  if len(false_negative_signals) >= 1 and total_loss_pct > 2.0:
    classify as false_negative with {trigger, signals, total_loss_pct}
```

### C. Threshold Drift Analysis

Compare current gate thresholds against optimal values derived from
attribution data.

```
For each gate threshold in scoring-config.json:

  # DEPLOY_THRESHOLD
  deployed_above = trades from campaigns deployed when composite >= threshold
  deployed_below = trades from campaigns deployed when composite < threshold
  optimal_threshold = binary search for threshold that maximizes:
    win_rate(above) - win_rate(below)
  if abs(optimal - current) > 0.3:
    recommend adjustment with evidence

  # RETIREMENT_GATES.catastrophic_dd_multiplier
  For each archetype:
    actual_max_dd = max DD observed across all trials of this archetype
    current_limit = archetype.max_dd * multiplier
    if actual_max_dd < current_limit * 0.5:
      # Threshold too loose — tighten
      recommend reducing multiplier
    if false_positives from trigger A exist:
      # Threshold too tight — loosen
      recommend increasing multiplier

  # SIGNAL_HYSTERESIS_TICKS
  gate_effectiveness.gate_lift from rollup
  if gate_lift < 5.0:
    # Signals gating isn't helping much — reduce friction
    recommend reducing hysteresis ticks
  if gate_lift > 30.0:
    # Gating is very valuable — consider increasing
    recommend keeping or increasing hysteresis
```

### D. Gate Health Score

```
n_fp = len(false_positives)
n_fn = len(false_negatives)
n_total_retirements = total retirements in 90 days
n_total_deployments = total deployments in 90 days

# Precision: of all retirements, how many were correct?
precision = 1 - (n_fp / max(n_total_retirements, 1))

# Recall: of all bad strategies, how many were caught promptly?
# (inverse of false negatives as fraction of total losses)
total_loss_from_fn = sum(fn.total_loss_pct for fn in false_negatives)
total_loss_all = sum(abs(c.pnl) for c in retired_campaigns)
recall = 1 - (total_loss_from_fn / max(total_loss_all, 1))

gate_health_score = (precision * 0.5 + recall * 0.5)
# Clamp to [0, 1]
```

## Output

Write `reports/gate-audit.json`:

```json
{
  "last_audit": "2026-04-22T06:00:00Z",
  "window_days": 90,
  "n_retirements_analyzed": 24,
  "n_deployments_analyzed": 38,

  "false_positives": [
    {
      "campaign_id": "campaign_abc",
      "strategy": "MeanRevBB_XRP",
      "trigger": "anti_regime_win_rate",
      "signals": ["premature_sample_size", "profitable_in_preferred_regime"],
      "retired_at": "2026-04-10T12:00:00Z",
      "pnl_at_retirement": -0.8,
      "trades_at_retirement": 4
    }
  ],

  "false_negatives": [
    {
      "campaign_id": "campaign_def",
      "strategy": "BreakoutDonch_ETH",
      "trigger": "trial_deadline_expired",
      "signals": ["excessive_bleed", "delayed_consecutive_loss_trigger"],
      "total_loss_pct": 4.2,
      "trades_before_catch": 12,
      "earliest_possible_trigger_trade": 6
    }
  ],

  "threshold_recommendations": {
    "DEPLOY_THRESHOLD": {
      "current": 3.5,
      "suggested": 3.2,
      "direction": "lower",
      "evidence": "Strategies deployed at 3.2-3.5 had 52% win rate vs 48% above 3.5",
      "confidence": "medium"
    },
    "RETIREMENT_GATES.catastrophic_dd_multiplier": {
      "current": 1.5,
      "suggested": 1.3,
      "direction": "tighter",
      "evidence": "2 false negatives bled >3% before trigger A caught them",
      "confidence": "high"
    }
  },

  "gate_effectiveness": {
    "gate_lift": 29.0,
    "regime_gating_value": "high",
    "execution_gating_value": "medium"
  },

  "gate_health_score": 0.72,
  "gate_kata_recommended": false,
  "gate_kata_trigger_threshold": 0.60
}
```

## Decision Logic

```
If gate_health_score < 0.60:
  → Trigger gate kata race (Level 2 Improve)
  → Write gate-audit.json with threshold_recommendations as starting point
  → kata-bridge reads gate-audit.json and creates target_type="gates" race

If gate_health_score >= 0.60 AND gate_health_score < 0.80:
  → Log recommendations but don't trigger kata
  → Display in dashboard for operator review

If gate_health_score >= 0.80:
  → Gates are healthy, no action needed
```

## Graceful Degradation

- If `live-attribution.jsonl` has < 20 trades: skip analysis, report
  `gate_health_score: null, reason: "insufficient_data"`
- If `campaigns.json` has no retired campaigns: skip false positive/negative
  analysis, compute threshold drift only
- If `scoring-config.json` is missing: use defaults from
  `setup/scoring-config-defaults.json`
- Never auto-commit gate changes — always route through gate kata for
  systematic improvement with keep/revert verification
