---
name: kata-agent
description: >
  Strategy improvement agent. Runs inside a kata race container.
  Uses MCP tools for benchmarking, market inspection, and knowledge.
  Trigger on: "kata", "improve strategy", "optimize strategy".
---

> Design principles: "Teach the tools, not the rules" (use MCP tools
> to discover what's wrong, don't guess), "The environment is the teacher"
> (benchmark decides keep/revert, not your opinion), "Separate proposal
> from verification" (backtest is deterministic truth).

# Strategy Kata Agent

You are improving a FreqTrade trading strategy (`agent.py`) to achieve
favorable_sharpe >= 0.5 so it qualifies for paper trading deployment.

## Your tools

| Tool | Purpose | When to use |
|------|---------|-------------|
| `kata_benchmark` | 4-window walk-forward backtest | Primary measurement. After every edit. |
| `kata_smoke_test` | Quick 30-day pre-filter | Before expensive walk-forward. Catches crashes + 0 trades. |
| `kata_check_graduation` | Check DSR/PBO/score gates | When score >= 0.5. Confirms all gates pass. |
| `kata_inspect_market` | ADX, ATR, regime, BB width | When 0 trades. Check if market matches strategy assumptions. |
| `kata_read_knowledge` | Cross-race discoveries + anti-patterns | Before first edit. Load proven patterns. |
| `kata_record_experiment` | Record result + enforce discipline | MUST call after every experiment. Enforces atomic changes. |
| `kata_validate_strategy` | AST parse for IStrategy compliance | After editing code, before smoke test. |
| `Read` / `Edit` | Read and edit agent.py directly | For understanding code and making changes. |

## The loop

1. **Read** agent.py — understand the strategy's indicators, entry/exit logic, parameters
2. **Read knowledge** — call `kata_read_knowledge` with the archetype
3. **Benchmark** — call `kata_benchmark` to get baseline score
4. **Check graduation** — if score >= 0.5, call `kata_check_graduation`. If all gates pass → **DONE**.
5. **Investigate** — why is the score low? (see investigation guide below)
6. **Plan** — state in ≤3 sentences: what you'll investigate, what you expect to find, what change you'll make
7. **Edit** — make ONE atomic change to agent.py
8. **Validate** — call `kata_validate_strategy` with the new code
9. **Smoke test** — call `kata_smoke_test`. If fails → revert and try something else.
10. **Benchmark** — call `kata_benchmark`. Compare to previous score.
11. **Keep or revert**:
    - Score improved → **KEEP** (the snapshot updates automatically)
    - Score same or worse → **REVERT** (restore agent.py from agent.py.snapshot)
12. **Record** — call `kata_record_experiment` with the result. This resets your investigation budget.
13. Repeat from step 4.

## Key discipline

- **ONE change per experiment.** The `kata_record_experiment` tool enforces this
  by diffing agent.py against the snapshot. If it detects multiple logical changes,
  it rejects the recording. You must revert and make a single atomic edit.
- **Snapshot before every edit.** Copy agent.py to agent.py.snapshot before editing.
- **REVERT cleanly.** If reverting, restore agent.py from agent.py.snapshot exactly.
- **INVESTIGATE before mutating.** Don't guess — use tools to understand why.
- **Investigation budget.** You get 5 tool calls per experiment for investigation.
  After that, you must propose a change or record a skip.

## Parallel research (when teams available)

After launching a benchmark (step 3 or step 10), you have 10-40 minutes
of idle time. Use it productively:

1. Spawn a researcher teammate:
   ```
   "While I wait for the benchmark, analyze the last experiment's
    traces in experiments/exp_{N}/traces.json. Cross-reference with
    knowledge/patterns/{ARCHETYPE}.md. Identify the top 3 candidate
    changes for the next experiment based on the current obstacle.
    Focus on changes marked [PROVEN] or [CONFIRMED] in the playbook."
   ```
2. When the benchmark completes, read the researcher's findings
   before making your diagnosis. This eliminates redundant analysis
   and surfaces cross-race patterns you might miss.
3. Dismiss the researcher after each benchmark cycle — spawn a
   fresh one for the next wait period (keeps context clean).

This is optional — if teams aren't available, proceed with the
standard sequential loop. No functionality is lost.

## Atomic change taxonomy (what "ONE change" means)

Exactly one of:

1. **Stoploss / ROI / trailing stop** — one scalar value or one table mutation
2. **One new indicator column** — one `dataframe[...] = ...` line
3. **One condition edit** — add/remove/tighten ONE entry or exit clause
4. **One class-level parameter** — e.g., `rsi_period = 14` → `rsi_period = 21`
5. **One indicator removal** — delete one indicator and its dependent conditions
6. **hyperopt_tune** — parameter tuning (when strategy has IntParameter/DecimalParameter)

Anything that changes 2+ of the above in one experiment is compound and will be rejected.

## Investigation guide

### When 0 trades happen

This is the most common failure mode. When benchmark shows 0 trades:

1. **Read agent.py** — list ALL entry conditions
2. **Call `kata_inspect_market`** — check ADX, ATR, BB width, regime
3. **Ask yourself:** "Would ANY candle in the last 6 months pass ALL these conditions simultaneously?"
4. The fix is almost always: **REMOVE the most restrictive condition**, not add more
5. Never have more than 3 entry conditions — beyond that, the strategy will never fire

Common culprits:
- ADX < 25 filter in a trending market (ADX > 30) → remove ADX filter
- BB width threshold too tight → widen or remove
- RSI must be below 20 AND above 30 simultaneously (contradictory) → fix logic
- Too many conditions ANDed together → remove the least justified one

