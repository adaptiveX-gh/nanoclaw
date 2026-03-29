/**
 * Stdio MCP Server for Orderflow / Market Regime data
 * Standalone process providing 5 tools for real-time regime classification,
 * microstructure analysis, and opportunity scanning via orderflow.tradev.app.
 * No authentication required.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = (process.env.ORDERFLOW_API_URL || 'https://orderflow.tradev.app').replace(/\/+$/, '');

function log(message: string): void {
  console.error(`[ORDERFLOW] ${message}`);
}

async function apiFetch<T>(path: string, timeout = 15000): Promise<T> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
    });
    clearTimeout(id);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Orderflow API ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

// ── Normalize helpers ──────────────────────────────────────────────────

type MarketRegime = 'CHAOS' | 'EFFICIENT_TREND' | 'COMPRESSION' | 'TRANQUIL';

interface RegimeData {
  symbol: string;
  horizon: string;
  regime: MarketRegime;
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  direction_score: number;
  conviction: number;
  conviction_level: string;
  volatility_percentile: number;
  liquidity_percentile: number;
  confidence: number;
  strategy_recommendation: string;
}

function getStrategyRecommendation(regime: MarketRegime): string {
  const rec: Record<MarketRegime, string> = {
    CHAOS: 'Reduce size, wider stops, or sit out. High vol with low liquidity.',
    EFFICIENT_TREND: 'Ideal for trend-following and momentum. Ride the trend.',
    COMPRESSION: 'Market coiling — prepare for breakout or wait for confirmation.',
    TRANQUIL: 'Good for mean reversion and range trading. Fade extremes.',
  };
  return rec[regime] || 'Monitor conditions closely.';
}

function normalizeRegime(data: Record<string, unknown>): RegimeData {
  const regime = (data.regime as MarketRegime) || 'TRANQUIL';
  return {
    symbol: (data.symbol as string) || '',
    horizon: (data.horizon as string) || 'H3_MEDIUM',
    regime,
    direction: (data.direction as 'BULLISH' | 'BEARISH' | 'NEUTRAL') || 'NEUTRAL',
    direction_score: (data.direction_score as number) ?? (data.directionScore as number) ?? 0,
    conviction: (data.conviction as number) ?? (data.conviction_score as number) ?? (data.convictionScore as number) ?? 0,
    conviction_level: (data.conviction_level as string) ?? (data.convictionLevel as string) ?? 'LOW',
    volatility_percentile: (data.volatility_percentile as number) ?? (data.volatilityPercentile as number) ?? 50,
    liquidity_percentile: (data.liquidity_percentile as number) ?? (data.liquidityPercentile as number) ?? 50,
    confidence: (data.confidence as number) ?? 0,
    strategy_recommendation: getStrategyRecommendation(regime),
  };
}

interface MicrostructureReading {
  symbol: string;
  pair: string;
  horizon: string;
  aggressorRatio: number;
  aggressorBias: string;
  whaleFlowDelta: number;
  whaleFlowMagnitude: number;
  whaleBias: string;
  bookImbalance: number;
  bookImbalanceEma: number;
  bookBias: string;
  timestamp: string;
  dataAge: number;
}

function normalizeMicrostructure(data: Record<string, unknown>): MicrostructureReading {
  const aggressorRatio = (data.aggressor_ratio as number) ?? (data.aggressorRatio as number) ?? 0.5;
  const whaleFlowDelta = (data.whale_flow_delta as number) ?? (data.whaleFlowDelta as number) ?? 0;
  const whaleFlowMagnitude = (data.whale_flow_magnitude as number) ?? (data.whaleFlowMagnitude as number) ?? 0;
  const bookImbalance = (data.book_imbalance as number) ?? (data.bookImbalance as number) ?? 0;
  const bookImbalanceEma = (data.book_imbalance_ema as number) ?? (data.bookImbalanceEma as number) ?? 0;
  const symbol = (data.symbol as string) || '';

  return {
    symbol,
    pair: `${symbol}/USDT`,
    horizon: (data.horizon as string) || 'H3_MEDIUM',
    aggressorRatio,
    aggressorBias: aggressorRatio > 0.55 ? 'accumulation' : aggressorRatio < 0.45 ? 'distribution' : 'neutral',
    whaleFlowDelta,
    whaleFlowMagnitude,
    whaleBias: whaleFlowDelta > 0 ? 'buying' : whaleFlowDelta < 0 ? 'selling' : 'neutral',
    bookImbalance,
    bookImbalanceEma,
    bookBias: bookImbalanceEma > 0.15 ? 'bid_heavy' : bookImbalanceEma < -0.15 ? 'ask_heavy' : 'balanced',
    timestamp: (data.timestamp as string) || new Date().toISOString(),
    dataAge: (data.data_age as number) ?? (data.dataAge as number) ?? 0,
  };
}

// ── MCP Server ─────────────────────────────────────────────────────────

const server = new McpServer({ name: 'orderflow', version: '1.0.0' });

// Tool 1: Fetch regime for symbols at a given horizon
server.tool(
  'orderflow_fetch_regime',
  `Fetch market regime classification for one or more symbols at a specific horizon.
Returns: regime (EFFICIENT_TREND/TRANQUIL/COMPRESSION/CHAOS), direction, conviction (0-100), confidence, volatility/liquidity percentiles.
Horizons: H1_MICRO (5m-15m), H2_SHORT (1h-4h), H3_MEDIUM (4h-1d), H4_LONG (1d-1w), H5_MACRO (1w+).`,
  {
    symbols: z.array(z.string()).describe('List of symbols (e.g. ["BTC", "ETH", "SOL"])'),
    horizon: z.enum(['H1_MICRO', 'H2_SHORT', 'H3_MEDIUM', 'H4_LONG', 'H5_MACRO']).default('H3_MEDIUM').describe('Time horizon'),
  },
  async (args) => {
    try {
      const params = new URLSearchParams({ symbols: args.symbols.join(','), horizon: args.horizon });
      const response = await apiFetch<{ regimes: Record<string, unknown>[] }>(`/api/v1/regime?${params}`);
      const regimes = (response.regimes || []).map(normalizeRegime);
      log(`Fetched regime for ${regimes.length} symbols at ${args.horizon}`);
      return ok({
        success: true,
        horizon: args.horizon,
        regimes,
        summary: `Regime data for ${regimes.length} symbols at ${args.horizon}`,
      });
    } catch (e) {
      return err(`Failed to fetch regime: ${(e as Error).message}`);
    }
  },
);

// Tool 2: Fetch all horizons for a single symbol
server.tool(
  'orderflow_fetch_all_horizons',
  `Fetch regime data across ALL 5 horizons for a single symbol.
Returns regime, direction, conviction at each horizon (H1_MICRO through H5_MACRO).
Use for comprehensive multi-timeframe analysis of a single asset.`,
  {
    symbol: z.string().describe('Symbol (e.g. "BTC", "ETH")'),
  },
  async (args) => {
    try {
      const response = await apiFetch<{ horizons: Record<string, Record<string, unknown>> }>(`/api/v1/regime/${args.symbol}/all-horizons`);
      const horizons: Record<string, RegimeData> = {};
      for (const h of ['H1_MICRO', 'H2_SHORT', 'H3_MEDIUM', 'H4_LONG', 'H5_MACRO']) {
        if (response.horizons?.[h]) {
          horizons[h] = normalizeRegime(response.horizons[h]);
        }
      }
      log(`Fetched all horizons for ${args.symbol}`);
      return ok({
        success: true,
        symbol: args.symbol,
        horizons,
        summary: `Multi-horizon analysis for ${args.symbol}`,
      });
    } catch (e) {
      return err(`Failed to fetch all horizons: ${(e as Error).message}`);
    }
  },
);

// Tool 3: Fetch microstructure data (aggregated from signal + vpin endpoints)
server.tool(
  'orderflow_fetch_microstructure',
  `Fetch microstructure data for one or more symbols.
Returns: aggressor ratio, whale flow delta/magnitude, book imbalance, derived biases (accumulation/distribution, buying/selling, bid_heavy/ask_heavy), VPIN toxicity, and signal components.
Use for execution quality assessment and market depth analysis.`,
  {
    symbols: z.array(z.string()).describe('List of symbols (e.g. ["BTC", "ETH"])'),
    horizon: z.enum(['H1_MICRO', 'H2_SHORT', 'H3_MEDIUM', 'H4_LONG', 'H5_MACRO']).default('H3_MEDIUM').describe('Time horizon'),
  },
  async (args) => {
    try {
      const readings = await Promise.all(
        args.symbols.map(async (symbol) => {
          const [signalResult, vpinResult] = await Promise.allSettled([
            apiFetch<{
              symbol: string;
              horizon: string;
              signal_direction: string;
              signal_strength: number;
              entry_confidence: string;
              position_size_mult: number;
              components: Record<string, number>;
              updated_at: string;
            }>(`/api/v1/signal/${symbol}?horizon=${args.horizon}`),
            apiFetch<{
              symbol: string;
              vpin: number;
              is_elevated: boolean;
              is_extreme: boolean;
            }>(`/api/v1/vpin/${symbol}`),
          ]);

          const sig = signalResult.status === 'fulfilled' ? signalResult.value : null;
          const vpinData = vpinResult.status === 'fulfilled' ? vpinResult.value : null;

          if (!sig) {
            // Fallback: return neutral reading so scoring can proceed
            return normalizeMicrostructure({ symbol, horizon: args.horizon });
          }

          const c = sig.components;
          // delta_momentum: roughly -100..100 → normalize to 0..1 (0.5 = neutral)
          const rawMomentum = c.delta_momentum ?? 0;
          const aggressorRatio = Math.max(0, Math.min(1, (rawMomentum + 100) / 200));
          // large_trades: positive = buy-heavy, negative = sell-heavy
          const whaleFlowDelta = c.large_trades ?? 0;
          // imbalance_skew: roughly -100..100 → normalize to -1..1
          const bookImbalance = (c.imbalance_skew ?? 0) / 100;

          return {
            symbol,
            pair: `${symbol}/USDT`,
            horizon: sig.horizon,
            aggressorRatio: Math.round(aggressorRatio * 1000) / 1000,
            aggressorBias: aggressorRatio > 0.55 ? 'accumulation' : aggressorRatio < 0.45 ? 'distribution' : 'neutral',
            whaleFlowDelta: Math.round(whaleFlowDelta * 100) / 100,
            whaleFlowMagnitude: Math.round(Math.abs(whaleFlowDelta) * 100) / 100,
            whaleBias: whaleFlowDelta > 20 ? 'buying' : whaleFlowDelta < -20 ? 'selling' : 'neutral',
            bookImbalance: Math.round(bookImbalance * 1000) / 1000,
            bookImbalanceEma: Math.round(bookImbalance * 1000) / 1000,
            bookBias: bookImbalance > 0.15 ? 'bid_heavy' : bookImbalance < -0.15 ? 'ask_heavy' : 'balanced',
            vpin: vpinData?.vpin ?? null,
            vpinElevated: vpinData?.is_elevated ?? null,
            vpinExtreme: vpinData?.is_extreme ?? null,
            signalDirection: sig.signal_direction,
            signalStrength: sig.signal_strength,
            entryConfidence: sig.entry_confidence,
            positionSizeMult: sig.position_size_mult,
            components: c,
            timestamp: sig.updated_at,
            dataAge: Math.round((Date.now() - new Date(sig.updated_at).getTime()) / 1000),
          };
        }),
      );

      const valid = readings.filter((r) => !('error' in r));
      log(`Fetched microstructure for ${valid.length}/${args.symbols.length} symbols`);
      return ok({ success: true, readings });
    } catch (e) {
      return err(`Failed to fetch microstructure: ${(e as Error).message}`);
    }
  },
);

// Tool 4: Scan for high-conviction opportunities
server.tool(
  'orderflow_scan_opportunities',
  `Scan all tracked symbols across all horizons for high-conviction trading opportunities.
Returns opportunities ranked by conviction, split into EXTREME (80+) and HIGH (60-79) tiers.
Default symbols: BTC, ETH, SOL, XRP, DOGE, ADA, AVAX, LINK, DOT, MATIC, LTC, UNI, ATOM, ARB, OP, INJ, SUI, SEI, BNB, PEPE, APT, NEAR.`,
  {
    symbols: z.array(z.string()).optional().describe('Override symbol list (default: 22 major coins)'),
    min_conviction: z.number().min(0).max(100).default(60).describe('Minimum conviction threshold (0-100)'),
    horizons: z.array(z.enum(['H1_MICRO', 'H2_SHORT', 'H3_MEDIUM', 'H4_LONG', 'H5_MACRO'])).optional().describe('Override horizons to scan (default: all 5)'),
  },
  async (args) => {
    const symbols = args.symbols || [
      'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'MATIC',
      'LTC', 'UNI', 'ATOM', 'ARB', 'OP', 'INJ', 'SUI', 'SEI', 'BNB', 'PEPE', 'APT', 'NEAR',
    ];
    const horizons = args.horizons || ['H1_MICRO', 'H2_SHORT', 'H3_MEDIUM', 'H4_LONG', 'H5_MACRO'];

    try {
      const opportunities: RegimeData[] = [];
      for (const horizon of horizons) {
        try {
          const params = new URLSearchParams({ symbols: symbols.join(','), horizon });
          const response = await apiFetch<{ regimes: Record<string, unknown>[] }>(`/api/v1/regime?${params}`);
          for (const r of response.regimes || []) {
            const normalized = normalizeRegime(r);
            if (normalized.conviction >= args.min_conviction) {
              opportunities.push({ ...normalized, horizon });
            }
          }
        } catch {
          // skip failed horizon
        }
      }
      opportunities.sort((a, b) => b.conviction - a.conviction);
      const extreme = opportunities.filter(o => o.conviction >= 80);
      const high = opportunities.filter(o => o.conviction >= 60 && o.conviction < 80);

      const recommendation = extreme.length
        ? `Top: ${extreme[0].symbol} on ${extreme[0].horizon} — ${extreme[0].direction} with ${extreme[0].conviction}% conviction in ${extreme[0].regime}`
        : high.length
          ? `Top: ${high[0].symbol} on ${high[0].horizon} — ${high[0].direction} with ${high[0].conviction}% conviction`
          : 'No high conviction opportunities found at this time.';

      log(`Scan: ${extreme.length} extreme + ${high.length} high conviction across ${symbols.length} symbols × ${horizons.length} horizons`);
      return ok({
        success: true,
        total_scanned: symbols.length * horizons.length,
        opportunities_found: opportunities.length,
        extreme_conviction: extreme,
        high_conviction: high,
        summary: `Found ${extreme.length} EXTREME and ${high.length} HIGH conviction opportunities`,
        recommendation,
      });
    } catch (e) {
      return err(`Failed to scan opportunities: ${(e as Error).message}`);
    }
  },
);

// Tool 5: Check strategy-regime alignment
server.tool(
  'orderflow_check_alignment',
  `Check whether strategies are aligned with current market regimes.
Given a list of strategies (with their archetype and pairs), fetches current regimes and returns alignment status.
Archetype compatibility: trend_following/momentum → EFFICIENT_TREND, mean_reversion → TRANQUIL/COMPRESSION, range → TRANQUIL, breakout → COMPRESSION, scalping → TRANQUIL/EFFICIENT_TREND.`,
  {
    strategies: z.array(z.object({
      name: z.string().describe('Strategy name'),
      pairs: z.array(z.string()).describe('Trading pairs (e.g. ["BTC/USDT", "ETH/USDT"])'),
      type: z.string().optional().describe('Strategy archetype (trend_following, momentum, mean_reversion, range, breakout, scalping)'),
    })).describe('Strategies to check alignment for'),
  },
  async (args) => {
    try {
      // Collect unique symbols from pairs
      const allSymbols = new Set<string>();
      for (const s of args.strategies) {
        for (const pair of s.pairs || []) {
          const match = pair.match(/^([A-Z0-9]+)\//);
          allSymbols.add(match ? match[1] : pair.split('/')[0] || pair);
        }
      }

      const params = new URLSearchParams({ symbols: Array.from(allSymbols).join(','), horizon: 'H3_MEDIUM' });
      const response = await apiFetch<{ regimes: Record<string, unknown>[] }>(`/api/v1/regime?${params}`);
      const regimeMap: Record<string, RegimeData> = {};
      for (const r of (response.regimes || []).map(normalizeRegime)) {
        regimeMap[r.symbol] = r;
      }

      const compatibility: Record<string, string[]> = {
        trend_following: ['EFFICIENT_TREND'],
        momentum: ['EFFICIENT_TREND'],
        mean_reversion: ['TRANQUIL', 'COMPRESSION'],
        range: ['TRANQUIL'],
        breakout: ['COMPRESSION'],
        scalping: ['TRANQUIL', 'EFFICIENT_TREND'],
        carry_funding: ['TRANQUIL'],
        volatility_harvest: ['CHAOS', 'COMPRESSION'],
      };

      const results = args.strategies.map(strat => {
        const stratType = (strat.type || 'unknown').toLowerCase().replace(/[^a-z_]/g, '_');
        const compatibleRegimes = compatibility[stratType] || [];

        const coinAnalysis = (strat.pairs || []).map(pair => {
          const match = pair.match(/^([A-Z0-9]+)\//);
          const symbol = match ? match[1] : pair.split('/')[0] || pair;
          const regime = regimeMap[symbol];
          if (!regime) return { symbol, status: 'unknown', message: 'Regime data not available' };

          const isAligned = compatibleRegimes.includes(regime.regime);
          return {
            symbol,
            regime: regime.regime,
            direction: regime.direction,
            conviction: regime.conviction,
            is_aligned: isAligned,
            recommendation: isAligned && regime.conviction >= 60
              ? 'CONTINUE - Good alignment with high conviction'
              : isAligned
                ? 'CONTINUE WITH CAUTION - Aligned but low conviction'
                : regime.regime === 'CHAOS'
                  ? 'REDUCE or EXIT - Chaotic conditions'
                  : `REVIEW - ${regime.regime} may not suit ${strat.type || 'this'} strategy`,
          };
        });

        return {
          strategy: strat.name,
          type: strat.type || 'unknown',
          coins: coinAnalysis,
          overall_alignment: coinAnalysis.every((c: any) => c.is_aligned)
            ? 'FULLY_ALIGNED'
            : coinAnalysis.some((c: any) => c.is_aligned)
              ? 'PARTIALLY_ALIGNED'
              : 'MISALIGNED',
        };
      });

      log(`Checked alignment for ${args.strategies.length} strategies`);
      return ok({
        success: true,
        strategies: results,
        summary: `Analyzed ${args.strategies.length} strategies against current regimes`,
      });
    } catch (e) {
      return err(`Failed to check alignment: ${(e as Error).message}`);
    }
  },
);

// ── Start ───────────────────────────────────────────────────────────────

log(`Starting Orderflow MCP server (url=${API_BASE})`);
const transport = new StdioServerTransport();
await server.connect(transport);
