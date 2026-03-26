---
name: auto-mode
description: >
  Autonomous deployment lifecycle monitor. Runs every 15 minutes to check
  active deployment health, manage state transitions (shadow/active/throttled/
  paused/retired), scan for opportunities and retirement candidates, enforce
  portfolio constraints, and report significant events. Reads market-timing
  cell grid for scores, uses orderflow for regime refresh, freqtrade for bot
  health, aphexdata for audit trail. Trigger on: "auto-mode", "auto mode",
  "deployment status", "shadow track", "auto check", "portfolio health",
  "deployment lifecycle", "activate deployment", "pause deployment",
  "show opportunities", "retirement candidates", "what should be running".
---

# Auto-Mode — Deployment Lifecycle Monitor

Manages live and shadow strategy deployments. Reads market-timing scores,
monitors bot health, enforces portfolio risk, and recommends actions.

**Auto-Mode NEVER modifies strategy code.** If a strategy underperforms,
Auto-Mode pauses it and recommends sending it back to Research (ClawTeam).
The boundary is sacred: Auto-Mode operates strategies, Research improves them.

## Dependencies

| Skill | Purpose |
|-------|---------|
| `market-timing` | 140-cell scores (reads `cell-grid-latest.json`) |
| `orderflow` | Hourly regime refresh for active pairs |
| `archetype-taxonomy` | Archetype definitions, thresholds, constraints |
| `freqtrade-mcp` | Bot status, profit, balance (health monitoring) |
| `aphexdata` | Audit trail for all lifecycle events |

## Deployment Lifecycle State Machine

```
SHADOW ──user approve──> ACTIVE ──composite < 3.0 (2 checks)──> THROTTLED
  │                        │                                       │
  │ score < 2.0 (3x)      │ circuit breaker                       │ composite < 2.0 (3 checks)
  v                        v                                       v
RETIRED              ── PAUSED ──────────────────────────────── PAUSED
                          │                                       │
                          │ paused > 48h or user command           │
                          v                                       v
                        RETIRED                                 RETIRED
```

### States

| State | Description | Freqtrade | New Entries |
|-------|-------------|-----------|-------------|
| **SHADOW** | Monitoring only, no live capital. Tracks scores as if deployed. Minimum 24h before promotion-eligible. | Not running | N/A |
| **ACTIVE** | Live deployment, fully monitored every 15 minutes. | Running | Allowed |
| **THROTTLED** | Reduced position size (50%). Bot running with reduced stake. | Running (reduced) | Allowed (reduced) |
| **PAUSED** | Bot stopped. No new trades. Existing positions managed to exit. | Stopped | Blocked |
| **RETIRED** | Permanently removed. Cannot re-activate without user adding as new shadow. | Stopped | Blocked |

### Critical Safety Invariant

**SHADOW → ACTIVE requires explicit user approval.** The agent never auto-deploys
live capital. When a shadow deployment becomes promotion-eligible, the agent sends
a message asking the user to approve. All other downward transitions (throttle,
pause, retire) happen automatically based on scores and hysteresis.

### Thresholds

| Threshold | Default | Purpose |
|-----------|---------|---------|
| `deploy_threshold` | 3.5 | Composite to consider deployment-worthy |
| `throttle_threshold` | 3.0 | Below this → throttle (2 consecutive checks) |
| `pause_threshold` | 2.0 | Below this → pause (3 consecutive checks) |
| `restore_threshold` | 3.5 | Above this → restore from throttled/paused |
| `retire_threshold` | 1.5 | Below this for 3 checks → retire |
| `circuit_breaker_dd_pct` | 15% | Portfolio DD → pause ALL |
| `circuit_breaker_recovery_dd_pct` | 10% | DD recovery → allow re-approval |
| `shadow_minimum_hours` | 24 | Minimum time before promotion-eligible |
| `shadow_minimum_checks_above_threshold` | 6 | Minimum checks above deploy_threshold |
| `throttle_stake_modifier` | 0.5 | Position size multiplier when throttled |
| `throttle_consecutive_checks` | 2 | Checks below throttle_threshold to trigger |
| `pause_consecutive_checks` | 3 | Checks below pause_threshold to trigger |
| `restore_consecutive_checks` | 2 | Checks above restore_threshold to restore |
| `paused_retire_hours` | 48 | Hours in PAUSED before auto-retire |
| `pnl_retire_threshold_pct` | -10 | P&L since deploy → retirement candidate |

