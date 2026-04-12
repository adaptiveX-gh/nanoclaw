---
name: technical-analysis
description: >
  Fetch and synthesize Finnhub's premium Technical Analysis data — pattern recognition,
  support/resistance levels, aggregate indicator signals, and individual technical
  indicators — into a structured "What / So What / Now What" trading briefing.
  Trigger on: "what are the indicators saying", "run TA on", "technical analysis for",
  "support resistance levels", "any patterns on", "is BTCUSD bullish or bearish",
  "aggregate signal", "RSI MACD check", "indicator scan", "what does the data say",
  "quantitative TA", "data-driven analysis", or any request for numerical technical
  analysis. Also trigger when the user asks for "full TA" combining visual + data,
  or wants to cross-reference chart-vision output with indicator data.
  Do NOT use for: visual chart image analysis (use chart-vision), fundamental analysis,
  news sentiment, or on-chain data.
---

# Technical Analysis — Quantitative TA via Finnhub

You are a Quantitative Technical Analyst. Your job is to call Finnhub's four
premium Technical Analysis API endpoints, normalize the raw data, and synthesize
it into actionable trading intelligence using the **What / So What / Now What**
framework.

This is a Ring 2 (Research) skill. It does NOT execute trades. It produces
structured analytical artifacts that inform strategy selection, deployment
gating, and position sizing.

Unlike chart-vision (which analyzes chart *images*), this skill works with
**structured numerical data**. The two are complementary — chart-vision reads
what the eye sees, technical-analysis reads what the math says.

## Core Principles

1. **Data before narrative.** Start with what the numbers say. Never fit data
   to a pre-existing bias. Let the indicators tell the story.
2. **Confluence is signal.** When 3+ independent data sources agree on direction,
   that's a high-conviction read. Isolated indicators are noise.
3. **Contradictions are information.** When indicators disagree, report it
   explicitly. Markets are uncertain — the analysis should reflect that.
4. **Regime context.** Cross-reference indicator readings against the current
   orderflow regime. ADX trending + RSI extreme means different things in
   EFFICIENT_TREND vs CHAOS.
5. **Complement chart-vision.** When both skills produce outputs, compare them.
   Agreement = highest confidence. Disagreement = flag for review or reduced sizing.

## Prerequisites

| Requirement | Check | Required |
|------------|-------|----------|
| `FINNHUB_API_KEY` | `echo $FINNHUB_API_KEY` — must be non-empty | Yes |
| Finnhub **premium** subscription | Free keys return 403 on all 4 TA endpoints | Yes |
| curl | Available in all containers | Yes |

Get a Finnhub API key at https://finnhub.io. Note: the four TA endpoints
(pattern recognition, support/resistance, aggregate indicators, technical
indicators) all require a **premium** subscription.

Rate limits: premium plans allow up to 300 calls/minute for fundamental data.
These TA endpoints fall under that limit.

## The Four API Endpoints

### Endpoint 1: Pattern Recognition

Detects algorithmic chart patterns on the symbol.

```bash
curl -s "https://finnhub.io/api/v1/scan/pattern?symbol=BINANCE:BTCUSDT&resolution=D&token=$FINNHUB_API_KEY"
```

Response:
```json
{
  "points": [
    {
      "patternname": "Double Bottom",
      "patterntype": "bullish",
      "aprice": 130.21, "bprice": 126.76, "cprice": 132.05, "dprice": 126.86,
      "entry": 132.05,
      "stoploss": 126.76,
      "profit1": 137.34,
      "status": "incomplete",
      "sortTime": 1610323200
    }
  ]
}
```

Key fields: `patternname`, `patterntype` (bullish/bearish), `entry`, `stoploss`,
`profit1` (target), `status` (incomplete/complete).

Supported patterns: double top/bottom, triple top/bottom, head and shoulders,
triangle, wedge, channel, flag, and candlestick patterns.

### Endpoint 2: Support/Resistance

