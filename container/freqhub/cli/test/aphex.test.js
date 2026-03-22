import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeAphexScore } from '../src/lib/aphex.js';

describe('Aphex Score', () => {
  const highSharpeAtt = {
    total_trades: 6,
    walk_forward_sharpe: 18.93,
    win_rate: 0.833,
    sortino_ratio: 25.0,
    calmar_ratio: 1.5,
    expectancy: 0.8,
    profit_factor: 4.2,
    cagr: 45.0,
    max_drawdown: 0.03,
    avg_profit_pct: 3.5,
    rejection_rate: 5.0,
    per_window_sharpes: [20.0, 0.5, 15.0, -1.0, 25.0, 2.0],
  };
  const highSharpeGenome = {
    timeframe: '1h',
    risk: { stop_loss: { params: { pct: 0.04 } } },
  };

  const solidAtt = {
    total_trades: 200,
    walk_forward_sharpe: 1.2,
    win_rate: 0.58,
    sortino_ratio: 1.5,
    calmar_ratio: 0.8,
    expectancy: 0.25,
    profit_factor: 1.65,
    cagr: 22.0,
    max_drawdown: 0.14,
    avg_profit_pct: 0.8,
    rejection_rate: 10.0,
    per_window_sharpes: [1.1, 1.3, 1.0, 1.2, 1.4, 1.1],
  };
  const solidGenome = {
    timeframe: '4h',
    risk: { stop_loss: { params: { pct: 0.05 } } },
  };

  it('high Sharpe + low trades scores below 50', () => {
    const result = computeAphexScore(highSharpeAtt, highSharpeGenome);
    assert.ok(
      result.aphex_score < 50,
      `Score ${result.aphex_score} should be < 50 for 6 trades`
    );
    assert.ok(
      ['experimental', 'viable'].includes(result.tier),
      `Tier ${result.tier} should be experimental or viable`
    );
    // Trade count penalty must be applied
    assert.ok(
      result.components.validation_penalty <= -10,
      `Validation penalty ${result.components.validation_penalty} should be <= -10`
    );
  });

  it('solid strategy scores between 55 and 80', () => {
    const result = computeAphexScore(solidAtt, solidGenome);
    assert.ok(
      result.aphex_score >= 55,
      `Score ${result.aphex_score} should be >= 55`
    );
    assert.ok(
      result.aphex_score <= 80,
      `Score ${result.aphex_score} should be <= 80`
    );
    assert.ok(
      ['strong', 'viable'].includes(result.tier),
      `Tier ${result.tier} should be strong or viable`
    );
    // No validation penalties
    assert.strictEqual(result.components.validation_penalty, 0);
  });

  it('solid strategy scores higher than high Sharpe + low trades', () => {
    const highSharpe = computeAphexScore(highSharpeAtt, highSharpeGenome);
    const solid = computeAphexScore(solidAtt, solidGenome);
    assert.ok(
      solid.aphex_score > highSharpe.aphex_score,
      `Solid (${solid.aphex_score}) should rank above high-Sharpe (${highSharpe.aphex_score})`
    );
  });

  it('handles missing/null fields gracefully', () => {
    const minimal = {
      total_trades: 100,
      walk_forward_sharpe: 1.0,
      win_rate: 0.55,
      max_drawdown: 0.1,
      profit_factor: 1.5,
    };
    const genome = { timeframe: '1h', risk: { stop_loss: { params: { pct: 0.05 } } } };
    const result = computeAphexScore(minimal, genome);
    assert.ok(result.aphex_score >= 0 && result.aphex_score <= 100);
    assert.ok(typeof result.tier === 'string');
  });

  it('handles sortino=-100 sentinel', () => {
    const att = {
      total_trades: 100,
      walk_forward_sharpe: 1.0,
      win_rate: 0.55,
      sortino_ratio: -100,
      max_drawdown: 0.1,
      profit_factor: 1.5,
    };
    const result = computeAphexScore(att, {});
    // sortino=-100 should contribute 0, not crash or go negative
    assert.ok(result.components.risk_adjusted >= 0);
  });

  it('applies tight trailing stop penalty only on non-short timeframes', () => {
    const att = { total_trades: 100, walk_forward_sharpe: 1.0, win_rate: 0.55, max_drawdown: 0.1, profit_factor: 1.5 };
    const genomeShort = { timeframe: '15m', risk: { stop_loss: { params: { pct: 0.05, trailing_stop_positive: 0.005 } } } };
    const genome1h = { timeframe: '1h', risk: { stop_loss: { params: { pct: 0.05, trailing_stop_positive: 0.005 } } } };

    const short = computeAphexScore(att, genomeShort);
    const hourly = computeAphexScore(att, genome1h);

    // 15m should NOT get trailing stop penalty, 1h SHOULD
    assert.ok(
      short.components.validation_penalty > hourly.components.validation_penalty,
      `15m penalty (${short.components.validation_penalty}) should be less severe than 1h (${hourly.components.validation_penalty})`
    );
  });
});
