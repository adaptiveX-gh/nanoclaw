/**
 * Health actions — side effects layer for the deterministic health ticker.
 * HTTP calls (orderflow, aphexdata), state file writes, and messaging.
 * Phase 2 of the deterministic health ticker plan.
 */

import fs from 'fs';
import path from 'path';
import pino from 'pino';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import type {
  HealthTickerDeps,
  TickResult,
  Transition,
  ReconcilePatch,
  BotSnapshot,
} from './health-types.js';

const logger = pino({ name: 'health-actions' });

const TICKER_DATA_DIR = path.join(DATA_DIR, 'monitor-health');

// ─── Environment ────────────────────────────────────────────────────

const ENV_KEYS = [
  'ORDERFLOW_API_URL',
  'APHEXDATA_URL',
  'APHEXDATA_API_KEY',
  'APHEXDATA_AGENT_ID',
];

function getEnv(): Record<string, string> {
  return readEnvFile(ENV_KEYS);
}

// ─── HTTP: Orderflow API ────────────────────────────────────────────

export interface RegimeData {
  symbol: string;
  regime: string;
  direction: string;
  conviction: number;
}

export async function fetchRegimes(symbols: string[]): Promise<RegimeData[]> {
  const env = getEnv();
  const baseUrl = env.ORDERFLOW_API_URL || 'https://orderflow.tradev.app';
  const symbolList = symbols.join(',');
  const url = `${baseUrl}/api/v1/regime?symbols=${encodeURIComponent(symbolList)}&horizon=H3_MEDIUM`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body }, 'Orderflow API error');
      return [];
    }
    const data = await res.json();
    // API returns an array of regime data objects
    return Array.isArray(data) ? data : ((data as any).regimes ?? []);
  } catch (err) {
    clearTimeout(timeout);
    logger.warn({ err }, 'Orderflow API fetch failed');
    return [];
  }
}

// ─── HTTP: aphexDATA API ────────────────────────────────────────────

export async function recordAphexdataEvent(event: {
  verb_id: string;
  verb_category?: string;
  object_type?: string;
  object_id?: string;
  result_data?: any;
  context?: any;
}): Promise<void> {
  const env = getEnv();
  if (!env.APHEXDATA_URL) {
    logger.debug('APHEXDATA_URL not set — skipping event recording');
    return;
  }

  const url = `${env.APHEXDATA_URL}/api/v1/events`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (env.APHEXDATA_API_KEY) {
    headers['Authorization'] = `Bearer ${env.APHEXDATA_API_KEY}`;
  }

  const body = {
    agent_id: env.APHEXDATA_AGENT_ID,
    ...event,
    occurred_at: new Date().toISOString(),
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.warn(
        { status: res.status, text },
        'aphexDATA event recording failed',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'aphexDATA event recording error');
  }
}

// ─── State File Helpers ─────────────────────────────────────────────

function findGroupDir(): string | null {
  try {
    if (!fs.existsSync(GROUPS_DIR)) return null;
    const folders = fs.readdirSync(GROUPS_DIR);
    return folders.length > 0 ? path.join(GROUPS_DIR, folders[0]) : null;
  } catch {
    return null;
  }
}

function readJsonFile(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: any): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─── State Mutations ────────────────────────────────────────────────

