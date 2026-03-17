---
name: tds
description: >
  Use this skill for recording paper trades, signals, backtest results, and
  strategy events to the Trading Data Store (TDS). Always use the TDS MCP tools
  rather than calling the REST API directly via Bash.
---

# Trading Data Store (TDS) — Paper Trade Recording

13 tools for recording and querying trading events via an append-only,
hash-chain-verified event ledger.

## Tools

### Agent Management

| Tool | What it does |
|------|-------------|
| `tds_register_agent` | Register a new agent in TDS (returns UUID) |
| `tds_list_agents` | List all registered agents |
| `tds_get_agent` | Get agent details by ID |

### Event Recording

| Tool | What it does |
|------|-------------|
| `tds_record_trade` | Record a paper trade (opened/closed/modified) — convenience wrapper |
| `tds_record_signal` | Record a trading signal (buy/sell/hold) — convenience wrapper |
| `tds_record_event` | Record any event (generic, full control over schema) |
| `tds_query_events` | Query events with filters (agent, type, date range) |
| `tds_get_event` | Get a specific event by ID |

### Competition

| Tool | What it does |
|------|-------------|
| `tds_list_competitions` | List all competitions |
| `tds_get_competition` | Get competition details |
| `tds_get_standings` | Get competition leaderboard |

### System

| Tool | What it does |
|------|-------------|
| `tds_health` | Check TDS server health |
| `tds_verify_integrity` | Verify hash chain integrity of events |

## Common Patterns

**Record a paper trade:**
```
tds_record_trade(pair="BTC/USDT", side="long", action="opened", entry_price=95000, stake_amount=100, strategy="RSI_EMA")
```

**Close a paper trade:**
```
tds_record_trade(pair="BTC/USDT", side="long", action="closed", entry_price=95000, exit_price=97000, profit_pct=2.1, strategy="RSI_EMA")
```

**Record a signal:**
```
tds_record_signal(pair="ETH/USDT", signal_type="buy", confidence=0.85, strategy="MACD_Cross", indicators={"macd": 0.5, "signal": 0.3})
```

**Query recent trades:**
```
tds_query_events(object_type="trade", limit=20)
```

**Record a backtest result:**
```
tds_record_event(verb_id="completed", verb_category="analysis", object_type="backtest", object_id="RSI_EMA_2024", result_data={"profit_pct": 15.3, "max_drawdown": -8.2, "trades": 142})
```

## Connection Errors

- `TDS_URL not configured` — set `TDS_URL` in `.env` (e.g. `http://host.docker.internal:3100`)
- `TDS 401` — check `TDS_API_KEY` in `.env`
- `agent_id required` — set `TDS_AGENT_ID` in `.env` or pass `agent_id` to each tool call