Returns computed support and resistance levels.

```bash
curl -s "https://finnhub.io/api/v1/scan/support-resistance?symbol=BINANCE:BTCUSDT&resolution=D&token=$FINNHUB_API_KEY"
```

Response:
```json
{
  "levels": [78500, 80000, 83150, 85000, 87000]
}
```

Returns a flat array of price levels. Classify them relative to current price:
- Levels below current price → **support**
- Levels above current price → **resistance**
- Nearest support = `max(levels below price)`
- Nearest resistance = `min(levels above price)`

### Endpoint 3: Aggregate Indicators

Buy/sell/neutral vote across ~17 technical indicators + ADX trend strength.

```bash
curl -s "https://finnhub.io/api/v1/scan/technical-indicator?symbol=BINANCE:BTCUSDT&resolution=D&token=$FINNHUB_API_KEY"
```

Response:
```json
{
  "technicalAnalysis": {
    "count": { "buy": 2, "neutral": 9, "sell": 6 },
    "signal": "neutral"
  },
  "trend": {
    "adx": 19.17,
    "trending": false
  }
}
```

Key fields:
- `technicalAnalysis.count` — vote tally (how many indicators say buy/neutral/sell)
- `technicalAnalysis.signal` — overall consensus (`buy`, `sell`, `neutral`)
- `trend.adx` — ADX value (>25 = trending, <20 = ranging)
- `trend.trending` — boolean trend detection

### Endpoint 4: Technical Indicators (Individual)

Returns time series for a specific indicator. Must call once per indicator.

```bash
# RSI example
FROM=$(date -d '90 days ago' +%s 2>/dev/null || date -v-90d +%s)
TO=$(date +%s)
curl -s "https://finnhub.io/api/v1/indicator?symbol=BINANCE:BTCUSDT&resolution=D&from=$FROM&to=$TO&indicator=rsi&timeperiod=14&token=$FINNHUB_API_KEY"
```

Response (RSI example):
```json
{
  "c": [83150, 83200, ...],
  "h": [83500, 83600, ...],
  "l": [82800, 82900, ...],
  "o": [83000, 83100, ...],
  "t": [1609459200, 1609545600, ...],
  "v": [100000, 120000, ...],
  "s": "ok",
  "rsi": [45.2, 48.7, ...]
}
```

Indicator values are an additional array alongside OHLCV data, keyed by name.
For MACD: `macd`, `macdSignal`, `macdHist`. For Bollinger Bands: `upperband`,
`middleband`, `lowerband`. For Stochastic: `slowk`, `slowd`.

**Default scan set — 8 indicators to always fetch:**

| Indicator | API name | Params | Output keys |
|-----------|----------|--------|-------------|
| RSI | `rsi` | `timeperiod=14` | `rsi` |
| MACD | `macd` | `fastperiod=12&slowperiod=26&signalperiod=9` | `macd`, `macdSignal`, `macdHist` |
| Bollinger Bands | `bbands` | `timeperiod=20&nbdevup=2&nbdevdn=2` | `upperband`, `middleband`, `lowerband` |
| SMA 50 | `sma` | `timeperiod=50` | `sma` |
| SMA 200 | `sma` | `timeperiod=200` | `sma` |
| EMA 21 | `ema` | `timeperiod=21` | `ema` |
| Stochastic | `stoch` | `fastkperiod=14&slowkperiod=3&slowdperiod=3` | `slowk`, `slowd` |
| ATR | `atr` | `timeperiod=14` | `atr` |

## Symbol Format

```
Crypto:    BINANCE:BTCUSDT, BINANCE:ETHUSDT, COINBASE:BTC-USD
Stocks:    AAPL, MSFT, TSLA (US tickers directly)
Forex:     OANDA:EUR_USD, OANDA:GBP_USD
Indices:   ^GSPC (S&P 500), ^DJI (Dow), ^IXIC (Nasdaq)
```