export function applyReconcilePatches(patches: ReconcilePatch[]): void {
  const groupDir = findGroupDir();
  if (!groupDir) return;

  // Group patches by file
  const campaignPatches = patches.filter((p) => p.file === 'campaigns');
  const deploymentPatches = patches.filter((p) => p.file === 'deployments');
  const rosterPatches = patches.filter((p) => p.file === 'roster');

  if (campaignPatches.length > 0) {
    const filePath = path.join(groupDir, 'research-planner', 'campaigns.json');
    const data = readJsonFile(filePath);
    if (data?.campaigns) {
      for (const patch of campaignPatches) {
        const campaign = data.campaigns.find(
          (c: any) => c.id === patch.campaign_id,
        );
        if (campaign) campaign[patch.field] = patch.new_value;
      }
      writeJsonFile(filePath, data);
    }
  }

  if (deploymentPatches.length > 0) {
    const filePath = path.join(groupDir, 'auto-mode', 'deployments.json');
    const data = readJsonFile(filePath);
    if (data?.deployments) {
      for (const patch of deploymentPatches) {
        const dep = data.deployments.find(
          (d: any) =>
            d.campaign_id === patch.campaign_id ||
            d.deployment_id === patch.campaign_id,
        );
        if (dep) dep[patch.field] = patch.new_value;
      }
      writeJsonFile(filePath, data);
    }
  }

  if (rosterPatches.length > 0) {
    const filePath = path.join(groupDir, 'auto-mode', 'roster.json');
    const data = readJsonFile(filePath);
    if (data?.cells) {
      for (const patch of rosterPatches) {
        const cell = data.cells.find(
          (c: any) => c.deployment_id === patch.campaign_id,
        );
        if (cell) cell[patch.field] = patch.new_value;
      }
      writeJsonFile(filePath, data);
    }
  }
}

export function writeRetirement(
  campaignId: string,
  deploymentId: string,
  reason: string,
  bot: BotSnapshot,
): void {
  const groupDir = findGroupDir();
  if (!groupDir) return;

  const now = new Date().toISOString();

  // Update campaigns.json
  const campPath = path.join(groupDir, 'research-planner', 'campaigns.json');
  const campData = readJsonFile(campPath);
  if (campData?.campaigns) {
    const campaign = campData.campaigns.find((c: any) => c.id === campaignId);
    if (campaign) {
      campaign.state = 'retired';
      campaign.retire_reason = reason;
      campaign.retired_at = now;
      if (campaign.paper_trading) {
        campaign.paper_trading.signals_active = false;
      }
    }
    writeJsonFile(campPath, campData);
  }

  // Update deployments.json
  const depPath = path.join(groupDir, 'auto-mode', 'deployments.json');
  const depData = readJsonFile(depPath);
  if (depData?.deployments) {
    const dep = depData.deployments.find(
      (d: any) =>
        d.deployment_id === deploymentId || d.campaign_id === campaignId,
    );
    if (dep) {
      dep.state = 'retired';
      dep.retired_reason = reason;
      dep.retired_at = now;
    }
    writeJsonFile(depPath, depData);
  }

  // Write live outcome
  writeLiveOutcome(bot, reason, 'retired');
}

export function writeGraduation(
  campaignId: string,
  deploymentId: string,
  bot: BotSnapshot,
): void {
  const groupDir = findGroupDir();
  if (!groupDir) return;

  const now = new Date().toISOString();

  // Update campaigns.json
  const campPath = path.join(groupDir, 'research-planner', 'campaigns.json');
  const campData = readJsonFile(campPath);
  if (campData?.campaigns) {
    const campaign = campData.campaigns.find((c: any) => c.id === campaignId);
    if (campaign) {
      campaign.state = 'graduated_internal_only';
      campaign.slot_state = 'graduated';
      campaign.graduated_at = now;
      campaign.eviction_priority = 0;
    }
    writeJsonFile(campPath, campData);
  }

  // Update deployments.json
  const depPath = path.join(groupDir, 'auto-mode', 'deployments.json');
  const depData = readJsonFile(depPath);
  if (depData?.deployments) {
    const dep = depData.deployments.find(
      (d: any) =>
        d.deployment_id === deploymentId || d.campaign_id === campaignId,
    );
    if (dep) {
      dep.state = 'graduated_internal_only';
      dep.slot_state = 'graduated';
      dep.graduated = now;
    }
    writeJsonFile(depPath, depData);
  }

  writeLiveOutcome(bot, 'graduated', 'graduated');
}

