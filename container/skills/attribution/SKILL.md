---
name: attribution
description: >
  Live trade attribution — closes the backward diagnostic loop. Enriches
  closed trades with regime, gate state, and divergence context, then
  appends to knowledge/live-attribution.jsonl. Called inline by monitor
  Step 3 after metrics update. Trigger on: "attribution", "trade attribution",
  "live attribution", "backward diagnostics", "close the loop".
---

# Attribution — Live Trade Backward Diagnostics

Closes the backward diagnostic loop: live trade outcomes flow back to
the knowledge store so Levels 2–4 (gates, portfolio, meta-kata) have
signal to discover what needs improving.

**This is the sensor.** Without it, gate-audit has no data to find
misfires, portfolio-audit has no data to detect concentration drift,
and meta-kata has no data to measure pipeline throughput.

## Dependencies

| Skill | Purpose |
|-------|---------|
| `freqtrade-mcp` | `bot_trades(deployment_id)` — closed trade list |
| `orderflow` | Regime at entry/exit time (from market-prior.json) |
| `monitor` | Calls attribution inline in Step 3 |

## When This Runs

Called by monitor Step 3 after metrics update, for each bot that has
new closed trades since `last_attribution_ts`. Not a standalone tick —
runs inside the monitor's 15-minute loop.

## Knowledge Output

### `knowledge/live-attribution.jsonl`

One JSON line per closed trade. Append-only.

```json
{
  "ts": "2026-04-22T14:30:00Z",
  "trade_id": "trade_abc123",
  "strategy": "MeanRevBB_XRP",
  "archetype": "MEAN_REVERSION",
  "correlation_group": "range",
  "pair": "XRP/USDT:USDT",
  "timeframe": "15m",
  "direction": "long",

  "regime_at_entry": "TRANQUIL",
  "regime_at_exit": "COMPRESSION",
  "regime_changed_during_trade": true,

  "exit_reason": "stoploss",
  "pnl_pct": -1.2,
  "duration_minutes": 45,

  "slippage_pct": 0.03,
  "slippage_source": "measured",
  "execution_quality": 0.85,

  "gate_state_at_entry": {
    "composite": 3.8,
    "signals_active": true,
    "regime_fit": 4.2,
    "execution_fit": 3.1,
    "change_prob": 0.08
  },

  "backtest_expected": {
    "avg_pnl_pct": 0.4,
    "win_rate": 62.0,
    "avg_duration_minutes": 30
  },
  "divergence": {
    "pnl_vs_expected": -1.6,
    "duration_vs_expected": 15
  },

  "campaign_id": "campaign_xyz",
  "slot_state": "trial",
  "days_since_deploy": 3
}
```

### `knowledge/live-attribution-rollup.json`

Rolling aggregates updated after each attribution write. This is the
primary input for gate-audit and portfolio-audit discovery.

```json
{
  "last_updated": "2026-04-22T14:30:00Z",
  "window_days": 30,
  "n_trades": 142,

  "by_archetype": {
    "MEAN_REVERSION": {
      "n_trades": 45,
      "win_rate": 58.0,
      "avg_pnl_pct": 0.3,
      "live_sharpe": 0.62,
      "avg_slippage_pct": 0.04,
      "regime_breakdown": {
        "TRANQUIL": {"n": 30, "win_rate": 68.0, "avg_pnl": 0.5},
        "COMPRESSION": {"n": 10, "win_rate": 40.0, "avg_pnl": -0.1},
        "CHAOS": {"n": 5, "win_rate": 20.0, "avg_pnl": -0.8}
      }
    }
  },

  "by_exit_reason": {
    "stoploss": {"n": 38, "avg_pnl": -1.4, "pct_of_total": 26.8},
    "roi": {"n": 52, "avg_pnl": 1.1, "pct_of_total": 36.6},
    "trailing_stop_loss": {"n": 32, "avg_pnl": 0.6, "pct_of_total": 22.5},
    "exit_signal": {"n": 20, "avg_pnl": 0.2, "pct_of_total": 14.1}
  },

  "by_regime": {
    "EFFICIENT_TREND": {"n": 40, "win_rate": 55.0, "avg_pnl": 0.4},
    "TRANQUIL": {"n": 50, "win_rate": 62.0, "avg_pnl": 0.5},
    "COMPRESSION": {"n": 30, "win_rate": 43.0, "avg_pnl": -0.1},
    "CHAOS": {"n": 22, "win_rate": 27.0, "avg_pnl": -0.6}
  },

  "gate_effectiveness": {
    "trades_with_signals_on": 130,
    "trades_with_signals_off": 12,
    "win_rate_signals_on": 54.0,
    "win_rate_signals_off": 25.0,
    "gate_lift": 29.0
  },

  "divergence_summary": {
    "avg_pnl_divergence": -0.3,
    "strategies_diverging_gt_30pct": ["BreakoutDonch_ETH"],
    "regimes_with_negative_divergence": ["CHAOS"]
  }
}
```

