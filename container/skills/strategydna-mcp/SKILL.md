---
name: strategydna-mcp
description: >
  Use this skill for managing StrategyDNA genomes: creating, verifying, diffing,
  forking, and compiling .sdna genome files into FreqTrade IStrategy Python code.
  Always use the strategydna MCP tools rather than writing genome JSON manually.
---

# StrategyDNA — Genome Management Toolkit

8 tools for the full **Create → Verify → Fork → Compile** genome lifecycle.

## Recommended Workflow

1. **Create** — generate a genome from a template (`sdna_init`)
2. **Inspect** — review the genome structure (`sdna_inspect`)
3. **Fork** — create variants with mutations (`sdna_fork`)
4. **Compile** — generate FreqTrade IStrategy code (`sdna_compile`)
5. **Verify** — confirm content hash integrity (`sdna_verify`)

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