export function writeValidationExtension(
  campaignId: string,
  extensionDays: number,
  reason: string,
  flags: {
    extended?: boolean;
    regime_extension?: boolean;
    rr_extension?: boolean;
  },
): void {
  const groupDir = findGroupDir();
  if (!groupDir) return;

  const campPath = path.join(groupDir, 'research-planner', 'campaigns.json');
  const campData = readJsonFile(campPath);
  if (campData?.campaigns) {
    const campaign = campData.campaigns.find((c: any) => c.id === campaignId);
    if (campaign) {
      const pt = campaign.paper_trading ?? {};
      const currentDeadline = pt.validation_deadline ?? campaign.trial_deadline;
      if (currentDeadline) {
        const newDeadline = new Date(currentDeadline);
        newDeadline.setDate(newDeadline.getDate() + extensionDays);
        pt.validation_deadline = newDeadline.toISOString();
        campaign.trial_deadline = newDeadline.toISOString();
      }
      if (flags.extended) pt.extended = true;
      if (flags.regime_extension) pt.regime_extension = true;
      if (flags.rr_extension) {
        pt.rr_extension = true;
        pt.investigation_mode = true;
        pt.investigation_reason = 'risk_reward_inversion';
      }
      campaign.paper_trading = pt;
      writeJsonFile(campPath, campData);
    }
  }
}

export function writeSignalToggle(campaignId: string, enable: boolean): void {
  const groupDir = findGroupDir();
  if (!groupDir) return;

  const campPath = path.join(groupDir, 'research-planner', 'campaigns.json');
  const campData = readJsonFile(campPath);
  if (campData?.campaigns) {
    const campaign = campData.campaigns.find((c: any) => c.id === campaignId);
    if (campaign?.paper_trading) {
      campaign.paper_trading.signals_active = enable;
    }
    writeJsonFile(campPath, campData);
  }
}

export function writeInvestigationMode(
  campaignId: string,
  reason: string,
): void {
  const groupDir = findGroupDir();
  if (!groupDir) return;

  const campPath = path.join(groupDir, 'research-planner', 'campaigns.json');
  const campData = readJsonFile(campPath);
  if (campData?.campaigns) {
    const campaign = campData.campaigns.find((c: any) => c.id === campaignId);
    if (campaign?.paper_trading) {
      campaign.paper_trading.investigation_mode = true;
      campaign.paper_trading.investigation_reason = reason;
      campaign.paper_trading.signals_active = false;
    }
    writeJsonFile(campPath, campData);
  }
}

// ─── Tick Counter ───────────────────────────────────────────────────

export function updateSignalTicks(
  campaignId: string,
  signalsActive: boolean,
  consecutiveAbove: number,
  consecutiveBelow: number,
): void {
  const groupDir = findGroupDir();
  if (!groupDir) return;

  const campPath = path.join(groupDir, 'research-planner', 'campaigns.json');
  const campData = readJsonFile(campPath);
  if (campData?.campaigns) {
    const campaign = campData.campaigns.find((c: any) => c.id === campaignId);
    if (campaign?.paper_trading) {
      const pt = campaign.paper_trading;
      if (signalsActive) {
        pt.ticks_signals_on = (pt.ticks_signals_on ?? 0) + 1;
      } else {
        pt.ticks_signals_off = (pt.ticks_signals_off ?? 0) + 1;
      }
      pt.consecutive_above = consecutiveAbove;
      pt.consecutive_below = consecutiveBelow;
    }
    writeJsonFile(campPath, campData);
  }
}

// ─── Tick Log ───────────────────────────────────────────────────────

export function writeTickLog(tickResult: TickResult): void {
  fs.mkdirSync(TICKER_DATA_DIR, { recursive: true });

  // Latest tick (single file, overwritten each tick)
  writeJsonFile(path.join(TICKER_DATA_DIR, 'latest-tick.json'), tickResult);

  // Tick log (append)
  const logEntry = {
    tick_id: tickResult.tick_id,
    tick_complete: true,
    ts: tickResult.computed_at,
    health: tickResult.escalations.length > 0 ? 'escalation' : 'ok',
    transitions: tickResult.transitions.length,
    signal_changes: tickResult.signal_changes.length,
    patches: tickResult.reconcile_patches.length,
    slots: tickResult.slot_summary,
  };
  fs.appendFileSync(
    path.join(TICKER_DATA_DIR, 'tick-log.jsonl'),
    JSON.stringify(logEntry) + '\n',
  );
}

