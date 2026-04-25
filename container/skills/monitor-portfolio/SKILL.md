---
name: monitor-portfolio
description: >
  Daily portfolio analysis. Runs at 00:00 UTC: computes portfolio
  correlation, regime transition frequencies (weekly), tail risk CVaR,
  portfolio diagnosis, competition benchmark scorecard, experiment
  ledger review, and daily briefing. Part of the split monitor pipeline
  (see also: monitor-health, monitor-deploy, monitor-kata).
  Trigger on: "portfolio analysis", "daily rollup", "portfolio health",
  "competition scorecard", "monitor portfolio", "daily briefing".
---

# Monitor — Portfolio Analysis (Steps 8-8d + Daily Rollup)

Computes portfolio-level metrics, risk analysis, and daily operational
summaries. Runs daily at 00:00 UTC — independent from the 15-minute
health checks and 30-minute deployment cycles.

**This skill does NOT check bot health, deploy bots, or manage signals.**
Those responsibilities belong to monitor-health and monitor-deploy.

## Dependencies

| Skill | Purpose |
|-------|---------|
| `freqtrade-mcp` | `compute_portfolio_cvar` MCP tool |
| `aphexdata` | Audit trail |
| `experiment-ledger` | Experiment resolution procedure |

Files read:
- `auto-mode/campaigns.json` — bot metrics, P&L data
- `auto-mode/portfolio-correlation.json` — historical daily returns
- `auto-mode/market-prior.json` — regime tick history
- `auto-mode/portfolio.json` — existing risk state
- `auto-mode/portfolio-risk.json` — tail contribution data
- `auto-mode/competition-state.json` — competition mode state
- `auto-mode/experiment-ledger.jsonl` — open experiments
- `scoring-config.json` — TAIL_RISK, SLOT_MANAGEMENT config
- `knowledge/live-attribution-rollup.json` — attribution data

Files written:
- `auto-mode/portfolio-correlation.json` — updated correlation data
- `auto-mode/regime-transitions.json` — transition probabilities
- `auto-mode/portfolio.json` — tail risk + risk scaling
- `auto-mode/portfolio-risk.json` — tail contribution breakdown
- `reports/portfolio-audit.json` — diagnosis results
- `auto-mode/competition-state.json` — daily snapshots
- `auto-mode/experiment-ledger.jsonl` — resolved experiments
- `reports/briefings/YYYY-MM-DD.md` — daily briefing
- `auto-mode/tick-log.jsonl` — step trace (append)

## Console Sync — Mandatory

After writing any state file, sync to Supabase:

| File | state_key |
|------|-----------|
| `portfolio-correlation.json` | `portfolio_correlation` |
| `regime-transitions.json` | `regime_transitions` |
| `campaigns.json` | `campaigns` |

### Step 8: PORTFOLIO CORRELATION (daily at 00:00 only)

Skip unless current hour == 0 AND last_correlation_update was yesterday.

When 3+ bots have run concurrently for 7+ days:

1. **RECORD**: For each active bot, record today's P&L % in
   `/workspace/group/auto-mode/portfolio-correlation.json`
   under `daily_returns[date][strategy_name]`

2. **COMPUTE** (weekly): Pearson correlation between all strategy
   return series. Average pairwise correlation. Portfolio Sharpe:
   ```
   portfolio_sharpe = avg_sharpe × sqrt(N / (1 + (N-1) × avg_corr))
   estimated_return = portfolio_sharpe × 0.60
   ```

3. **STORE**:
   ```json
   {
     "daily_returns": { "2026-03-30": { "strat_a": 0.42 } },
     "correlation_matrix": { "strat_a|strat_b": 0.12 },
     "avg_pairwise_correlation": 0.12,
     "portfolio_sharpe_estimate": 1.15,
     "estimated_annual_return_pct": 69,
     "strategy_count": 5,
     "last_updated": "..."
   }
   ```
   `sync_state_to_supabase(state_key="portfolio_correlation", ...)`

4. **ALERT** if avg correlation > 0.30:
   "High correlation: {corr} across {n} strategies.
    Consider filling a different correlation group."

5. **WEEKLY SUMMARY** (Sunday):
   "Portfolio: {n} strategies, correlation {corr}, estimated
    Sharpe {ps}, projected return {ret}%. Target: 1.33 / 80%."
    tags: ["portfolio", "analysis"]

### Step 8b: REGIME TRANSITION FREQUENCIES (weekly, Sunday 00:00)

