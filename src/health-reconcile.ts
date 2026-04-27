/**
 * State file reconciliation — pure deterministic function.
 * Detects and returns patches needed to keep campaigns, deployments, and roster in sync.
 * Also tracks container health (consecutive_container_down).
 * No I/O, no side effects. Phase 2 of the deterministic health ticker plan.
 */

import type { BotSnapshot, ReconcilePatch } from './health-types.js';

export interface ReconcileResult {
  patches: ReconcilePatch[];
  orphans: string[];
}

/**
 * Reconcile campaigns ↔ deployments ↔ roster state.
 * Returns patches that need to be applied and orphan deployment IDs.
 */
export function reconcileState(
  campaigns: any[],
  deployments: any[],
  roster: any,
  botSnapshots: BotSnapshot[],
): ReconcileResult {
  const patches: ReconcilePatch[] = [];
  const orphans: string[] = [];

  // Build lookup maps
  const campaignById = new Map<string, any>();
  for (const c of campaigns) {
    if (c.id) campaignById.set(c.id, c);
  }

  const deploymentById = new Map<string, any>();
  for (const d of deployments) {
    if (d.deployment_id) deploymentById.set(d.deployment_id, d);
  }

  // 1. slot_state sync: campaign → deployment
  for (const campaign of campaigns) {
    const dep = deployments.find(
      (d: any) =>
        d.campaign_id === campaign.id ||
        d.deployment_id === campaign.paper_trading?.bot_deployment_id,
    );
    if (!dep) continue;

    if (campaign.slot_state && dep.slot_state !== campaign.slot_state) {
      patches.push({
        file: 'deployments',
        campaign_id: campaign.id,
        field: 'slot_state',
        old_value: dep.slot_state,
        new_value: campaign.slot_state,
      });
      if (campaign.slot_state === 'graduated' && campaign.graduated_at) {
        patches.push({
          file: 'deployments',
          campaign_id: campaign.id,
          field: 'graduated',
          old_value: dep.graduated,
          new_value: campaign.graduated_at,
        });
      }
    }

    // 2. Retirement propagation: campaign → deployment
    if (campaign.state === 'retired' && dep.state !== 'retired') {
      patches.push({
        file: 'deployments',
        campaign_id: campaign.id,
        field: 'state',
        old_value: dep.state,
        new_value: 'retired',
      });
      if (campaign.retire_reason) {
        patches.push({
          file: 'deployments',
          campaign_id: campaign.id,
          field: 'retired_reason',
          old_value: dep.retired_reason,
          new_value: campaign.retire_reason,
        });
      }
    }

    // 3. Graduation propagation: campaign → deployment
    if (
      (campaign.state === 'graduated_internal_only' ||
        campaign.state === 'graduated_external') &&
      dep.state !== campaign.state
    ) {
      patches.push({
        file: 'deployments',
        campaign_id: campaign.id,
        field: 'state',
        old_value: dep.state,
        new_value: campaign.state,
      });
    }
  }

  // 4. Roster cleanup: retired deployments → cell status
  if (roster?.cells) {
    for (const cell of roster.cells) {
      if (cell.status !== 'paper_trading') continue;
      const depId = cell.deployment_id;
      if (!depId) continue;

      const dep = deploymentById.get(depId);
      if (dep && dep.state === 'retired') {
        patches.push({
          file: 'roster',
          campaign_id: dep.campaign_id ?? depId,
          field: 'status',
          old_value: 'paper_trading',
          new_value: 'retired',
        });
      }
    }
  }

  // 5. Container health tracking
  for (const bot of botSnapshots) {
    const campaign = campaigns.find(
      (c: any) =>
        c.paper_trading?.bot_deployment_id === bot.deployment_id ||
        c.id === bot.deployment_id,
    );
    if (!campaign) continue;

    if (bot.bot_status === 'running') {
      if (campaign.consecutive_container_down > 0) {
        patches.push({
          file: 'campaigns',
          campaign_id: campaign.id,
          field: 'consecutive_container_down',
          old_value: campaign.consecutive_container_down,
          new_value: 0,
        });
      }
    } else if (bot.bot_status === 'error' || bot.bot_status === 'stopped') {
      patches.push({
        file: 'campaigns',
        campaign_id: campaign.id,
        field: 'consecutive_container_down',
        old_value: campaign.consecutive_container_down ?? 0,
        new_value: (campaign.consecutive_container_down ?? 0) + 1,
      });
    }
  }

  // 6. Orphan detection: deployments with no matching campaign
  for (const dep of deployments) {
    if (dep.state === 'retired') continue;
    const hasCampaign = campaigns.some(
      (c: any) =>
        c.id === dep.campaign_id ||
        c.paper_trading?.bot_deployment_id === dep.deployment_id,
    );
    if (!hasCampaign) {
      orphans.push(dep.deployment_id);
    }
  }

  return { patches, orphans };
}