Users can override any threshold via `/workspace/group/auto-mode/config.json`.

---

## Security Hardening

### 1. Main-Group Gate

Auto-mode commands that affect capital MUST only run in the main group.
Before executing any capital-affecting command, check:

```bash
[ "$NANOCLAW_IS_MAIN" = "1" ] || echo "DENIED: auto-mode capital operations require main group"
```

**Capital-affecting commands** (require main group):
- `activate` / `approve` (SHADOW → ACTIVE)
- `resume` (PAUSED → ACTIVE)
- `retire` (stops bot permanently)
- `shadow track` (creates deployment entry)
- `set threshold` (modifies config)
- `emergency stop`

**Read-only commands** (allowed from any group):
- `show auto-mode status`
- `show opportunities`
- `show retirement candidates`
- `show portfolio health`

### 2. Confirmation Tokens for Irreversible Actions

Actions that start or permanently stop live capital require a two-step confirmation.
When the user requests an irreversible action, respond with a confirmation prompt
containing a random 4-character token. The user must reply with the exact token.

**Actions requiring confirmation:**
- SHADOW → ACTIVE: `"Activating EMA_Cross_v3 on BTC/USDT 1h with $100 stake. Type CONFIRM-A7K2 to proceed."`
- RETIRE with open positions: `"Retiring EMA_Cross_v3 — has 2 open positions. Type CONFIRM-X9P1 to proceed."`
- EMERGENCY STOP: `"This will stop ALL bots immediately. Type CONFIRM-STOP to proceed."`

Generate the token from the deployment ID + current timestamp (deterministic but
not guessable). Do NOT execute the action until the user replies with the exact token
in the same conversation turn.

**Actions that do NOT need confirmation** (safe direction / reversible):
- Shadow track (no capital at risk)
- Pause (protective)
- Throttle (automatic, protective)
- Show/read commands

### 3. Absolute Capital Limits

Beyond percentage-based constraints, enforce hard dollar limits:

| Limit | Default | Config Key |
|-------|---------|------------|
| Max capital per single deployment | $500 | `max_stake_amount_usd` |
| Max total capital across all deployments | $2500 | `max_total_capital_usd` |
| Max new capital deployed per 24h | $1000 | `max_daily_new_capital_usd` |

Track daily deployment capital in `portfolio.json`:
```json
{
  "daily_deployed_usd": 300,
  "daily_deployed_reset_at": "2026-03-25T00:00:00Z"
}
```

If a deployment would exceed any limit, block it and message the user:
```
"Blocked: activating EMA_Cross_v3 ($100) would exceed daily deployment limit
($1000). $900 already deployed today. Override with 'set limit max_daily_new_capital_usd=1500'."
```

### 4. Deployment Rate Limit

Prevent rapid-fire deployments that could overwhelm risk management:

| Limit | Default | Config Key |
|-------|---------|------------|
| Max new activations per hour | 3 | `max_activations_per_hour` |
| Cooldown between activations | 5 minutes | `activation_cooldown_minutes` |

Track in `portfolio.json`:
```json
{
  "recent_activations": [
    {"deployment_id": "dep_btc_...", "activated_at": "2026-03-25T17:30:00Z"}
  ]
}
```

### 5. Emergency Stop

The `EMERGENCY STOP` command (after confirmation) immediately:
1. Calls `freqtrade_stop_bot(confirm=true)` for ALL active and throttled deployments
2. Sets `portfolio.circuit_breaker_active = true`
3. Calls `pause_task(name="auto_mode_check")` to stop the scheduled monitoring
4. Transitions all non-retired deployments to PAUSED
5. Writes state atomically
6. Logs `aphexdata_record_event(verb_id="emergency_stop", verb_category="risk", object_type="portfolio")`
7. Messages user: "EMERGENCY STOP executed. All bots stopped. Scheduler paused. Manual 'enable auto-mode' + individual re-approval required to resume."

Recovery from emergency stop requires:
- `enable auto-mode` (restarts scheduler)
- Individual `approve` commands for each deployment (with confirmation tokens)

### 6. Dry-Run Mode