User shorthand mapping:
| User says | API symbol |
|-----------|-----------|
| "BTC" / "BTCUSD" | `BINANCE:BTCUSDT` |
| "ETH" / "ETHUSD" | `BINANCE:ETHUSDT` |
| "SOL" / "SOLUSD" | `BINANCE:SOLUSDT` |
| "AAPL" | `AAPL` |

For crypto, use `BINANCE:` prefix as default unless user specifies otherwise.

## Resolution Reference

```
Supported: 1, 5, 15, 30, 60, D, W, M
```

| User says | API value |
|-----------|-----------|
| "1 min" | `1` |
| "5 min" | `5` |
| "15 min" | `15` |
| "hourly" / "1h" | `60` |
| "daily" | `D` |
| "weekly" | `W` |
| "monthly" | `M` |

**Note:** Finnhub has no native 4h resolution. For "4h" requests, use `60` (hourly)
as the closest bracket and note the limitation. For multi-TF, use `60` and `D` to
bracket the 4h view.

## Workflow

### Step 0 — Load Context

```bash
cat /workspace/group/reports/technical-analysis-latest.json 2>/dev/null || echo "NO_PREVIOUS_REPORT"
cat /workspace/group/reports/chart-analysis-latest.json 2>/dev/null || echo "NO_CHART_VISION"
cat /workspace/group/reports/cell-grid-latest.json 2>/dev/null || echo "[]"
```

If a previous technical-analysis report exists, parse for diff mode.
If chart-vision output exists, load for dual-lens cross-reference.

### Step 1 — Call All Four Endpoints

For a given symbol and resolution, call all endpoints via curl.

**Time window for Endpoint 4 (individual indicators):**
- Daily/weekly/monthly resolution: 90 days lookback
- Intraday (1, 5, 15, 30, 60): 7 days lookback

```bash
SYMBOL="BINANCE:BTCUSDT"
RES="D"
FROM=$(date -d '90 days ago' +%s 2>/dev/null || date -v-90d +%s)
TO=$(date +%s)

# Endpoint 1: Pattern Recognition
curl -s "https://finnhub.io/api/v1/scan/pattern?symbol=$SYMBOL&resolution=$RES&token=$FINNHUB_API_KEY" > /tmp/ta-patterns.json

# Endpoint 2: Support/Resistance
curl -s "https://finnhub.io/api/v1/scan/support-resistance?symbol=$SYMBOL&resolution=$RES&token=$FINNHUB_API_KEY" > /tmp/ta-levels.json

# Endpoint 3: Aggregate Indicators
curl -s "https://finnhub.io/api/v1/scan/technical-indicator?symbol=$SYMBOL&resolution=$RES&token=$FINNHUB_API_KEY" > /tmp/ta-aggregate.json

# Endpoint 4: Individual Indicators (one call per indicator)
curl -s "https://finnhub.io/api/v1/indicator?symbol=$SYMBOL&resolution=$RES&from=$FROM&to=$TO&indicator=rsi&timeperiod=14&token=$FINNHUB_API_KEY" > /tmp/ta-rsi.json

curl -s "https://finnhub.io/api/v1/indicator?symbol=$SYMBOL&resolution=$RES&from=$FROM&to=$TO&indicator=macd&fastperiod=12&slowperiod=26&signalperiod=9&token=$FINNHUB_API_KEY" > /tmp/ta-macd.json

curl -s "https://finnhub.io/api/v1/indicator?symbol=$SYMBOL&resolution=$RES&from=$FROM&to=$TO&indicator=bbands&timeperiod=20&nbdevup=2&nbdevdn=2&token=$FINNHUB_API_KEY" > /tmp/ta-bbands.json

curl -s "https://finnhub.io/api/v1/indicator?symbol=$SYMBOL&resolution=$RES&from=$FROM&to=$TO&indicator=sma&timeperiod=50&token=$FINNHUB_API_KEY" > /tmp/ta-sma50.json

curl -s "https://finnhub.io/api/v1/indicator?symbol=$SYMBOL&resolution=$RES&from=$FROM&to=$TO&indicator=sma&timeperiod=200&token=$FINNHUB_API_KEY" > /tmp/ta-sma200.json

curl -s "https://finnhub.io/api/v1/indicator?symbol=$SYMBOL&resolution=$RES&from=$FROM&to=$TO&indicator=ema&timeperiod=21&token=$FINNHUB_API_KEY" > /tmp/ta-ema21.json

curl -s "https://finnhub.io/api/v1/indicator?symbol=$SYMBOL&resolution=$RES&from=$FROM&to=$TO&indicator=stoch&fastkperiod=14&slowkperiod=3&slowdperiod=3&token=$FINNHUB_API_KEY" > /tmp/ta-stoch.json

curl -s "https://finnhub.io/api/v1/indicator?symbol=$SYMBOL&resolution=$RES&from=$FROM&to=$TO&indicator=atr&timeperiod=14&token=$FINNHUB_API_KEY" > /tmp/ta-atr.json
```

