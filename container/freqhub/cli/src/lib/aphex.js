/**
 * Aphex Score — composite 0-100 scoring for strategy quality.
 *
 * Replaces raw Sharpe as the leaderboard sort key. Combines positive
 * metrics (trade performance, risk-adjusted returns, strategy quality,
 * stoploss quality) with penalty metrics (drawdown, rejection, validation).
 */

// --- Positive metric scorers ---

function scoreTrades(trades) {
  return Math.min(9, (trades / 300) * 9);
}

function scoreAvgProfit(avgProfitPct) {
  const clamped = Math.max(-5, Math.min(5, avgProfitPct));
  return Math.max(0, ((clamped + 5) / 10) * 26);
}

function scoreWinRate(winRatePct) {
  return (winRatePct / 100) * 24;
}

function scoreSharpe(sharpe) {
  return Math.min(7, (Math.max(0, sharpe) / 2) * 7);
}

function scoreSortino(sortino) {
  return Math.min(7, (Math.max(0, sortino) / 3) * 7);
}

function scoreCalmar(calmar) {
  return Math.min(7, (Math.max(0, calmar) / 1.5) * 7);
}

function scoreExpectancy(expectancy) {
  return Math.min(7, (Math.max(0, expectancy) / 0.5) * 7);
}

function scoreProfitFactor(pf) {
  if (pf <= 1) return 0;
  return Math.min(9, ((pf - 1) / 1.5) * 9);
}

function scoreCagr(cagrPct) {
  return Math.min(10, (Math.max(0, cagrPct) / 100) * 10);
}

function scoreStoploss(stoplossPercent) {
  if (stoplossPercent == null || stoplossPercent === 0) return 0;
  if (stoplossPercent >= 1 && stoplossPercent <= 10) return 7;
  if (stoplossPercent > 10 && stoplossPercent <= 20) return 3.5;
  return 1;
}

// --- Penalty scorers ---

function penaltyDrawdown(drawdownPct) {
  return -Math.min(25, (drawdownPct / 50) * 25);
}

function penaltyRejection(rejectionRatePct) {
  return -Math.min(25, (rejectionRatePct / 100) * 25);
}

function validationPenalties(attestation, genome) {
  let penalty = 0;

  // Tight trailing stop (except on short timeframes where it's legitimate)
  const shortTimeframes = ['1m', '3m', '5m', '15m'];
  const trailingPct = getTrailingStopPct(genome);
  const timeframe = genome.timeframe || '';
  if (trailingPct != null && trailingPct < 1 && !shortTimeframes.includes(timeframe)) {
    penalty -= 15;
  }

  // Low trade count — graduated penalty
  const trades = attestation.total_trades || 0;
  if (trades < 10) {
    penalty -= 35;
  } else if (trades < 30) {
    penalty -= 20;
  } else if (trades < 50) {
    penalty -= 10;
  }

  // Excessive signal rejection
  if ((attestation.rejection_rate || 0) > 50) {
    penalty -= 10;
  }

  // Walk-forward inconsistency
  if (attestation.per_window_sharpes && Array.isArray(attestation.per_window_sharpes)) {
    const sharpes = attestation.per_window_sharpes;
    if (sharpes.length > 1) {
      const mean = sharpes.reduce((a, b) => a + b, 0) / sharpes.length;
      const variance = sharpes.reduce((a, s) => a + (s - mean) ** 2, 0) / sharpes.length;
      const stddev = Math.sqrt(variance);
      if (stddev > 1.0) {
        penalty -= 10;
      }
    }
  }

  return penalty;
}

// --- Reliability bonus ---

function reliabilityBonus(trades) {
  if (trades >= 200) return 5;
  if (trades >= 100) return 3;
  return 0;
}

// --- Field extractors ---

function getStoplossPercent(genome) {
  // genome.risk.stop_loss.params.pct is stored as fraction (0.05 = 5%)
  const pct = genome?.risk?.stop_loss?.params?.pct;
  if (pct != null) return Math.abs(pct) * 100;
  return null;
}

