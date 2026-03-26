---
name: orderflow
description: >
  Use this skill for real-time market regime classification, microstructure analysis,
  and opportunity scanning. Provides regime state (EFFICIENT_TREND/TRANQUIL/COMPRESSION/CHAOS),
  conviction scoring, and execution quality metrics via orderflow.tradev.app.
---

# Orderflow — Real-Time Market Regime & Microstructure

5 MCP tools for regime classification, microstructure analysis, and opportunity scanning.

## Tools

| Tool | What it does |
|------|-------------|
| `orderflow_fetch_regime` | Fetch regime for symbols at a specific horizon |
| `orderflow_fetch_all_horizons` | Fetch all 5 horizons for one symbol |
| `orderflow_fetch_microstructure` | Fetch microstructure (whale flow, book imbalance, aggressor ratio) |
| `orderflow_scan_opportunities` | Scan 22 coins × 5 horizons for high-conviction setups |
| `orderflow_check_alignment` | Check if strategies are aligned with current regimes |

## Regime Classification

Each symbol is classified into one of 4 regimes per horizon:

| Regime | Description | Strategy Fit |
|--------|-------------|-------------|
| `EFFICIENT_TREND` | Strong directional move with liquidity | Trend-following, momentum |
| `TRANQUIL` | Low volatility, stable range | Mean reversion, range, scalping |
| `COMPRESSION` | Coiling — low vol but building energy | Breakout, mean reversion |
| `CHAOS` | High volatility, low liquidity | Reduce exposure, wider stops |

## Horizons

| Horizon | Typical Timeframes | Use For |
|---------|-------------------|---------|
| `H1_MICRO` | 5m–15m | Scalping, micro-entries |
| `H2_SHORT` | 1h–4h | Intraday swing trades |
| `H3_MEDIUM` | 4h–1d | Standard swing trades (default) |
| `H4_LONG` | 1d–1w | Position trades |
| `H5_MACRO` | 1w+ | Portfolio allocation, macro overlay |

## Microstructure Metrics

| Metric | Range | Interpretation |
|--------|-------|----------------|
| `aggressorRatio` | 0.0–1.0 | Buy-taker proportion. >0.55 = accumulation, <0.45 = distribution |
| `whaleFlowDelta` | unbounded | Net large-trade delta. Positive = whale buying |
| `bookImbalance` | -1.0 to +1.0 | Bid/ask volume ratio |
| `bookImbalanceEma` | -1.0 to +1.0 | Smoothed book imbalance. >0.15 = bid_heavy, <-0.15 = ask_heavy |

## Conviction Levels

| Level | Range | Sizing Modifier |
|-------|-------|-----------------|
| LOW | 0–40 | 0.5× |
| MEDIUM | 40–60 | 1.0× |
| HIGH | 60–80 | 1.25× |
| EXTREME | 80–100 | 1.5× |

## Common Patterns

**Quick regime check:**
```
orderflow_fetch_regime(symbols=["BTC", "ETH", "SOL"], horizon="H3_MEDIUM")
```

**Full multi-timeframe analysis:**
```
orderflow_fetch_all_horizons(symbol="BTC")
```

**Market-wide opportunity scan:**
```
orderflow_scan_opportunities(min_conviction=60)
```

**Execution quality check before deployment:**
```
orderflow_fetch_microstructure(symbols=["BTC", "ETH"], horizon="H2_SHORT")
```

**Strategy-regime alignment check:**
```
orderflow_check_alignment(strategies=[
  {"name": "RSI_MeanRevert", "pairs": ["BTC/USDT", "ETH/USDT"], "type": "mean_reversion"},
  {"name": "EMA_Trend", "pairs": ["SOL/USDT"], "type": "trend_following"}
])
```

## Integration with Market Timing

The orderflow tools provide the **regime_fit** and **execution_fit** subscores for market timing:

- **regime_fit**: `orderflow_fetch_regime` → does the current regime match the archetype?
- **execution_fit**: `orderflow_fetch_microstructure` → is liquidity/depth sufficient for clean execution?

Typical workflow:
1. `orderflow_scan_opportunities` — find high-conviction setups
2. `orderflow_fetch_microstructure` — verify execution quality
3. `orderflow_check_alignment` — validate strategy-regime fit before deployment
