/**
 * Health Snapshot — pre-computes a joined view of bot metrics + campaign state.
 *
 * Runs at the end of each bot-runner health check cycle (~60s).
 * Writes data/bot-runner/health-snapshot.json so the monitor-health LLM agent
 * can read one file instead of making 3+ MCP tool calls per bot.
 *
 * Phase 1 of the deterministic health ticker plan.
 * Pure data joining — no decisions, no side effects beyond the output file.
 */

import fs from 'fs';
import path from 'path';
import pino from 'pino';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const logger = pino({ name: 'health-snapshot' });

const SNAPSHOT_PATH = path.join(DATA_DIR, 'bot-runner', 'health-snapshot.json');

// ─── Types ──────────────────────────────────────────────────────────

export interface BotMetrics {
  profit_pct: number;
  trade_count: number;
  win_rate: number;
  sharpe: number;
  max_drawdown: number | null;
  avg_win_pct: number | null;
  avg_loss_pct: number | null;
  max_consecutive_losses: number | null;
  execution_quality: number | null;
  slippage_as_pct_of_pnl: number | null;
  by_regime: Record<string, any> | null;
  daily_equity: Array<{ date: string; cumulative_pnl_pct: number }> | null;
}

export interface BotSnapshot {
  deployment_id: string;
  strategy: string;
  pair: string;
  timeframe: string;

  // From bot status file
  bot_status: 'running' | 'stopped' | 'starting' | 'error';
  signals_active: boolean;
  last_health_check: string | null;
  error: string | null;
  metrics: BotMetrics;

  // From campaign (joined)
  campaign_id: string | null;
  campaign_state: string | null;
  archetype: string | null;
  correlation_group: string | null;
  slot_state: string | null;
  deployed_at: string | null;
  trial_deadline: string | null;
  validation_deadline: string | null;

  // Campaign hysteresis counters
  ticks_signals_on: number;
  ticks_signals_off: number;
  consecutive_above: number;
  consecutive_below: number;
  consecutive_container_down: number;

  // Campaign paper_trading flags
  investigation_mode: boolean;
  extended: boolean;
  regime_extension: boolean;
  rr_extension: boolean;
  feasibility_warning: boolean;

  // Campaign divergence
  divergence_pct: number | null;
  wfo_sharpe: number | null;

  // Campaign eviction
  eviction_priority: number | null;
  eviction_factors: string[];
}

export interface HealthSnapshot {
  computed_at: string;
  bots: BotSnapshot[];
  active_slot_count: number;
  total_trade_count: number;
  portfolio_win_rate: number | null;
  cell_grid_stale: boolean;
  cell_grid_age_hours: number | null;
}

// ─── Data Loading ───────────────────────────────────────────────────

