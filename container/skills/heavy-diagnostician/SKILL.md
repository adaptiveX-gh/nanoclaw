---
name: heavy-diagnostician
description: >
  Diagnose why a FreqTrade strategy failed or degraded via parallel diagnostic lenses + sequential verdict.
  Use this skill when a strategy has failed a backtest, failed walk-forward OOS testing, degraded in live/paper
  trading, or been routed to kata with a vague obstacle. Trigger on: "why did this fail", "diagnose this strategy",
  "what's wrong with", "backtest failed", "strategy degraded", "figure out the obstacle", kata routing with
  unknown obstacle. Do NOT trigger for strategy ideation (that's heavy-strategist), parameter optimization
  (that's Hyperopt), or live signal decisions.
---

# Heavy Diagnostician — Failure Analysis Skill

## Purpose

Failure routing in freqtrade-agents currently classifies ~70% of failures via four named obstacles
(`risk_reward_ratio`, `entry_quality`, `regime_dependent`, `overfit_decay`) and a four-pattern WFO classifier.
The remaining ~30% reaches kata with a vague or incorrect obstacle, causing wasted optimization cycles.

This skill replaces single-pass obstacle classification with **parallel diagnostic lenses + sequential verdict**
specialized for strategy post-mortems. Unlike heavy-strategist (which generates ideas), the diagnostician
receives **specific failure data** and must classify it.

Output is a **diagnosis packet**: primary obstacle, optional secondary obstacle, fix prescription, verification
metric, and routing decision. This is consumed by the kata harness, not by the user directly.

## When to Activate

Activate when **any** of the following are true:
- A strategy has been routed to kata but the obstacle field is empty, `unknown`, or `entry_quality` by default
- A strategy has failed walk-forward OOS testing and the failure pattern is unclear
- Monitor has classified an obstacle but the kata fix made things worse (possible misdiagnosis)
- A strategy shows contradictory signals (high win rate AND negative P&L AND low trade count simultaneously)
- A live/paper strategy was paused and the root cause is disputed between strategy failure and execution failure

Do **not** activate for:
- New archetype generation → use `heavy-strategist`
- Parameter tuning on a correctly-diagnosed strategy → use Hyperopt directly
- Portfolio-level failures → use monitor-portfolio skill
- Strategies with fewer than 5 trades — return `undiagnosable` immediately, do not run lenses

## Failure Taxonomy

Nine output classifications. The first four are compatible with existing monitor/kata obstacle strings.
The new five extend coverage into the previously unclassified 30%.

```
exit_quality          — win rate > 45%, P&L negative
                        Exits destroy entries; wins too small, losers run too long.
                        Verification metric: avg_win / avg_loss ratio (target: > 1.5)

entry_quality         — win rate < 30%
                        Entry logic wrong for current conditions; catching falling knives.
                        Verification metric: win rate after adding trend filter (target: > 35%)

regime_incompatible   — fails hard in ≥1 regime, acceptable in others
                        Sub-classified as: anti_regime | session_bound | volatility_band
                        Verification metric: per-regime win rate split (target: failing regime isolated)

overfit_decay         — Sharpe degrades monotonically across WFO windows
                        Strategy was tuned to early data; generalizes poorly.
                        Verification metric: WFO window Sharpe spread (target: < 0.5 std dev across windows)

parameter_brittleness — passes WFO but fails sensitivity sweep; parameters are fragile
                        Different from overfit_decay: the strategy structure is sound but params
                        sit on a cliff edge — small perturbations collapse performance.
                        Verification metric: 10% param perturbation retains ≥ 70% of base Sharpe

execution_drag        — strategy simulation metrics are fine; live fill quality degrades P&L
                        Slippage, spread, or fill rate is the actual root cause, not entry/exit logic.
                        Verification metric: replay backtest with realistic slippage model; Sharpe holds

signal_drought        — 0 or near-zero trades; entry conditions rarely or never fire
                        Sub-classified as:
                          logic_error       — conditions mathematically contradict (RSI < 20 AND RSI > 30)
                          threshold_too_tight — conditions possible but extremely rare given current regime
                          regime_blocked    — conditions were valid historically but current regime breaks them
                        Verification metric: condition fire rate per 1000 candles (target: > 2/day on target TF)

correlation_cluster   — win rate acceptable but losses cluster; consecutive loss runs distort true Sharpe
                        Individual trade statistics look fine; temporal structure reveals hidden risk.
                        Verification metric: max consecutive loss run vs. binomial expectation (p < 0.05 = flag)

undiagnosable         — insufficient trade count, data quality issues, or contradictory signals
                        Not a failure of the diagnostician — a data requirement that must be satisfied first.
                        Returns: minimum data requirements to enable diagnosis.
```

## Execution Protocol

### Pre-flight: Data Requirements Check

Before spawning any lenses, verify minimum data is present:

```
Required inputs:
  - backtest_results or live_trade_log (at minimum: trade list with entry/exit timestamps, P&L, direction)
  - strategy_config (indicators used, entry/exit conditions, stoploss, ROI table)
  - wfo_window_results (if available: per-window Sharpe, trade count, win rate)
  - regime_labels (if available: regime per candle or per trade)

Minimum trade count: 5 completed trades
Recommended for reliable diagnosis: ≥ 20 completed trades

If trade count < 5: return undiagnosable immediately.
  Include: { min_trades_needed: 5, current_count: N, recommendation: "collect_more_data" }
If wfo_window_results missing: lenses 3 and 5 will operate in degraded mode (flag in output).
If regime_labels missing: lens 2 will operate in degraded mode (flag in output).
```

### Stage 1: Spawn K=5 Parallel Diagnostic Lenses

Each lens receives the same failure data but examines a **different failure surface**. Run all five in parallel.
Lenses must not see each other's intermediate output.

The five lenses (do not deviate, do not collapse two into one):

**Lens 1 — Signal Quality**
Focus: Entry/exit separation. Does the entry logic find real edge, or do exits destroy it?

```
You are a quantitative analyst examining entry/exit separation.
Your only job is to determine whether the strategy's losses come from
bad entries or bad exits. Do NOT speculate about regime or parameter issues.

Data provided: {trade_list, strategy_config}

Analyze:
1. Entry accuracy: of all entries, what fraction were "correct" (price moved
   in predicted direction within 2× the stoploss distance before touching stoploss)?
2. Exit efficiency: for winning trades, what fraction of the available move was captured?
   For losing trades, were they stopped out at stoploss, or did they run past it?
3. Asymmetry check: compute avg_win / avg_loss. If < 1.0, exits are the problem.
   If avg_win / avg_loss > 1.5 but win_rate < 30%, entries are the problem.
4. Worst 5 trades: what did they have in common? Same direction? Same time of day?
   Same indicator state at entry?

Output:
- primary_suspect: "entries" | "exits" | "both" | "neither"
- evidence: 3-5 bullet points from the data (not narrative)
- confidence: 0.0–1.0 (how clean is the signal in the data?)
- degraded: true if trade count < 20 (flag only, do not omit analysis)
```

**Lens 2 — Regime Fit**
Focus: Per-regime performance cards. Which regime kills this strategy, and why?

```
You are a regime analyst examining strategy performance across market conditions.
Your only job is to determine whether failures are regime-conditional.
Do NOT speculate about entry/exit quality or parameter issues.

Data provided: {trade_list, regime_labels (if available), wfo_window_results (if available)}

Analyze:
1. If regime_labels available: compute win_rate, avg_pnl, trade_count per regime.
   Flag any regime where win_rate < 20% or avg_pnl < -1%.
2. If wfo_window_results available: classify each window as
   CONSISTENT (all positive), DEGRADING (monotone decline), ALTERNATING (zigzag),
   or SINGLE_SPIKE (one outlier window).
3. If neither is available: examine trade timestamps and look for temporal clustering
   of losses (same week? same month? post-volatility-event?).
4. Anti-regime check: does the strategy have declared anti_regimes in its config?
   Were any of the failing trades entered during an anti_regime?

Output:
- pattern: "CONSISTENT" | "DEGRADING" | "ALTERNATING" | "SINGLE_SPIKE" | "REGIME_CONDITIONAL" | "UNCLEAR"
- failing_regime: regime name or time period where failures concentrate (null if not determinable)
- sub_class: "anti_regime" | "session_bound" | "volatility_band" | null
- evidence: 3-5 bullet points
- confidence: 0.0–1.0
- degraded: true if regime_labels missing (flag only)
```

**Lens 3 — Parameter Sensitivity**
Focus: Are the parameters on a cliff edge? Would slight perturbation collapse performance?

```
You are a robustness analyst examining parameter sensitivity.
Your only job is to determine whether the strategy's parameters are
genuinely robust or sitting at a fragile optimum.
Do NOT speculate about entry/exit quality or regime fit.

Data provided: {strategy_config, wfo_window_results (if available), backtest_results}

Analyze:
1. Parameter count: how many free parameters does the strategy expose?
   If > 8, flag as high overfit risk regardless of other metrics.
2. If wfo_window_results available: does performance vary strongly across windows
   that used similar parameter sets? (Indicator of parameter cliff)
3. Edge concentration: does the P&L come from many small wins distributed across
   time, or from a few large wins in one window? Concentrated edge = parameter risk.
4. Indicator redundancy: do any two indicators in the entry logic measure
   the same underlying thing (e.g., RSI + Stochastic)? Redundancy amplifies
   param sensitivity without adding information.
5. Stoploss/ROI table: are the stoploss and ROI values suspiciously "round"
   (e.g., exactly -3%, exactly +1%)? Round values from Hyperopt often indicate
   parameter space boundary effects.

Output:
- brittleness_risk: "low" | "medium" | "high"
- param_count: integer
- evidence: 3-5 bullet points
- confidence: 0.0–1.0
- degraded: true if wfo_window_results missing
```

**Lens 4 — Execution Realism**
Focus: Is this a venue/execution problem, not a strategy problem?

```
You are an execution analyst examining whether live trading conditions
explain the failure, independent of strategy logic.
Do NOT speculate about entry/exit quality, regime fit, or parameter issues.

Data provided: {trade_list (with slippage and fill data if available), strategy_config}

Analyze:
1. Slippage impact: if slippage data is available, compute total slippage as
   % of total P&L. If > 20%, execution is a primary suspect.
2. Signal frequency: how many trades per day does the strategy produce?
   If < 1 trade/week on its target timeframe, the signal is too infrequent
   to be practically deployable regardless of Sharpe.
3. Fill rate: if fill data available, what fraction of signals were filled
   within 1 candle? Low fill rate on fast timeframes = strategy can't execute.
4. Spread sensitivity: for the target pair, is the avg_win large enough
   to absorb spread + slippage with margin remaining? Compute:
   min_viable_avg_win = 2 × avg_spread + avg_slippage
   If avg_win < min_viable_avg_win: execution drag is structural.
5. Venue mismatch: does the strategy's position size vs. the pair's typical
   daily volume create meaningful market impact?

Output:
- execution_suspect: true | false
- signal_frequency: trades_per_day (float)
- slippage_pnl_ratio: float | null (if no slippage data)
- evidence: 3-5 bullet points
- confidence: 0.0–1.0 (lower if no live fill data available)
- degraded: true if no slippage or fill data (flag only)
```

**Lens 5 — WFO Structure**
Focus: Walk-forward pattern reveals the failure's temporal signature.

```
You are a walk-forward analyst examining the temporal structure of the strategy's failure.
Your only job is to determine whether the failure pattern in WFO reveals
overfitting, regime dependence, or single-spike luck.
Do NOT speculate about entry/exit quality, parameter sensitivity, or execution.

Data provided: {wfo_window_results (required), backtest_results}

Analyze:
1. Window-by-window Sharpe: plot the trajectory (mentally). Is it:
   CONSISTENT: all windows positive and similar magnitude
   DEGRADING: monotone decline (most recent window worst)
   ALTERNATING: positive/negative/positive/negative pattern
   SINGLE_SPIKE: one outlier window dominates total Sharpe
2. Trade count per window: is it stable? Sudden drought in later windows
   = regime shift, not overfitting.
3. In-sample vs OOS gap: for each window, is the OOS Sharpe consistently
   below IS Sharpe by a large margin? IS/OOS ratio < 0.5 = heavy overfit.
4. Failure window characteristics: which window has the worst performance?
   What was the approximate market condition during that window?
   (Use date range to infer: 2024-01 = crypto bear, 2024-Q4 = bull, etc.)
5. Consistency metric: compute Sharpe std dev across windows.
   < 0.3 = consistent, 0.3–0.7 = noisy, > 0.7 = unreliable

Output:
- wfo_pattern: "CONSISTENT" | "DEGRADING" | "ALTERNATING" | "SINGLE_SPIKE" | "INSUFFICIENT_DATA"
- is_oos_gap: float | null (IS Sharpe / OOS Sharpe ratio)
- window_sharpe_stddev: float | null
- evidence: 3-5 bullet points
- confidence: 0.0–1.0
- degraded: true if wfo_window_results missing (return INSUFFICIENT_DATA)
```

### Stage 2: Serialize the Lens Cache

Collect five lens outputs. **Strip strategy name and archetype identity** before passing to deliberator.
The deliberator sees metrics and evidence, not "this is a MEAN_REVERSION strategy on BTC/USDT."
Removing identity prevents the deliberator from pattern-matching the strategy type to known failure modes
rather than reading the actual evidence.

```
# ====== Failure Data Summary ======
Trade count: {N}
Win rate: {pct}
Avg win: {val}  Avg loss: {val}
Max DD: {val}
Total P&L: {val}
WFO windows available: {yes/no}
Regime labels available: {yes/no}
Live slippage data available: {yes/no}

# ====== Lens Outputs ======
## Lens 1 (Signal Quality)
[lens output]

## Lens 2 (Regime Fit)
[lens output]

## Lens 3 (Parameter Sensitivity)
[lens output]

## Lens 4 (Execution Realism)
[lens output]

## Lens 5 (WFO Structure)
[lens output]
```

### Stage 3: Sequential Deliberation

The deliberator's job is classification and routing — not narrative synthesis. Use this prompt verbatim:

```
You are the senior failure analyst reviewing five independent diagnostic lens outputs.
Your job is NOT to write a coherent story about why this strategy failed.
Your job is to classify the failure mode and produce a routing decision
with a specific, falsifiable verification metric.

# ====== Failure Data Summary ======
{summary}

# ====== Lens Outputs ======
{serialized_lens_outputs}

# ====== Deliberation Protocol ======

Step 1 — Evidence inventory.
For each lens, restate its primary finding in one sentence and its confidence level.
Downweight lenses that returned degraded: true (still consider them, but discount).
Flag any lens where confidence < 0.4 — this lens provides weak signal.

Step 2 — Cross-lens consistency check.
Are the lenses telling a consistent story, or do they contradict?
  - Consistent high-win-rate + negative P&L from lens 1 AND clean WFO pattern from lens 5
    → strong signal for exit_quality
  - Low win rate from lens 1 AND alternating WFO from lens 5 AND regime failure from lens 2
    → strong signal for regime_incompatible
  - Clean lens 1 + clean lens 2 + high brittleness from lens 3 + degrading WFO from lens 5
    → strong signal for parameter_brittleness
  - Everything looks fine in simulation lenses BUT execution drag from lens 4
    → strong signal for execution_drag
  - All lenses show 0 or near-0 trades → signal_drought (sub-classify from lens 1 entry analysis)
  - Contradictory signals across lenses → potential correlation_cluster or undiagnosable

Step 3 — Anti-plausibility checks.
Reject or downweight any classification that:
  (a) is supported by only one lens with confidence < 0.6
  (b) requires assuming data that isn't present
  (c) contradicts the raw trade statistics (e.g., classifying exit_quality when avg_win > avg_loss)
  (d) all five lenses converged on — unanimous agreement on a diagnosis from lenses
      that examine different surfaces is suspicious; verify it isn't a tautology

Step 4 — Produce the diagnosis packet.
Classify into exactly ONE primary obstacle from the taxonomy.
May name ONE secondary obstacle if evidence supports it.

If no classification has strong support across multiple lenses: return undiagnosable.
  Include: { missing_data: [...], min_additional_trades: N }
  This is the correct output when evidence is insufficient — never force a classification.

# ====== Required Output Format ======

## Diagnosis

**Primary obstacle:** {obstacle_name}
**Secondary obstacle:** {obstacle_name | none}
**Confidence:** {0.0–1.0}

**Evidence summary:** (3-5 bullet points citing specific lens findings, not narrative)

**Verification metric:**
{The specific number that should change in kata if this diagnosis is correct.
 Must be measurable and specific. Examples:
 - "avg_win / avg_loss should rise above 1.5 after tightening stoploss by 30%"
 - "win rate in regime X should rise above 35% after adding ADX filter"
 - "10% perturbation of ema_period should retain ≥ 70% of base Sharpe"
 No vague metrics: "performance should improve" is not acceptable.}

**Fix prescription:**
{1-3 concrete changes to the strategy config or kata obstacle routing.
 Each change maps to the primary obstacle.
 Do NOT prescribe changes that address the secondary obstacle first.}

**Routing decision:**
{Exactly one of:
  kata(obstacle={obstacle_name})             — route to kata with classified obstacle
  kata(simplify_first)                        — parameter_brittleness: simplify before reoptimizing
  venue_audit                                 — execution_drag: investigate slippage/venue before kata
  collect_more_data(min_trades={N})           — undiagnosable: wait for more data
  retire                                      — failure not fixable within current archetype scope}

**Synthesis notes:**
- Which lenses contributed (1/2/3/4/5 → which finding)
- Which lenses were discounted and why
- One specific condition that would change this diagnosis
  (e.g., "if slippage data shows < 5% impact, execution_drag is ruled out")
```

### Stage 4: Verification Loop (Optional, Triggered by Kata)

If kata runs with the prescribed fix and performance does not improve:

1. Take original five lens outputs + diagnosis packet + kata results
2. Add a sixth "empirical" lens containing kata's actual results:
   - What changed? What didn't?
   - Does the verification metric confirm or deny the original diagnosis?
3. Re-run Stage 3 deliberation with updated cache
4. If still unresolved after one iteration: classify as `undiagnosable` — the failure requires
   more data collection, not more diagnosis. Do not iterate further.

Cap at **N=1 iteration**. A diagnosis that requires two full kata cycles to validate is either
wrong or diagnosing the wrong level of failure.

## What This Skill Is NOT

- **Not a strategy improver.** It classifies failures. Fixing the classified failure is kata's job.
- **Not a replacement for kata.** The diagnosis is a hypothesis — kata provides the ground truth.
- **Not applicable to portfolio-level failures.** If multiple strategies fail simultaneously,
  that's a regime event, not individual strategy failure — use monitor-portfolio.
- **Not a substitute for having enough data.** Five trades is the minimum; twenty is the floor
  for reliable diagnosis. `undiagnosable` is the correct output, not a workaround.

## Failure Modes of This Skill

1. **Lens collusion.** All five lenses see the same surface signal (e.g., low win rate) and
   converge on `entry_quality` without examining the other surfaces. Step 3e checks for this.
   If unanimous: audit that each lens actually examined its specific failure surface.

2. **Identity bias.** The deliberator sees the strategy name or archetype type and applies
   known-archetype failure patterns rather than reading the evidence. Strip identity in Stage 2.

3. **Forcing classification on insufficient data.** Trade count < 10 with high variance statistics
   will produce spurious lens outputs. Pre-flight check enforces the minimum; if it was bypassed,
   the deliberator must still return `undiagnosable`.

4. **Misrouting execution failures to kata.** If execution_drag is the primary obstacle,
   routing to kata with any obstacle will produce false fixes (kata optimizes strategy logic,
   not execution venue). `venue_audit` routing exists for this reason — use it.

5. **Secondary obstacle shadowing primary.** Real failures often have two causes; the fix
   prescription must target primary first. Addressing secondary first risks fixing the wrong
   thing and burning a kata run.

## Integration With freqtrade-agents

- **Upstream callers:** monitor-health (Trigger F, Trigger J), strategyzer (pre-kata routing),
  kata-bridge (when obstacle is unclear after round 1)
- **Downstream consumer:** kata-agent (receives routing decision + obstacle)
- **Verifier:** kata WFO results vs. verification metric from diagnosis packet
- **RLVR signal source:** (diagnosis packet, kata outcome, verification metric delta) tuples

## Obstacle String Compatibility

The following obstacle strings produced by this skill are compatible with kata-bridge's
existing obstacle handling:

| Diagnosis Output    | kata-bridge obstacle string |
|---------------------|-----------------------------|
| exit_quality        | `risk_reward_ratio`         |
| entry_quality       | `entry_quality`             |
| regime_incompatible | `regime_dependent`          |
| overfit_decay       | `overfit_decay`             |
| parameter_brittleness | `overfit_decay` + `simplify_first` flag |
| execution_drag      | routes to `venue_audit`, NOT kata |
| signal_drought      | `entry_quality` with sub_class in notes |
| correlation_cluster | `risk_reward_ratio` with correlation note |
| undiagnosable       | does not route to kata |
