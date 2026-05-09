---
name: heavy-strategist
description: Generate FreqTrade strategy archetypes via parallel reasoning + sequential deliberation. Use this skill whenever the user is in the Strategyzer phase of the freqtrade-agents pipeline — generating new strategy hypotheses, ideating on a market regime or a 560-cell grid cell, converting a pattern observation into a testable archetype, or asking for "a strategy for X" / "ideas for Y instrument". Trigger especially when the user references Strategyzer, archetype generation, strategy ideation, hypothesis generation, or wants strategy candidates for Kata to backtest. Also trigger when the user pastes a chart, an indicator combo, or a market observation and wants it turned into a FreqTrade strategy. Do NOT trigger for parameter optimization (that's Hyperopt), backtest analysis (that's Kata/Monitor), or production trade execution.
---

# Heavy Strategist — Strategyzer-Stage Ideation Skill

## Purpose

Single-pass strategy generation defaults to a narrow band of ideas (RSI/MACD/Bollinger variants) regardless of how the request is framed. This skill replaces single-pass ideation with **parallel-reasoning + sequential-deliberation** (HeavySkill pattern, arxiv 2605.02396) specialized for FreqTrade strategy archetypes.

Output is a **strategy archetype spec** ready for Kata-stage parameterization across the 560-cell grid — *not* parameterized code, *not* a backtest, *not* a final strategy. Just the archetype.

## When to Activate

Activate when **all** of the following are true:
- Task is in the Strategyzer phase (ideation, not optimization or analysis)
- Output needed is a *new* archetype, not iteration on an existing one
- A walk-forward verifier (Kata harness, separation index, DVF score) will gate the output downstream

Do **not** activate for:
- Tweaking an existing strategy's parameters → use Hyperopt
- Diagnosing why a backtest failed → use `heavy-diagnostician` (separate skill)
- Live signal generation → use the deployed strategy
- Casual market commentary

## Execution Protocol

### Stage 1: Spawn K=6 Parallel Strategist Subagents

Each receives the same problem statement but is **assigned a different prior**. Run all six in parallel via a single Agent tool call with concurrent invocations. Agents must not see each other's intermediate output.

The six priors (do not deviate, do not collapse two into one):

1. **Wyckoff / Accumulation-Distribution.** Markets cycle through phases; smart money leaves footprints in volume/spread structure. Indicators: effort vs. result, volume profile, range compression, spring/upthrust.
2. **Mean-Reversion / VWAP Deviation.** Price oscillates around a true value anchor; statistical extremes mean-revert. Indicators: VWAP bands, Bollinger %B, Z-score, RSI divergence in range regimes.
3. **Momentum / Lorentzian Classification.** Trends persist longer than chance; non-linear similarity to historical winners. Indicators: Lorentzian Classification, ADX, Donchian breakouts, KAMA.
4. **Regime-Conditional Confluence.** Different rules for different regimes; meta-strategy switches sub-strategies via a regime classifier. Indicators: Andean cross-filter, ATR regime, Hurst exponent, multi-timeframe alignment.
5. **Orderflow / Microstructure.** Edge lives in liquidity dynamics, not chart patterns; absorption, sweeps, imbalance. Indicators: cumulative delta, footprint imbalance, large-trade clusters, BBO pressure.
6. **Sentiment / Cross-Asset Overlay.** Price action lags information; CT sentiment, funding rates, BTC dominance, on-chain flows lead. Indicators: ct-sentiment skill output, funding rate Z-score, BTC.D, stablecoin inflows, finnhub-ta.

Subagent prompt template:

```
You are a quantitative strategist with a strong prior in {prior_name}.
Your mental model: {mental_model}.

Problem: {problem_statement}
Context: {market_context}
Constraints: {timeframe, instrument set, max DD tolerance, etc.}

Produce ONE strategy archetype spec independently. You have NOT seen any
other strategist's work and must not speculate about what they might say.

Required output (markdown, no code yet):
1. Edge thesis: 1-3 sentences. WHY does this make money? What market
   inefficiency does it exploit? Be mechanistic, not statistical.
2. Entry conditions: indicator combo, logic, regime filter
3. Exit conditions: take-profit, stop-loss, time-based, signal-based
4. Risk frame: position sizing logic, max correlated exposure, regime kill-switch
5. Failure modes: when will this stop working? What regime kills it?
6. Parameterization surface: what would Hyperopt tune? (max 8 parameters)

Constraints:
- Do NOT pick more than 4 indicators. Parsimony is a feature.
- The edge thesis must survive "why hasn't this been arbitraged?"
- If your prior doesn't fit the problem, say so explicitly and produce
  the spec anyway — DO NOT silently drift to a different prior.
```

