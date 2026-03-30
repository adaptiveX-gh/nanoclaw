---
name: research-planner
description: >
  Simplified strategy research pipeline. Triages strategies via walk-forward,
  computes favorable Sharpe (positive windows only), deploys paper bots for
  live validation, and auto-graduates winners. Regime-gated favorable Sharpe
  is the single decision metric. Trigger on: "research priorities",
  "research status", "research plan", "run research planner", "fill the gap",
  "fill strategy gaps", "bootstrap nova", "scan nova", "graduate strategy",
  "research <archetype>", "show paper bots", "retire <strategy>",
  "show triage matrix".
---

# Research Planner — Simplified Pipeline

Paper trading IS the validation. A strategy that makes money on live unseen
data for a timeframe-appropriate period is more trustworthy than one that
passed walk-forward on historical data. Deploy many, keep winners, retire
losers. Paper trading costs nothing.

Regime gating changes the math: auto-mode only runs strategies when conditions
favor them. A strategy's effective Sharpe is its favorable-window Sharpe, not
its all-window mean. Measure what the portfolio actually sees, not what happens
when the strategy is off.

**Key principle: The planner deploys PAPER bots for live validation. Auto-mode
monitors paper bots, graduates winners, retires losers, and manages live
capital deployment.**


═══════════════════════════════════════════════════════════════════════
PART 1: DEPENDENCIES
═══════════════════════════════════════════════════════════════════════

| Skill | What it provides |
|-------|-----------------|
| auto-mode | `missed-opportunities.json`, `missed_opportunity_daily_summary` events, roster, paper bot validation |
| freqswarm | `swarm_scan_strategy`, `swarm_trigger_autoresearch`, `swarm_poll_run`, `swarm_job_results`, `swarm_check_graduation_gates`, `swarm_graduate_keeper`, `swarm_autoresearch_history`, `swarm_list_seeds`, `swarm_load_seed` |
| freqtrade-mcp | `freqtrade_backtest`, `freqtrade_run_hyperopt`, `bot_start`, `bot_stop`, `bot_status` — needed for paper bot deployment |
| clawteam | `team_spawn_worker`, `team_wait_all` for Tier 3 structural creation |
| archetype-taxonomy | `archetypes.yaml` — 7 archetypes, strategy_tags, risk_profiles, paper_validation periods |
| aphexdna | `sdna_registry_search`, `sdna_fork`, `sdna_compile`, `sdna_attest`, `sdna_registry_add` |
| aphexdata | `aphexdata_record_event`, `aphexdata_query_events` |


═══════════════════════════════════════════════════════════════════════
CONSOLE SYNC — MANDATORY
═══════════════════════════════════════════════════════════════════════

After EVERY atomic write of campaigns.json, call:
  sync_state_to_supabase(state_key="campaigns",
    file_path="/workspace/group/research-planner/campaigns.json")

The console dashboard reads from Supabase, not local files.
If you skip the sync call, the console will show stale data.


═══════════════════════════════════════════════════════════════════════
PART 2: PIPELINE STAGES
═══════════════════════════════════════════════════════════════════════

```
TESTING → PAPER_TRADING → GRADUATED
  │            │
  │            └──→ RETIRED (not profitable after validation)
  │
  └──→ IMPROVING (hyperopt/structural, then re-test)
  └──→ SKIPPED (no edge)
```

| State | Entry | What Happens | Exit |
|-------|-------|-------------|------|
| `testing` | Triage finds Sharpe > 0 | Run 4-window WF, compute favorable Sharpe | favorable >= 0.5 → paper_trading; 0.3-0.5 → improving; < 0.3 → skipped |
| `improving` | Favorable Sharpe 0.3-0.5 | Hyperopt (200 epochs), re-test WF | Improved >= 0.5 → paper_trading; no improvement after hyperopt + structural → skipped |
| `paper_trading` | Favorable Sharpe >= 0.5 | Deploy paper bot, auto-mode monitors | Validation passes → graduated; fails → retired |
| `graduated` | Profitable through validation period | Publish signals, roster, cross-pair sweep | Terminal (stays deployed) |
| `retired` | Not profitable after validation | Stop bot, free slot | Terminal |
| `skipped` | No edge found | Log result, move on | Terminal |


═══════════════════════════════════════════════════════════════════════
PART 3: SEED DISCOVERY CASCADE
═══════════════════════════════════════════════════════════════════════

For discovering strategy candidates, try these tiers in order. Stop at the
first tier that produces ≥1 viable seed.

### Tier 1: Nova Strategy Scan (cheapest)

Scan existing .py strategy files to classify by archetype.

```
Procedure:
1. List .py files in /workspace/group/user_data/strategies/
   (plus any nova/ directory if mounted)
2. Check nova-scan.json cache — skip already-classified strategies
3. For each unclassified strategy:
   a. swarm_scan_strategy(name) → get StrategyFacts + MutationEligibility
   b. Match StrategyFacts.indicators against archetypes.yaml strategy_tags:
      - RSI, Bollinger, Stochastic → MEAN_REVERSION
      - EMA crossover, ADX, MACD → TREND_MOMENTUM
      - Donchian, range_breakout → BREAKOUT
      - Support/resistance, grid → RANGE_BOUND
      - Supertrend, ATR expansion → VOLATILITY_HARVEST
      - Funding rate → CARRY_FUNDING
      - Micro_trend, tick → SCALPING
   c. Store classification in nova-scan.json. IMPORTANT: also store the full
      strategy_facts and strategy_ref from the scan result — you will need
      these when building the AutoresearchSpec (facts is REQUIRED for
      derived_subclass seeds, without it 0 variants are generated).
4. For the target archetype: pick strategies with matching classification
   AND that pass the Seed Quality Gate (below) as seeds
```