function loadBotStatusFiles(): any[] {
  const botsDir = path.join(DATA_DIR, 'bot-runner', 'bots');
  if (!fs.existsSync(botsDir)) return [];
  return fs
    .readdirSync(botsDir)
    .filter((f) => f.endsWith('.status.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(botsDir, f), 'utf-8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadCampaignsFromGroups(): any[] {
  const all: any[] = [];
  try {
    if (!fs.existsSync(GROUPS_DIR)) return [];
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const filePath = path.join(
        GROUPS_DIR,
        folder,
        'research-planner',
        'campaigns.json',
      );
      if (!fs.existsSync(filePath)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data.campaigns) all.push(...data.campaigns);
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* ignore */
  }
  return all;
}

function loadDeploymentsFromGroups(): any[] {
  const all: any[] = [];
  try {
    if (!fs.existsSync(GROUPS_DIR)) return [];
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const filePath = path.join(
        GROUPS_DIR,
        folder,
        'auto-mode',
        'deployments.json',
      );
      if (!fs.existsSync(filePath)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data.deployments) all.push(...data.deployments);
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* ignore */
  }
  return all;
}

function loadCellGridAge(): { stale: boolean; ageHours: number | null } {
  try {
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const filePath = path.join(
        GROUPS_DIR,
        folder,
        'reports',
        'cell-grid-latest.json',
      );
      if (!fs.existsSync(filePath)) continue;
      const stat = fs.statSync(filePath);
      const ageMs = Date.now() - stat.mtimeMs;
      const ageHours = ageMs / (1000 * 60 * 60);
      return { stale: ageHours > 8, ageHours: Math.round(ageHours * 10) / 10 };
    }
  } catch {
    /* ignore */
  }
  return { stale: true, ageHours: null };
}

// ─── Metric Extraction ──────────────────────────────────────────────

function extractMetrics(botStatus: any): BotMetrics {
  const pnl = botStatus.paper_pnl;
  if (!pnl) {
    return {
      profit_pct: 0,
      trade_count: 0,
      win_rate: 0,
      sharpe: 0,
      max_drawdown: null,
      avg_win_pct: null,
      avg_loss_pct: null,
      max_consecutive_losses: null,
      execution_quality: null,
      slippage_as_pct_of_pnl: null,
      by_regime: null,
      daily_equity: null,
    };
  }

  // Compute avg_win/loss and max_consecutive_losses from enriched trades
  let avgWin: number | null = null;
  let avgLoss: number | null = null;
  let maxConsecLosses: number | null = null;

  const trades = (pnl.enriched_trades || []).filter(
    (t: any) => t.closed_at !== null,
  );
  if (trades.length > 0) {
    const wins = trades.filter(
      (t: any) => (t.profit_ratio ?? t.profit_pct ?? 0) > 0,
    );
    const losses = trades.filter(
      (t: any) => (t.profit_ratio ?? t.profit_pct ?? 0) <= 0,
    );
    if (wins.length > 0) {
      avgWin =
        wins.reduce(
          (s: number, t: any) =>
            s + Math.abs(t.profit_ratio ?? t.profit_pct ?? 0),
          0,
        ) / wins.length;
    }
    if (losses.length > 0) {
      avgLoss =
        losses.reduce(
          (s: number, t: any) =>
            s + Math.abs(t.profit_ratio ?? t.profit_pct ?? 0),
          0,
        ) / losses.length;
    }

    // Max consecutive losses
    let streak = 0;
    let maxStreak = 0;
    for (const t of trades) {
      if ((t.profit_ratio ?? t.profit_pct ?? 0) <= 0) {
        streak++;
        if (streak > maxStreak) maxStreak = streak;
      } else {
        streak = 0;
      }
    }
    maxConsecLosses = maxStreak;
  }

  // Max drawdown from daily equity curve
  let maxDd: number | null = null;
  const equity = pnl.daily_equity || [];
  if (equity.length > 0) {
    let peak = 0;
    let dd = 0;
    for (const pt of equity) {
      const val = pt.cumulative_pnl_pct ?? 0;
      if (val > peak) peak = val;
      const currentDd = peak - val;
      if (currentDd > dd) dd = currentDd;
    }
    maxDd = -dd; // Negative number convention
  }

  return {
    profit_pct: pnl.profit_pct ?? 0,
    trade_count: pnl.trade_count ?? 0,
    win_rate: pnl.win_rate ?? 0,
    sharpe: pnl.sharpe ?? 0,
    max_drawdown: maxDd,
    avg_win_pct: avgWin,
    avg_loss_pct: avgLoss,
    max_consecutive_losses: maxConsecLosses,
    execution_quality: pnl.execution?.execution_quality ?? null,
    slippage_as_pct_of_pnl: pnl.execution?.slippage_as_pct_of_pnl ?? null,
    by_regime: pnl.by_regime ?? null,
    daily_equity: equity.length > 0 ? equity : null,
  };
}

// ─── Join Logic ─────────────────────────────────────────────────────

function joinBotWithCampaign(botStatus: any, campaigns: any[]): BotSnapshot {
  const metrics = extractMetrics(botStatus);

  // Find matching campaign by deployment_id
  const campaign = campaigns.find(
    (c: any) =>
      c.paper_trading?.bot_deployment_id === botStatus.deployment_id ||
      c.id === botStatus.deployment_id,
  );

  const pt = campaign?.paper_trading;

  return {
    deployment_id: botStatus.deployment_id,
    strategy: botStatus.strategy,
    pair: botStatus.pair,
    timeframe: botStatus.timeframe,

    bot_status: botStatus.status,
    signals_active: botStatus.signals_active ?? false,
    last_health_check: botStatus.last_health_check ?? null,
    error: botStatus.error ?? null,
    metrics,

    campaign_id: campaign?.id ?? null,
    campaign_state: campaign?.state ?? null,
    archetype: campaign?.archetype ?? null,
    correlation_group: campaign?.correlation_group ?? null,
    slot_state: campaign?.slot_state ?? null,
    deployed_at: pt?.deployed_at ?? null,
    trial_deadline: pt?.trial_deadline ?? campaign?.trial_deadline ?? null,
    validation_deadline: pt?.validation_deadline ?? null,

    ticks_signals_on: pt?.ticks_signals_on ?? 0,
    ticks_signals_off: pt?.ticks_signals_off ?? 0,
    consecutive_above: pt?.consecutive_above ?? 0,
    consecutive_below: pt?.consecutive_below ?? 0,
    consecutive_container_down: campaign?.consecutive_container_down ?? 0,

    investigation_mode: pt?.investigation_mode ?? false,
    extended: pt?.extended ?? false,
    regime_extension: pt?.regime_extension ?? false,
    rr_extension: pt?.rr_extension ?? false,
    feasibility_warning: pt?.feasibility_warning ?? false,

    divergence_pct: pt?.divergence_pct ?? null,
    wfo_sharpe:
      campaign?.wfo_sharpe ?? campaign?.wfo_metrics?.favorable_sharpe ?? null,

    eviction_priority:
      pt?.eviction_priority ?? campaign?.eviction_priority ?? null,
    eviction_factors: pt?.eviction_factors ?? campaign?.eviction_factors ?? [],
  };
}

// ─── Main ───────────────────────────────────────────────────────────

export function computeHealthSnapshot(): HealthSnapshot | null {
  try {
    const botStatuses = loadBotStatusFiles();
    const campaigns = loadCampaignsFromGroups();
    const { stale, ageHours } = loadCellGridAge();

    // Only include running or recently-errored bots (not stopped/retired)
    const activeBots = botStatuses.filter(
      (b: any) =>
        b.status === 'running' ||
        b.status === 'error' ||
        b.status === 'starting',
    );

    const bots = activeBots.map((b: any) => joinBotWithCampaign(b, campaigns));

    // Portfolio-level metrics
    let totalTrades = 0;
    let totalWins = 0;
    for (const b of bots) {
      totalTrades += b.metrics.trade_count;
      totalWins += b.metrics.trade_count * b.metrics.win_rate;
    }

    const snapshot: HealthSnapshot = {
      computed_at: new Date().toISOString(),
      bots,
      active_slot_count: bots.length,
      total_trade_count: totalTrades,
      portfolio_win_rate: totalTrades > 0 ? totalWins / totalTrades : null,
      cell_grid_stale: stale,
      cell_grid_age_hours: ageHours,
    };

    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));

    logger.debug(
      { bots: bots.length, path: SNAPSHOT_PATH },
      'Health snapshot written',
    );

    return snapshot;
  } catch (err) {
    logger.error({ err }, 'Failed to compute health snapshot');
    return null;
  }
}
