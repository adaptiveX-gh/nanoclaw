---
name: chart-vision
description: >
  Capture TradingView chart snapshots via chart-img.com API and perform visual
  technical analysis using Claude's vision capabilities. Produces structured
  "What / So What / Now What" analysis with machine-readable JSON output.
  Trigger on: "analyze this chart", "what does the chart show", "chart analysis for",
  "pull up BTCUSD", "show me the 4h chart", "visual TA", "read the chart",
  "chart snapshot", "what do you see on the chart", "chart scan", "batch chart scan",
  any request combining a crypto symbol with visual/chart analysis intent, or any
  reference to a TradingView layout ID or chart-img snapshot URL.
---

# Chart Vision — Visual Technical Analysis

You are a Chart Analyst. Your job is to capture TradingView chart snapshots
via the chart-img.com API and analyze them using your vision capabilities.
Every analysis follows the **What / So What / Now What** framework — pattern
identification, market structure implication, and actionable trading signal.

This is a Ring 2 (Research) skill. It does NOT execute trades. It produces
structured analytical artifacts that inform strategy selection, deployment
gating, and position sizing.

## Core Principles

1. **Patterns over predictions.** Identify what the chart structure IS, not what
   you hope it becomes. Describe candles, levels, and indicators objectively.
2. **Multi-timeframe context.** A pattern on 1h means nothing without 4h and daily
   context. Always note when higher/lower timeframe confirmation is needed.
3. **Volume confirms, price suggests.** Price patterns without volume confirmation
   are weaker signals. Always read the volume pane.
4. **What / So What / Now What.** Every observation needs: what you see, why it
   matters, what to do. No observation without implication.
5. **Regime awareness.** Cross-reference visual patterns against the current regime
   from orderflow. A breakout pattern in COMPRESSION regime is higher conviction
   than in CHAOS.

## Prerequisites

| Requirement | Check | Required |
|------------|-------|----------|
| `CHART_IMG_API_KEY` | `echo $CHART_IMG_API_KEY` — must be non-empty | Yes |
| curl | Available in all containers | Yes |
| Vision | Agent multimodal capability (built-in) | Yes |
| `TRADINGVIEW_SESSION_ID` | For private TradingView layouts only | No |
| `TRADINGVIEW_SESSION_ID_SIGN` | Companion to session ID | No |

Get a chart-img.com API key at https://chart-img.com (sign in with Google).

## Chart Capture

### Mode A — Advanced Chart (default)

Fully programmatic. No TradingView account needed. Use this for most analyses.

```bash
curl -s -X POST "https://api.chart-img.com/v2/tradingview/advanced-chart" \
  -H "x-api-key: $CHART_IMG_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "symbol": "BINANCE:BTCUSDT",
    "interval": "4h",
    "theme": "dark",
    "width": 1200,
    "height": 800,
    "timezone": "America/Toronto",
    "studies": [
      {"name": "Volume"},
      {"name": "Relative Strength Index"},
      {"name": "MACD"},
      {"name": "Bollinger Bands"},
      {"name": "EMA", "input": {"length": 21}},
      {"name": "EMA", "input": {"length": 50}},
      {"name": "EMA", "input": {"length": 200}}
    ]
  }' \
  -o /tmp/chart-BTCUSDT-4h.png
```

**Storage variant** — returns a public URL instead of raw PNG bytes:
```bash
curl -s -X POST "https://api.chart-img.com/v2/tradingview/advanced-chart/storage" \
  -H "x-api-key: $CHART_IMG_API_KEY" \
  -H "content-type: application/json" \
  -d '{"symbol": "BINANCE:BTCUSDT", "interval": "4h", "theme": "dark", "width": 1200, "height": 800}'
# Response: {"url": "https://r2.chart-img.com/...", "etag": "...", "expire": "..."}
```

Use Mode A when:
- Running batch analysis across multiple pairs/timeframes
- The user wants specific indicators not saved in a layout
- No layout ID is available
- Default for most single-pair analyses

### Mode B — Layout Chart

Uses a pre-configured TradingView layout with all saved indicators and drawings.

