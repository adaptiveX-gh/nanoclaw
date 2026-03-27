---
name: add-research-planner
description: >
  Add autonomous strategy research orchestration. Reads auto-mode's missed
  opportunity data, bootstraps archetypes with zero coverage via a 3-tier seed
  cascade (nova scan → sdna registry → ClawTeam creation), triggers autoresearch
  mutation batches, graduates keepers through walk-forward validation, and hands
  off to auto-mode for staging. Weekly planning cycle + 6-hourly polling.
  Requires: auto-mode, freqswarm, archetype-taxonomy, aphexdata, clawteam, aphexdna.
---

# Add Research Planner

Autonomous strategy research pipeline. Connects missed-opportunity detection
(auto-mode) to targeted autoresearch (FreqSwarm), manages multi-archetype
coverage, handles cold-start bootstrapping, and graduates strategies into
auto-mode's deployment roster.

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
| archetype-taxonomy | `[ -f container/skills/archetype-taxonomy/archetypes.yaml ]` |
| aphexdata | `grep -q 'aphexdata' container/agent-runner/src/index.ts` |
| clawteam | `[ -f container/skills/clawteam-leader/SKILL.md ]` |
| aphexdna | `grep -q 'aphexdna' container/agent-runner/src/index.ts` |

If any dependency is missing, install it first using the corresponding `/add-*` skill.

## Phase 2: Apply Code Changes

### 2a. Create the agent-facing SKILL.md

Create `container/skills/research-planner/SKILL.md` with the full orchestration workflow:
- Research pipeline stages (detected → planned → seeded → researching → near_miss → graduated → staged → completed)
- 3-tier seed discovery cascade (nova scan → sdna registry → ClawTeam structural creation)
- Weekly planning cycle (9 steps)
- 6-hourly poll procedure
- Graduation gate with walk-forward validation
- Cold-start budget mode (doubled caps until all 7 archetypes have coverage)
- Near-miss escalation (keeper within 10% of threshold → ask user)
- State file schemas (campaigns.json, nova-scan.json, config.json, weekly-plan-latest.json)
- Command table (8 user commands)
- aphexDATA event conventions

### 2b. Build

```bash
./container/build.sh
```

No TypeScript changes needed — this is a prompt-only orchestration skill.

## Phase 3: Configure

### Schedule the planning and polling tasks

Ask the agent to schedule two recurring tasks:

**Weekly planning cycle:**
```
"Schedule research planner to run every Monday at 3am UTC"
```

The agent will use `schedule_task` to set up:
```
schedule_task(
  name: "research_planner_weekly",
  schedule: "0 3 * * 1",
  context_mode: "isolated",
  prompt: "Run the weekly research planning cycle. Read missed-opportunity summaries from the last 7 days, read current campaign state, identify gaps, prioritize by frequency × composite × cold-start bonus, create/update campaigns, run seed discovery for planned campaigns, trigger autoresearch for seeded campaigns within budget, write state, log to aphexDATA, and message with weekly summary."
)
```

**6-hourly polling:**
```
"Schedule research planner polling every 6 hours"
```

```
schedule_task(
  name: "research_planner_poll",
  schedule: "0 */6 * * *",
  context_mode: "isolated",
  prompt: "Poll active research campaigns. Check running autoresearch/ClawTeam jobs with swarm_poll_run, graduate keepers that pass walk-forward validation, detect near-misses (best keeper within 10% of threshold), flag stale campaigns (>48h no update), write updated state."
)
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

### Test 1: Research priorities (read-only)
```
"Show research priorities"
```
Expected: Reads missed-opportunity data from last 7 days, displays ranked table of cells with hit count, avg composite, archetype. Highlights archetypes with zero coverage.

### Test 2: Research status (empty state)
```
"Show research status"
```
Expected: Reports "No active campaigns. Research planner initialized." or similar.

### Test 3: Nova bootstrap
```
"Bootstrap nova"
```
Expected: Scans untagged .py strategy files, classifies by archetype using indicator analysis, stores results in `nova-scan.json`. Reports coverage map showing how many strategies matched each archetype.

### Test 4: Create a campaign
```
"Research MEAN_REVERSION"
```
Expected: Creates campaign immediately (skipping detection threshold). Runs seed discovery — finds nova strategies or sdna registry matches. If seeds found, triggers autoresearch. Campaign appears in `campaigns.json`.

### Test 5: Check aphexDATA logging
```
aphexdata_query_events(verb_id="research_campaign_created", limit=5)
```
Expected: Campaign creation event logged with archetype, targets, priority score.

### Test 6: Check state files
```bash
cat /workspace/group/research-planner/campaigns.json
cat /workspace/group/research-planner/nova-scan.json
```

### Test 7: Near-miss handling
If a campaign produces a keeper close to but below graduation threshold, verify the agent enters `near_miss` state and asks user for approval before abandoning.

## Troubleshooting

### No missed opportunity data
Auto-mode hasn't run enough cycles to accumulate missed opportunities. Wait for the next daily summary at 23:47 UTC, or run "Show research priorities" which also reads the rolling buffer directly.

### Nova scan finds no strategies
The strategy .py files must exist in `/workspace/group/user_data/strategies/` or the nova folder. Verify files are present and contain valid FreqTrade IStrategy classes.

### Campaign stuck in "researching"
If a campaign has been researching for >48 hours, the poll task will flag it. Check `swarm_poll_run` for the associated run_id. The autoresearch job may have failed — check `swarm_job_results` for error details.

### Cold-start budget insufficient
If 5 archetypes need bootstrapping and budget runs out, the planner queues remaining campaigns for the next weekly cycle. Cold-start mode doubles budget caps, but complex archetypes (CARRY_FUNDING, VOLATILITY_HARVEST) may need multiple weeks of Tier 3 ClawTeam work.

### Graduation fails walk-forward
The keeper's walk-forward Sharpe or degradation didn't meet the gate. The planner will try the next best keeper from the same autoresearch run, or trigger another round if budget allows. If all keepers fail, the campaign enters `near_miss` (if close) or `abandoned`.