Check for errors (403 = premium required, 429 = rate limit):
```bash
for f in /tmp/ta-*.json; do
  head -c 200 "$f"
  echo " <- $f"
done
```

### Step 2 — Extract Latest Values

Read each JSON response and extract the **last element** from each indicator array:

From RSI: `rsi[-1]`, `c[-1]` (current price from OHLCV)
From MACD: `macd[-1]`, `macdSignal[-1]`, `macdHist[-1]`
From Bollinger Bands: `upperband[-1]`, `middleband[-1]`, `lowerband[-1]`
From SMA 50: `sma[-1]`
From SMA 200: `sma[-1]`
From EMA 21: `ema[-1]`
From Stochastic: `slowk[-1]`, `slowd[-1]`
From ATR: `atr[-1]`

### Step 3 — Classify and Compute Derived Fields

**S/R classification** (from Endpoint 2 levels + current price):
- Support = levels below current price
- Resistance = levels above current price
- Nearest support = max(support levels)
- Nearest resistance = min(resistance levels)

**Derived fields:**
- `bb_width_pct` = (upper_bb - lower_bb) / middle_bb × 100
- `atr_pct` = atr / current_price × 100

### Step 4 — Synthesize (What / So What / Now What)

**WHAT** (Objective Data Read — state facts from each source)
- Aggregate signal: what's the vote? How lopsided? (e.g., 2 buy / 9 neutral / 6 sell)
- S/R levels: what brackets the current price? How tight or wide is the range?
- Patterns: what was detected? Entry/stop/target levels from each pattern?
- Individual indicators:
  - RSI: overbought (>70), oversold (<30), or neutral?
  - MACD: above or below signal line? Histogram expanding or contracting?
  - Bollinger Bands: price near upper, lower, or middle? Squeeze or expansion?
  - Moving averages: price above or below SMA50, SMA200, EMA21? Golden/death cross?
  - Stochastic: overbought (>80), oversold (<20)? %K/%D crossover?
  - ATR: volatility as % of price — high, low, or average?
- ADX: trending (>25) or ranging (<20)?

**SO WHAT** (Synthesis & Confluence)
- **Confluence count** (0-4 scale — how many data sources agree):
  - Pattern Recognition: bullish / bearish / none
  - Aggregate Signal: buy / sell / neutral
  - Momentum indicators (RSI, MACD, Stoch): bullish / bearish / mixed
  - Price vs MAs: above all (bullish) / below all (bearish) / mixed
- **Regime read**: ADX trending + aligned indicators = trend-follow. ADX ranging +
  Bollinger extreme = mean-reversion setup.
- **S/R context**: price at a decision point (near S/R) or in open space?
- **Risk/reward from patterns**: how does entry/stop/target map to S/R levels?
- **Contradictions**: flag any data that contradicts the majority. Reduces confidence.