When `config.json` contains `"dry_run": true`:
- ALL transitions are computed and logged normally
- ALL state file updates happen normally (so hysteresis tracking works)
- NO freqtrade actions are executed (Step 13 is skipped entirely)
- Messages include `[DRY RUN]` prefix
- aphexDATA events include `"dry_run": true` in result_data

This allows testing the full decision pipeline without risking capital.

Enable: `"Set auto-mode to dry run"` → writes `"dry_run": true` to config.json
Disable: `"Set auto-mode to live"` → writes `"dry_run": false` to config.json

### 7. State File Integrity

Each state file includes a `_checksum` field — a SHA-256 hash of the file content
(excluding the `_checksum` field itself). On read, verify the checksum matches.

```json
{
  "version": 1,
  "deployments": [...],
  "last_updated": "...",
  "_checksum": "a3f2b8c1..."
}
```

**On write (Step 12):** Compute checksum of the JSON content without `_checksum`,
then add `_checksum` field before writing.

**On read (Step 3):** Verify checksum. If mismatch:
- Log `aphexdata_record_event(verb_id="integrity_violation", verb_category="security", object_type="state_file")`
- Message user: "State file integrity check failed for {filename}. File may have been tampered with. Entering safe mode — all transitions blocked until resolved."
- Skip all transitions for this tick (read-only mode)
- Do NOT overwrite the file (preserve evidence)

Compute checksum via:
```bash
# Write: compute hash of content without _checksum
echo '{"version":1,...}' | sha256sum | cut -d' ' -f1
```

---

## 15-Minute Check Procedure (15 Steps)

This is the core algorithm. Execute these steps in order on every scheduled tick.

### Crash-Safety Invariant

State is written BEFORE freqtrade actions execute (Step 12 before Step 13).
If the agent crashes between writing state and executing a bot stop, the next
check's reconciliation step (Step 4) detects the mismatch and retries the action.
This is safe because all transitions are idempotent — stopping an already-stopped
bot is a no-op, starting an already-running bot is a no-op.

### Steps 1–2: Hourly Scans (every 4th tick only)

Check `market-prior.json` → `tick_count`. If `tick_count % 4 == 0`, run Steps 1–2.
Otherwise skip directly to Step 3.

**Step 1: Opportunity Scan**

Read these files:
```bash
cat /workspace/group/reports/cell-grid-latest.json 2>/dev/null || echo '[]'
cat /workspace/group/auto-mode/deployments.json 2>/dev/null || echo '{"deployments":[]}'
```

Check cell-grid age. If older than 8 hours: **skip opportunity scanning entirely**
(stale scores cannot justify new deployments). Log: "Opportunity scanning paused — scores stale."

For each cell where `composite >= 3.5`:
1. Is there already a deployment covering this `archetype + pair + timeframe`? → Skip
2. Check rate limit: has this cell been recommended in the last 4 hours?
   (check `market-prior.json` → `recommendations.opportunities.<cell_key>`) → Skip
3. Scan strategy library for a matching strategy:
   ```bash
   head -10 /workspace/group/user_data/strategies/*.py 2>/dev/null
   ```
   Look for `# ARCHETYPE: <archetype_name>` in first 10 lines of each `.py` file.
4. If no matching graduated strategy found → log opportunity but do NOT recommend
5. If match found, check portfolio constraints:
   - Would adding exceed max total deployments (10)?
   - Would it exceed per-archetype limit (3)?
   - Would it exceed per-pair limit (2)?
6. If constraints pass → message user:
   ```
   Opportunity: {pair} {archetype} {tf} composite={score}. Strategy {strategy_name}
   matches. Reply "shadow track {pair} {archetype} {tf}" to deploy.
   ```
7. Log: `aphexdata_record_event(verb_id="opportunity_detected", object_type="deployment", result_data={cell, strategy, composite})`
8. Update rate limit: `recommendations.opportunities.<cell_key> = now()`

**NEVER auto-deploy.** Recommendation only. User must reply with shadow track command.

**Step 2: Retirement Scan**

For each deployment in `deployments.json`:
1. Look up its cell in `cell-grid-latest.json`
2. Check retirement criteria (ANY of these triggers a recommendation):
   - `consecutive_low_checks >= 3` AND `last_composite < retire_threshold` (1.5)
   - State is PAUSED AND time in PAUSED > `paused_retire_hours` (48h)
   - `total_pnl_pct < pnl_retire_threshold_pct` (-10%)