export function writeEvolutionEvent(transition: Transition): void {
  const groupDir = findGroupDir();
  if (!groupDir) return;

  const event = {
    event_id: `evo_${new Date().toISOString().slice(0, 10)}_${transition.campaign_id.slice(0, 8)}`,
    resource_type: 'campaign',
    resource_id: transition.campaign_id,
    operation: transition.to_state.startsWith('graduated')
      ? 'commit'
      : 'rollback',
    committed_to: transition.to_state.startsWith('graduated')
      ? 'graduated_slot'
      : undefined,
    rollback_reason: transition.trigger_id
      ? `trigger_${transition.trigger_id}`
      : transition.reason,
    net_delta: `strategy: ${transition.strategy}, ${transition.pair}/${transition.timeframe}`,
    timestamp: new Date().toISOString(),
  };

  const eventsDir = path.join(groupDir, 'knowledge');
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.appendFileSync(
    path.join(eventsDir, 'evolution-events.jsonl'),
    JSON.stringify(event) + '\n',
  );
}

function writeLiveOutcome(
  bot: BotSnapshot,
  reason: string,
  outcome: string,
): void {
  const groupDir = findGroupDir();
  if (!groupDir) return;

  const entry = {
    ts: new Date().toISOString(),
    strategy: bot.strategy,
    archetype: bot.archetype,
    correlation_group: bot.correlation_group,
    pair: bot.pair,
    timeframe: bot.timeframe,
    outcome,
    days_deployed: bot.deployed_at
      ? Math.round(
          (Date.now() - new Date(bot.deployed_at).getTime()) /
            (1000 * 60 * 60 * 24),
        )
      : null,
    trade_count: bot.metrics.trade_count,
    pnl_pct: bot.metrics.profit_pct,
    live_sharpe: bot.metrics.sharpe,
    win_rate: bot.metrics.win_rate,
    divergence_pct: bot.divergence_pct,
    execution_quality: bot.metrics.execution_quality,
    reason,
  };

  const knowledgeDir = path.join(groupDir, 'knowledge');
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.appendFileSync(
    path.join(knowledgeDir, 'live-outcomes.jsonl'),
    JSON.stringify(entry) + '\n',
  );
}

// ─── Tick Stamp ─────────────────────────────────────────────────────

export function stampTickCompletion(): void {
  const groupDir = findGroupDir();
  if (!groupDir) return;

  const depPath = path.join(groupDir, 'auto-mode', 'deployments.json');
  const depData = readJsonFile(depPath);
  if (depData) {
    if (!depData._meta) depData._meta = {};
    depData._meta.last_tick = new Date().toISOString();
    delete depData._meta.last_tick_failure;
    writeJsonFile(depPath, depData);
  }
}

// ─── Composite Execution Functions ──────────────────────────────────

export async function executeRetirement(
  deps: HealthTickerDeps,
  bot: BotSnapshot,
  reason: string,
  triggerId: string,
): Promise<Transition> {
  const transition: Transition = {
    campaign_id: bot.campaign_id ?? bot.deployment_id,
    strategy: bot.strategy,
    pair: bot.pair,
    timeframe: bot.timeframe,
    from_state: bot.campaign_state ?? 'paper_trading',
    to_state: 'retired',
    reason,
    trigger_id: triggerId,
  };

  try {
    await deps.stopBotContainer(bot.deployment_id);
  } catch (err) {
    logger.warn(
      { err, deploymentId: bot.deployment_id },
      'Failed to stop container on retirement',
    );
  }

  writeRetirement(
    bot.campaign_id ?? bot.deployment_id,
    bot.deployment_id,
    reason,
    bot,
  );
  writeEvolutionEvent(transition);

  await recordAphexdataEvent({
    verb_id: 'campaign_retired',
    verb_category: 'lifecycle',
    object_type: 'campaign',
    object_id: bot.campaign_id ?? bot.deployment_id,
    result_data: {
      reason,
      trigger: triggerId,
      strategy: bot.strategy,
      pair: bot.pair,
    },
  });

  const msg = `Retired: ${bot.strategy} on ${bot.pair}/${bot.timeframe} — ${reason}`;
  try {
    await deps.sendMessage(deps.chatJid, msg);
  } catch (err) {
    logger.warn({ err }, 'Failed to send retirement message');
  }

  logger.info(
    { strategy: bot.strategy, reason, trigger: triggerId },
    'Bot retired',
  );
  return transition;
}

