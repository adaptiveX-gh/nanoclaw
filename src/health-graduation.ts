/**
 * Graduation gate evaluation — pure deterministic functions.
 * Evaluates 6 primary gates + overfitting + execution gates.
 * Handles 3 deadline cases + early graduation.
 * No I/O, no side effects. Phase 2 of the deterministic health ticker plan.
 */

import type {
  BotSnapshot,
  GateResult,
  GraduationResult,
  ScoringConfig,
  ArchetypeConfig,
} from './health-types.js';
import { isLowWrArchetype } from './health-types.js';

// ─── Primary Gate Evaluation ────────────────────────────────────────

export function evaluatePrimaryGates(
  bot: BotSnapshot,
  archetype: ArchetypeConfig,
  config: ScoringConfig,
): GateResult[] {
  const gates: GateResult[] = [];
  const gg = config.SLOT_MANAGEMENT.graduation_gates;
  const tf = bot.timeframe;

  // 1. min_trades (from archetypes.yaml paper_validation or scoring-config fallback)
  const minTrades =
    archetype.paper_validation?.[tf]?.min_trades ?? gg.min_trades[tf] ?? 10;
  gates.push({
    name: 'min_trades',
    required: minTrades,
    actual: bot.metrics.trade_count,
    met: bot.metrics.trade_count >= minTrades,
  });

  // 2. min_favorable_sharpe
  gates.push({
    name: 'min_favorable_sharpe',
    required: gg.min_favorable_sharpe,
    actual: bot.metrics.sharpe,
    met: bot.metrics.sharpe >= gg.min_favorable_sharpe,
  });

  // 3. min_win_rate (archetype-aware)
  const wrThreshold = isLowWrArchetype(bot.archetype ?? '')
    ? config.GRADUATION_GATES.min_win_rate_low_rr_archetypes
    : gg.min_win_rate;
  gates.push({
    name: 'min_win_rate',
    required: wrThreshold,
    actual: bot.metrics.win_rate,
    met: bot.metrics.win_rate >= wrThreshold,
  });

  // 4. min_risk_reward_ratio
  const rr =
    bot.metrics.avg_win_pct != null &&
    bot.metrics.avg_loss_pct != null &&
    bot.metrics.avg_loss_pct > 0
      ? bot.metrics.avg_win_pct / bot.metrics.avg_loss_pct
      : null;
  gates.push({
    name: 'min_risk_reward_ratio',
    required: gg.min_risk_reward_ratio,
    actual: rr,
    met: rr != null ? rr >= gg.min_risk_reward_ratio : null,
  });

  // 5. max_consecutive_losses
  gates.push({
    name: 'max_consecutive_losses',
    required: gg.max_consecutive_losses,
    actual: bot.metrics.max_consecutive_losses,
    met:
      bot.metrics.max_consecutive_losses != null
        ? bot.metrics.max_consecutive_losses <= gg.max_consecutive_losses
        : null,
  });

  // 6. max_divergence
  gates.push({
    name: 'max_divergence',
    required: gg.max_divergence,
    actual: bot.divergence_pct,
    met:
      bot.divergence_pct != null
        ? bot.divergence_pct <= gg.max_divergence
        : null,
  });

  return gates;
}

// ─── Overfitting Gate ───────────────────────────────────────────────

export interface OverfittingCheckResult {
  passed: boolean;
  action: 'continue' | 'retire' | 'extend';
  reason: string;
}