3. Check rate limit: recommended in last 24 hours? → Skip
4. If criteria met → message user:
   ```
   {strategy_name} on {pair} {tf}: {reason}. Recommend retiring.
   Reply "retire {deployment_id}" to confirm, or "send to research {strategy_name}" to improve.
   ```
5. If deployment has open positions (check via `freqtrade_fetch_bot_status()`), append:
   ```
   Note: this deployment has open positions. Retiring will not close them — manage exits manually.
   ```
6. Log: `aphexdata_record_event(verb_id="retirement_recommended", object_type="deployment", result_data={deployment_id, reason, composite, pnl})`
7. Update rate limit: `recommendations.retirements.<deployment_id> = now()`

**NEVER auto-retire.** Recommendation only.

### Steps 3–15: Every-Tick Health Check

**Step 3: Read State**

```bash
cat /workspace/group/auto-mode/deployments.json 2>/dev/null || echo '{"deployments":[],"version":1}'
cat /workspace/group/auto-mode/market-prior.json 2>/dev/null || echo '{"regimes":{},"last_refresh":null,"tick_count":0,"recommendations":{"opportunities":{},"retirements":{}}}'
cat /workspace/group/auto-mode/portfolio.json 2>/dev/null || echo '{"total_dd_pct":0,"total_capital_allocated_pct":0,"circuit_breaker_active":false}'
cat /workspace/group/auto-mode/config.json 2>/dev/null || echo '{}'
cat /workspace/group/reports/cell-grid-latest.json 2>/dev/null || echo '[]'
```

If `config.json` exists, merge its values over the defaults above.

**Step 4: Reconcile State vs Reality**

Call `freqtrade_fetch_bot_status()`. Compare running bots against deployment state:

| Mismatch | Action |
|----------|--------|
| State = "active" but bot not running | Re-start bot OR mark as previous crash (log warning) |
| Bot running but not in deployments.json | External deployment (market-timing or manual). Add as state=ACTIVE with `reason: "external_detected"` |
| State = "paused" but bot still running | Previous stop didn't complete. Execute `freqtrade_stop_bot()` now |
| State = "throttled" but bot not running | Re-start bot with reduced stake |

**Step 5: Increment Tick Counter**

```
market_prior.tick_count += 1
```

**Step 6: Hourly Regime Refresh (every 4th tick)**

If `tick_count % 4 == 0`:

Collect unique pairs from all non-retired deployments. Then:
```
orderflow_fetch_regime(symbols=[<active_pairs>], horizon="H2_SHORT")
orderflow_fetch_regime(symbols=[<active_pairs>], horizon="H3_MEDIUM")
```

Update `market-prior.json` → `regimes` with fresh data and `last_refresh` timestamp.

If no active deployments, skip entirely.

**Step 7: Fetch Portfolio DD**

```
freqtrade_fetch_profit()
```

Extract: `max_drawdown`, cumulative profit, win rate. Update `portfolio.json`.

**Step 8: Quick Score Active Deployments**

For each non-retired deployment:
1. Look up the cell in `cell-grid-latest.json` by `archetype + pair + timeframe`
2. Use the cell's `composite` score as-is (from market-timing's last scoring cycle)
3. If hourly regime refresh just ran (Step 6), check whether regime has changed since
   the cell grid was scored. If regime shifted to an anti-regime for this archetype,
   apply a -1.0 penalty to the composite (capped at 0)
4. Store `last_composite` on the deployment

**Step 9: Apply Hysteresis**

For each deployment, evaluate against thresholds:

| Current State | Composite | Counter Action | Transition |
|---------------|-----------|----------------|------------|
| SHADOW | >= deploy_threshold for 6+ checks AND age >= 24h | — | Flag as **promotion-eligible** |
| SHADOW | < pause_threshold for 3 consecutive | Increment | → RETIRED |
| ACTIVE | < throttle_threshold | Increment `consecutive_low_checks` | If >= 2 → THROTTLED |
| ACTIVE | >= throttle_threshold | Reset counter to 0 | — |
| THROTTLED | >= restore_threshold for 2 consecutive | Increment `consecutive_high_checks` | → ACTIVE |
| THROTTLED | < pause_threshold | Increment `consecutive_low_checks` | If >= 3 → PAUSED |
| PAUSED | >= restore_threshold for 4 consecutive | — | Flag as **reactivation-eligible** |
| PAUSED | age in PAUSED > 48h | — | Flag as **retirement candidate** (Step 2 handles messaging) |

