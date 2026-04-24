---
name: experiment-ledger
description: >
  Append-only experiment ledger with falsification discipline. Logs every
  material portfolio change with hypothesis, prediction, and falsifier.
  Reviews open experiments by computing outcomes deterministically.
  Trigger on: "log experiment", "experiment ledger", "review experiments",
  "open experiments", "ledger status".
---

# Experiment Ledger — Falsification-Disciplined Decision Log

Every material portfolio change gets one row in an append-only JSONL
ledger. Each entry has a time-boxed prediction and a falsifier that
makes the hypothesis testable. Outcomes are computed deterministically
from observed metrics — the agent cannot soft-confirm a failed prediction.

## DATA SOURCES

All paths under `/workspace/group/`.

| File | Purpose | Required |
|------|---------|----------|
| `auto-mode/experiment-ledger.jsonl` | The ledger | No (created if missing) |
| `auto-mode/competition-state.json` | Alpha, benchmark, kata state | Yes |
| `auto-mode/campaigns.json` | Active bot campaigns | Yes |
| `auto-mode/roster.json` | Bot performance metrics | Yes |
| `auto-mode/portfolio.json` | Portfolio-level metrics | Yes |

## SCHEMA

One JSONL row per experiment:

```json
{
  "id": "exp_20260424_a1b2c3d4",
  "ts": "2026-04-24T20:00:00Z",
  "hypothesis": "ATR-expansion edge decayed — realized vol above operating range",
  "action": "Retired atr-expansion-eth-15m, deployed vwap-dmi-eth-15m",
  "prediction": "Portfolio vol drops 15%, alpha improves by Day 3",
  "falsifier": "If after 72h vol has not dropped 8% OR alpha not improved 3%, hypothesis wrong",
  "review_after": "2026-04-27T20:00:00Z",
  "outcome": null,
  "inference": null
}
```

Fields:

| Field | Type | Rule |
|-------|------|------|
| `id` | string | `exp_{YYYYMMDD}_{8hex}`, unique |
| `ts` | ISO datetime | Auto-filled at creation |
| `hypothesis` | string | Why you believe the change is needed. Non-empty. |
| `action` | string | What you did. Non-empty. |
| `prediction` | string | What you expect to happen, with timeframe. Non-empty. |
| `falsifier` | string | The specific threshold that proves the hypothesis wrong. Non-empty. |
| `review_after` | ISO datetime | When to evaluate. Derived from prediction timeframe. |
| `outcome` | string or null | `"CONFIRMED: ..."` or `"FALSIFIED: ..."` with numeric proof. Null until reviewed. |
| `inference` | string or null | Agent prose: what to learn from the outcome. Null until reviewed. |

## MATERIAL CHANGE TRIGGERS

A ledger entry is **mandatory** when the agent performs any of these:

- Strategy deployment to paper trading
- Strategy retirement or eviction
- Strategy rotation (retire + deploy in same tick)
- Slot reallocation between correlation groups
- Parameter change on a live bot (stoploss, ROI, pair)
- Kata race completion that changes the active strategy
- Manual override of any automated decision

A ledger entry is **NOT triggered** by:

- Routine state ticks (alpha update, equity snapshot, timestamp)
- Monitor health checks with no state change
- Candidate pipeline runs that don't deploy anything
- Read-only operations (scout scan, gap report generation)

## PROCEDURE

### Mode 1: Log Experiment

Called when the agent makes a material change (see triggers above).