Skip unless current day == Sunday AND last_transition_update was last week.

Compute from market-prior.json tick history (106+ ticks logged):

For each pair and timeframe, count regime transitions:
  For each tick where regime changed from A to B:
    increment transitions[pair][tf][A→B]

Build a transition probability table:
  P(next_regime | current_regime, pair, tf) =
    count(current→next) / count(current→any)

Store in /workspace/group/auto-mode/regime-transitions.json:
  ```json
  {
    "BTC/USDT:USDT": {
      "4h": {
        "TRANQUIL": {
          "→ TRANQUIL": 0.55,
          "→ COMPRESSION": 0.20,
          "→ EFFICIENT_TREND": 0.20,
          "→ CHAOS": 0.05,
          "sample_size": 40
        },
        "EFFICIENT_TREND": {
          "→ EFFICIENT_TREND": 0.60,
          "→ TRANQUIL": 0.25,
          "→ COMPRESSION": 0.10,
          "→ CHAOS": 0.05,
          "sample_size": 35
        }
      }
    },
    "last_updated": "2026-04-06T00:00:00Z"
  }
  ```

sync_state_to_supabase(state_key="regime_transitions", ...)

### Step 8c: PORTFOLIO TAIL RISK (daily, same cadence as Step 8)

Skip unless Step 8 ran this tick (current hour == 0, daily_returns updated).

Compute CVaR (Expected Shortfall) and update portfolio risk state. This is
non-blocking — if the MCP tool is unavailable or fails, the existing
portfolio state continues unchanged.

```
cfg = scoring_config.get("TAIL_RISK", {})
if not cfg:
    skip  # TAIL_RISK config block not present

result = compute_portfolio_cvar(
    workspace_dir=<workspace_root>,
    alpha=cfg.get("alpha", 0.975),
    lookback_days=cfg.get("lookback_days", 365),
    estimator=cfg.get("estimator", "ew_hist"),
    target_cvar_daily_pct=cfg.get("target_cvar_daily_pct", 1.5),
    smoothing_halflife_days=cfg.get("smoothing_halflife_days", 7),
    multiplier_min=cfg.get("multiplier_min", 0.25),
    multiplier_max=cfg.get("multiplier_max", 1.0),
    shadow_mode=cfg.get("shadow_mode", true),
    write_state=true,
)

# The tool writes:
#   auto-mode/portfolio.json  → tail_risk{} + risk_scaling{} blocks
#   auto-mode/portfolio-risk.json → tail contribution breakdown

Log: "Tail risk: CVaR={result.cvar_daily_pct}% (α={result.alpha}),
      m={result.multiplier} ({result.mode}),
      confidence={result.confidence},
      top_contributor={result.top_tail_contributor}"
```

**Risk-off gating** (when `shadow_mode == false`):

When the risk multiplier falls below the deploy gate threshold, block
new trial deployments to avoid adding risk during stressed periods.

```
portfolio = read("auto-mode/portfolio.json")
m = portfolio.risk_scaling?.multiplier ?? 1.0
shadow = portfolio.risk_scaling?.shadow_mode ?? true

if !shadow AND m < cfg.deploy_gate_multiplier_threshold:
    Log: "RISK-OFF: m={m} < {threshold} — blocking new trial deployments"
    Skip Step 6 trial deployment this tick
```

This interacts with the circuit breaker:
- Circuit breaker (15% DD) → halts ALL activity (binary, reactive)
- CVaR risk-off (m < 0.60) → blocks new trial deployments only (continuous, pre-emptive)
- CVaR scaling (0.60 ≤ m < 1.0) → existing bots continue but nanoclaw scales suggested_stake_pct

### Step 8d: PORTFOLIO DIAGNOSIS (daily, same cadence as Step 8)

Skip unless Step 8c ran this tick (daily, after CVaR computation).

Level 3 Discover — diagnose portfolio allocation problems using the
tail risk data from Step 8c and live attribution data. This is the
sensor that triggers portfolio kata (Level 3 Improve) when allocation
rules are drifting from optimal.