export async function executeGraduation(
  deps: HealthTickerDeps,
  bot: BotSnapshot,
  reason: string,
): Promise<Transition> {
  const transition: Transition = {
    campaign_id: bot.campaign_id ?? bot.deployment_id,
    strategy: bot.strategy,
    pair: bot.pair,
    timeframe: bot.timeframe,
    from_state: bot.campaign_state ?? 'paper_trading',
    to_state: 'graduated_internal_only',
    reason,
  };

  writeGraduation(bot.campaign_id ?? bot.deployment_id, bot.deployment_id, bot);
  writeEvolutionEvent(transition);

  const verbId =
    reason === 'early_graduation'
      ? 'slot_trial_early_graduated'
      : 'slot_trial_graduated';
  await recordAphexdataEvent({
    verb_id: verbId,
    verb_category: 'lifecycle',
    object_type: 'campaign',
    object_id: bot.campaign_id ?? bot.deployment_id,
    result_data: {
      strategy: bot.strategy,
      pair: bot.pair,
      sharpe: bot.metrics.sharpe,
      trades: bot.metrics.trade_count,
      pnl: bot.metrics.profit_pct,
    },
  });

  const prefix =
    reason === 'early_graduation' ? 'EARLY GRADUATED' : 'GRADUATED';
  const msg = `${prefix}: ${bot.strategy} on ${bot.pair}/${bot.timeframe} — Sharpe ${bot.metrics.sharpe.toFixed(2)}, ${bot.metrics.trade_count} trades, P&L ${bot.metrics.profit_pct.toFixed(1)}%`;
  try {
    await deps.sendMessage(deps.chatJid, msg);
  } catch (err) {
    logger.warn({ err }, 'Failed to send graduation message');
  }

  logger.info({ strategy: bot.strategy, reason }, 'Bot graduated');
  return transition;
}

export async function executeSignalToggle(
  deps: HealthTickerDeps,
  bot: BotSnapshot,
  enable: boolean,
  ticksRequired: number,
): Promise<void> {
  try {
    await deps.toggleBotSignals(bot.deployment_id, enable);
  } catch (err) {
    logger.warn(
      { err, deploymentId: bot.deployment_id },
      'Failed to toggle signals',
    );
    return;
  }

  writeSignalToggle(bot.campaign_id ?? bot.deployment_id, enable);

  const state = enable ? 'ON' : 'OFF';
  const qualifier = enable ? 'favorable' : 'unfavorable';
  const msg = `${bot.strategy}: signals ${state} — regime ${qualifier} for ${ticksRequired} consecutive checks`;
  try {
    await deps.sendMessage(deps.chatJid, msg);
  } catch (err) {
    logger.warn({ err }, 'Failed to send signal toggle message');
  }

  logger.info({ strategy: bot.strategy, signals: state }, 'Signals toggled');
}

export async function executePause(
  deps: HealthTickerDeps,
  bot: BotSnapshot,
  reason: string,
  obstacle: string,
): Promise<void> {
  try {
    await deps.toggleBotSignals(bot.deployment_id, false);
  } catch (err) {
    logger.warn(
      { err, deploymentId: bot.deployment_id },
      'Failed to pause signals',
    );
  }

  writeInvestigationMode(bot.campaign_id ?? bot.deployment_id, reason);

  const msg = `PAUSED: ${bot.strategy} on ${bot.pair}/${bot.timeframe} — ${reason}. Routing to kata with obstacle: ${obstacle}`;
  try {
    await deps.sendMessage(deps.chatJid, msg);
  } catch (err) {
    logger.warn({ err }, 'Failed to send pause message');
  }

  logger.info({ strategy: bot.strategy, reason, obstacle }, 'Bot paused');
}