**Parallelization:** For bulk scans (>5 strategies), use ClawTeam workers:
```
team_spawn_worker(
  name: "nova_scan_batch_1",
  prompt: "Scan these strategies with swarm_scan_strategy and classify
    by archetype. Strategies: [list]. Return JSON array of
    {name, archetype, eligible, indicators}.",
  timeout_minutes: 15
)
```
Up to 3 workers scanning in parallel.

### Tier 2: sdna Registry Search

Search the aphexDNA registry for genome-based seeds.

```
Procedure:
1. Get archetype strategy_tags from archetypes.yaml
2. sdna_registry_search(tags=strategy_tags) → list of matching genomes
3. If matches found:
   a. sdna_registry_show(genome_id) → inspect genome
   b. sdna_fork(genome_id, mutations=[]) → create a copy as starting point
4. These genomes use the sdna_compile backend in autoresearch
```

### Tier 3: ClawTeam Structural Creation (expensive, last resort)

When no existing strategies match the target archetype — **or when Tier 1/2
seeds fail the Seed Quality Gate** — use ClawTeam to create a purpose-built
sdna seed. Two modes, tried in order:

**Mode A: Fork from adjacent archetype (preferred)**

| Target Archetype | Borrow From | Mutation Direction |
|-----------------|-------------|---------------------|
| BREAKOUT | TREND_MOMENTUM | + Donchian channel, + volatility expansion filter, - trailing logic |
| RANGE_BOUND | MEAN_REVERSION | + S/R detection, + range filter, - trend filters |
| VOLATILITY_HARVEST | BREAKOUT | + ATR expansion, + Supertrend, widen stops |
| CARRY_FUNDING | MEAN_REVERSION | + funding rate indicator, extend to 4h/1d, reduce signal frequency |
| SCALPING | TREND_MOMENTUM | shorten to 5m/15m, tighten stops, increase trade frequency |

```
team_spawn_worker(
  name: "tier3_fork_adjacent",
  prompt: "You have a {source_archetype} strategy at {path}.
    Goal: mutate it toward {target_archetype}.
    Changes needed: {mutation_direction}.
    1. Read the strategy file
    2. Create a modified version with the changes
    3. Write to /workspace/group/user_data/strategies/{NewName}.py
    4. Run a quick backtest: freqtrade_backtest(strategy={NewName}, ...)
    5. Return JSON: {name, sharpe, trades, drawdown, success}",
  timeout_minutes: 30
)
```

**Mode B: Generate from archetype definition (fallback)**

```
team_spawn_worker(
  name: "tier3_generate",
  prompt: "Create a new FreqTrade IStrategy for the {archetype} archetype.
    Archetype definition from archetypes.yaml:
      description: {description}
      preferred_regimes: {regimes}
      strategy_tags: {tags}
      risk_profile: max_dd={max_dd}, win_rate={win_rate}, rr={rr_ratio}
    Target pair: {pair}, Timeframe: {timeframe}
    Requirements:
    - Must be a complete IStrategy subclass
    - Must use indicators from strategy_tags
    - Must implement populate_indicators, populate_entry_trend, populate_exit_trend
    - Add header tag: # ARCHETYPE: {archetype}
    Write to /workspace/group/user_data/strategies/{Name}.py
    Run a quick backtest. Return JSON: {name, sharpe, trades, drawdown}",
  timeout_minutes: 60
)
```

Both modes: max 2 attempts per archetype. If the generated strategy has
Sharpe >= 0.0, use it as a seed for autoresearch. If Sharpe < 0.0 on both
attempts → skip archetype this cycle.

### Seed Quality Gate — apply to ALL seeds before submission

```
A seed is only viable if ALL of the following hold:
1. ARCHETYPE MATCH: The seed's core entry logic matches the target archetype.
   Check the actual indicator logic, not just the name.
2. MUTATION SURFACE (backend-dependent):
   - sdna_compile seeds: must have ≥2 eligible behavioral families
   - derived_subclass seeds: param_pin with ≥3 eligible hyperopt params
     is sufficient. If <3 params AND no static stoploss → reject.
3. CONTINUOUS PARAMS (backend-dependent):
   - sdna_compile seeds: entry/exit parameters must include at least one
     continuous (int/float) parameter.
   - derived_subclass seeds: categorical params are viable.
4. DATA CONFIRMED: OHLCV data must exist for ALL pairs the strategy needs,
   including informative pairs.
5. PRODUCES TRADES: If a quick triage backtest (single window) shows 0 trades,
   the seed is non-viable. Do NOT submit.
```

### Pre-Gate Triage — test before mutating

Before running full autoresearch on a seed, test it AS-IS through walk-forward.
A strategy that already works doesn't need mutation.