```
1. Validate all five fields are non-empty strings
   - hypothesis: WHY (the belief being tested)
   - action: WHAT (the change made)
   - prediction: EXPECT (measurable outcome + timeframe)
   - falsifier: DISPROVE (specific threshold for failure)
   - review_after: WHEN (ISO datetime, derived from prediction)

2. Generate ID: exp_{YYYYMMDD}_{8 random hex}

3. Append to auto-mode/experiment-ledger.jsonl:
   { id, ts: now, hypothesis, action, prediction, falsifier,
     review_after, outcome: null, inference: null }

4. Update kata link:
   competition-state.json → kata.last_step = action
   competition-state.json → kata.last_step_expected = prediction
   (last_step_actual and last_step_learned stay null until review)

5. Record aphexDATA event:
   aphexdata_record_event({
     verb_id: "experiment_logged",
     verb_category: "assessment",
     object_type: "experiment",
     object_id: id,
     result_data: { hypothesis, action, prediction, review_after }
   })
```

### Mode 2: Review Open Experiments

Called during daily rollup or on explicit request.

```
1. Read auto-mode/experiment-ledger.jsonl
   Filter: outcome === null AND review_after <= now

2. For each open experiment past its review window:

   a. Parse the falsifier to extract metric and threshold
      Examples:
        "vol has not dropped 8%" → metric: portfolio_vol_change, threshold: -8%
        "alpha not improved 3%"  → metric: alpha_change, threshold: +3%
        "win rate below 40%"     → metric: win_rate, threshold: 40%

   b. Compute the metric from current state files:
      - Alpha change: compare competition-state.json snapshots
      - Vol change: compare portfolio.json volatility readings
      - Win rate: read from roster.json bot stats
      - Trade count: read from roster.json

   c. Evaluate DETERMINISTICALLY:
      metric >= threshold → outcome = "CONFIRMED: {metric} = {value} (threshold: {threshold})"
      metric < threshold  → outcome = "FALSIFIED: {metric} = {value} (threshold: {threshold})"

      The outcome is a PASS/FAIL comparison, not agent judgment.
      2.7% does NOT round to 3%. The falsifier said 3%, so < 3% = FALSIFIED.

   d. Write inference (agent prose):
      What did we learn? Should we adjust strategy selection, timing,
      or the hypothesis framework itself?

   e. Append resolution row to ledger:
      { id: original_id, ts: now, outcome, inference,
        resolved_from: original_id }

   f. Update kata state:
      competition-state.json → kata.last_step_actual = outcome
      competition-state.json → kata.last_step_learned = inference

   g. Record aphexDATA event:
      aphexdata_record_event({
        verb_id: "experiment_resolved",
        verb_category: "assessment",
        object_type: "experiment",
        object_id: original_id,
        result_data: { outcome, inference, days_open }
      })

3. Return summary of reviewed experiments for daily scorecard.
```

### Mode 3: Ledger Status

Display current state of all experiments.

```
1. Read auto-mode/experiment-ledger.jsonl

2. Categorize:
   - Open: outcome === null AND review_after > now
   - Overdue: outcome === null AND review_after <= now
   - Confirmed: outcome starts with "CONFIRMED"
   - Falsified: outcome starts with "FALSIFIED"

3. Compute accuracy: confirmed / (confirmed + falsified)
   (Rolling prediction accuracy — meta-learning about forecasting bias)
```

## DISPLAY FORMAT

```
EXPERIMENT LEDGER
=================
Open: {n}  Overdue: {n}  Confirmed: {n}  Falsified: {n}
Prediction accuracy: {pct}% ({confirmed}/{total} resolved)

OVERDUE (review now):
  - {id}: "{hypothesis}" — due {review_after}
    Falsifier: {falsifier}

OPEN (waiting):
  - {id}: "{hypothesis}" — due {review_after}

RECENT (last 5 resolved):
  - {id}: {outcome} — "{inference}"
```

## GRACEFUL DEGRADATION

- `experiment-ledger.jsonl` missing → create empty, proceed
- `competition-state.json` missing → skip kata link, log warning
- Falsifier unparseable → outcome = "MANUAL_REVIEW: could not parse
  falsifier thresholds" — flag for human review instead of guessing
- Portfolio data missing for metric computation → outcome = "INCOMPLETE:
  {metric} data unavailable" — do not guess, do not confirm
