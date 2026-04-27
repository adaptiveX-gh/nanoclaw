/**
 * Health Triggers A-J — pure deterministic functions.
 * Each trigger takes a BotSnapshot + config and returns a TriggerResult.
 * No I/O, no side effects. Phase 2 of the deterministic health ticker plan.
 *
 * Trigger precedence: A-G (hard triggers) > H (deadline) > I (early eviction) > J (execution).
 * Only the first firing trigger per bot is acted on per tick.
 */

import type {
  BotSnapshot,
  TriggerResult,
  ScoringConfig,
  ArchetypeConfig,
} from './health-types.js';
import { isLowWrArchetype } from './health-types.js';

// ─── Trigger A: Catastrophic Drawdown ───────────────────────────────

export function evaluateTriggerA(
  bot: BotSnapshot,
  archetype: ArchetypeConfig,
  config: ScoringConfig,
): TriggerResult {
  const { max_drawdown } = bot.metrics;
  if (max_drawdown == null) {
    return { id: 'A', fired: false, action: 'retire', reason: '' };
  }

  // High-regime-dependency archetypes use a tighter multiplier
  const isHighRegimeDep =
    archetype.anti_regimes.length >= 2 ||
    archetype.preferred_regimes.length === 1;
  const multiplier = isHighRegimeDep
    ? config.RETIREMENT_GATES.catastrophic_dd_multiplier_high_regime_dep
    : config.RETIREMENT_GATES.catastrophic_dd_multiplier;

  const threshold = archetype.max_drawdown * multiplier;
  const absDd = Math.abs(max_drawdown);

  if (absDd > threshold) {
    return {
      id: 'A',
      fired: true,
      action: 'retire',
      reason: 'drawdown_exceeded',
      details: `DD ${(absDd * 100).toFixed(1)}% > ${(threshold * 100).toFixed(1)}% limit`,
    };
  }
  return { id: 'A', fired: false, action: 'retire', reason: '' };
}

// ─── Trigger B: Dead Container ──────────────────────────────────────

export function evaluateTriggerB(
  bot: BotSnapshot,
  config: ScoringConfig,
): TriggerResult {
  const threshold = config.RETIREMENT_GATES.dead_container_consecutive_checks;
  if (bot.consecutive_container_down >= threshold) {
    return {
      id: 'B',
      fired: true,
      action: 'retire',
      reason: 'container_failed',
      details: `Container down ${bot.consecutive_container_down} consecutive checks`,
    };
  }
  return { id: 'B', fired: false, action: 'retire', reason: '' };
}

// ─── Trigger C: Consecutive Losses ──────────────────────────────────

export function evaluateTriggerC(
  bot: BotSnapshot,
  config: ScoringConfig,
): TriggerResult {
  const { trade_count } = bot.metrics;
  const requiredCount = config.RETIREMENT_GATES.consecutive_losses_count;
  const requiredPct = config.RETIREMENT_GATES.consecutive_losses_pct;

  if (trade_count < requiredCount) {
    return { id: 'C', fired: false, action: 'retire', reason: '' };
  }

  const maxConsec = bot.metrics.max_consecutive_losses;
  if (maxConsec == null || maxConsec < requiredCount) {
    return { id: 'C', fired: false, action: 'retire', reason: '' };
  }

  // Check if cumulative loss from last N trades exceeds threshold
  // We use profit_pct as proxy — if max_consecutive_losses >= count AND profit is deeply negative
  if (bot.metrics.profit_pct < -requiredPct) {
    return {
      id: 'C',
      fired: true,
      action: 'retire',
      reason: 'consecutive_losses',
      details: `${maxConsec} consecutive losses, P&L ${bot.metrics.profit_pct.toFixed(1)}%`,
    };
  }
  return { id: 'C', fired: false, action: 'retire', reason: '' };
}

// ─── Trigger D: Win Rate Floor ──────────────────────────────────────

export function evaluateTriggerD(
  bot: BotSnapshot,
  config: ScoringConfig,
): TriggerResult {
  const { trade_count, win_rate } = bot.metrics;
  if (trade_count < 5) {
    return { id: 'D', fired: false, action: 'retire', reason: '' };
  }

  const floor = isLowWrArchetype(bot.archetype ?? '')
    ? config.RETIREMENT_GATES.win_rate_floor_low_rr_archetypes
    : config.RETIREMENT_GATES.win_rate_floor;

  if (win_rate < floor) {
    return {
      id: 'D',
      fired: true,
      action: 'retire',
      reason: 'win_rate_floor',
      obstacle: 'win_rate',
      details: `WR ${(win_rate * 100).toFixed(0)}% < ${(floor * 100).toFixed(0)}% floor at ${trade_count} trades`,
    };
  }
  return { id: 'D', fired: false, action: 'retire', reason: '' };
}

// ─── Trigger E: Risk/Reward Inversion ───────────────────────────────