### Stage 2: Serialize the Memory Cache

Collect six specs. **Shuffle order** (avoid position bias). **Strip prior labels** — deliberator evaluates on merit, not perceived prior strength.

```
# ====== Problem ======
{original problem statement and constraints}

# ====== Strategist Archetypes ======
## Archetype A
[shuffled, unlabeled spec]

## Archetype B
...
```

### Stage 3: Sequential Deliberation

Synthesis under anti-plausibility constraints. Not voting. Not selection. Use this prompt verbatim:

```
You are the senior strategist reviewing six independent archetype specs.
Your job is NOT to pick the most plausible-sounding one. Your job is to
produce ONE final archetype spec with the best chance of surviving
walk-forward OOS testing.

# ====== Problem ======
{problem}

# ====== Archetype Specs ======
{shuffled_archetypes}

# ====== Deliberation Protocol ======

Step 1 — Edge inventory.
Restate each archetype's edge thesis in one sentence. Flag any thesis
that is purely statistical ("this pattern has worked historically")
rather than mechanistic ("this exploits {specific market participant
behavior}"). Statistical-only theses are overfit candidates.

Step 2 — Cross-trajectory synthesis.
The most valuable output is NOT picking a winner. It is identifying
combinations: a regime filter from one archetype + an entry trigger
from another + an exit logic from a third can produce a spec better
than any single archetype. Note at least two candidate combinations.

Step 3 — Anti-plausibility checks. Reject or downweight any archetype that:
  (a) uses more than 4 indicators
  (b) has a clean narrative but no mechanistic edge story
  (c) requires regime classification as complex as the strategy itself
  (d) has parameterization surface >8 params (it will overfit in Hyperopt)
  (e) all six archetypes converged on — consensus is suspicious here, not
      reassuring (usually means they all pattern-matched the same training data)

Step 4 — Produce the final spec.
Output ONE archetype spec following the same 6-section format. May be
one of the original six, a synthesis of two or three, or a new archetype
derived from analyzing their failures.

If none of the six produce edge, return a "no-go" verdict explicitly.
This is a valid and valuable output.

# ====== Output Format ======
## Final Archetype: {name}

### Edge thesis
### Entry conditions
### Exit conditions
### Risk frame
### Failure modes
### Parameterization surface
### Synthesis notes
- Which source archetypes contributed (A/B/C/D/E/F → which sections)
- Which were rejected and why
- One specific OOS test that would falsify this archetype
```

### Stage 4: Serialize to Bridge File

After Stage 3 deliberation produces the final archetype spec (or a no-go verdict),
serialize the output to the workspace bridge file for downstream consumption by
strategyzer.

**Output path:** `/workspace/group/reports/heavy-strategist-result.json`

#### Step 1: Map to canonical archetype

The final spec must declare which of the 7 canonical archetypes it maps to.
This mapping is non-optional — strategyzer uses it for anti-pattern filtering,
regime guidance, graduation gates, and correlation group assignment.

Read `/workspace/skills/archetype-taxonomy/archetypes.yaml` and match:

1. If the spec's edge thesis and indicator set align with exactly one archetype's
   `strategy_tags` and `preferred_regimes` → `archetype_confidence: "exact"`
2. If the spec primarily aligns with one archetype but borrows elements from
   another (e.g., mean-reversion entry + momentum trailing stop) →
   `archetype_confidence: "closest"`, use the primary archetype
3. If the spec synthesizes elements from 2+ archetypes with no clear primary →
   `archetype_confidence: "synthesis"`, choose the archetype whose graduation
   gates are most appropriate for the spec's expected behavior (win rate,
   trade frequency, drawdown tolerance)

Set `canonical_archetype` to the matched archetype name (one of:
TREND_MOMENTUM, MEAN_REVERSION, BREAKOUT, RANGE_BOUND, SCALPING,
CARRY_FUNDING, VOLATILITY_HARVEST).

#### Step 2: Extract indicator list