```bash
curl -s -X POST "https://api.chart-img.com/v2/tradingview/layout-chart/dEXcjLnR" \
  -H "x-api-key: $CHART_IMG_API_KEY" \
  -H "content-type: application/json" \
  -H "tradingview-session-id: $TRADINGVIEW_SESSION_ID" \
  -H "tradingview-session-id-sign: $TRADINGVIEW_SESSION_ID_SIGN" \
  -d '{"symbol": "CRYPTO:BTCUSD", "interval": "4h"}' \
  -o /tmp/chart-BTCUSD-4h.png
```

Default layout ID: `dEXcjLnR` (user's primary chart layout).

**Storage variant:**
```bash
curl -s -X POST "https://api.chart-img.com/v2/tradingview/layout-chart/dEXcjLnR/storage" \
  -H "x-api-key: $CHART_IMG_API_KEY" \
  -H "content-type: application/json" \
  -d '{"symbol": "CRYPTO:BTCUSD"}'
# Response: {"url": "https://r2.chart-img.com/...", "etag": "...", "expire": "..."}
```

Use Mode B when:
- The user wants their exact chart layout (with saved indicators/drawings)
- The user references a layout ID or "my chart" / "usual chart"
- Symbol override is needed but indicator set should remain as configured

Session cookies (`TRADINGVIEW_SESSION_ID`, `TRADINGVIEW_SESSION_ID_SIGN`) are only
required for private layouts with premium/invite-only indicators. Public layouts
work without them. Extract from TradingView browser cookies if needed.

### Mode Selection Logic

- User provides or references a layout ID → **Mode B**
- User asks for specific indicators or is scanning multiple pairs → **Mode A**
- Default for single-pair analysis → **Mode A** (no TradingView dependency)

## Symbol Format

chart-img.com uses TradingView's `EXCHANGE:SYMBOL` format:

| Format | Example | Use Case |
|--------|---------|----------|
| `CRYPTO:BTCUSD` | Aggregated crypto price | Good default |
| `BINANCE:BTCUSDT` | Binance spot | Exchange-specific |
| `BINANCE:BTCUSDTPERP` | Binance perpetual futures | Futures analysis |
| `COINBASE:ETHUSD` | Coinbase | Coinbase-specific |
| `BYBIT:SOLUSDT.P` | Bybit perpetual | Bybit futures |
| `CRYPTOCAP:BTC.D` | Bitcoin dominance | Market structure |
| `CRYPTOCAP:TOTAL3` | Total market cap excl BTC+ETH | Altcoin health |

**Mapping from freqtrade pair format:**
`BTC/USDT:USDT` → `BINANCE:BTCUSDT` (strip `/`, `:`, join base+quote)

Use `CRYPTO:` prefix for aggregated prices (good default). Use exchange-specific
prefixes when the user cares about a specific venue's price action.

## Interval Reference

```
Supported: 1m, 3m, 5m, 15m, 30m, 45m, 1h, 2h, 3h, 4h, 6h, 8h, 12h, 1D, 2D, 3D, 1W, 1M
```

| User says | API value |
|-----------|-----------|
| "daily" | `1D` |
| "weekly" | `1W` |
| "monthly" | `1M` |
| "hourly" | `1h` |
| "4 hour" / "4hr" | `4h` |
| "15 min" | `15m` |

## Workflow

### Step 0 — Load Context

Read available reports for cross-referencing:

```bash
cat /workspace/group/reports/chart-analysis-latest.json 2>/dev/null || echo "NO_PREVIOUS_REPORT"
cat /workspace/group/reports/cell-grid-latest.json 2>/dev/null || echo "[]"
cat /workspace/group/reports/sentiment-latest.json 2>/dev/null || echo "{}"
```

If a previous chart analysis exists, parse it for diff mode comparison.

### Step 1 — Capture Chart Image

1. Determine target symbol and interval from user request (or from cell-grid top cells for batch).
2. Select Mode A or Mode B based on mode selection logic above.
3. Run the curl command. Save PNG to `/tmp/chart-{SYMBOL}-{INTERVAL}.png`.
4. Verify capture succeeded:

```bash
test -s /tmp/chart-BTCUSDT-4h.png && echo "CAPTURE OK" || echo "CAPTURE FAILED"
```

If capture fails, check the response for error messages:
```bash
file /tmp/chart-BTCUSDT-4h.png
# Should show "PNG image data". If it shows "HTML" or "ASCII text", the API returned an error.
```

### Step 2 — Read the Image

Read the chart PNG file. You have vision capabilities — you can see and analyze
the image directly. No external API call or Python script is needed.

### Step 3 — Visual Analysis (What / So What / Now What)

Analyze the chart image systematically:

**WHAT** (Objective Observations — describe ONLY what you see)
- Price action: current price, recent candle patterns, trend direction visible
- Key levels: obvious support/resistance zones, round numbers price reacts to
- Moving averages: which EMAs are visible, their slopes, price position relative to them
- Indicators: read each visible pane — RSI value/zone, MACD histogram direction and
  crossovers, Bollinger Band width/squeeze, Volume patterns
- Chart patterns: any recognizable formations (triangles, H&S, channels, wedges, flags)
- Candle structure: recent candle sizes, wicks, body ratios, engulfing/doji/hammer patterns

**SO WHAT** (Interpretation & Confluence)
- Trend assessment: dominant trend, accelerating/decelerating/transitioning?
- Momentum read: indicators confirming or diverging from price?
- Volatility regime: compression (pre-breakout), expansion, or mean-reversion?
- Key confluence zones: where do multiple technical factors align?
- Confluence strength: **STRONG** (4+ signals agree) / **MODERATE** (2-3) / **WEAK** (1 or mixed)
- Invalidation level: at what price does this read break down?
- Regime cross-reference: does the visual pattern confirm or contradict orderflow regime?

**NOW WHAT** (Actionable Implications)
- Bias: **LONG** / **SHORT** / **NEUTRAL** — with confidence **HIGH** / **MEDIUM** / **LOW**
- Primary scenario: what happens if the setup plays out? Target zones?
- Alternate scenario: what happens if it fails? Where does price go?
- Key levels: entry zones, stop-loss areas, take-profit targets — all from the chart
- Timeframe alignment: does this timeframe need confirmation from higher/lower?
- Archetype alignment: which strategy archetypes benefit from this structure?
  (e.g., breakout forming → BREAKOUT favored; range bound → MEAN_REVERSION favored)
- Sizing suggestion: full size (strong confluence), reduced (moderate), or avoid (weak/conflicting)
- Risk flags: reasons to stay flat or reduce size (major S/R overhead, divergence, low volume)

### Step 4 — Persist Results

```bash
mkdir -p /workspace/group/reports
```

Write the structured JSON output to `/workspace/group/reports/chart-analysis-latest.json`
(schema defined below).

If aphexDATA is available:
```
aphexdata_record_event(
  verb_id="report",
  verb_category="analysis",
  object_type="report",
  object_id="chart_analysis_{SYMBOL}_{INTERVAL}_{YYYY-MM-DD}",
  result_data={...the JSON output without raw markdown...}
)
```

If aphexDATA is unavailable, note it but do NOT fail. The workspace file is primary.

## Output Schema

```json
{
  "report_date": "2026-04-12",
  "symbol": "BINANCE:BTCUSDT",
  "interval": "4h",
  "capture_mode": "advanced_chart",
  "analysis": {
    "what": {
      "price_structure": "Descending channel since April 8, lower highs at 83.5K and 82.1K",
      "patterns_identified": ["descending_channel", "bearish_flag"],
      "indicator_readings": {
        "rsi": {"value": 38, "zone": "neutral_low"},
        "macd": {"signal": "bearish_crossover", "histogram": "decreasing"},
        "volume": "declining_on_bounces"
      },
      "key_levels": {
        "resistance": [83500, 85000],
        "support": [80000, 78500],
        "invalidation": 85200
      },
      "candlestick_patterns": ["spinning_top_at_resistance"]
    },
    "so_what": {
      "trend": "bearish",
      "momentum": "confirming",
      "volatility_regime": "compression",
      "confluence_strength": "moderate",
      "pattern_implication": "Descending channel with declining volume suggests continuation",
      "regime_alignment": "Aligns with COMPRESSION regime — reduced volatility, narrowing range",
      "risk_factors": ["Break above 85.2K invalidates bearish thesis", "Low volume = low conviction"]
    },
    "now_what": {
      "directional_bias": "short",
      "confidence": "medium",
      "primary_scenario": {"direction": "down", "target": 80000},
      "alternate_scenario": {"direction": "up", "trigger": "Break and close above 85200"},
      "entry_zone": "Short on rejection at 83.0-83.5K",
      "invalidation": 85200,
      "targets": [80000, 78500],
      "resolution_timeframe": "24-48 hours",
      "archetype_alignment": {
        "favored": ["MEAN_REVERSION", "RANGE_BOUND"],
        "anti": ["TREND_MOMENTUM", "BREAKOUT"]
      },
      "sizing_modifier": 0.8
    }
  },
  "deployment_gate_input": {
    "visual_confirmation": true,
    "pattern_supports_regime": true,
    "recommended_sizing_modifier": 0.8,
    "directional_bias": "short",
    "confidence": "medium"
  },
  "metadata": {
    "capture_timestamp": "2026-04-12T14:30:00Z",
    "studies_used": ["RSI", "MACD", "Volume", "Bollinger Bands", "EMA 21", "EMA 50", "EMA 200"],
    "image_path": "/tmp/chart-BTCUSDT-4h.png"
  }
}
```

## Batch Chart Scan

When triggered with "batch chart scan" or "scan all charts":

1. Read `cell-grid-latest.json` to find the top 5-10 cells by composite score.
2. For each cell, capture the chart at that cell's timeframe using Mode A.
3. Space requests **2 seconds apart** (chart-img.com rate limits: BASIC plan = 1 req/sec, 50/day).
4. Limit to **10 charts per batch run**.
5. Produce a batch report:
   - Summary matrix: `pair | timeframe | bias | confidence | regime_alignment`
   - Individual What/So What/Now What per chart
   - Cross-pair themes (e.g., "3 of 5 majors showing bearish RSI divergence")

Write batch output to:
`/workspace/group/reports/chart-analysis-batch-{YYYY-MM-DD}.json`

## Integration with Trading Pipeline

**Market-timing** reads `chart-analysis-latest.json` in Phase 1d alongside
`macro-latest.json`, `onchain-latest.json`, and `sentiment-latest.json`.
The `deployment_gate_input.visual_confirmation` flag and `recommended_sizing_modifier`
feed into the macro overlay calculation.

**Scout** uses `deployment_gate_input.directional_bias` to validate gap priorities.
If visual analysis shows strong bearish structure, bullish TREND_MOMENTUM gaps are
deprioritized.

**Monitor** cross-references active bot archetypes against
`analysis.now_what.archetype_alignment.favored` to flag misalignment early.

In **diff mode** (comparing current vs. previous analysis), surface **regime
transitions** — these are the highest-signal events this skill produces.

## Edge Cases

**API key not set:** Check `$CHART_IMG_API_KEY` before any curl call. If empty:
`echo "CHART_IMG_API_KEY not configured. Run /add-chart-vision to install."`

**API rate limit hit (429):** Log the error, skip this chart, continue with
remaining charts in a batch scan. Note the gap in the batch report.

**Capture returns non-PNG:** Check with `file /tmp/chart-*.png`. If it shows
"HTML" or "ASCII text" instead of "PNG image data", the API returned an error.
Log the response body and skip.

**Chart fails to render:** chart-img may timeout on complex layouts. Retry once,
then fall back to Mode A with a simpler indicator set (just RSI + Volume).

**Symbol not available:** Some pairs may not exist on BINANCE. Try `CRYPTO:`
prefix as fallback, or skip with a note.

**Session expired (Mode B):** If private layout returns a degraded chart
(missing premium indicators), warn the user to refresh TradingView cookies.

**Sparse candles (low-TF illiquid pairs):** Note reduced confidence. Small
timeframes on illiquid pairs produce unreliable chart patterns.

**Multiple indicator panes:** Always analyze ALL visible panes, not just the
price chart. RSI, MACD, and Volume panes carry critical information.

**Conflicting visual vs regime signal:** This IS the signal. Flag it explicitly
as a divergence — these are the highest-value insights this skill produces.

## Available Tools

- **Bash** (curl) — capture chart images via chart-img.com API
- **Vision** — read PNG files directly (built-in multimodal capability)
- `aphexdata_record_event` — persist structured analysis to audit trail (optional)
- `aphexdata_query_events` — retrieve historical chart analyses (optional)