export function evaluateTriggerE(
  bot: BotSnapshot,
  config: ScoringConfig,
): TriggerResult {
  const { trade_count, win_rate, profit_pct, avg_win_pct, avg_loss_pct } =
    bot.metrics;
  if (trade_count < 5) {
    return { id: 'E', fired: false, action: 'pause', reason: '' };
  }

  const wrMin = config.RETIREMENT_GATES.rr_inversion_win_rate_min;
  const pnlThreshold = config.RETIREMENT_GATES.rr_inversion_pnl_threshold;

  if (
    win_rate > wrMin &&
    profit_pct < pnlThreshold &&
    avg_win_pct != null &&
    avg_loss_pct != null &&
    avg_loss_pct > avg_win_pct * 1.5
  ) {
    return {
      id: 'E',
      fired: true,
      action: 'pause',
      reason: 'risk_reward_inversion',
      obstacle: 'risk_reward_ratio',
      details: `WR ${(win_rate * 100).toFixed(0)}% but P&L ${profit_pct.toFixed(1)}%, avg_loss/avg_win = ${(avg_loss_pct / avg_win_pct).toFixed(1)}x`,
    };
  }
  return { id: 'E', fired: false, action: 'pause', reason: '' };
}

// ─── Trigger F: Divergence / Anti-Regime Drift ──────────────────────

export function evaluateTriggerF(
  bot: BotSnapshot,
  config: ScoringConfig,
): TriggerResult {
  const { trade_count } = bot.metrics;
  if (trade_count < 8) {
    return { id: 'F', fired: false, action: 'route_to_kata', reason: '' };
  }

  const divergence = bot.divergence_pct;
  if (
    divergence != null &&
    divergence >= config.DIVERGENCE_GATE.route_threshold
  ) {
    const severe = divergence >= config.DIVERGENCE_GATE.pause_threshold;
    return {
      id: 'F',
      fired: true,
      action: severe ? 'pause' : 'route_to_kata',
      reason: severe ? 'severe_divergence' : 'overfit_decay',
      obstacle: 'overfit_decay',
      details: `Divergence ${(divergence * 100).toFixed(0)}%${severe ? ' (severe — pausing)' : ''}`,
    };
  }
  return { id: 'F', fired: false, action: 'route_to_kata', reason: '' };
}

// ─── Trigger G: Regime Collapse ─────────────────────────────────────

export function evaluateTriggerG(
  bot: BotSnapshot,
  archetype: ArchetypeConfig,
): TriggerResult {
  const byRegime = bot.metrics.by_regime;
  if (!byRegime) {
    return { id: 'G', fired: false, action: 'pause', reason: '' };
  }

  // Check anti-regime subsets
  for (const antiRegime of archetype.anti_regimes) {
    const regimeData = byRegime[antiRegime];
    if (!regimeData) continue;

    const trades = regimeData.n_trades ?? regimeData.trade_count ?? 0;
    const wr = regimeData.win_rate ?? 0;
    const pnl = regimeData.pnl_pct ?? regimeData.profit_pct ?? 0;

    // Sub-condition 1: anti-regime WR collapse
    if (trades >= 5 && wr < 0.15) {
      return {
        id: 'G',
        fired: true,
        action: 'pause',
        reason: 'regime_conditional_collapse',
        obstacle: 'regime_dependent',
        details: `${antiRegime}: WR ${(wr * 100).toFixed(0)}% at ${trades} trades`,
      };
    }
    // Sub-condition 2: anti-regime PnL collapse
    if (trades >= 8 && pnl < -2.0) {
      return {
        id: 'G',
        fired: true,
        action: 'pause',
        reason: 'regime_conditional_collapse',
        obstacle: 'regime_dependent',
        details: `${antiRegime}: P&L ${pnl.toFixed(1)}% at ${trades} trades`,
      };
    }
  }

  // Sub-condition 3: any regime total collapse
  for (const [regime, regimeData] of Object.entries(byRegime)) {
    if (!regimeData || typeof regimeData !== 'object') continue;
    const rd = regimeData as any;
    const trades = rd.n_trades ?? rd.trade_count ?? 0;
    const wr = rd.win_rate ?? 0;
    if (trades >= 10 && wr < 0.1) {
      return {
        id: 'G',
        fired: true,
        action: 'pause',
        reason: 'regime_conditional_collapse',
        obstacle: 'regime_dependent',
        details: `${regime}: WR ${(wr * 100).toFixed(0)}% at ${trades} trades`,
      };
    }
  }

  return { id: 'G', fired: false, action: 'pause', reason: '' };
}

// ─── Trigger H: Trial Deadline ──────────────────────────────────────

export function evaluateTriggerH(bot: BotSnapshot, now: Date): TriggerResult {
  if (bot.slot_state !== 'trial') {
    return { id: 'H', fired: false, action: 'retire', reason: '' };
  }

  const deadline = bot.trial_deadline ?? bot.validation_deadline;
  if (!deadline) {
    return { id: 'H', fired: false, action: 'retire', reason: '' };
  }

  if (now >= new Date(deadline)) {
    return {
      id: 'H',
      fired: true,
      action: 'retire', // Action determined by graduation evaluation
      reason: 'trial_deadline_expired',
      details: `Deadline was ${deadline}`,
    };
  }
  return { id: 'H', fired: false, action: 'retire', reason: '' };
}

