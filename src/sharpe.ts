/**
 * Sharpe ratio computation for live paper trading bots.
 *
 * TypeScript port of kata/lib/metrics.py:compute_sharpe_ratio() so live and
 * backtest figures stay numerically consistent.
 *
 * The backtest path passes DAILY returns into compute_sharpe_ratio and
 * annualizes with periods_per_year=365. This live path must do the same —
 * feeding per-trade returns into the same formula would over-annualize an
 * active strategy (a bot firing 10 trades in 2 days would yield an implied
 * "periods_per_year" of 1825 and a nonsense Sharpe in the 8-10 range).
 *
 * Pure utility — no I/O, no dependencies.
 */

/** Annualized Sharpe ratio from per-period returns (sample std dev, Bessel n-1). */
export function computeSharpe(
  returns: number[],
  periodsPerYear: number,
  riskFreeRate: number = 0,
): number {
  const n = returns.length;
  if (n < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const excess = mean - riskFreeRate / periodsPerYear;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const std = variance > 0 ? Math.sqrt(variance) : 0;
  if (std === 0) return 0;
  return (excess / std) * Math.sqrt(periodsPerYear);
}

/**
 * Bucket trades into a continuous daily return series.
 *
 * - Uses `close_date` when available, falling back to `open_date`.
 * - Sums each day's `profit_ratio` (additive approximation; fine for
 *   small per-trade returns and matches how kata builds daily_returns).
 * - Fills the span between first and last trade day with zero-return days
 *   so the std reflects real calendar-time variance, not just active days.
 */
function tradesToDailyReturns(
  trades: Array<{
    profit_ratio?: number;
    open_date?: string;
    close_date?: string;
  }>,
): number[] {
  const byDay = new Map<number, number>();
  for (const t of trades) {
    if (typeof t.profit_ratio !== 'number') continue;
    const dateStr = t.close_date || t.open_date;
    if (!dateStr) continue;
    const ts = Date.parse(dateStr);
    if (Number.isNaN(ts)) continue;
    // Floor to UTC day
    const day = Math.floor(ts / 86_400_000);
    byDay.set(day, (byDay.get(day) ?? 0) + t.profit_ratio);
  }
  if (byDay.size === 0) return [];

  const days = Array.from(byDay.keys());
  const minDay = Math.min(...days);
  const maxDay = Math.max(...days);

  const series: number[] = [];
  for (let d = minDay; d <= maxDay; d++) {
    series.push(byDay.get(d) ?? 0);
  }
  return series;
}

/**
 * Compute annualized Sharpe from a list of FreqTrade trade objects.
 *
 * Requires at least 3 calendar days of trading history with at least 2
 * non-zero days — below that, the sample is too small for the figure to
 * be statistically meaningful and we return 0 (shown as "—" in the UI).
 *
 * Result is clamped to [-10, 10] as a sanity cap.
 */
export function computeTradeSharpe(
  trades: Array<{
    profit_ratio?: number;
    open_date?: string;
    close_date?: string;
  }>,
): number {
  if (!trades || trades.length < 2) return 0;

  const dailyReturns = tradesToDailyReturns(trades);
  if (dailyReturns.length < 3) return 0;

  const nonZeroDays = dailyReturns.filter((r) => r !== 0).length;
  if (nonZeroDays < 2) return 0;

  const sharpe = computeSharpe(dailyReturns, 365);

  // Sanity clamp — anything outside [-10, 10] is almost certainly a
  // small-sample artifact, not a real edge.
  if (!Number.isFinite(sharpe)) return 0;
  if (sharpe > 10) return 10;
  if (sharpe < -10) return -10;
  return sharpe;
}

/**
 * Build a daily cumulative equity curve from FreqTrade trade objects.
 *
 * Returns an array of {date, cumulative_pnl_pct} points, one per UTC day
 * from first to last trade day, where cumulative_pnl_pct is the running
 * sum of profit_ratio (in %) up to and including that day.
 *
 * Same additive convention as tradesToDailyReturns — fine for small
 * per-trade returns and matches how the kata builds equity curves.
 */
export function computeDailyEquityCurve(
  trades: Array<{
    profit_ratio?: number;
    open_date?: string;
    close_date?: string;
  }>,
): Array<{ date: string; cumulative_pnl_pct: number }> {
  const byDay = new Map<number, number>();
  for (const t of trades) {
    if (typeof t.profit_ratio !== 'number') continue;
    const dateStr = t.close_date || t.open_date;
    if (!dateStr) continue;
    const ts = Date.parse(dateStr);
    if (Number.isNaN(ts)) continue;
    const day = Math.floor(ts / 86_400_000);
    byDay.set(day, (byDay.get(day) ?? 0) + t.profit_ratio);
  }
  if (byDay.size === 0) return [];

  const days = Array.from(byDay.keys());
  const minDay = Math.min(...days);
  const maxDay = Math.max(...days);

  const series: Array<{ date: string; cumulative_pnl_pct: number }> = [];
  let cum = 0;
  for (let d = minDay; d <= maxDay; d++) {
    cum += byDay.get(d) ?? 0;
    const dateStr = new Date(d * 86_400_000).toISOString().slice(0, 10);
    series.push({ date: dateStr, cumulative_pnl_pct: cum * 100 });
  }
  return series;
}