```
Pre-Gate Triage procedure:
1. For each candidate seed matched to the target archetype:
   a. Run 4-window walk-forward backtest on the target pair(s)
      using the strategy's default parameters.
   b. Collect per-window Sharpe, trade count, max drawdown.
   c. Compute favorable_sharpe (see Part 3B).
   d. If favorable_sharpe >= 0.5: → PAPER TRADE IMMEDIATELY
      Deploy paper bot, create campaign with state: paper_trading
   e. If favorable_sharpe 0.3-0.5: → IMPROVE
      Proceed to hyperopt/structural improvement
   f. If favorable_sharpe < 0.3: → SKIP
      Reject seed, try next
   g. If 0 trades: → SKIP (pair/timeframe mismatch)
```


═══════════════════════════════════════════════════════════════════════
PART 3B: PAPER TRADING GATE
═══════════════════════════════════════════════════════════════════════

After walk-forward, compute TWO Sharpe values:

```
mean_sharpe = average across all 4 windows
favorable_sharpe = average of windows where Sharpe > 0
favorable_windows = list of window indices where Sharpe > 0
```

The portfolio only sees favorable_sharpe because auto-mode turns
the strategy OFF in unfavorable regimes. A strategy with windows
[+0.8, -0.3, +0.9, -0.2] has favorable_sharpe = 0.85. Auto-mode
prevents the -0.3 and -0.2 windows from executing.

### Decision (two questions)

**Question 1: Does any walk-forward window show edge?**
  Count windows with Sharpe > 0.
  Zero positive windows → SKIP. No edge in any condition.
  At least 1 positive window → proceed.

**Question 2: Is the favorable-window Sharpe strong enough?**

  **favorable_sharpe >= 0.5:**
    → PAPER TRADE IMMEDIATELY with regime gating

    Pre-flight validation (30 seconds):
      Run a 1-day sanity backtest to verify the strategy file loads
      and produces signals. If it fails (import error, 0 trades due to
      broken config): log error, skip this candidate, do NOT waste a
      paper bot slot on a broken strategy.

    If pre-flight passes:
      → Deploy paper bot via bot_start(strategy, pair, dry_run=true)
      → Campaign state: paper_trading
      → Set regime_gated: true if not all windows positive
      → Set validation deadline from archetypes.yaml paper_validation[timeframe]
      → Post to feed: "Deploying paper bot: {strategy} on {pair}/{tf}
        — favorable Sharpe {n} ({k}/4 windows positive). Regime-gated."
        tags: ["deployment", "triage"]
      → aphexdata_record_event(verb_id="paper_bot_deployed", ...)

  **favorable_sharpe 0.3 to 0.5 (some edge, not strong enough):**
    → IMPROVE
    → Run freqtrade_run_hyperopt(strategy, timerange, epochs=200,
        spaces=["buy","sell"], loss_function="SharpeHyperOptLossDaily")
    → Apply best params, re-run 4-window walk-forward
    → Re-compute favorable_sharpe
    → If improved >= 0.5 → PAPER TRADE (same deployment flow above)
    → If still < 0.5 → try structural mutation (sdna_compile or ClawTeam)
    → If structural improves >= 0.5 → PAPER TRADE
    → If nothing works → SKIP
    → Campaign state: improving
    → Max 2 improvement rounds (1 hyperopt + 1 structural)

  **favorable_sharpe < 0.3:**
    → SKIP. Edge too weak even in favorable conditions.

### What this removes (and why)

REMOVED: WF pattern classification as a GATE
  Pattern classification still runs for LOGGING and the agent feed
  (see Part 6: Walk-Forward Interpretation). But it does NOT block
  paper trading. A DEGRADING strategy might still be profitable in
  the current window — let paper trading prove it.

REMOVED: Regime correlation check before deployment
  Auto-mode already gates by regime. A strategy deployed in the
  wrong regime just won't trade. No harm done.

REMOVED: 5-mode decision tree (VALIDATE_ONLY, HYPEROPT, PARAM_PIN,
  STRUCTURAL, HYBRID)
  Two paths: strong enough → paper trade. Not strong enough →
  hyperopt, then structural, then skip.

REMOVED: Near-miss state
  Either paper trade it or skip it. No waiting for user approval.

