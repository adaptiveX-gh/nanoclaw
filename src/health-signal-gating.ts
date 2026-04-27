/**
 * Signal hysteresis logic — pure deterministic function.
 * Computes whether to toggle signals on/off based on composite threshold
 * and adaptive tick counting (BOCPD change_prob).
 * No I/O, no side effects. Phase 2 of the deterministic health ticker plan.
 */

import type { SignalDecision } from './health-types.js';

/**
 * Compute whether to toggle signals on or off for a bot.
 *
 * @param currentSignalsActive - Current state of signals
 * @param cellComposite - Composite score from cell-grid-latest.json for this bot's archetype+pair
 * @param consecutiveAbove - How many consecutive ticks composite has been >= threshold
 * @param consecutiveBelow - How many consecutive ticks composite has been < threshold
 * @param changeProb - BOCPD change_prob from market-prior.json (null if unavailable)
 * @param expectedRunLength - Expected run length from BOCPD (null if unavailable)
 * @param investigationMode - If true, skip signal toggling entirely
 * @param hysteresisTicksDefault - Default hysteresis ticks from config (SIGNAL_HYSTERESIS_TICKS)
 */
export function computeSignalDecision(
  currentSignalsActive: boolean,
  cellComposite: number,
  consecutiveAbove: number,
  consecutiveBelow: number,
  changeProb: number | null,
  expectedRunLength: number | null,
  investigationMode: boolean,
  hysteresisTicksDefault: number,
): SignalDecision {
  // Investigation mode: don't toggle, just track
  if (investigationMode) {
    return { toggle: 'none', ticks_required: 0, reason: 'investigation_mode' };
  }

  // Compute adaptive ticks_required based on BOCPD
  let ticksRequired = hysteresisTicksDefault;
  if (changeProb != null) {
    if (changeProb > 0.5) {
      ticksRequired = 4;
    } else if (changeProb > 0.3) {
      ticksRequired = 3;
    }
    // Long stable regime → reduce required ticks
    if (expectedRunLength != null && expectedRunLength > 100) {
      ticksRequired = Math.max(1, ticksRequired - 1);
    }
  }

  const COMPOSITE_THRESHOLD = 3.5;

  // TURNING ON: signals currently off, composite above threshold
  if (!currentSignalsActive) {
    if (cellComposite >= COMPOSITE_THRESHOLD) {
      const newAbove = consecutiveAbove + 1;
      if (newAbove >= ticksRequired) {
        return {
          toggle: 'on',
          ticks_required: ticksRequired,
          reason: `composite ${cellComposite.toFixed(1)} >= ${COMPOSITE_THRESHOLD} for ${ticksRequired} ticks`,
        };
      }
    }
    // Not enough consecutive ticks yet (or below threshold) — no toggle
    return { toggle: 'none', ticks_required: ticksRequired };
  }

  // TURNING OFF: signals currently on, composite below threshold
  if (currentSignalsActive) {
    if (cellComposite < COMPOSITE_THRESHOLD) {
      const newBelow = consecutiveBelow + 1;
      if (newBelow >= ticksRequired) {
        return {
          toggle: 'off',
          ticks_required: ticksRequired,
          reason: `composite ${cellComposite.toFixed(1)} < ${COMPOSITE_THRESHOLD} for ${ticksRequired} ticks`,
        };
      }
    }
    // Not enough consecutive ticks yet (or above threshold) — no toggle
    return { toggle: 'none', ticks_required: ticksRequired };
  }

  return { toggle: 'none', ticks_required: ticksRequired };
}