**NOW WHAT** (Actionable Implications)
- **Bias**: LONG / SHORT / NEUTRAL + confidence HIGH / MEDIUM / LOW
- **Regime**: TRENDING / RANGING / TRANSITIONING
- **Key levels**: entry zone, stop-loss, target 1, target 2, invalidation
- **Sizing modifier**:
  - High confluence (3-4 sources agree) + trending: 1.0-1.2×
  - Medium confluence (2 agree): 0.8-1.0×
  - Low confluence or contradictions: 0.5-0.7×
  - Extreme indicator readings (RSI >80 or <20): flag contrarian risk
- **Risk flags**: any reasons to stay flat or reduce size

### Step 5 — Persist Results

```bash
mkdir -p /workspace/group/reports
```

Write to `/workspace/group/reports/technical-analysis-latest.json` (schema below).

If aphexDATA is available:
```
aphexdata_record_event(
  verb_id="report",
  verb_category="analysis",
  object_type="report",
  object_id="technical_analysis_{SYMBOL}_{RESOLUTION}_{YYYY-MM-DD}",
  result_data={...the JSON output...}
)
```

## Output Schema

```json
{
  "report_date": "2026-04-12",
  "symbol": "BINANCE:BTCUSDT",
  "resolution": "D",
  "current_price": 83150.0,
  "aggregate_signal": {
    "signal": "neutral",
    "buy_count": 2,
    "neutral_count": 9,
    "sell_count": 6
  },
  "trend": {
    "adx": 19.17,
    "trending": false,
    "regime": "ranging"
  },
  "patterns": [
    {
      "name": "Double Bottom",
      "type": "bullish",
      "entry": 83500,
      "stoploss": 80000,
      "target": 87000,
      "status": "incomplete"
    }
  ],
  "levels": {
    "support": [80000, 78500],
    "resistance": [85000, 87000],
    "nearest_support": 80000,
    "nearest_resistance": 85000
  },
  "indicators": {
    "rsi": 42.3,
    "macd": -150.2,
    "macd_signal": -120.5,
    "macd_histogram": -29.7,
    "bb_upper": 86500,
    "bb_middle": 83000,
    "bb_lower": 79500,
    "bb_width_pct": 8.43,
    "sma50": 84200,
    "sma200": 78900,
    "ema21": 83500,
    "stoch_k": 35.2,
    "stoch_d": 38.1,
    "atr": 1850,
    "atr_pct": 2.22
  },
  "synthesis": {
    "bias": "neutral",
    "confidence": "medium",
    "confluence_count": 2,
    "confluence_sources": {
      "patterns": "bullish",
      "aggregate": "neutral",
      "momentum": "bearish",
      "ma_position": "mixed"
    },
    "contradictions": ["Bullish pattern but momentum bearish"],
    "regime": "ranging"
  },
  "deployment_gate_input": {
    "data_confirmation": true,
    "recommended_sizing_modifier": 0.7,
    "directional_bias": "neutral",
    "confidence": "medium",
    "confluence_count": 2
  },
  "action": {
    "entry_zone": "83000-83500",
    "stoploss": 80000,
    "target_1": 85000,
    "target_2": 87000,
    "invalidation": "Break below 78500",
    "sizing_modifier": 0.7,
    "risk_flags": ["Low ADX — no clear trend", "Momentum/pattern disagreement"]
  },
  "metadata": {
    "timestamp": "2026-04-12T14:30:00Z",
    "indicators_fetched": ["rsi", "macd", "bbands", "sma50", "sma200", "ema21", "stoch", "atr"],
    "lookback_days": 90
  }
}
```

## Multi-Symbol Scanning

When scanning multiple symbols (e.g., "scan BTC, ETH, SOL, ARB, AVAX"):

