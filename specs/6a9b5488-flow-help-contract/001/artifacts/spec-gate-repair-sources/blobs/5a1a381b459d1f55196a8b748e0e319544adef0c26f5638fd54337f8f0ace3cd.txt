/**
 * src/flow/lib/gate-recovery-display.js
 *
 * Selects the gate phase whose retry exhaustion should be surfaced in
 * next-action/status. Some gate steps map to multiple phases; the display must
 * point at the phase that actually consumed its retry budget.
 */

import { getFlowNode } from "../definition.js";
import { resolveGatePhaseFromState } from "./gate-step.js";
import { countGateRetry } from "./run-gate.js";
import { resolveRecoveryMaxAttempts } from "./retry-recovery.js";

export class GateRecoveryDisplayPhase {
  constructor({ phase, attempts, max }) {
    this.phase = phase;
    this.attempts = attempts;
    this.max = max;
  }
}

export function resolveGateRecoveryDisplayPhase({ root = null, flowState, stepId, maxAttempts }) {
  const phases = getFlowNode(stepId)?.gatePhase;
  const gatePhases = Array.isArray(phases) ? phases : [];
  const activePhase = resolveGatePhaseFromState(flowState)?.phase;
  if (activePhase) {
    const attempts = countGateRetry(flowState.metrics, activePhase);
    const max = resolveRecoveryMaxAttempts({
      root,
      flowState,
      kind: "gate",
      phase: activePhase,
      attempts,
      resolvedMax: maxAttempts,
    });
    return new GateRecoveryDisplayPhase({ phase: activePhase, attempts, max });
  }

  for (const phase of gatePhases) {
    const attempts = countGateRetry(flowState.metrics, phase);
    const max = resolveRecoveryMaxAttempts({
      root,
      flowState,
      kind: "gate",
      phase,
      attempts,
      resolvedMax: maxAttempts,
    });
    if (attempts >= max) {
      return new GateRecoveryDisplayPhase({ phase, attempts, max });
    }
  }

  return null;
}