**Step 10: Check Portfolio Constraints + Circuit Breaker**

From Step 7 profit data:
- If `max_drawdown_pct > circuit_breaker_dd_pct` (15%):
  - Set `portfolio.circuit_breaker_active = true`
  - Mark ALL active and throttled deployments for → PAUSED
  - Message user immediately
- If circuit breaker was active AND DD recovered below `circuit_breaker_recovery_dd_pct` (10%):
  - Set `portfolio.circuit_breaker_active = false`
  - Deployments remain PAUSED (user must re-approve each individually)
  - Message user

Concentration checks (from `archetypes.yaml` constraints):
- Total active deployments > 10: pause lowest-scoring active
- Any archetype > 3 active: pause lowest in that archetype
- Any pair > 2 active: pause lowest for that pair

**Step 11: Determine Transitions**

Collect all intended transitions from Steps 9–10. Do NOT execute yet.

For each transition, record:
```json
{
  "deployment_id": "...",
  "from_state": "active",
  "to_state": "throttled",
  "reason": "composite 2.8 below throttle_threshold 3.0 for 2 consecutive checks"
}
```

**Step 12: Atomic State Write**

Write the new state (with intended transitions applied) to temporary files, then rename:
```bash
cat > /workspace/group/auto-mode/deployments.json.tmp << 'DEOF'
{...updated deployments with new states...}
DEOF
mv /workspace/group/auto-mode/deployments.json.tmp /workspace/group/auto-mode/deployments.json

cat > /workspace/group/auto-mode/market-prior.json.tmp << 'MEOF'
{...updated tick_count, regimes, recommendations...}
MEOF
mv /workspace/group/auto-mode/market-prior.json.tmp /workspace/group/auto-mode/market-prior.json

cat > /workspace/group/auto-mode/portfolio.json.tmp << 'PEOF'
{...updated portfolio stats...}
PEOF
mv /workspace/group/auto-mode/portfolio.json.tmp /workspace/group/auto-mode/portfolio.json
```

State is now durable. If the agent crashes after this point, the next tick's
reconciliation step (Step 4) will detect and complete any pending freqtrade actions.

**Step 13: Execute Transitions**

For each transition from Step 11:

| Transition | Freqtrade Action |
|-----------|-----------------|
| → ACTIVE (from shadow, user approved) | `freqtrade_start_bot(strategy=<name>, pairs=[pair], timeframe=tf)` |
| → THROTTLED | Reduce stake: `freqtrade_stop_bot()` then `freqtrade_start_bot()` with `stake_amount * throttle_stake_modifier` |
| → PAUSED | `freqtrade_stop_bot(confirm=true)` |
| → RETIRED | `freqtrade_stop_bot(confirm=true)` |
| → ACTIVE (restored from throttled) | `freqtrade_stop_bot()` then `freqtrade_start_bot()` with full stake |

If any freqtrade call fails, log the error but do NOT roll back state.
The next tick's reconciliation (Step 4) will detect and retry.

**Step 14: Message User**

Send a message ONLY if any of these occurred:
- A deployment changed state (any transition from Step 11)
- Circuit breaker activated or deactivated
- Shadow deployment became promotion-eligible
- Opportunity or retirement recommendation from Steps 1–2

If nothing changed: produce NO output (silent check).

Message format when reporting state changes:
```markdown
## Auto-Mode — [TIMESTAMP]

### State Changes
- EMA_Cross_v3 on BTC/USDT 1h: ACTIVE → THROTTLED
  Reason: composite 2.8 below threshold 3.0 for 2 checks

### Active Deployments (N)
| Strategy | Pair | TF | State | Composite | P&L |
|----------|------|----|-------|-----------|-----|
| EMA_Cross_v3 | BTC/USDT | 1h | THROTTLED | 2.8 | +1.3% |
| Squeeze_v2 | ETH/USDT | 1h | ACTIVE | 4.1 | +0.8% |

### Portfolio
- DD: 5.2% | Capital: 42% | Active: 3/10 | Circuit breaker: OFF
```

**Step 15: Log to AphexDATA**

