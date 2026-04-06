---
name: add-archetype-taxonomy
description: >
  Add the canonical 7-archetype strategy taxonomy, configurable cell scoring grid schema
  (default 560 cells), and portfolio constraints for the Market Timing Agent. No MCP server
  — just config files and an agent-facing reference doc.
---

# Add Archetype Taxonomy

Defines the 7 strategy archetypes, their regime preferences, the cell grid schema
(default 7 × 20 × 4 = 560 cells, configurable via instance-config.json), scoring rubrics, and portfolio constraints.

## Phase 1: Pre-flight

### Check if already applied
```bash
[ -f container/skills/archetype-taxonomy/archetypes.yaml ] && echo "ALREADY APPLIED — skip to Phase 3"
```

### Prerequisites
- NanoClaw installed
- Orderflow skill installed (provides regime_fit + execution_fit data)

## Phase 2: Apply Code Changes

### 2a. Create the config file

Create `container/skills/archetype-taxonomy/archetypes.yaml` with:
- 7 archetype definitions (TREND_MOMENTUM, MEAN_REVERSION, BREAKOUT, RANGE_BOUND, SCALPING, CARRY_FUNDING, VOLATILITY_HARVEST)
- Per-archetype: preferred_regimes, anti_regimes, preferred_pairs, preferred_timeframes, risk_profile, strategy_tags
- Cell grid dimensions (20 pairs across 4 liquidity tiers, timeframes: 5m/15m/1h/4h)
- Scoring rubric: regime_fit (0-6), execution_fit (0-6), net_edge (0-6)
- Composite formula: (regime_fit × 0.4) + (execution_fit × 0.25) + (net_edge × 0.35)
- Deploy threshold: 3.5, undeploy threshold: 2.0
- Portfolio constraints: max deployments per archetype/pair, capital limits, DD circuit breaker

### 2b. Create the agent-facing SKILL.md

Create `container/skills/archetype-taxonomy/SKILL.md` with the full reference doc covering:
- Archetype summary table
- Cell grid schema (JSON example)
- Scoring rubrics with data source mapping
- Composite score interpretation
- Portfolio constraints
- Strategy-to-archetype mapping instructions

### 2c. Build

```bash
./container/build.sh
```

No TypeScript changes needed — this is config + docs only.

## Phase 3: Configure

No environment variables needed. The archetype definitions are static config read from the container's mounted skills directory.

### Restart the service

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw

# Manual
npm run dev
```

## Phase 4: Verify

### Test via chat

1. Ask the agent: "Read the archetype taxonomy and list all 7 archetypes"
   - Should read `archetypes.yaml` and list all 7 with their preferred regimes

2. Ask: "What archetype fits EFFICIENT_TREND regime on BTC 1h?"
   - Should answer: TREND_MOMENTUM (preferred regime match)

3. Ask: "Score the BTC TREND_MOMENTUM 1h cell"
   - Should call `orderflow_fetch_regime` and `orderflow_fetch_microstructure`, then compute subscores

## Troubleshooting

### Agent can't find archetypes.yaml
The skills directory is mounted at `/workspace/skills/` in the container. Check:
```bash
ls /workspace/skills/archetype-taxonomy/
```
If missing, verify `container/skills/archetype-taxonomy/` exists on the host and rebuild the container.