```
portfolio_risk = read("auto-mode/portfolio-risk.json")
portfolio = read("auto-mode/portfolio.json")
rollup = read("knowledge/live-attribution-rollup.json")
campaigns = read("auto-mode/campaigns.json")
scoring_config = read("scoring-config.json")

issues = []

# 1. Concentration risk: any single strategy > 40% of tail risk
if portfolio_risk.tail_contrib.by_strategy exists:
  for strategy, share in portfolio_risk.tail_contrib.by_strategy:
    if share > 0.40:
      issues.append({
        type: "concentration_risk",
        entity: strategy,
        value: share,
        threshold: 0.40,
        severity: "high" if share > 0.60 else "medium"
      })

# 2. Group imbalance: correlation group targets not met
group_targets = scoring_config.SLOT_MANAGEMENT.group_targets
  ?? {trend: 3, range: 3, vol: 2, carry: 1}
active_by_group = count campaigns with slot_state in {"trial","graduated"}
  grouped by correlation_group
for group, target in group_targets:
  actual = active_by_group.get(group, 0)
  if actual == 0 and target > 0:
    issues.append({
      type: "group_imbalance",
      group: group,
      actual: 0,
      target: target,
      severity: "high"
    })
  elif actual < target * 0.5:
    issues.append({
      type: "group_imbalance",
      group: group,
      actual: actual,
      target: target,
      severity: "medium"
    })

# 3. Risk parity drift: actual allocation weights vs equal-risk target
if len(active_campaigns) >= 4:
  # Compute actual weights (by stake allocation)
  # Compute equal-risk weights (inverse volatility)
  # drift = mean absolute deviation between actual and target
  if drift > 0.15:
    issues.append({
      type: "risk_parity_drift",
      drift: drift,
      threshold: 0.15,
      severity: "medium"
    })

# 4. Archetype over-allocation
archetype_counts = count active campaigns by archetype
max_per_arch = scoring_config.PORTFOLIO_CONSTRAINTS.max_per_archetype ?? 5
for arch, count in archetype_counts:
  if count > max_per_arch * 0.8:
    issues.append({
      type: "archetype_over_allocation",
      archetype: arch,
      count: count,
      limit: max_per_arch,
      severity: "low"
    })

# Compute portfolio health score
high_severity = len([i for i in issues if i.severity == "high"])
medium_severity = len([i for i in issues if i.severity == "medium"])
portfolio_health_score = max(0, 1.0 - (high_severity * 0.20) - (medium_severity * 0.10))

Write reports/portfolio-audit.json:
  {
    last_audit: now_utc,
    issues: issues,
    portfolio_health_score: portfolio_health_score,
    portfolio_kata_recommended: portfolio_health_score < 0.60,
    n_active_bots: len(active_campaigns),
    group_coverage: {group: count for group, count in active_by_group}
  }

If portfolio_health_score < 0.60:
  Log: "PORTFOLIO HEALTH LOW: score={score}, {n} issues detected.
        Portfolio kata recommended."
```

sync_state_to_supabase(state_key="portfolio_audit", ...)

## Daily Rollup — Competition Benchmark + Experiment Ledger

**Competition Benchmark (daily, only when competition mode active):**

