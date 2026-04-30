---
name: monitor-kata
description: >
  Kata worker completion handler. Runs hourly: detects completed kata
  races (strategy, gate, portfolio), runs walk-forward validation for
  graduates, deploys promising results as trial bots. Part of the split
  monitor pipeline (see also: monitor-health, monitor-deploy,
  monitor-portfolio).
  Trigger on: "kata check", "kata worker", "kata status",
  "monitor kata", "check kata races".
---

# Monitor — Kata Worker Handler (Step 7)

Detects completed kata optimization races, validates results via
walk-forward analysis, and deploys promising graduates as trial bots.
Runs independently to avoid blocking fast-path health monitoring.

**This skill does NOT check bot health, toggle signals, or manage slots.**
Those responsibilities belong to monitor-health and monitor-deploy.

## Guard Clause

Before doing any work, check for active kata races:

1. Read kata-state files:
   - `/workspace/group/research-planner/kata-state.json` (strategy kata)
   - Check `data/kata-runner/races/*.status.json` for running races

2. If NO races exist with `round == 4` AND `status in ["improved", "stuck"]`:
   → Log: "No completed kata races. Skipping."
   → Append tick-log entry and exit immediately.

## Dependencies

| Skill | Purpose |
|-------|---------|
| `kata-bridge` | Race management, kata-state schema |
| `freqtrade-mcp` | Walk-forward backtest, bot_start_paper |
| `aphexdata` | Audit trail for kata outcomes |

Files read:
- `research-planner/kata-state.json` — kata race state
- `data/kata-runner/races/*.status.json` — race status files
- `auto-mode/campaigns.json` — existing campaigns
- `auto-mode/deployments.json` — slot state
- `reports/gate-audit.json` — gate health scores (Level 2 trigger)
- `reports/portfolio-audit.json` — portfolio health scores (Level 3 trigger)

Files written:
- `auto-mode/campaigns.json` — new campaign from kata graduate
- `auto-mode/deployments.json` — new deployment record
- `research-planner/kata-state.json` — outcome updates
- `auto-mode/tick-log.jsonl` — step trace (append)
- `knowledge/anti-patterns.jsonl` — race-level anti-pattern entry (append)

## Console Sync — Mandatory

After writing any state file, sync to Supabase:

| File | state_key |
|------|-----------|
| `campaigns.json` | `campaigns` |
| `kata-state.json` | `kata_state` |

## Step 7: KATA WORKER CHECK

Read `/workspace/group/research-planner/kata-state.json`

If file exists AND `round == 4` AND `status in ["improved", "stuck"]`:

A Round 3 worker has finished. Run Round 4:

**If status == "improved":**
```
Read the modified strategy .py
Run compound 4-window walk-forward (1 bash call)
Compute favorable_sharpe
If >= 0.5: deploy paper bot
If >= 0.3: deploy with lower confidence
If < 0.3: close Kata, write race-level anti-pattern to knowledge/anti-patterns.jsonl:
  {
    "archetype": race.target.archetype,
    "pair":      race.target.pair,
    "timeframe": race.target.timeframe,
    "obstacle":  "race_zero_score",
    "change":    "kata race {race_id}: {experiments} experiments, best_score={best_score:.3f}, wf_pattern={wf_pattern}",
    "score_before": 0,
    "score_after":  race.best_score,
    "delta":        race.best_score,
    "wf_pattern":   race.wf_pattern (or "UNKNOWN" if absent),
    "ts":  now (UTC ISO 8601),
    "type": "anti_pattern"
  }
Update kata-state.json outcome
Move to kata-history/
```

**If status == "stuck":**
```
Check current_favorable_sharpe
If >= 0.3: deploy best result
If < 0.3: close Kata, write race-level anti-pattern to knowledge/anti-patterns.jsonl:
  {
    "archetype": race.target.archetype,
    "pair":      race.target.pair,
    "timeframe": race.target.timeframe,
    "obstacle":  "race_zero_score",
    "change":    "kata race {race_id}: {experiments} experiments, best_score={best_score:.3f}, wf_pattern={wf_pattern}",
    "score_before": 0,
    "score_after":  race.best_score,
    "delta":        race.best_score,
    "wf_pattern":   race.wf_pattern (or "UNKNOWN" if absent),
    "ts":  now (UTC ISO 8601),
    "type": "anti_pattern"
  }
Move to kata-history/
```

**Race-level anti-pattern schema** matches `kata/lib/knowledge.py` `append_anti_pattern()`.
The `obstacle` field is `race_zero_score` (distinct from per-experiment obstacles like
`entry_quality` or `risk_reward_ratio`). Strategyzer Phase 0 filters by archetype and
takes the 20 most recent entries — race-level entries appear alongside per-experiment
entries, giving the next strategyzer run a "don't retry this cell" signal.
Create `knowledge/` if it does not exist. `ts` and `type` may be omitted — the
knowledge.py writer stamps them automatically.

This means: parent spawns worker and exits. Auto-mode detects
completion and handles deployment. No polling, no blocking.

**Level 2/3 kata auto-triggers (daily check):**

After the strategy kata worker check, check whether gate or portfolio
kata races should be triggered based on audit health scores.

```
# Level 2: Gate kata trigger
gate_audit = read("reports/gate-audit.json")
if gate_audit exists AND gate_audit.gate_health_score < 0.60:
  if no active kata race with target_type == "gates":
    Log: "GATE HEALTH LOW: score={score}. Triggering gate kata."
    Route to kata-bridge with target_type="gates"
    # kata-bridge reads gate-audit.json for threshold_recommendations

# Level 3: Portfolio kata trigger
portfolio_audit = read("reports/portfolio-audit.json")
if portfolio_audit exists AND portfolio_audit.portfolio_health_score < 0.60:
  if no active kata race with target_type == "portfolio":
    Log: "PORTFOLIO HEALTH LOW: score={score}. Triggering portfolio kata."
    Route to kata-bridge with target_type="portfolio"
    # kata-bridge reads portfolio-audit.json for concentration/imbalance data
```

These auto-triggers only fire if no race of that type is already active.
Gate and portfolio kata races do not compete with strategy kata races for
slots — they run independently.

## Epilogue — Sync and Log

After completing kata check (even if no races found):

1. If any campaigns or deployments were modified:
   ```
   sync_state_to_supabase(state_key="campaigns", ...)
   sync_state_to_supabase(state_key="kata_state", ...)
   ```

2. Append completion entry to tick-log:
   ```
   append to auto-mode/tick-log.jsonl:
     {"ts": now, "tick_id": null, "skill": "monitor-kata", "step": 7,
      "phase": "complete",
      "outcome": "kata_races_checked_{n}_deployments_{deployed}"}
   ```

3. Message user ONLY if a kata graduate was deployed or a race was closed.
   Silent when no completed races found.

4. Write auto-memory summary to `~/.claude/memory/monitor-kata.md`:
   ```
   # Monitor-Kata Tick Summary
   Updated: {ISO timestamp}

   ## Active Races
   {list each open race: cell (archetype/pair/timeframe), round, current_score, experiments_run — or "none"}

   ## Completed This Tick
   {graduations deployed, races closed with reason — or "none"}

   ## Next Tick Notes
   {races near experiment budget, stalled cells (score < 0.3 after 10+ experiments), anything to recheck}
   ```