// ─── Trigger I: Trial Early Eviction ────────────────────────────────

export function evaluateTriggerI(
  bot: BotSnapshot,
  config: ScoringConfig,
  now: Date,
): TriggerResult {
  if (bot.slot_state !== 'trial') {
    return { id: 'I', fired: false, action: 'retire', reason: '' };
  }

  const eviction = config.SLOT_MANAGEMENT.trial_early_eviction;
  const deployedAt = bot.deployed_at ? new Date(bot.deployed_at) : null;
  const { trade_count, win_rate, profit_pct } = bot.metrics;

  // Sub 1: 0 trades after 48h
  if (deployedAt && trade_count === 0) {
    const hoursDeployed =
      (now.getTime() - deployedAt.getTime()) / (1000 * 60 * 60);
    if (hoursDeployed >= eviction.zero_trades_hours) {
      return {
        id: 'I',
        fired: true,
        action: 'retire',
        reason: 'early_eviction:zero_trades',
        details: `0 trades after ${hoursDeployed.toFixed(0)}h`,
      };
    }
  }

  // Sub 2: <=1 trade after 72h
  if (deployedAt && trade_count <= eviction.near_dead_trades) {
    const hoursDeployed =
      (now.getTime() - deployedAt.getTime()) / (1000 * 60 * 60);
    if (hoursDeployed >= eviction.near_dead_hours) {
      return {
        id: 'I',
        fired: true,
        action: 'retire',
        reason: 'early_eviction:near_dead',
        details: `${trade_count} trades after ${hoursDeployed.toFixed(0)}h`,
      };
    }
  }

  // Sub 3: win_rate < 0.20 at 5+ trades
  if (
    trade_count >= eviction.min_win_rate_n &&
    win_rate < eviction.min_win_rate_floor
  ) {
    return {
      id: 'I',
      fired: true,
      action: 'retire',
      reason: 'early_eviction:low_win_rate',
      details: `WR ${(win_rate * 100).toFixed(0)}% at ${trade_count} trades`,
    };
  }

  // Sub 4: divergence >= 0.70
  if (
    bot.divergence_pct != null &&
    bot.divergence_pct >= eviction.max_divergence
  ) {
    return {
      id: 'I',
      fired: true,
      action: 'retire',
      reason: 'early_eviction:high_divergence',
      details: `Divergence ${(bot.divergence_pct * 100).toFixed(0)}%`,
    };
  }

  // Sub 5: pnl <= -5%
  if (profit_pct <= eviction.max_loss_pct) {
    return {
      id: 'I',
      fired: true,
      action: 'retire',
      reason: 'early_eviction:max_loss',
      details: `P&L ${profit_pct.toFixed(1)}%`,
    };
  }

  return { id: 'I', fired: false, action: 'retire', reason: '' };
}

// ─── Trigger J: Execution Collapse ──────────────────────────────────

export function evaluateTriggerJ(
  bot: BotSnapshot,
  config: ScoringConfig,
): TriggerResult {
  const { trade_count, execution_quality } = bot.metrics;
  if (!config.EXECUTION_GATES.enabled) {
    return { id: 'J', fired: false, action: 'pause', reason: '' };
  }
  if (
    trade_count < config.EXECUTION_GATES.min_trades_for_gate ||
    execution_quality == null
  ) {
    return { id: 'J', fired: false, action: 'pause', reason: '' };
  }

  if (execution_quality < config.EXECUTION_GATES.pause_threshold) {
    return {
      id: 'J',
      fired: true,
      action: 'pause',
      reason: 'execution_drag',
      details: `Execution quality ${(execution_quality * 100).toFixed(0)}% < ${(config.EXECUTION_GATES.pause_threshold * 100).toFixed(0)}% threshold`,
    };
  }
  return { id: 'J', fired: false, action: 'pause', reason: '' };
}

// ─── Evaluate All Triggers ──────────────────────────────────────────

export function evaluateAllTriggers(
  bot: BotSnapshot,
  archetype: ArchetypeConfig,
  config: ScoringConfig,
  now: Date,
): TriggerResult[] {
  return [
    evaluateTriggerA(bot, archetype, config),
    evaluateTriggerB(bot, config),
    evaluateTriggerC(bot, config),
    evaluateTriggerD(bot, config),
    evaluateTriggerE(bot, config),
    evaluateTriggerF(bot, config),
    evaluateTriggerG(bot, archetype),
    evaluateTriggerH(bot, now),
    evaluateTriggerI(bot, config, now),
    evaluateTriggerJ(bot, config),
  ];
}

export function getFirstFiredTrigger(
  triggers: TriggerResult[],
): TriggerResult | null {
  return triggers.find((t) => t.fired) ?? null;
}
