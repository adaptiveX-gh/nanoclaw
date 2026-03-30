---
name: add-research-planner
description: >
  Add simplified strategy research pipeline. Triages strategies via walk-forward,
  computes favorable Sharpe (positive windows only), deploys paper bots for live
  validation, and auto-graduates winners. Daily planning cycle + auto-mode
  integration for 15-minute paper bot health checks.
  Requires: auto-mode, freqswarm, freqtrade-mcp, archetype-taxonomy, aphexdata, clawteam, aphexdna.
---

# Add Research Planner

Simplified strategy research pipeline. Triages strategies, computes favorable
Sharpe (average of positive WF windows only), deploys paper bots for live
validation, and auto-graduates winners through auto-mode's 15-minute health
checks. 4 states, 2 decision questions, 3 minutes to paper trade.

## Phase 1: Pre-flight

### Check if already applied
```bash
[ -f container/skills/research-planner/SKILL.md ] && echo "ALREADY APPLIED — skip to Phase 3"
```

### Prerequisites

All of these must be installed first:

| Dependency | Check |
|-----------|-------|
| auto-mode | `[ -f container/skills/auto-mode/SKILL.md ]` |
| freqswarm | `[ -f container/skills/freqswarm/SKILL.md ]` |
| freqtrade-mcp | `grep -q 'freqtrade' container/agent-runner/src/index.ts` |
| archetype-taxonomy | `[ -f container/skills/archetype-taxonomy/archetypes.yaml ]` |
| aphexdata | `grep -q 'aphexdata' container/agent-runner/src/index.ts` |
| clawteam | `[ -f container/skills/clawteam-leader/SKILL.md ]` |
| aphexdna | `grep -q 'aphexdna' container/agent-runner/src/index.ts` |

If any dependency is missing, install it first using the corresponding `/add-*` skill.

## Phase 2: Apply Code Changes

### 2a. Create the agent-facing SKILL.md

Create `container/skills/research-planner/SKILL.md` with the simplified pipeline:
- 4 pipeline states: TESTING → PAPER_TRADING → GRADUATED (or RETIRED), plus IMPROVING, SKIPPED
- Paper Trading Gate: favorable_sharpe (positive windows only) >= 0.5 → deploy paper bot
- 3-tier seed discovery cascade (nova scan → sdna registry → ClawTeam structural creation)
- Simplified daily planning cycle (5 steps: check slots → fill winners → fill candidates → cross-pair sweep → report)
- Continuous triage feeding the paper bot pull system
- Paper bot validation delegated to auto-mode (15-min health checks)
- Cross-pair sweep on graduates
- Graduation tiers (paper entry 0.5, portfolio graduation 0.5 live, signal publishing 0.8 live)
- State file schemas (campaigns.json v2, nova-scan.json, config.json, triage-matrix.json v2)
- Command table (10 user commands)
- aphexDATA event conventions (12 events)

### 2b. Add Paper Bot Validation to auto-mode SKILL.md

Add a "Paper Bot Validation" section to `container/skills/auto-mode/SKILL.md` that runs
during every 15-minute health check:
- Read paper bot status for each paper_trading campaign
- Update campaign metrics
- Check early retirement triggers (DD, zero trades, consecutive losses)
- Auto-graduate if validation passes
- Auto-retire if validation fails
- Fill empty slots from triage matrix (pull system)

### 2c. Verify archetypes.yaml has paper_validation

Check `container/skills/archetype-taxonomy/archetypes.yaml` has `paper_validation`
entries under each archetype's `graduation_gates`. If missing, add them per the
validation period table (timeframe-specific days, min_trades, min_live_sharpe).

### 2d. Build

```bash
./container/build.sh
```

No TypeScript changes needed — this is a prompt-only orchestration skill.

## Phase 3: Configure

### Schedule the daily planning cycle

Ask the agent to schedule one recurring task:

**Daily planning cycle:**
```
"Schedule research planner to run daily at 3am UTC"
```

The agent will use `schedule_task` to set up:
```
schedule_task(
  name: "research_planner_daily",
  schedule: "0 3 * * *",
  context_mode: "isolated",
  prompt: "Run the daily research planning cycle. Check paper bot slots. Fill slots from triage matrix winners (favorable Sharpe >= 0.5). Improve candidates via hyperopt. Run cross-pair sweep on graduates. Sync state and report funnel metrics."
)
```

**Note:** The 4-hourly poll is no longer needed. Paper bot validation, graduation,
and retirement are handled by auto-mode's 15-minute health check cycle.

If old schedules exist, remove them:
```
"Remove the research_planner_weekly and research_planner_poll schedules"
```

### Optional: Bootstrap nova strategies

Run an initial classification scan:
```
"Bootstrap nova — scan all untagged strategies and classify by archetype"
```

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

Tests build on each other — run in order.

### Test 1: Research status (new states)
```
"Show research status"
```
Expected: Shows paper bots active/slots, graduated count, retired count, top candidates from triage matrix. States should be: testing, paper_trading, graduated, retired (not the old detected/planned/seeded/researching).

### Test 2: Show paper bots
```
"Show paper bots"
```
Expected: Lists active paper bots with strategy, pair, elapsed days, current Sharpe, P&L, max DD, validation deadline.

### Test 3: Triage cycle
```
"Run one triage cycle"
```
Expected: Picks next strategy from triage queue, runs single-window backtest, classifies result. If winner found (favorable Sharpe > 0.5), should deploy paper bot automatically.

### Test 4: Campaigns v2 schema
```bash
cat /workspace/group/research-planner/campaigns.json
```
Expected: Version 2 schema with triage, improvement, paper_trading, graduation sections. Timeline array present.

### Test 5: Archetypes paper_validation
```bash
grep -A5 "paper_validation" container/skills/archetype-taxonomy/archetypes.yaml
```
Expected: paper_validation entries for all 7 archetypes with per-timeframe days, min_trades, min_live_sharpe.

### Test 6: Simulate graduation
Set a paper_trading campaign's deployed_at to past its validation deadline with good metrics (sharpe >= 0.5, trades >= min). Wait for auto-mode health check. Expected: auto-mode graduates the strategy, writes header tags, adds to roster.

### Test 7: Simulate retirement
Set a paper_trading campaign's max_dd above 1.5x the archetype's max_drawdown_pct. Wait for auto-mode health check. Expected: auto-mode retires early, frees slot, fills from triage matrix.

## Troubleshooting

### No missed opportunity data
Auto-mode hasn't run enough cycles to accumulate missed opportunities. Wait for the next daily summary at 23:47 UTC, or run "Show research priorities" which reads the rolling buffer directly.

### Nova scan finds no strategies
Strategy .py files must exist in `/workspace/group/user_data/strategies/`. Verify files are present and contain valid FreqTrade IStrategy classes.

### Paper bot not deploying
Check: favorable_sharpe >= 0.5? Pre-flight validation passing (strategy loads, produces trades)? Paper bot slots available (< 20 active)? Duplicate check passing (no existing campaign for same strategy+pair)?

### Paper bot stuck (no graduation/retirement)
Check auto-mode health check is running (15-min cycle). Verify campaigns.json is readable. Check bot status is returning metrics. If bot_status returns errors, the bot may have crashed — auto-mode should detect this as "no_signals" and retire early.