function getTrailingStopPct(genome) {
  // trailing_stop_positive is stored as fraction (0.01 = 1%)
  const pct = genome?.risk?.stop_loss?.params?.trailing_stop_positive;
  if (pct != null) return Math.abs(pct) * 100;
  return null;
}

function sanitize(val, sentinel) {
  if (val == null || val === sentinel) return 0;
  if (typeof val === 'number' && !isFinite(val)) return 0;
  return val;
}

// --- Main scoring function ---

/**
 * Compute Aphex Score (0-100) from attestation metrics and genome params.
 *
 * @param {object} attestation - Flat attestation data. Accepts both
 *   fraction-based fields (win_rate=0.58, max_drawdown=0.14) and
 *   percentage-based fields. Detects format automatically.
 * @param {object} genome - Genome body (signals, risk, timeframe, etc.)
 * @returns {{ aphex_score: number, tier: string, components: object }}
 */
export function computeAphexScore(attestation, genome) {
  const att = attestation || {};
  const gen = genome || {};

  // Normalize fields — attestation stores win_rate/max_drawdown as fractions
  const totalTrades = att.total_trades || 0;
  const winRatePct = (att.win_rate || 0) <= 1 ? (att.win_rate || 0) * 100 : (att.win_rate || 0);
  const sharpe = sanitize(att.walk_forward_sharpe ?? att.sharpe_ratio, null);
  const sortino = sanitize(att.sortino_ratio, -100);
  const calmar = sanitize(att.calmar_ratio, null);
  const expectancy = sanitize(att.expectancy, null);
  const profitFactor = sanitize(att.profit_factor, null);
  const maxDrawdownPct = (att.max_drawdown || 0) <= 1 ? (att.max_drawdown || 0) * 100 : (att.max_drawdown || 0);
  const profitTotal = att.profit_total || 0;

  // Derived fields
  const avgProfitPct = att.avg_profit_pct != null
    ? att.avg_profit_pct
    : (totalTrades > 0 ? (profitTotal / totalTrades) * 100 : 0);
  const cagr = att.cagr || 0;
  const rejectionRate = att.rejection_rate || 0;

  // Positive metrics
  const tradePerf =
    scoreTrades(totalTrades) +
    scoreAvgProfit(avgProfitPct) +
    scoreWinRate(winRatePct);

  const riskAdj =
    scoreSharpe(sharpe) +
    scoreSortino(sortino) +
    scoreCalmar(calmar) +
    scoreExpectancy(expectancy);

  const quality =
    scoreProfitFactor(profitFactor) +
    scoreCagr(cagr);

  const stoploss = scoreStoploss(getStoplossPercent(gen));

  // Penalties
  const ddPenalty = penaltyDrawdown(maxDrawdownPct);
  const rejPenalty = penaltyRejection(rejectionRate);
  const valPenalty = validationPenalties(att, gen);

  const relBonus = reliabilityBonus(totalTrades);

  const rawScore = tradePerf + riskAdj + quality + stoploss +
    ddPenalty + rejPenalty + valPenalty + relBonus;

  const score = Math.max(0, Math.min(100, rawScore));

  let tier;
  if (score >= 80) tier = 'exceptional';
  else if (score >= 60) tier = 'strong';
  else if (score >= 40) tier = 'viable';
  else if (score >= 20) tier = 'experimental';
  else tier = 'poor';

  return {
    aphex_score: Math.round(score * 10) / 10,
    tier,
    components: {
      trade_performance: Math.round(tradePerf * 10) / 10,
      risk_adjusted: Math.round(riskAdj * 10) / 10,
      strategy_quality: Math.round(quality * 10) / 10,
      stoploss_quality: Math.round(stoploss * 10) / 10,
      drawdown_penalty: Math.round(ddPenalty * 10) / 10,
      rejection_penalty: Math.round(rejPenalty * 10) / 10,
      validation_penalty: Math.round(valPenalty * 10) / 10,
      reliability_bonus: Math.round(relBonus * 10) / 10,
    },
  };
}