export function evaluateOverfittingGate(
  bot: BotSnapshot,
  config: ScoringConfig,
  wfoMetrics: {
    dsr?: number;
    pbo?: number;
    n_strategies_tried?: number;
  } | null,
): OverfittingCheckResult {
  const og = config.OVERFITTING_GATES;
  if (!og.enabled) {
    return {
      passed: true,
      action: 'continue',
      reason: 'overfitting_gate_disabled',
    };
  }

  if (!wfoMetrics) {
    return { passed: true, action: 'continue', reason: 'no_wfo_metrics' };
  }

  const { dsr, pbo } = wfoMetrics;

  // PBO > eviction threshold → immediate retire
  if (pbo != null && pbo > og.pbo_evict) {
    return {
      passed: false,
      action: 'retire',
      reason: 'overfit_pbo_above_evict',
    };
  }

  // Need sufficient trades for DSR evaluation
  if (bot.metrics.trade_count < og.min_trades_for_dsr) {
    return {
      passed: true,
      action: 'continue',
      reason: 'insufficient_trades_for_dsr',
    };
  }

  // DSR below threshold
  if (dsr != null && dsr < og.dsr_threshold) {
    return {
      passed: false,
      action: 'extend',
      reason: 'low_dsr',
    };
  }

  // PBO above warning threshold
  if (pbo != null && pbo > og.pbo_max) {
    return {
      passed: false,
      action: 'extend',
      reason: 'high_pbo',
    };
  }

  return {
    passed: true,
    action: 'continue',
    reason: 'overfitting_gates_passed',
  };
}

// ─── Execution Quality Gate ─────────────────────────────────────────

export function evaluateExecutionGate(
  bot: BotSnapshot,
  config: ScoringConfig,
): { passed: boolean; reason: string } {
  const eg = config.EXECUTION_GATES;
  if (!eg.enabled) {
    return { passed: true, reason: 'execution_gate_disabled' };
  }

  if (
    bot.metrics.execution_quality == null ||
    bot.metrics.trade_count < eg.min_trades_for_gate
  ) {
    return { passed: true, reason: 'insufficient_data_for_execution_gate' };
  }

  if (bot.metrics.execution_quality < eg.min_execution_quality) {
    return { passed: false, reason: 'low_execution_quality' };
  }

  return { passed: true, reason: 'execution_gate_passed' };
}

// ─── R:R Inversion Check (pre-graduation) ──────────────────────────

function hasRRInversion(bot: BotSnapshot): boolean {
  return (
    bot.metrics.win_rate > 0.5 &&
    bot.metrics.avg_win_pct != null &&
    bot.metrics.avg_loss_pct != null &&
    bot.metrics.avg_win_pct < bot.metrics.avg_loss_pct
  );
}

// ─── Full Graduation Evaluation ─────────────────────────────────────

