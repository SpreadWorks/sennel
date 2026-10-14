import assert from "node:assert/strict";
import { StepResult } from "../../../src/flow/engine/step-result.js";
import { finalizationPhaseResultContracts } from "./finalization-phase-result-contracts.js";
import { assertFinalizationPhaseSettlement } from "./finalization-phase-settlement.js";

export { finalizationPhaseResultContracts } from "./finalization-phase-result-contracts.js";

export function assertFinalizationPhaseResult(result) {
  assert.ok(result instanceof StepResult);
  const contract = finalizationPhaseResultContracts.find((entry) => entry.stepId === result.stepId && entry.kind === result.kind);
  assert.ok(contract, `FINALIZATION_PHASE_RESULT_UNKNOWN: ${result.stepId}/${result.kind}`);
  return contract.assertResult(result);
}

export function assertFinalizationPhaseSettlementRoundtrip(result) {
  return assertFinalizationPhaseSettlement(result);
}