```
aphexdata_record_event(
  verb_id="auto_mode_check",
  verb_category="monitoring",
  object_type="report",
  object_id="auto_mode_<YYYY-MM-DD_HH-MM>",
  result_data={
    "tick_count": N,
    "active": N, "shadow": N, "throttled": N, "paused": N, "retired": N,
    "transitions": [{from, to, deployment_id, reason}],
    "portfolio_dd_pct": N,
    "circuit_breaker_active": false,
    "regime_refresh": true/false,
    "opportunities_found": N,
    "retirements_recommended": N
  }
)
```

For each state transition, also log individually:
```
aphexdata_record_event(
  verb_id="throttled" | "paused" | "restored" | "retired" | "promoted",
  verb_category="execution",
  object_type="deployment",
  object_id=<deployment_id>,
  result_data={
    "strategy": "...", "pair": "...", "timeframe": "...",
    "from_state": "active", "to_state": "throttled",
    "composite": 2.8, "reason": "..."
  }
)
```

---

## Strategy-to-Archetype Matching

Strategies are matched to archetypes via header comment tags in `.py` files:

```python
# ARCHETYPE: TREND_MOMENTUM
# GRADUATED: 2026-03-20
# WALK_FORWARD_DEGRADATION: 18%
# VALIDATED_PAIRS: BTC/USDT, ETH/USDT
class EMA_Crossover_v3(IStrategy):
    ...
```

Scan first 10 lines of each `.py` in `/workspace/group/user_data/strategies/`.

**ClawTeam graduation convention:** When a strategy graduates from research, the
graduation step should add these header tags. This links the Research → Operations
handoff.

**Fallback** if no tags: query `aphexdata_query_events(verb_id="attested", object_type="strategy")`
for strategy metadata including archetype classification.

---

## Stale Data Protection

Check the `last_scored` timestamp in `cell-grid-latest.json`, or the file modification
time via `stat`.

If cell-grid is **> 8 hours old**:
- **Block** upward transitions (no promotions, no restores)
- **Continue** downward transitions (safe direction: throttle, pause, retire)
- **Skip** opportunity scanning entirely
- **Continue** retirement scanning (safe direction)
- **Alert** user: "Market-timing scores stale (last: Xh ago). Opportunity scanning paused. Run a scoring cycle to refresh."

---

## State File Schemas

All files at `/workspace/group/auto-mode/`. Create the directory if it doesn't exist:
```bash
mkdir -p /workspace/group/auto-mode
```

### deployments.json

```json
{
  "version": 1,
  "deployments": [
    {
      "id": "dep_btc_trend_1h_20260325",
      "archetype": "TREND_MOMENTUM",
      "pair": "BTC/USDT",
      "timeframe": "1h",
      "strategy_name": "EMA_Crossover_v3",
      "strategy_path": "EMA_Crossover_v3.py",
      "state": "active",
      "consecutive_low_checks": 0,
      "consecutive_high_checks": 0,
      "last_composite": 4.2,
      "last_regime_fit": 5,
      "last_execution_fit": 4,
      "last_net_edge": 4,
      "stake_amount": 100,
      "stake_modifier": 1.0,
      "total_pnl_pct": 1.3,
      "max_dd_since_deploy": -2.1,
      "trades_since_deploy": 12,
      "checks_in_current_state": 8,
      "state_history": [
        {"state": "shadow", "entered_at": "2026-03-24T12:00:00Z", "reason": "user_added"},
        {"state": "active", "entered_at": "2026-03-25T12:00:00Z", "reason": "user_approved"}
      ],
      "current_state_entered_at": "2026-03-25T12:00:00Z",
      "created_at": "2026-03-24T12:00:00Z",
      "last_checked_at": "2026-03-25T18:15:00Z"
    }
  ],
  "last_updated": "2026-03-25T18:15:00Z"
}
```

### market-prior.json

