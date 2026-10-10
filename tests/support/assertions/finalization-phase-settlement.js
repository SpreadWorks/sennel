import assert from "node:assert/strict";
import { assertPhaseSettlementRoundtrip } from "./phase-settlement.js";

/** The frozen 0717/5ab3 Result-only policy. This inspects Definition output;
 * it never supplies a Result, settlement, route or production registration.
 */
export class FinalizationPhaseSettlementExpectation {
  constructor(stepId, resultKind, settlementKind, targetStepId = null, connectorName = null) {
    if ([stepId, resultKind].some((value) => typeof value !== "string" || !value)
      || !["execution", "target-connection", "await", "failure", "completion"].includes(settlementKind)
      || (settlementKind === "target-connection"
        ? [targetStepId, connectorName].some((value) => typeof value !== "string" || !value)
        : targetStepId !== null || connectorName !== null)) {
      throw new TypeError("finalization settlement expectation requires its exact Result and target contract");
    }
    Object.assign(this, { stepId, resultKind, settlementKind, targetStepId, connectorName });
    Object.freeze(this);
  }

  assertSelected(selected) {
    const context = `${this.stepId}/${this.resultKind}`;
    assert.equal(selected.sourceStepId, this.stepId, `FINALIZATION_PHASE_SETTLEMENT_SOURCE_MISMATCH: ${context}`);
    assert.equal(selected.resultKind, this.resultKind, `FINALIZATION_PHASE_SETTLEMENT_RESULT_MISMATCH: ${context}`);
    assert.equal(selected.kind, this.settlementKind, `FINALIZATION_PHASE_SETTLEMENT_KIND_MISMATCH: ${context}`);
    if (this.settlementKind === "target-connection") {
      assert.equal(selected.targetStepId, this.targetStepId, `FINALIZATION_PHASE_SETTLEMENT_TARGET_MISMATCH: ${context}`);
      assert.equal(selected.connector?.name, this.connectorName, `FINALIZATION_PHASE_SETTLEMENT_CONNECTOR_MISMATCH: ${context}`);
    } else {
      assert.equal("targetStepId" in selected, false, `FINALIZATION_PHASE_SETTLEMENT_FALSE_TARGET: ${context}`);
      assert.equal("connector" in selected, false, `FINALIZATION_PHASE_SETTLEMENT_FALSE_CONNECTOR: ${context}`);
    }
    return selected;
  }
}

export const finalizationPhaseSettlementExpectations = Object.freeze([
  ["finalize-commit", "finalize-commit-execution-required", "execution"],
  ["finalize-commit", "finalize-commit-created", "target-connection", "finalize-merge", "FinalizeMergeConnector"],
  ["finalize-commit", "finalize-commit-unchanged", "target-connection", "finalize-merge", "FinalizeMergeConnector"],
  ["finalize-merge", "finalize-merge-execution-required", "execution"],
  ["finalize-merge", "finalize-merge-squashed", "target-connection", "finalize-sync", "FinalizeSyncConnector"],
  ["finalize-merge", "finalize-merge-policy-skipped", "target-connection", "finalize-sync", "FinalizeSyncConnector"],
  ["finalize-merge", "finalize-merge-pr-opened", "await"],
  ["finalize-sync", "finalize-sync-execution-required", "execution"],
  ["finalize-sync", "finalize-sync-built", "target-connection", "finalize-cleanup", "FinalizeCleanupConnector"],
  ["finalize-sync", "finalize-sync-unchanged", "target-connection", "finalize-cleanup", "FinalizeCleanupConnector"],
  ["finalize-sync", "finalize-sync-skipped-with-warning", "target-connection", "finalize-cleanup", "FinalizeCleanupConnector"],
  ["finalize-cleanup", "finalize-cleanup-execution-required", "execution"],
  ["finalize-cleanup", "finalize-cleanup-completed", "completion"],
  ["finalize-cleanup", "finalize-cleanup-completed-with-warning", "completion"],
  ...["finalize-commit", "finalize-merge", "finalize-sync", "finalize-cleanup"]
    .map((stepId) => [stepId, `${stepId}-error`, "failure"]),
].map((entry) => new FinalizationPhaseSettlementExpectation(...entry)));

export function assertFinalizationPhaseSettlement(result) {
  const expectation = finalizationPhaseSettlementExpectations.find((entry) => entry.stepId === result.stepId
    && entry.resultKind === result.kind);
  assert.ok(expectation, `FINALIZATION_PHASE_SETTLEMENT_RESULT_UNKNOWN: ${result.stepId}/${result.kind}`);
  const selected = assertPhaseSettlementRoundtrip(result, { name: "settleFinalizationStepResult",
    missingCode: "FINALIZATION_PHASE_SETTLEMENT_API_MISSING",
    nonTargetKinds: ["execution", "await", "failure", "completion"],
    connectorNames: ["FinalizeMergeConnector", "FinalizeSyncConnector", "FinalizeCleanupConnector"] });
  return expectation.assertSelected(selected);
}