From the spec's entry and exit conditions, extract the indicator names using
the vocabulary from strategyzer's archetype indicator signatures:

```
bbands, rsi, stochastic, keltner, ema, macd, adx, supertrend, aroon,
donchian, bbands_squeeze, keltner_squeeze, vwap, volume, pivots, atr,
bbands_width, cci, sma_long, rsi_extreme
```

Map any non-standard indicator names to the closest match. Record as
`spec.entry_conditions.indicators[]`.

#### Step 3: Build prompt blocks

Distill the spec into Pine Script-compatible prompt fragments for LuxAlgo.
These REPLACE (not augment) the static archetype-specific prompts in
strategyzer's Path B.

Write three blocks:

- `prompt_blocks.entry_prompt`: Entry logic as a single paragraph using
  Pine Script indicator names (ta.ema, ta.atr, ta.rsi, etc.). Include
  specific parameter values from the spec's parameterization surface as
  defaults. Follow the same level of specificity as strategyzer's existing
  archetype prompts.

- `prompt_blocks.exit_prompt`: Exit conditions (TP, SL, time-based,
  signal-based) as concrete indicator logic.

- `prompt_blocks.risk_prompt`: Position sizing and regime kill-switch as
  strategy() settings constraints.

#### Step 4: Compose the bridge file

Write to `/workspace/group/reports/heavy-strategist-result.json`:

```json
{
  "spec_version": "1.0",
  "status": "<spec_ready | no_go>",
  "target": {
    "archetype": "<canonical_archetype>",
    "pair": "<target pair from problem statement>",
    "timeframe": "<target timeframe from problem statement>",
    "source": "heavy-strategist"
  },
  "canonical_archetype": "<one of 7 canonical types>",
  "archetype_confidence": "<exact | closest | synthesis>",
  "spec": {
    "name": "<archetype name from deliberation>",
    "edge_thesis": "<1-3 sentences from Stage 3 output>",
    "entry_conditions": {
      "summary": "<human-readable entry logic>",
      "indicators": ["<indicator1>", "<indicator2>"],
      "logic": "<boolean expression>",
      "regime_filter": "<preferred regimes>"
    },
    "exit_conditions": {
      "take_profit": "<TP logic>",
      "stop_loss": "<SL logic>",
      "time_based": "<time exit or null>",
      "signal_based": "<signal exit or null>"
    },
    "risk_frame": {
      "position_sizing": "<sizing logic>",
      "max_correlated_exposure": "<max positions>",
      "regime_kill_switch": "<kill-switch regimes>"
    },
    "failure_modes": ["<failure mode 1>", "<failure mode 2>"],
    "parameterization_surface": [
      {"name": "<param>", "type": "<int|float>", "range": ["<min>", "<max>"], "default": "<value>"}
    ]
  },
  "synthesis_notes": {
    "source_priors": ["<prior names that contributed>"],
    "rejected_priors": [
      {"prior": "<name>", "reason": "<why rejected>"}
    ],
    "falsification_test": "<specific OOS test>",
    "deliberation_verdict": "<selection | synthesis | no_go>",
    "contributing_archetypes": ["<A/B/C/D/E/F labels>"],
    "plausibility_checks_passed": true,
    "consensus_warning": false
  },
  "prompt_blocks": {
    "entry_prompt": "<Pine Script-style entry specification>",
    "exit_prompt": "<Pine Script-style exit specification>",
    "risk_prompt": "<strategy settings constraints>"
  },
  "metadata": {
    "generated_at": "<ISO8601>",
    "subagent_count": 6,
    "deliberation_rounds": 1,
    "iteration": 0,
    "token_cost_estimate": "<approximate tokens used>",
    "priors_used": [
      "wyckoff_accumulation",
      "mean_reversion_vwap",
      "momentum_lorentzian",
      "regime_conditional",
      "orderflow_microstructure",
      "sentiment_cross_asset"
    ]
  }
}
```

#### No-go verdict serialization

When Stage 3 returns a no-go verdict, still write the bridge file:

```json
{
  "spec_version": "1.0",
  "status": "no_go",
  "target": { "archetype": null, "pair": "...", "timeframe": "...", "source": "heavy-strategist" },
  "canonical_archetype": null,
  "archetype_confidence": null,
  "spec": null,
  "synthesis_notes": {
    "source_priors": ["<all 6>"],
    "rejected_priors": [{"prior": "<all 6>", "reason": "..."}],
    "falsification_test": null,
    "deliberation_verdict": "no_go",
    "contributing_archetypes": [],
    "plausibility_checks_passed": false,
    "consensus_warning": false
  },
  "prompt_blocks": null,
  "metadata": { "generated_at": "...", "subagent_count": 6, "deliberation_rounds": 1, "iteration": 0 }
}
```

Strategyzer reads `status: "no_go"` and falls through to its standard
gap-report flow. The no-go file is still valuable: it tells downstream
consumers that a deliberated analysis found no viable edge for this cell,
which is stronger evidence than simply not having tried.

#### Validation

After writing, verify the file is valid JSON:

```bash
cat /workspace/group/reports/heavy-strategist-result.json | python3 -c "import sys,json; json.load(sys.stdin); print('OK')"
```

If validation fails, log error and retry write once.

---

### Stage 5: Iteration (Optional, Triggered by Kata)

After Kata returns walk-forward results, **do not** rerun this skill from scratch:

1. Take the original six archetypes + synthesized final + Kata OOS metrics
2. Add a seventh "verified expert" trajectory containing Kata results and what failed
3. Re-run Stage 3 deliberation with the augmented cache
4. Re-run Stage 4 serialization to update `heavy-strategist-result.json`
   (increment `metadata.iteration` and `metadata.deliberation_rounds`)
5. Output a revised archetype spec

Cap iteration at **N=2**. Beyond that, entropy collapse (per the HeavySkill paper, K=16 collapsed after ~100 RL steps) and overfitting to the specific Kata test set both become serious risks.

## What This Skill Is NOT

- **Not a strategy improver.** It generates archetypes. Improving an existing strategy is a different skill.
- **Not a verifier.** The deliberator has no ground truth during synthesis. Walk-forward backtest is the ground truth, downstream in Kata. Do not present deliberator output as validated edge.
- **Not a substitute for Hyperopt.** This skill *defines* the parameterization surface; Hyperopt *tunes* it.
- **Not for parameter sweeps.** That's the 560-cell grid's job.

## Failure Modes to Watch For

1. **Plausibility convergence.** All six archetypes coincidentally adopt similar logic — usually because the problem statement primed them. Restate problem more abstractly and rerun Stage 1.
2. **Deliberator narrative-bias.** Deliberator picks the most coherent-sounding archetype rather than the most generalizable. Step-3 anti-plausibility checks exist for this; audit the deliberation transcript if they're being skipped.
3. **Prior drift.** A subagent silently abandons its assigned prior. Stage-1 prompt forbids this; the spec should call drift out explicitly rather than hide it.
4. **Synthesis-as-Frankenstein.** Combining incompatible archetypes (momentum entry + mean-reversion exit) produces incoherent strategies. Deliberator must check synthesized specs have an internally consistent edge thesis.

## Integration With freqtrade-agents

- **Upstream caller:** Strategyzer phase orchestrator, scout (when `heavy_strategist_recommended: true`)
- **Downstream consumer:** Strategyzer (Option D, reads `heavy-strategist-result.json` to guide Path A/B/C),
  Kata harness (parameterizes archetype across 560-cell grid)
- **Output artifact:** `/workspace/group/reports/heavy-strategist-result.json` (see Stage 4)
- **Verifier:** walk-forward OOS Sharpe / separation index / DVF score
- **RLVR signal source:** (final archetype spec, walk-forward OOS metric) tuples for future deliberator fine-tuning

## Compatibility

- Requires: Agent tool with parallel subagent invocation
- Optional: ct-sentiment, finnhub-ta, chart-vision skills (used by individual strategists for priors 5 and 6)
- Conflicts with: any skill that pre-commits to a specific indicator set before Stage 1

## A/B Test Before Trusting

Before treating heavy-strategist output as default, run the one-week experiment:

1. Generate 20–30 archetypes via single-pass Strategyzer (baseline)
2. Generate 20–30 archetypes via heavy-strategist (treatment)
3. Run all through Kata + walk-forward
4. Compare **OOS Sharpe distributions** — not in-sample performance, not narrative quality

If treatment shows better OOS persistence, this skill earns its compute cost. If it just produces smarter-looking archetypes that degrade the same amount OOS, kill it — the latency and token cost aren't worth it.
