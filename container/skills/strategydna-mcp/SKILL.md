---
name: strategydna-mcp
description: >
  Use this skill for the full StrategyDNA lifecycle: creating, verifying, forking,
  compiling .sdna genomes, attesting backtest results, and managing the strategy
  registry. Always use the strategydna MCP tools rather than writing genome JSON manually.
---

# StrategyDNA — Genome Management Toolkit

16 tools for the full **Create → Verify → Fork → Compile → Attest → Register** lifecycle.

## Recommended Workflow

1. **Create** — generate a genome from a template (`sdna_init`)
2. **Inspect** — review the genome structure (`sdna_inspect`)
3. **Fork** — create variants with mutations (`sdna_fork`)
4. **Compile** — generate FreqTrade IStrategy code (`sdna_compile`)
5. **Backtest** — run via freqtrade tools, then ingest results (`sdna_ingest_backtest`)
6. **Attest** — create a signed attestation linking genome to backtest (`sdna_attest`)
7. **Register** — add to the strategy registry with scoring (`sdna_registry_add`)
8. **Compare** — browse the leaderboard (`sdna_registry_leaderboard`)

## Genome Management (4 tools)

| Tool | What it does |
|------|-------------|
| `strategydna_sdna_init` | Create a new .sdna genome from a template (blank, rsi_mean_reversion) |
| `strategydna_sdna_fork` | Fork a genome with optional mutations (name, risk params, etc.) |
| `strategydna_sdna_verify` | Verify the SHA-256 content hash integrity of a genome |
| `strategydna_sdna_inspect` | Parse and display genome metadata, signals, and structure summary |

## Diff & Comparison (1 tool)

| Tool | What it does |
|------|-------------|
| `strategydna_sdna_diff` | Compute semantic diff between two genomes (shows what changed) |

## Compilation (2 tools)

| Tool | What it does |
|------|-------------|
| `strategydna_sdna_compile` | Compile an .sdna genome to a FreqTrade IStrategy Python file |
| `strategydna_sdna_compile_config` | Generate a FreqTrade config.json from genome market/risk settings |

## Discovery (1 tool)

| Tool | What it does |
|------|-------------|
| `strategydna_sdna_list_templates` | List available genome templates with descriptions |

## Attestation (3 tools)

| Tool | What it does |
|------|-------------|
| `strategydna_sdna_attest` | Create an attestation from a genome + FreqTrade backtest result. Links genome hash to performance metrics with an optional operator ID |
| `strategydna_sdna_verify_attestation` | Verify attestation integrity; optionally cross-check the genome hash matches |
| `strategydna_sdna_ingest_backtest` | Parse a FreqTrade backtest result JSON and extract metrics, dataset info, and environment |

## Registry (5 tools)

| Tool | What it does |
|------|-------------|
| `strategydna_sdna_registry_add` | Register a genome (optionally with attestation) — computes composite score and tier |
| `strategydna_sdna_registry_search` | Search by archetype, pairs, timeframe, tier, or tags |
| `strategydna_sdna_registry_leaderboard` | Ranked leaderboard sorted by composite score (or any score field) |
| `strategydna_sdna_registry_show` | Look up a single registry entry by genome hash |
| `strategydna_sdna_registry_export` | Export the full registry as a TradeV-importable snapshot |

## Usage Examples

### Create and compile a strategy

```
1. Use sdna_list_templates to see available templates
2. Use sdna_init with template="rsi_mean_reversion" to create a genome
3. Use sdna_compile with the genome content to get FreqTrade Python code
4. Use freqtrade_write_strategy_file to save the compiled strategy
5. Use freqtrade_validate_strategy to verify it loads correctly
```

### Fork a strategy with tighter risk

```
1. Use sdna_fork with mutations={"risk.stoploss": -0.03, "risk.trailing_stop": true}
2. Use sdna_diff to compare parent and child genomes
3. Use sdna_compile on the forked genome
4. Backtest both to compare performance
```

### Backtest → Attest → Register

```
1. Compile genome with sdna_compile, save strategy file
2. Run backtest via freqtrade tools
3. Use sdna_ingest_backtest to extract metrics from the backtest result
4. Use sdna_attest with the genome + backtest result to create an attestation
5. Use sdna_verify_attestation to confirm attestation integrity
6. Use sdna_registry_add with genome + attestation to register with scoring
```

### Browse the registry

```
1. Use sdna_registry_leaderboard to see top strategies by composite score
2. Use sdna_registry_search with archetype="trend-following" or tier="excellent"
3. Use sdna_registry_show with a genome hash to see full details
4. Use sdna_registry_export to get a TradeV-importable snapshot
```

### Inspect and verify a genome

```
1. Use sdna_inspect to see metadata, signal count, risk params
2. Use sdna_verify to confirm the content hash is valid (no tampering)
```

## Key Concepts

- **Genome (.sdna)**: A declarative JSON document describing a trading strategy as data, not code
- **Content hash**: SHA-256 of canonical JSON — changes if any field changes
- **Lineage**: Parent hash chain forming a DAG of strategy evolution
- **Signals**: Indicator + operator + threshold conditions (e.g., RSI < 30)
- **Conditions**: Boolean logic (AND/OR) combining signals into entry/exit rules
- **Compilation**: Genome → FreqTrade IStrategy Python class with TA-Lib indicators
- **Attestation**: A signed record linking a genome hash to backtest metrics, creating a tamper-evident performance claim
- **Registry**: Local directory (`.sdna-registry/`) storing registered genomes with scores and tiers
- **Composite score**: Weighted blend of backtest (40%) + robustness (40%) + adoption (20%) metrics
- **Tier**: Classification based on composite score — poor / fair / good / excellent