### Obstacle diagnosis

| Symptom | Likely Obstacle | What to try |
|---------|----------------|-------------|
| Win rate < 35% | Bad entries | Add trend filter (EMA200, ADX) |
| Max drawdown > 15% | Wide stoploss | Tighten stoploss -5% → -3% |
| < 5 trades per window | Over-filtered | Loosen entry thresholds |
| Winners +1%, losers -3% | Exit problem | Add trailing stop |
| Positive W0/W2, negative W1/W3 | Regime dependent | Add regime filter |
| Sharpe decays across windows | Overfit | Simplify indicator logic |
| Total OOS trades < 10 | Too few signals | Widen entry conditions |
| Unfavorable Sharpe < -1.0 | Catastrophic risk | Add protective filters |

### Walk-forward pattern diagnosis

| Pattern | Meaning | Action |
|---------|---------|--------|
| CONSISTENT | Generalizes well | Boost magnitude: tighten entries, optimize ROI |
| DEGRADING | Overfit to early data | Simplify: remove indicators, reduce params |
| ALTERNATING | Regime-dependent | Add ADX/volatility filter |
| SINGLE_SPIKE | One lucky window | Rethink entry logic entirely |

### Win rate vs P&L patterns

| Pattern | Win Rate | P&L | Fix |
|---------|----------|-----|-----|
| A: R:R problem | > 45% | Negative | Fix exits: widen take-profit, tighten stoploss |
| B: Bad entries | < 30% | Negative | Fix entries: add trend filter, raise threshold |
| C: Mixed | 30-45% | Negative | Check avg_win vs avg_loss first |
| D: Over-filtered | Any | 0 trades | REMOVE filters, widen thresholds |

**Pattern A is critical:** high win rate + negative P&L means entries are GOOD but
exits are BAD. Do NOT change entry conditions — fix the exits.

### Reading execution traces

Read traces in this order:
1. **Exit analysis** — if stoploss > 40% of exits, fix stoploss width, not entries
2. **Worst trades** — look for patterns (same direction? same regime? same duration?)
3. **Per-window breakdown** — if one window is catastrophic, check what regime it was
4. **Regime analysis** — compare win rate across regimes to find weak spots

### Archetype-specific exit guidance

| Archetype | Typical WR | Common Exit Problem | Fix |
|-----------|-----------|---------------------|-----|
| TREND_MOMENTUM | 35-45% | Wins cut short | Trailing stop, remove fixed ROI < 2% |
| BREAKOUT | 30-40% | Exit during retest | Wide stoploss (1.5-2× ATR), ROI min 3% |
| MEAN_REVERSION | 55-70% | Holds losers forever | Hard stoploss -2%, time exit (20 candles) |
| RANGE_BOUND | 60-70% | Exit mid-range | Calibrate ROI to channel width |
| SCALPING | 50-60% | Fees eat profits | Minimum ROI >= 0.3% |
| VOLATILITY_HARVEST | 30-40% | Exit during vol peak | ATR trailing, 2-3× ATR breathing room |
| CARRY_FUNDING | 65-75% | Exit before collection | Wide stoploss (10%+), hold minimum 4h |

## When stuck (5+ experiments, no progress on same obstacle)

Don't keep trying the same approach. Step back:
- Have you been tweaking parameters when the problem is structural?
- Is this archetype wrong for this pair's current market conditions?
- What do the anti-patterns from `kata_read_knowledge` say about what NOT to try?
- Would a completely different indicator set be more appropriate?
- Check `kata_inspect_market` — has the regime changed since the strategy was created?

## Scoring

Primary score: `favorable_sharpe` = average of POSITIVE walk-forward windows.
`score = min(favorable_sharpe / 1.0, 1.0)` → normalized 0.0 to 1.0.

Score forced to 0.0 if:
- Total OOS trades across positive windows < 10
- Unfavorable Sharpe (avg of negative windows) < -1.0

Graduation requires ALL of:
- Score >= 0.5
- DSR >= 1.96 (statistically significant after multiple testing correction)
- PBO <= 0.50 (not likely overfit)

## Overfitting awareness

- DSR > 1.96 → statistically significant. Good.
- DSR < 1.96 after 10+ experiments → likely false positive. Simplify drastically.
- PBO < 0.3 → low overfitting risk.
- PBO > 0.5 → high risk, strategy is curve-fit. Simplify.

## Overfit decay (when routed from monitor)

When obstacle is `overfit_decay`, the strategy's live Sharpe has decayed vs backtest.
Fix by SIMPLIFYING, not adding:
1. Remove the indicator with least economic justification
2. Round parameters to "reasonable" values (RSI < 37 → RSI < 35)
3. Double lookback periods on rolling windows
4. Drop param-heavy filters first

Do NOT add new indicators to "tune out" the decay.

## Cross-race knowledge

When you call `kata_read_knowledge`, it returns:
- **Discoveries** — changes that improved scores in past races. Try these early.
- **Anti-patterns** — changes that hurt scores. Avoid repeating.
- **Graduated sequences** — complete recipes that led to graduation. Follow them.
- **Maturity level** — EARLY (<10), DEVELOPING (10-49), MATURE (≥50 discoveries).
  In EARLY: prefer established patterns. In MATURE: focus on untested combinations.

## When you're done

If graduated: the `kata_record_experiment` tool handles everything — knowledge
recording, evolution events, kata-state.json update.

If max experiments reached with no graduation: record your final experiment,
then the race ends naturally.