```json
{
  "version": 1,
  "tick_count": 47,
  "last_refresh": "2026-03-25T18:00:00Z",
  "regimes": {
    "BTC": {
      "H2_SHORT": {"regime": "EFFICIENT_TREND", "conviction": 72, "direction": "BULLISH", "fetched_at": "2026-03-25T18:00:00Z"},
      "H3_MEDIUM": {"regime": "EFFICIENT_TREND", "conviction": 65, "direction": "BULLISH", "fetched_at": "2026-03-25T18:00:00Z"}
    },
    "ETH": {
      "H2_SHORT": {"regime": "TRANQUIL", "conviction": 58, "direction": "NEUTRAL", "fetched_at": "2026-03-25T18:00:00Z"}
    }
  },
  "recommendations": {
    "opportunities": {
      "BTC/USDT_TREND_MOMENTUM_1h": "2026-03-25T18:00:00Z"
    },
    "retirements": {
      "dep_xrp_range_15m_20260320": "2026-03-25T14:00:00Z"
    }
  }
}
```

### portfolio.json

```json
{
  "version": 1,
  "total_dd_pct": 5.2,
  "total_capital_allocated_pct": 42,
  "max_dd_pct_24h": 7.1,
  "circuit_breaker_active": false,
  "circuit_breaker_activated_at": null,
  "dd_warning_sent": false,
  "by_archetype": {
    "TREND_MOMENTUM": {"count": 2, "capital_pct": 20},
    "MEAN_REVERSION": {"count": 1, "capital_pct": 10}
  },
  "by_pair": {
    "BTC/USDT": {"count": 1, "capital_pct": 15},
    "ETH/USDT": {"count": 2, "capital_pct": 17}
  },
  "last_updated": "2026-03-25T18:15:00Z"
}
```

### config.json (optional user overrides)

```json
{
  "deploy_threshold": 3.5,
  "throttle_threshold": 3.0,
  "pause_threshold": 2.0,
  "restore_threshold": 3.5,
  "retire_threshold": 1.5,
  "circuit_breaker_dd_pct": 15,
  "circuit_breaker_recovery_dd_pct": 10,
  "shadow_minimum_hours": 24,
  "shadow_minimum_checks_above_threshold": 6,
  "throttle_consecutive_checks": 2,
  "pause_consecutive_checks": 3,
  "restore_consecutive_checks": 2,
  "paused_retire_hours": 48,
  "pnl_retire_threshold_pct": -10,
  "throttle_stake_modifier": 0.5,
  "dd_warning_threshold_pct": 10,
  "silent_when_no_changes": true,
  "dry_run": false,
  "max_stake_amount_usd": 500,
  "max_total_capital_usd": 2500,
  "max_daily_new_capital_usd": 1000,
  "max_activations_per_hour": 3,
  "activation_cooldown_minutes": 5
}
```

If this file doesn't exist, use defaults from the thresholds table above.

---

## Quick Command Table

| User Says | Auto-Mode Does |
|-----------|---------------|
| "Show auto-mode status" | Read all state files, display deployment table with states, scores, P&L |
| "Shadow track BTC TREND_MOMENTUM 1h" | Add deployment entry in SHADOW state |
| "Shadow track BTC TREND_MOMENTUM 1h using EMA_Cross_v3" | Same, with explicit strategy |
| "Approve/activate BTC TREND_MOMENTUM 1h" | SHADOW → ACTIVE (starts freqtrade bot) |
| "Pause BTC deployment" | Manual ACTIVE/THROTTLED → PAUSED (stops bot) |
| "Resume BTC deployment" | If composite >= restore_threshold: PAUSED → ACTIVE |
| "Retire {deployment_id}" | Any → RETIRED (stops bot, removes from rotation) |
| "Send to research {strategy_name}" | Retire + message: recommend ClawTeam improvement session |
| "Run auto-mode check now" | Execute the full 15-step check immediately |
| "Show opportunities" | Run Step 1 now, list all undeployed high-scoring cells with matching strategies |
| "Show retirement candidates" | Run Step 2 now, list all deployments meeting retirement criteria |
| "Ignore opportunity {cell}" | Suppress recommendations for this cell for 24 hours |
| "Show portfolio health" | Display portfolio DD, capital allocation, concentration, circuit breaker status |
| "Set threshold deploy=4.0" | Update config.json with new threshold value |
| "Disable auto-mode" | `pause_task(name="auto_mode_check")` |
| "Enable auto-mode" | `resume_task(name="auto_mode_check")` |
| "EMERGENCY STOP" | Confirm token → stop ALL bots, pause scheduler, pause all deployments |
| "Set auto-mode to dry run" | Write `"dry_run": true` to config.json. All checks run but no freqtrade actions |
| "Set auto-mode to live" | Write `"dry_run": false` to config.json. Resume freqtrade actions |