KEPT: Walk-forward as sanity check (prevents gross overfitting)
KEPT: Continuous triage (Part 3C — the discovery engine)
KEPT: Seed discovery cascade (fallback when triage matrix empty)
KEPT: Pre-gate triage (single window quick filter)
KEPT: WF interpretation for logging (post to feed, don't gate on it)


═══════════════════════════════════════════════════════════════════════
PART 3C: CONTINUOUS TRIAGE (IDLE-TIME RESEARCH)
═══════════════════════════════════════════════════════════════════════

Between scheduled tasks, triage untested strategies one at a time
during idle periods. No batch — just steady progress filling the
triage matrix. The matrix feeds the paper bot pull system: strategies
that pass triage get deployed as paper bots automatically.

### When to Run

Auto-mode triggers one triage cycle after completing a routine health
check (see auto-mode skill for the trigger). The research planner
executes the cycle using this procedure.

Do NOT run triage if:
- A triage cycle completed less than 3 minutes ago
- An autoresearch run is actively being polled
- The triage queue is empty (all strategies tested against all top pairs)
- The agent is in a user message container (triage runs in task containers only)

### State File: triage-matrix.json

Location: `/workspace/group/research-planner/triage-matrix.json`

Created on first triage cycle if it doesn't exist.

```json
{
  "version": 2,
  "queue_position": 0,
  "total_strategies": 0,
  "tested": 0,
  "result_a_count": 0,
  "result_b_count": 0,
  "result_c_count": 0,
  "last_cycle": null,
  "last_queue_reset": null,
  "top_missed_pairs": [],
  "queue": [],
  "candidates": [],
  "winners": [],
  "tested_results": []
}
```

Field definitions:
- `queue`: ordered list of strategy names not yet tested
- `queue_position`: current index in the queue (for resuming)
- `top_missed_pairs`: the 5 pairs with most missed opportunities (refreshed on queue reset)
- `candidates`: Result B strategies — have some edge, need improvement
- `winners`: Result A strategies — favorable_sharpe >= 0.5, ready for paper trading
  Each winner includes: strategy, pair, timeframe, favorable_sharpe,
  wf_per_window, favorable_windows, regime_gated, deployed_as_paper (bool)
- `tested_results`: rolling log of all triage results

### One Triage Cycle Procedure (~2-3 minutes)

**Step 1: Initialize or load queue**

Read `/workspace/group/research-planner/triage-matrix.json`.

If the file doesn't exist OR queue is empty OR `last_queue_reset` is
more than 7 days ago:

  1. List all .py files in `/workspace/group/user_data/strategies/`
  2. Exclude strategies already in `tested_results` where ALL top 5
     pairs have been tested (fully exhausted strategies)
  3. Read `/workspace/group/auto-mode/missed-opportunities.json`
     Aggregate by pair, sort by hit_count descending, take top 5
     Store as `top_missed_pairs`
  4. Build queue: list of strategy names, sorted alphabetically
  5. Set `queue_position` = 0, `last_queue_reset` = now
  6. Write triage-matrix.json

If queue exists and is not stale: continue from `queue_position`.

**Step 2: Pick next strategy and pair**

  strategy_name = queue[queue_position]

  For this strategy, check tested_results: which of the top 5 pairs
  has it NOT been tested against yet?

  pair = first untested pair from top_missed_pairs for this strategy

  If all 5 pairs tested for this strategy:
    Mark strategy as "exhausted" in tested_results
    Increment queue_position
    Write triage-matrix.json
    Return (cycle done, no backtest needed)

**Step 3: Run single-window backtest**

  freqtrade_backtest(
    strategy=strategy_name,
    pairs=[pair],
    timeframe="1h",
    timerange="20250101-20250424",
    config_path=<standard config>
  )

  Extract from results: sharpe, trade_count, max_drawdown_pct

  If backtest fails (strategy error, import error, etc.):
    Record in tested_results: { strategy, pair, sharpe: null,
      trades: 0, result: "ERROR", error: "<message>", tested_at }
    Move to next pair for this strategy on next cycle
    Return

**Step 4: Classify result**

  Read the archetype's graduation gates from archetypes.yaml.

  Result A: sharpe >= graduation_gates.min_wf_sharpe
            AND trade_count >= graduation_gates.min_trades_per_window

    → IMMEDIATE ACTION within this same triage cycle:

    1. Run full 4-window walk-forward:
         W0: 20250101-20250424
         W1: 20250424-20250815
         W2: 20250815-20251206
         W3: 20251206-20260329

    2. Compute favorable_sharpe from WF results (Part 3B)

    3. Post walk-forward interpretation to feed (Part 6 — logging only)

    4. If favorable_sharpe >= 0.5:
       → Add to winners[] with deployed_as_paper: false
       → If paper bot slots available AND auto_deploy_triage_winners:
         Run pre-flight validation (30s sanity backtest)
         If passes: deploy paper bot immediately
         Create campaign with state: paper_trading
         Mark winner as deployed_as_paper: true
       → aphexdata_record_event(verb_id="triage_winner", ...)

    5. If favorable_sharpe 0.3-0.5:
       → Add to candidates[] for improvement during daily cycle
       → Log: "Triage candidate (needs improvement): {strategy}
         on {pair} — favorable Sharpe {n}"

    6. If favorable_sharpe < 0.3:
       → Record in tested_results, move on

  Result B: sharpe >= 0.1 AND sharpe < graduation threshold

    → Add to candidates[] in triage-matrix.json:
      { strategy, pair, timeframe: "1h", sharpe, trades, max_dd,
        archetype, triage_result: "B", tested_at }
    → If sharpe > 0.3: post to feed:
      "Triage candidate: {strategy} on {pair} Sharpe {sharpe}"
      tags: ["triage", "finding"]

  Result C: sharpe < 0.1

    → Record in tested_results only
    → Next cycle: try the next untested pair for this strategy

**Step 5: Update state**

  Record result in tested_results[]
  Update counts
  Update queue_position if moving to next strategy
  Update last_cycle = now
  Write triage-matrix.json (atomic: write .tmp then rename)
  sync_state_to_supabase(state_key="triage_matrix", ...)

### Queue Reset (Weekly)

Every Monday 03:00 UTC (aligned with budget reset):
  - Rebuild queue from strategies directory
  - Refresh top_missed_pairs from latest missed-opportunities.json
  - Clear "exhausted" flags
  - KEEP tested_results history, candidates, and winners
  - Reset queue_position to 0

### Throughput

  Auto-mode cycles: 96/day (every 15 min)
  Triage cycles: ~80/day (some cycles skipped due to state changes)
  Backtests per cycle: 1 (30 seconds each)
  Strategies in library: ~455
  Top pairs tested: 5
  Total combinations: 455 × 5 = 2,275
  Days to first pass: ~28 (2,275 / 80)


═══════════════════════════════════════════════════════════════════════
PART 4: DAILY PLANNING CYCLE (SIMPLIFIED)
═══════════════════════════════════════════════════════════════════════

Scheduled: `0 3 * * *` (daily 03:00 UTC). Manual trigger: "Run research planner"

### Step 1: Check paper bot slots

  active_paper_bots = count campaigns where state == "paper_trading"
  max_slots = 20 (from config.json)
  available = max_slots - active_paper_bots

  If available == 0:
    Log: "All 20 slots full. Waiting for graduations or retirements."
    Skip to Step 4.

### Step 2: Fill slots from triage matrix winners

  Read triage-matrix.json

  winners = triage_matrix.winners where deployed_as_paper == false
  Sort by: (archetype_coverage_gap DESC, favorable_sharpe DESC)

  archetype_coverage_gap: count paper bots per archetype, prioritize
  archetypes with fewer active paper bots. A portfolio with 5 MR bots
  and 0 BREAKOUT bots should fill BREAKOUT first.

  For each winner, up to available_slots:
    If 4-window WF not yet run: run it now
    Compute favorable_sharpe from WF results
    If favorable_sharpe >= 0.5:
      Pre-flight validation (30s sanity backtest)
      If pre-flight passes:
        Deploy paper bot (bot_start, dry_run=true)
        Create campaign with state: paper_trading
        Set validation deadline based on timeframe from archetypes.yaml
        Decrement available_slots
        Mark winner as deployed_as_paper: true
    Else:
      Move to candidates list for improvement

### Step 3: Fill remaining slots from candidates

  If available_slots > 0:
    candidates = triage_matrix.candidates (Result B)
    Sort by (archetype_coverage_gap DESC, sharpe DESC)

    For each candidate, up to available_slots:
      Run hyperopt (200 epochs, Sharpe objective)
      Re-run 4-window walk-forward with best params
      Compute favorable_sharpe
      If favorable_sharpe >= 0.5:
        Pre-flight validation
        Deploy paper bot
        Create campaign with state: paper_trading
        Decrement available_slots
      Else if favorable_sharpe >= 0.3 AND structural available:
        Try sdna_compile + structural mutations
        Re-test best variant
        If favorable_sharpe >= 0.5: deploy
        Else: mark as attempted, move on
      Else:
        Mark as attempted, move on

    Budget: max 10 hyperopt + 2 structural per week

### Step 4: Cross-pair sweep on graduates

  For each campaign with state == "graduated":
    If cross_pair_sweep_done == false:
      Run cross-pair sweep (see Part 5)
      Set cross_pair_sweep_done = true

### Step 5: Sync + report

  sync_state_to_supabase(state_key="campaigns", ...)

  Compute funnel metrics:
    tested = triage_matrix.tested count
    paper_bots = count campaigns where state == "paper_trading"
    graduated = count campaigns where state == "graduated"
    retired = count campaigns where state == "retired"

  Post to feed: "Daily planner: {paper_bots}/20 paper bots,
    {graduated} graduated, {retired} retired, {available} available
    Pipeline: {tested} triaged → {paper_bots} paper → {graduated} graduated"
    tags: ["research", "decision"]

  Message user (only if changes):
    "Research Planner — Daily Update
    Paper bots: {paper_bots}/20 slots used
    Graduated today: {list}
    Retired today: {list}
    Pipeline: {tested} triaged → {paper_bots} paper → {graduated} graduated
    Next candidates: {top 3 from triage matrix}"


═══════════════════════════════════════════════════════════════════════
PART 5: POST-GRADUATION — CROSS-PAIR SWEEP
═══════════════════════════════════════════════════════════════════════

When a strategy graduates, test it on other pairs cheaply:

1. Read top 20 pairs from the coverage grid

2. For each untested pair:
   Single-window backtest (30 seconds)
   Record Sharpe, trades, max_dd

3. For any pair with single-window Sharpe > 0.3:
   Run 4-window walk-forward (2 minutes)
   Compute favorable_sharpe

4. If favorable_sharpe >= 0.5 AND paper bot slots available:
   Pre-flight validation (30s sanity backtest)
   Deploy paper bot on that pair
   Create new campaign linked to parent graduation:
     campaign.id includes parent strategy name + new pair
     campaign.graduation.cross_pair_parent = parent_campaign_id

5. Each cross-pair deployment goes through the same live
   validation period independently.

6. Post to feed: "Cross-pair sweep: {strategy} → deploying on
   {pair1}, {pair2}. {n} pairs tested, {k} viable."
   tags: ["research", "cross-pair"]

7. Set parent campaign.graduation.cross_pair_sweep_done = true
   campaign.graduation.cross_pair_deployments = [new campaign ids]

8. aphexdata_record_event(verb_id="cross_pair_deployed", ...)


═══════════════════════════════════════════════════════════════════════
PART 6: WALK-FORWARD INTERPRETATION (LOGGING, NOT GATING)
═══════════════════════════════════════════════════════════════════════

After every walk-forward result, classify the pattern and post
to the agent feed. This information helps the operator understand
strategy behavior but does NOT block paper trading.

Classify as:
  CONSISTENT: all same sign, < 0.3 spread between max and min
  DEGRADING: first half mean > 2× second half mean
  ALTERNATING: flips +/- across windows
  SINGLE_SPIKE: one dominant window (Sharpe > 1.0, others near zero)

Post to feed with every WF result:

  WALK-FORWARD ANALYSIS
  Strategy: {name} on {pair}/{tf}
  Windows: W0:{sharpe} W1:{sharpe} W2:{sharpe} W3:{sharpe}
  Mean Sharpe: {mean}
  Favorable Sharpe: {favorable} ({k}/4 windows)
  Pattern: {classification}
  Regime gated: {yes/no}
  Decision: {paper_trade / improve / skip}
  tags: ["research", "finding"]

This replaces the previous role where pattern classification
could REJECT a strategy before paper trading. Now the pattern
is recorded for analysis, and favorable_sharpe alone determines
the paper trading decision.


═══════════════════════════════════════════════════════════════════════
PART 7: GRADUATION TIERS
═══════════════════════════════════════════════════════════════════════

Three thresholds serve different purposes:

| Tier | Threshold | What it means |
|------|-----------|---------------|
| Paper trading entry | favorable Sharpe >= 0.5 | Strategy shows real edge in at least some market conditions. Cheap to test live. |
| Portfolio graduation | live Sharpe >= 0.5 after validation period | Strategy proved profitable on truly unseen data. Add to roster, keep deployed. |
| Signal publishing | live Sharpe >= 0.8 after validation period | High enough quality to share with other operators via signal marketplace. |

Auto-mode handles these tiers:
  - Paper trading entry: research planner deploys the bot
  - Portfolio graduation: auto-mode promotes to roster after validation
  - Signal publishing: auto-mode or user enables signal publishing for high-Sharpe graduates

A strategy can graduate (tier 2) without being published (tier 3).
Publishing is opt-in for strategies that exceed the higher bar.


═══════════════════════════════════════════════════════════════════════
PART 8: BUDGET MANAGEMENT
═══════════════════════════════════════════════════════════════════════

| Resource | Weekly Cap | Purpose |
|----------|-----------|---------|
| Hyperopt runs | 10 | Parameter optimization for 0.3-0.5 candidates |
| Structural mutations | 2 | ClawTeam code changes for stubborn candidates |
| Paper bot slots | 20 (concurrent) | Live paper trading validation |
| Improvement rounds | 2 per candidate | Max attempts before skipping |

Budget tracked in campaigns.json, reset Monday 03:00 UTC.
If hyperopt budget exhausted → candidates queue for next week.
Paper bot slots are not weekly — they're concurrent capacity.


═══════════════════════════════════════════════════════════════════════
PART 9: STATE FILES
═══════════════════════════════════════════════════════════════════════

All at `/workspace/group/research-planner/`.

### campaigns.json

```json
{
  "version": 2,
  "campaigns": [
    {
      "id": "camp_20260330_MR_SOL_1h",
      "strategy": "MeanReversionQuant",
      "pair": "SOL/USDT:USDT",
      "timeframe": "1h",
      "archetype": "MEAN_REVERSION",
      "state": "paper_trading",
      "created_at": "2026-03-30T15:00:00Z",
      "updated_at": "2026-03-30T15:05:00Z",

      "timeline": [
        { "state": "testing", "timestamp": "2026-03-30T15:00:00Z", "reason": "triage_winner" },
        { "state": "paper_trading", "timestamp": "2026-03-30T15:05:00Z", "reason": "favorable_sharpe_0.85" }
      ],

      "triage": {
        "source": "triage_matrix",
        "single_window_sharpe": 0.394,
        "wf_mean_sharpe": 0.30,
        "wf_favorable_sharpe": 0.85,
        "wf_per_window": [0.80, -0.30, 0.90, -0.20],
        "wf_trades_per_window": [9, 14, 17, 10],
        "wf_max_dd": -4.9,
        "favorable_windows": [0, 2],
        "regime_gated": true,
        "wf_pattern": "ALTERNATING",
        "wf_pattern_note": "Positive in trending windows, regime-gated"
      },

      "improvement": {
        "hyperopt_sharpe": null,
        "hyperopt_favorable_sharpe": null,
        "structural_sharpe": null,
        "rounds_used": 0,
        "max_rounds": 2
      },

      "paper_trading": {
        "bot_deployment_id": "paper-meanrevquant-sol-1h",
        "deployed_at": "2026-03-30T15:05:00Z",
        "validation_period_days": 7,
        "validation_deadline": "2026-04-06T15:05:00Z",
        "current_pnl_pct": 0.0,
        "current_trade_count": 0,
        "current_sharpe": 0.0,
        "current_max_dd": 0.0,
        "last_checked": null
      },

      "graduation": {
        "graduated_at": null,
        "live_sharpe": null,
        "live_trades": null,
        "live_pnl_pct": null,
        "live_max_dd": null,
        "cross_pair_sweep_done": false,
        "cross_pair_deployments": [],
        "cross_pair_parent": null
      }
    }
  ],

  "budget": {
    "week_start": "2026-03-30T03:00:00Z",
    "hyperopt_used": 0,
    "hyperopt_max": 10,
    "structural_used": 0,
    "structural_max": 2
  }
}
```

### config.json

```json
{
  "version": 2,
  "paper_trading": {
    "max_paper_bots": 20,
    "favorable_sharpe_threshold": 0.5,
    "improvement_sharpe_min": 0.3,
    "early_retire_dd_multiplier": 1.5,
    "early_retire_zero_trades_pct": 0.25,
    "early_retire_consecutive_losses": 5,
    "early_retire_loss_threshold_pct": 5.0,
    "auto_cross_pair_sweep": true,
    "auto_deploy_triage_winners": true
  },
  "improvement": {
    "hyperopt_epochs": 200,
    "hyperopt_per_week": 10,
    "structural_per_week": 2,
    "max_rounds_per_candidate": 2
  },
  "graduation": {
    "min_live_sharpe": 0.5,
    "signal_publishing_sharpe": 0.8
  }
}
```

### nova-scan.json

Same schema as before — array of classified strategies with
strategy_facts, strategy_ref, and mutation eligibility.

### triage-matrix.json

See Part 3C for schema. Version 2 adds favorable_sharpe fields
to winners and deployed_as_paper tracking.


═══════════════════════════════════════════════════════════════════════
PART 10: COMMAND TABLE
═══════════════════════════════════════════════════════════════════════

| User Says | What Happens |
|-----------|-------------|
| "Show research status" | Read campaigns.json. Show: paper bots active/slots, graduated count, retired count, top candidates from triage matrix. Include funnel metrics. |
| "Run research planner" | Execute simplified daily planning cycle (Steps 1-5) |
| "Research {archetype}" | Find best seed from triage matrix or nova scan. Run WF. If favorable Sharpe > 0.5, deploy paper bot immediately. Non-blocking adhoc protocol. |
| "Fill strategy gaps" | Run triage matrix lookup for all gap archetypes. Deploy paper bots for any candidates with favorable Sharpe > 0.5 |
| "Show paper bots" | List all campaigns with state == paper_trading. Show: strategy, pair, timeframe, elapsed days, current Sharpe, current P&L, max DD, validation deadline |
| "Graduate {strategy}" | Manual graduation override. Write header tags, add to roster |
| "Retire {strategy}" | Manual retirement. Stop bot, free slot, update campaign state |
| "Show triage matrix" | Show triage-matrix.json summary: tested count, Result A/B/C counts, top candidates, winners |
| "Bootstrap nova" | Run Tier 1 nova scan on all untagged .py strategies. Classify by archetype. Store in nova-scan.json. Report coverage map. |
| "Show research priorities" | Query 7d of missed_opportunity_daily_summary from aphexDATA + read missed-opportunities.json. Rank by hit_count × avg_composite. Highlight gaps. |


═══════════════════════════════════════════════════════════════════════
PART 11: APHEXDATA EVENT CONVENTIONS
═══════════════════════════════════════════════════════════════════════

| verb_id | When |
|---------|------|
| `triage_tested` | Strategy backtested during idle-time triage |
| `triage_winner` | Strategy passed triage with favorable Sharpe >= 0.5 |
| `paper_bot_deployed` | Paper bot started for a candidate |
| `paper_bot_checked` | Live validation check (every 15 min health check) |
| `paper_bot_retired` | Paper bot stopped — failed validation |
| `paper_bot_retired_early` | Paper bot stopped before deadline — safety trigger |
| `strategy_graduated_live` | Strategy passed live validation period |
| `cross_pair_deployed` | Graduate deployed on additional pair |
| `improvement_hyperopt` | Hyperopt run on weak candidate |
| `improvement_structural` | Structural mutation on weak candidate |
| `research_daily_plan` | Daily planning cycle summary |
| `nova_scan_completed` | Nova strategy classification batch done |

All events include `result_data` with campaign_id, archetype, strategy,
pair, timeframe, and relevant metrics.


═══════════════════════════════════════════════════════════════════════
PART 12: SAFETY RAILS
═══════════════════════════════════════════════════════════════════════

### Compute budget

- Weekly caps enforced: 10 hyperopt, 2 structural
- Per-candidate caps enforced: max 2 improvement rounds
- Budget tracked in campaigns.json, reset Monday 03:00 UTC
- If exhausted → candidates queue for next week

### Paper bot slot management

- Max 20 concurrent paper bots (configurable)
- Slots freed on graduation or retirement
- Both research planner and auto-mode can deploy paper bots
- Auto-mode fills empty slots from triage matrix winners (pull system)

### Concurrent access to campaigns.json

- Both auto-mode (15 min) and research-planner (daily) write campaigns.json
- Use atomic write pattern: write to .tmp file, then rename
- Version counter incremented on each write
- On read, check version: if higher than expected, re-read before modifying
- If campaigns.json fails to parse → enter read-only mode, alert user

### Duplicate prevention

Before deploying a paper bot:
```
Check campaigns.json for existing campaign with same
(strategy, pair, timeframe) in non-terminal state.
If found → skip deployment, report existing campaign.
```

### Bad strategy prevention

- Walk-forward validation is MANDATORY before paper trading
- favorable_sharpe >= 0.5 is MANDATORY for paper bot deployment
- Pre-flight validation (30s sanity backtest) before every deployment
- All graduation criteria are per-archetype from archetypes.yaml

### Valid states and transitions

```
testing → paper_trading (favorable_sharpe >= 0.5)
testing → improving (favorable_sharpe 0.3-0.5)
testing → skipped (favorable_sharpe < 0.3)
improving → paper_trading (improvement successful)
improving → skipped (improvement failed)
paper_trading → graduated (validation passed — handled by auto-mode)
paper_trading → retired (validation failed — handled by auto-mode)
```

Terminal states: graduated, retired, skipped


═══════════════════════════════════════════════════════════════════════
PART 13: INTEGRATION NOTES
═══════════════════════════════════════════════════════════════════════

### Auto-Mode Handoff

The research planner deploys paper bots. Auto-mode monitors them:
- Every 15-minute health check: read paper bot status, update metrics
- Auto-graduate if validation passes (writes header tags, adds to roster)
- Auto-retire if validation fails (stops bot, frees slot)
- Auto-fill empty slots from triage matrix winners

Graduation writes header tags to strategy .py files:
```python
# ARCHETYPE: MEAN_REVERSION
# GRADUATED: 2026-03-30
# LIVE_VALIDATED: 7 days
# LIVE_SHARPE: 0.72
# LIVE_TRADES: 15
# LIVE_PNL: 4.2%
# VALIDATED_PAIRS: SOL/USDT:USDT
# REGIME_GATED: true
```

### ClawTeam Escalation

Escalate to ClawTeam when:
1. Tier 3 seed creation needed (no nova or sdna seeds for an archetype)
2. Structural improvement round needed (hyperopt failed to improve)

When spawning ClawTeam workers, always include:
- Full strategy file content in the prompt (workers have no memory)
- Fitness targets from the campaign
- Pair/timeframe targets
- archetype definition from archetypes.yaml

### FreqSwarm Tool Usage

For sdna-based seeds:
```
swarm_load_seed(name) → genome JSON
→ include genome in AutoresearchSpec.seed_genomes[] with execution_backend: "sdna_compile"
→ MUST include pair, timeframe in each seed entry
```

For nova/derived seeds:
```
swarm_scan_strategy(name) → {strategy_ref, strategy_facts, mutation_eligibility}
→ include strategy_ref AND facts (= strategy_facts) in seed entry
→ execution_backend: "derived_subclass"
→ strategy_ref uses "source_file" (NOT "file_path")
→ facts is REQUIRED — without it, 0 variants are generated
→ MUST include pair, timeframe, patch_families in each seed entry
```

### Adhoc vs Scheduled Execution

**Adhoc (user message: "Research {archetype}")** — runs in the message container.
1. Check triage matrix for winners/candidates
2. Run WF if needed, compute favorable_sharpe
3. If >= 0.5: deploy paper bot, create campaign
4. Reply: "Paper bot deployed for {strategy} on {pair}/{tf}. Tracking in auto-mode."
5. Exit. Auto-mode handles ongoing validation.

**Scheduled (daily planner)** — runs in the task container.
Full 5-step cycle. Can run hyperopt inline (task container has time).

### Anti-Patterns

1. **Never deploy live capital.** The planner deploys PAPER bots only. Auto-mode handles live.
2. **Never re-score cells.** Read market-timing's cell-grid-latest.json.
3. **Never overspend budget.** If weekly budget is exhausted, queue candidates.
4. **Never skip walk-forward.** Even if in-sample metrics look amazing.
5. **Never skip pre-flight validation.** A broken strategy wastes a paper bot slot for days.
6. **Never deploy with favorable_sharpe < 0.5.** This is the hard threshold.
7. **Never poll swarm inline from a message container.** Adhoc research deploys and exits.

### Feed Integration

After daily planning cycle:
  agent_post_status(
    status: "Daily plan: {paper_bots}/20 paper bots, {graduated} graduated,
      {retired} retired. Pipeline: {tested} triaged → {paper} paper → {grad} graduated",
    tags: ["research", "decision"],
    context: { paper_bots, graduated, retired, tested, available }
  )

After campaign state change:
  agent_post_status(
    status: "Campaign {id}: {old_state} → {new_state} — {reason}",
    tags: ["research"],
    context: { campaign_id, strategy, archetype, pair, state, reason }
  )

### Signal Check Before Research

Before creating a new research campaign:

1. Call signal_catalog_query(archetype={target}, pair={target_pair})
2. If quality signals exist (wf_sharpe >= 0.5, subscribers >= 3):
   - Log: "Signal available for {archetype} on {pair} — deferring research"
   - Do NOT create campaign
3. If no quality signals exist:
   - Create campaign as normal

### Scheduled Execution

Task schedule: `0 3 * * *` (daily 03:00 UTC)
Task prompt: "Run research planner daily cycle"

The 4-hourly poll is no longer needed — auto-mode's 15-minute health
check handles paper bot validation, graduation, and retirement.