```
competition_state = read auto-mode/competition-state.json
if competition_state exists AND competition_state.active == true:

  # 1. BTC benchmark
  btc_start_price = competition_state.benchmark.start_price
  btc_current_price = fetch current BTC/USDT price via exchange API
  btc_return_pct = ((btc_current_price - btc_start_price) / btc_start_price) * 100

  # 2. Portfolio return
  # Sum paper trading P&L across all active bots (from campaign paper_pnl data)
  portfolio_return_pct = sum of all bot P&L as % of starting capital

  # 3. Alpha
  alpha_pct = portfolio_return_pct - btc_return_pct

  # 4. Reflect on Last Step (Toyota Kata)
  kata = competition_state.kata
  reflection = {
    last_step: kata.last_step,
    expected: kata.last_step_expected,
    actual: kata.last_step_actual,    # <-- update this with today's observation
    learned: kata.last_step_learned   # <-- update this with today's learning
  }

  # 5. Five Questions
  # Q1: Target Condition — read from kata.current_target_condition
  # Q2: Actual Condition — the alpha and slot data computed above
  # Q3: Obstacles — identify from portfolio diagnosis, group coverage,
  #     underperforming bots, regime mismatches
  # Q4: Next Step — the single action to take (rotate, deploy, retire, kata race)
  # Q5: How quickly learn — next daily rollup (24h) or next monitor tick

  # 6. Append daily snapshot
  snapshot = {
    date: today_iso,
    btc_price: btc_current_price,
    btc_return_pct: btc_return_pct,
    portfolio_return_pct: portfolio_return_pct,
    alpha_pct: alpha_pct,
    slot_utilization: "{filled}/{max}",
    target_condition: kata.current_target_condition,
    obstacle_addressed: "<identified obstacle>",
    next_step: "<planned next step>"
  }
  competition_state.benchmark.daily_snapshots.append(snapshot)

  # 7. Update kata state with today's decisions
  competition_state.kata.last_step = snapshot.next_step
  competition_state.kata.last_step_expected = "<expected outcome>"
  # (actual + learned are filled at NEXT daily rollup via reflection)

  write competition_state to auto-mode/competition-state.json

  # 8. Message output (add to daily summary)
  message:
  """
  ## Competition Scorecard — {date}

  | Metric | Value |
  |--------|-------|
  | Portfolio Return | {portfolio_return_pct:+.2f}% |
  | BTC Buy & Hold   | {btc_return_pct:+.2f}% |
  | **Alpha**        | **{alpha_pct:+.2f}%** |
  | Slots            | {filled}/{max} |
  | Day              | {days_since_start} of {total_days} |

  ### Reflect on Last Step
  - **Step:** {kata.last_step}
  - **Expected:** {kata.last_step_expected}
  - **Actual:** {observed outcome}
  - **Learned:** {key insight}

  ### Five Questions
  1. **Target:** {kata.current_target_condition}
  2. **Actual:** Alpha {alpha_pct:+.2f}%
  3. **Obstacle:** {identified obstacle}
  4. **Next Step:** {planned action} — expect: {expected outcome}
  5. **Learn by:** Next daily rollup (24h)
  """

  # 9. Review open experiments (experiment-ledger integration)
  ledger = read auto-mode/experiment-ledger.jsonl (create empty if missing)
  overdue = [e for e in ledger
             if e.outcome is null AND e.review_after <= now]
  for exp in overdue:
    # Compute outcome DETERMINISTICALLY from observed metrics
    # Parse falsifier thresholds, compare to current state
    # outcome = "CONFIRMED: ..." or "FALSIFIED: ..." with numeric proof
    # inference = agent prose about what to learn
    # Append resolution row to ledger
    # Update kata.last_step_actual and kata.last_step_learned
    # See experiment-ledger skill for full procedure

  # 10. Write briefing file (audit trail)
  briefing_path = reports/briefings/{YYYY-MM-DD}.md
  write briefing_path:
  """
  # Briefing — {date}

  Alpha: {alpha_pct:+.1f}% | Portfolio: {portfolio_return_pct:+.1f}% | BTC: {btc_return_pct:+.1f}%
  Slots: {filled}/{max} | Day {days_since_start} of {total_days}

  ## Target Condition
  {kata.current_target_condition}

  ## Strategy Health
  {for each bot: "- {name}: {trades} trades, {pnl:+.1f}%, {status}"}

  ## Flags
  {any alerts, DD warnings, regime shifts, or "None"}

  ## Open Experiments
  {for each open exp: "- {id}: \"{hypothesis}\" — review due {review_after}"}
  {if overdue resolved this tick: "- {id}: {outcome}"}

  ## Prediction Accuracy
  {confirmed}/{total} resolved ({pct}% accuracy)
  """
```

If alpha is negative for 3+ consecutive days, flag as urgent and
auto-route to kata-bridge with target_type="portfolio" — do NOT
recommend, execute the rebalance autonomously. In competition mode
the agent acts, it does not ask.

**Competition autonomy rule:** The Five Questions and kata decisions
in the daily rollup are ANSWERED by the agent, not posed to the user.
The agent sets target conditions, identifies obstacles, chooses next
steps, and executes them. The user reviews the scorecard after the fact.

## Epilogue — Sync and Log

After completing portfolio analysis:

1. Sync all modified files to Supabase:
   ```
   sync_state_to_supabase(state_key="portfolio_correlation", ...)
   sync_state_to_supabase(state_key="regime_transitions", ...)  # if Sunday
   sync_state_to_supabase(state_key="portfolio_audit", ...)
   ```

2. Append completion entry to tick-log:
   ```
   append to auto-mode/tick-log.jsonl:
     {"ts": now, "tick_id": null, "skill": "monitor-portfolio", "step": 8,
      "phase": "complete",
      "outcome": "portfolio_analysis_correlation_{corr}_cvar_{cvar}_health_{score}"}
   ```

3. Message user with daily summary including:
   - Portfolio Sharpe estimate and correlation
   - Competition scorecard (if active)
   - Any portfolio diagnosis issues
   - Daily briefing path