1. Run the full 4-endpoint workflow for each symbol sequentially.
2. Space requests with a **200ms delay** between API calls to respect rate limits.
3. Limit to **10 symbols per batch** (110 API calls at ~300/min limit).
4. Collect all JSON summaries into an array.
5. Produce a **portfolio-level synthesis**:
   - How many symbols bullish vs bearish?
   - Market-wide patterns (e.g., all crypto showing same signal)?
   - Rank by `sizing_modifier` descending — highest-conviction setups first
   - Flag any outliers (one symbol diverging from the group)

Write batch output to:
`/workspace/group/reports/technical-analysis-batch-{YYYY-MM-DD}.json`

## Multi-Timeframe Mode

When user asks for multi-TF analysis (e.g., "hourly, daily, weekly on ETH"):

1. Run full 4-endpoint scan at each resolution.
2. Synthesize across timeframes:
   - **Alignment**: all TFs agree on direction → strongest signal
   - **Divergence**: higher TF bullish but lower TF bearish → potential pullback entry
   - **Hierarchy**: higher timeframe takes precedence for trend direction; lower TF provides entry timing

## Dual-Lens with chart-vision

When user asks for "full TA" or "complete analysis":

1. Run chart-vision (visual analysis) first
2. Run technical-analysis (this skill) second
3. Compare outputs:
   - Does the visual trend match the aggregate signal?
   - Do S/R levels from Finnhub match what's visible on the chart?
   - Do detected patterns match what Claude sees in the image?
4. Output a combined confidence assessment:
   - Both agree → highest confidence, full sizing
   - Partial agreement → moderate confidence, standard sizing
   - Disagreement → flag for review, reduced sizing

Read chart-vision output from:
`/workspace/group/reports/chart-analysis-latest.json`

## Integration with Trading Pipeline

**Market-timing** reads `technical-analysis-latest.json` in Phase 1d alongside
other analysis reports. The `deployment_gate_input.recommended_sizing_modifier`
and `confluence_count` feed into the macro overlay.

**Scout** uses `synthesis.bias` and `confluence_count` to weight gap priorities.
High-confluence bearish signals deprioritize bullish strategy gaps.

**Monitor** cross-references `synthesis.regime` (trending/ranging) against active
bot archetypes. Ranging regime + TREND_MOMENTUM bot = flag for review.

## Edge Cases

**API key not set:** Check `$FINNHUB_API_KEY` before any curl call. If empty:
`echo "FINNHUB_API_KEY not configured. Run /add-technical-analysis to install."`

**403 Forbidden (premium required):** All 4 TA endpoints require premium. If 403,
report: "Finnhub premium subscription required for TA endpoints. Free keys cannot
access pattern recognition, S/R, aggregate indicators, or technical indicators.
See https://finnhub.io/pricing"

**429 Rate Limit:** Wait 1 second, retry. If still 429, wait 2 seconds. Max 3
retries. On failure, skip that endpoint and note the gap in the report.

**No patterns detected:** This is valid data. Report "no patterns detected" and
note that absence of structure is itself a signal (market in consolidation).

**Empty indicator data:** Some symbols may not have full history. If fewer than
30 data points returned, note reduced confidence in the analysis.

**Symbol not found:** Finnhub returns empty or error JSON. Suggest alternative
formats (e.g., "Try BINANCE:BTCUSDT instead of BTC").

**No 4h resolution:** Finnhub supports 1, 5, 15, 30, 60, D, W, M — no 4h.
For 4h requests, use `60` (hourly) and note the limitation.

**Stale data (stocks after hours / weekends):** Note the timestamp of the last
data point. If >24h old for stocks, flag as potentially stale.

**Conflicting indicators:** Do NOT force consensus. Report the conflict. Markets
are uncertain — the analysis should reflect that honestly.

## Available Tools

- **Bash** (curl) — call Finnhub REST API endpoints
- `aphexdata_record_event` — persist structured analysis to audit trail (optional)
- `aphexdata_query_events` — retrieve historical analyses (optional)