export function evaluateGraduation(
  bot: BotSnapshot,
  archetype: ArchetypeConfig,
  config: ScoringConfig,
  now: Date,
  wfoMetrics: {
    dsr?: number;
    pbo?: number;
    n_strategies_tried?: number;
  } | null,
): GraduationResult {
  const gates = evaluatePrimaryGates(bot, archetype, config);
  const allMet = gates.every((g) => g.met === true || g.met === null);

  const gg = config.SLOT_MANAGEMENT.graduation_gates;
  const tf = bot.timeframe;
  const minTrades =
    archetype.paper_validation?.[tf]?.min_trades ?? gg.min_trades[tf] ?? 10;

  // ─── Early graduation check (before deadline) ──────────────────
  if (bot.slot_state === 'trial') {
    const deadline = bot.trial_deadline ?? bot.validation_deadline;
    const beforeDeadline = deadline ? now < new Date(deadline) : false;

    if (beforeDeadline && allMet) {
      // Check overfitting + execution gates before early graduation
      const overfitCheck = evaluateOverfittingGate(bot, config, wfoMetrics);
      if (overfitCheck.action === 'retire') {
        return {
          gates,
          all_met: false,
          action: 'retire',
          reason: overfitCheck.reason,
        };
      }
      if (!overfitCheck.passed) {
        return {
          gates,
          all_met: true,
          action: 'none',
          reason: 'overfitting_block',
        };
      }

      const execCheck = evaluateExecutionGate(bot, config);
      if (!execCheck.passed) {
        return {
          gates,
          all_met: true,
          action: 'none',
          reason: 'execution_quality_block',
        };
      }

      return {
        gates,
        all_met: true,
        action: 'graduate',
        reason: 'early_graduation',
      };
    }
  }

  // ─── Deadline graduation (Trigger H fired) ─────────────────────

  // Case 3: Zero trades at deadline
  if (bot.metrics.trade_count === 0) {
    const totalTicks = bot.ticks_signals_on + bot.ticks_signals_off;
    const signalsOnPct = totalTicks > 0 ? bot.ticks_signals_on / totalTicks : 0;

    if (signalsOnPct < 0.25) {
      // Regime-blocked — strategy never had a fair chance
      if (!bot.regime_extension) {
        return {
          gates,
          all_met: false,
          action: 'extend_regime',
          reason: 'regime_blocked_no_trades',
        };
      }
      return {
        gates,
        all_met: false,
        action: 'retire',
        reason: 'no_signals_after_regime_extension',
      };
    }
    return {
      gates,
      all_met: false,
      action: 'retire',
      reason: 'no_signals_despite_favorable_regime',
    };
  }

  // Case 2: Insufficient trades (some but < min)
  if (bot.metrics.trade_count < minTrades) {
    if (!bot.extended) {
      return {
        gates,
        all_met: false,
        action: 'extend',
        reason: 'insufficient_trades',
      };
    }
    return {
      gates,
      all_met: false,
      action: 'retire',
      reason: 'insufficient_trades_after_extension',
    };
  }

  // Case 1: Enough trades — evaluate all gates

  // R:R inversion check before gate decision
  if (hasRRInversion(bot) && !bot.rr_extension) {
    return {
      gates,
      all_met: false,
      action: 'investigate_rr',
      reason: 'rr_inversion_at_graduation',
    };
  }

  // Overfitting gate
  const overfitCheck = evaluateOverfittingGate(bot, config, wfoMetrics);
  if (overfitCheck.action === 'retire') {
    return {
      gates,
      all_met: false,
      action: 'retire',
      reason: overfitCheck.reason,
    };
  }
  if (overfitCheck.action === 'extend') {
    // Check if already extended for DSR
    if (bot.extended) {
      return {
        gates,
        all_met: false,
        action: 'retire',
        reason: `${overfitCheck.reason}_after_extension`,
      };
    }
    return {
      gates,
      all_met: false,
      action: 'extend',
      reason: overfitCheck.reason,
    };
  }

  // Execution gate
  const execCheck = evaluateExecutionGate(bot, config);
  if (!execCheck.passed) {
    return {
      gates,
      all_met: true,
      action: 'none',
      reason: 'execution_quality_block',
    };
  }

  if (allMet) {
    return {
      gates,
      all_met: true,
      action: 'graduate',
      reason: 'all_gates_passed',
    };
  }

  // Determine specific failure reason
  const sharpGate = gates.find((g) => g.name === 'min_favorable_sharpe');
  if (sharpGate && sharpGate.met === false) {
    return { gates, all_met: false, action: 'retire', reason: 'low_sharpe' };
  }

  const wrGate = gates.find((g) => g.name === 'min_win_rate');
  if (wrGate && wrGate.met === false) {
    return {
      gates,
      all_met: false,
      action: 'retire',
      reason: 'low_win_rate_at_graduation',
    };
  }

  const rrGate = gates.find((g) => g.name === 'min_risk_reward_ratio');
  if (rrGate && rrGate.met === false) {
    return {
      gates,
      all_met: false,
      action: 'retire',
      reason: 'poor_rr_ratio_at_graduation',
    };
  }

  const consLossGate = gates.find((g) => g.name === 'max_consecutive_losses');
  if (consLossGate && consLossGate.met === false) {
    return {
      gates,
      all_met: false,
      action: 'retire',
      reason: 'consecutive_losses_at_graduation',
    };
  }

  const divGate = gates.find((g) => g.name === 'max_divergence');
  if (divGate && divGate.met === false) {
    return {
      gates,
      all_met: false,
      action: 'retire',
      reason: 'high_divergence_at_graduation',
    };
  }

  return { gates, all_met: false, action: 'retire', reason: 'gates_failed' };
}
