/**
 * Shared types for the deterministic health ticker service.
 * Phase 2 of the deterministic health ticker plan.
 */

// Re-export snapshot types used throughout the ticker pipeline
export type {
  BotSnapshot,
  BotMetrics,
  HealthSnapshot,
} from './health-snapshot.js';

// ─── Config Types ───────────────────────────────────────────────────

export interface RetirementGatesConfig {
  catastrophic_dd_multiplier: number;
  catastrophic_dd_multiplier_high_regime_dep: number;
  consecutive_losses_count: number;
  consecutive_losses_pct: number;
  dead_container_consecutive_checks: number;
  win_rate_floor: number;
  win_rate_floor_low_rr_archetypes: number;
  rr_inversion_win_rate_min: number;
  rr_inversion_pnl_threshold: number;
}

export interface GraduationGatesConfig {
  min_win_rate: number;
  min_favorable_sharpe: number;
  min_risk_reward_ratio: number;
  max_consecutive_losses: number;
  max_divergence: number;
  min_trades: Record<string, number>;
}

export interface TrialEarlyEvictionConfig {
  zero_trades_hours: number;
  near_dead_trades: number;
  near_dead_hours: number;
  min_win_rate_n: number;
  min_win_rate_floor: number;
  max_divergence: number;
  max_loss_pct: number;
}

export interface SlotManagementConfig {
  max_total_bots: number;
  max_trial_bots: number;
  trial_deadlines_days: Record<string, number>;
  trial_early_eviction: TrialEarlyEvictionConfig;
  graduation_gates: GraduationGatesConfig;
  eviction_weights: Record<string, number>;
  replacement_sharpe_threshold: number;
  max_per_group: number;
  group_balance: Record<string, { target: number; min: number }>;
}

export interface OverfittingGatesConfig {
  enabled: boolean;
  dsr_threshold: number;
  pbo_max: number;
  pbo_evict: number;
  deadline_extension_on_low_dsr: number;
  min_trades_for_dsr: number;
  min_kata_experiments_for_dsr_enforcement: number;
}

export interface ExecutionGatesConfig {
  enabled: boolean;
  min_execution_quality: number;
  pause_threshold: number;
  slippage_pnl_ratio_max: number;
  min_trades_for_gate: number;
}

export interface DivergenceGateConfig {
  enabled: boolean;
  min_trades: number;
  route_threshold: number;
  pause_threshold: number;
}

export interface ScoringConfig {
  DEPLOY_THRESHOLD: number;
  UNDEPLOY_THRESHOLD: number;
  SIGNAL_HYSTERESIS_TICKS: number;
  RETIREMENT_GATES: RetirementGatesConfig;
  SLOT_MANAGEMENT: SlotManagementConfig;
  OVERFITTING_GATES: OverfittingGatesConfig;
  EXECUTION_GATES: ExecutionGatesConfig;
  DIVERGENCE_GATE: DivergenceGateConfig;
  GRADUATION_GATES: {
    min_live_sharpe_default: number;
    max_drawdown_pct_default: number;
    min_win_rate: number;
    min_win_rate_low_rr_archetypes: number;
    min_rr_ratio: number;
    max_consecutive_losses: number;
  };
}

export interface ArchetypeConfig {
  correlation_group: string;
  preferred_regimes: string[];
  anti_regimes: string[];
  max_drawdown: number;
  typical_win_rate: number;
  typical_rr_ratio: number;
  paper_validation: Record<
    string,
    { days: number; min_trades: number; min_live_sharpe: number }
  >;
}

export const LOW_WR_ARCHETYPES = [
  'TREND_MOMENTUM',
  'BREAKOUT',
  'VOLATILITY_HARVEST',
] as const;

export function isLowWrArchetype(archetype: string): boolean {
  return (LOW_WR_ARCHETYPES as readonly string[]).includes(archetype);
}

// ─── Trigger Types ──────────────────────────────────────────────────

export type TriggerAction = 'retire' | 'pause' | 'route_to_kata' | 'warn';

export interface TriggerResult {
  id: string;
  fired: boolean;
  action: TriggerAction;
  reason: string;
  obstacle?: string;
  details?: string;
}

// ─── Graduation Types ───────────────────────────────────────────────

export interface GateResult {
  name: string;
  required: number;
  actual: number | null;
  met: boolean | null;
}

export type GraduationAction =
  | 'graduate'
  | 'retire'
  | 'extend'
  | 'extend_regime'
  | 'investigate_rr'
  | 'none';

export interface GraduationResult {
  gates: GateResult[];
  all_met: boolean;
  action: GraduationAction;
  reason: string;
}

// ─── Signal Gating Types ────────────────────────────────────────────

export interface SignalDecision {
  toggle: 'on' | 'off' | 'none';
  ticks_required: number;
  reason?: string;
}

// ─── Reconciliation Types ───────────────────────────────────────────

export interface ReconcilePatch {
  file: 'campaigns' | 'deployments' | 'roster';
  campaign_id: string;
  field: string;
  old_value: any;
  new_value: any;
}

// ─── Tick Result ────────────────────────────────────────────────────

export interface Transition {
  campaign_id: string;
  strategy: string;
  pair: string;
  timeframe: string;
  from_state: string;
  to_state: string;
  reason: string;
  trigger_id?: string;
}

export interface SignalChange {
  campaign_id: string;
  strategy: string;
  toggled: 'on' | 'off';
  ticks_required: number;
}

export interface TickResult {
  tick_id: number;
  computed_at: string;
  has_transitions: boolean;
  transitions: Transition[];
  signal_changes: SignalChange[];
  reconcile_patches: ReconcilePatch[];
  escalations: string[];
  slot_summary: {
    total: number;
    trials: number;
    graduated: number;
    by_group: Record<string, number>;
  };
}

// ─── Action Dependencies ────────────────────────────────────────────

export interface HealthTickerDeps {
  stopBotContainer: (deploymentId: string) => Promise<void>;
  toggleBotSignals: (deploymentId: string, enable: boolean) => Promise<void>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  chatJid: string;
}