---

## Handoffs Between Modes

### Auto-Mode → Research (ClawTeam)

When a deployed strategy underperforms and is retired:
```
"{strategy_name} has been retired. Composite degraded from 4.2 to 1.3 over 2 weeks.
Regime shifted from EFFICIENT_TREND to COMPRESSION. Recommend sending back to
Research with hypothesis: strategy needs regime-conditional exit logic for
compression markets."

User can say: "Improve {strategy_name} for compression regime" → ClawTeam takes over.
```

### Research → Auto-Mode

When ClawTeam graduates a strategy:
```
"{strategy_name} graduated with WF Sharpe 1.1, degradation 18%. Ready for shadow
deployment. Reply 'shadow track {pair} {archetype} {tf}' to begin monitoring."
```

### Auto-Mode → Analysis Skills

When monitoring needs context (during hourly regime refresh):
- Read latest `macro-latest.json` if available (from macro-sentiment skill)
- Read latest `onchain-latest.json` if available (from onchain-intel skill)
- Read latest `sentiment-latest.json` if available (from ct-sentiment skill)
- Factor into regime assessment but do NOT run these scans — they have their own schedules

---

## AphexDATA Event Conventions

| verb_id | verb_category | object_type | When |
|---------|--------------|-------------|------|
| `auto_mode_check` | monitoring | report | Every 15-min check |
| `shadow_added` | execution | deployment | User adds shadow deployment |
| `promoted` | execution | deployment | SHADOW → ACTIVE (user approved) |
| `throttled` | execution | deployment | ACTIVE → THROTTLED |
| `paused` | execution | deployment | → PAUSED |
| `restored` | execution | deployment | THROTTLED/PAUSED → ACTIVE |
| `retired` | execution | deployment | → RETIRED |
| `circuit_breaker` | risk | portfolio | Portfolio DD > threshold |
| `circuit_breaker_cleared` | risk | portfolio | Portfolio DD recovered |
| `opportunity_detected` | analysis | deployment | High-scoring cell with matching strategy |
| `opportunity_acted` | execution | deployment | User shadow-tracked a recommendation |
| `retirement_recommended` | analysis | deployment | Deployment meets retirement criteria |
| `emergency_stop` | risk | portfolio | EMERGENCY STOP executed |
| `integrity_violation` | security | state_file | State file checksum mismatch detected |
| `dry_run_toggled` | config | system | Dry-run mode enabled or disabled |
| `capital_limit_blocked` | risk | deployment | Activation blocked by capital/rate limit |

---

## Scheduled Execution

Auto-mode runs every 15 minutes as a scheduled task:

```
schedule_task(
  name: "auto_mode_check",
  schedule: "*/15 * * * *",
  context_mode: "isolated",
  prompt: "Run an auto-mode monitoring check. Follow the 15-step procedure in the auto-mode skill. Read all state files, reconcile with reality, check deployment health, apply hysteresis, execute transitions, and message the user only on state changes. If tick_count % 4 == 0, also run opportunity and retirement scans and refresh regime data."
)
```

### Future: Fast-Cadence Monitoring

When spread/depth tools become available (e.g. via `/add-hyperliquid`), add a second
scheduled task at `*/5` for deployments with open positions only. The architecture
supports this — just another `schedule_task`. Deferred until tooling exists.

---

## Anti-Patterns

1. **REGIME CHURN**: Don't toggle strategies on single-check score changes.
   Use hysteresis (consecutive checks required for all transitions).

2. **MODIFYING STRATEGIES**: Auto-Mode NEVER changes strategy code. Pause and
   recommend Research mode instead.

3. **OVER-REPORTING**: Don't message every 15 minutes. Report on state changes
   and significant events only. Silent when nothing changed.

4. **IGNORING CORRELATION**: Don't run 3 trend-following strategies on correlated
   assets. Portfolio constraints exist for a reason.

5. **SKIPPING SHADOW**: Don't go straight to live capital. Shadow mode first, always.

6. **AUTO-DEPLOYING**: Never promote SHADOW → ACTIVE without user approval.
   Never start a new live bot without explicit user command.

7. **FALSE CONFIDENCE**: A high composite doesn't mean profit. It means conditions
   are aligned. The score gates whether to run, not whether to bet the farm.