## Procedure

### Step A: Identify New Closed Trades

```
For each bot in campaigns where slot_state in {"trial", "graduated"}:

  trades = bot_trades(deployment_id)
  last_ts = campaign.paper_trading.last_attribution_ts ?? campaign.deployed_at

  new_trades = [t for t in trades
                if t.close_date > last_ts
                and t.is_open == false]

  If len(new_trades) == 0: skip this bot
```

### Step B: Enrich Each Trade

```
For each trade in new_trades:

  # Regime context
  regime_at_entry = trade.custom_data.regime_at_entry
    ?? lookup market-prior.json at trade.open_date (nearest tick)
  regime_at_exit = trade.custom_data.regime_at_exit
    ?? lookup market-prior.json at trade.close_date (nearest tick)

  # Gate state at entry time
  Read cell-grid-latest.json for the trade's (archetype, pair, tf) cell
  gate_state = {
    composite: cell.composite,
    signals_active: campaign.paper_trading.signals_active at entry time,
    regime_fit: cell.regime_fit,
    execution_fit: cell.execution_fit,
    change_prob: market_prior[symbol][horizon].transition.change_prob ?? null
  }

  # Backtest baseline from campaign.wfo_metrics
  backtest_expected = {
    avg_pnl_pct: campaign.wfo_metrics.favorable_sharpe * scaling_factor,
    win_rate: campaign.paper_trading.wfo_win_rate ?? null,
    avg_duration_minutes: null  # not tracked in wfo_metrics
  }

  # Divergence
  divergence = {
    pnl_vs_expected: trade.pnl_pct - backtest_expected.avg_pnl_pct,
    duration_vs_expected: trade.duration_minutes - backtest_expected.avg_duration
  }

  # Slippage (from ExecBenchmark mixin)
  slippage_pct = trade.custom_data.slippage_pct ?? null
  slippage_source = trade.custom_data.slippage_source ?? null
```

### Step C: Append to Knowledge Store

```
For each enriched trade:
  entry = {
    ts: now_utc,
    trade_id: trade.trade_id,
    strategy: campaign.strategy,
    archetype: campaign.archetype,
    correlation_group: campaign.correlation_group,
    pair: campaign.pair,
    timeframe: campaign.timeframe,
    direction: trade.direction,
    regime_at_entry: regime_at_entry,
    regime_at_exit: regime_at_exit,
    regime_changed_during_trade: regime_at_entry != regime_at_exit,
    exit_reason: trade.exit_reason,
    pnl_pct: trade.profit_pct,
    duration_minutes: trade.duration_minutes,
    slippage_pct: slippage_pct,
    slippage_source: slippage_source,
    execution_quality: campaign.paper_trading.execution_quality,
    gate_state_at_entry: gate_state,
    backtest_expected: backtest_expected,
    divergence: divergence,
    campaign_id: campaign.id,
    slot_state: campaign.slot_state,
    days_since_deploy: (now - campaign.deployed_at).days
  }

  Append JSON line to knowledge/live-attribution.jsonl
```

### Step D: Update Rolling Aggregates

```
Read last 30 days of knowledge/live-attribution.jsonl
  (or all entries if fewer than 30 days)

Compute aggregates:
  by_archetype: group by archetype → {n, win_rate, avg_pnl, live_sharpe, regime_breakdown}
  by_exit_reason: group by exit_reason → {n, avg_pnl, pct_of_total}
  by_regime: group by regime_at_entry → {n, win_rate, avg_pnl}

  gate_effectiveness:
    Compare trades entered when signals_active==true vs false
    gate_lift = win_rate_on - win_rate_off

  divergence_summary:
    avg_pnl_divergence = mean(all divergence.pnl_vs_expected)
    strategies_diverging = [s where abs(live_sharpe - wfo_sharpe) / wfo_sharpe > 0.30]
    regimes_negative = [r where by_regime[r].avg_pnl < 0]

Write knowledge/live-attribution-rollup.json

Update campaign.paper_trading.last_attribution_ts = max(new_trades.close_date)
```

## Knowledge Flow

```
Live trades (bot_trades)
  → enriched with regime, gates, slippage, divergence
  → knowledge/live-attribution.jsonl (per-trade, append-only)
  → knowledge/live-attribution-rollup.json (30-day aggregates)
  → consumed by:
      gate-audit (Level 2 Discover) — finds gate misfires
      portfolio-audit (Level 3 Discover) — finds allocation problems
      meta-kata (Level 4 Discover) — measures pipeline throughput
      strategyzer Phase 0 — informs candidate generation
```

## Graceful Degradation

- If `bot_trades` is unavailable: skip attribution this tick, log warning
- If `market-prior.json` lacks regime data for a trade's timestamp: set
  `regime_at_entry = "UNKNOWN"`
- If `live-attribution.jsonl` doesn't exist: create it on first write
- If rollup computation fails: log error, don't block monitor tick
- Attribution is non-blocking — monitor continues regardless of failures
