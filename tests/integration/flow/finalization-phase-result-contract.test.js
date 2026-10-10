import assert from "node:assert/strict";
import { test } from "node:test";
import * as definition from "../../../src/flow/definition.js";
import { finalizationPhaseManifest } from "../../support/structure/finalization-phase-scope.js";
import { finalizationPhaseResultContracts, assertFinalizationPhaseResult, assertFinalizationPhaseSettlementRoundtrip }
  from "../../support/assertions/finalization-phase-result.js";
import { finalizationPhaseSettlementExpectations } from "../../support/assertions/finalization-phase-settlement.js";

test("0717 fixes all four leaves and their semantic and common Error Results", () => {
  const expected = finalizationPhaseManifest.leaves.map((leaf) => leaf.stepId).sort();
  assert.deepEqual([...new Set(finalizationPhaseResultContracts.map((entry) => entry.stepId))].sort(), expected);
  assert.equal(finalizationPhaseResultContracts.length, 18);
  assert.equal(new Set(finalizationPhaseResultContracts.map((entry) => entry.kind)).size, 18);
  for (const stepId of expected) {
    const contracts = finalizationPhaseResultContracts.filter((entry) => entry.stepId === stepId);
    assert.equal(contracts.filter((entry) => entry.type === "loop-required").length, 1);
    assert.deepEqual(contracts.filter((entry) => entry.type === "error").map((entry) => entry.className), ["StepErrorResult"]);
  }
  const pr = finalizationPhaseResultContracts.find((entry) => entry.kind === "finalize-merge-pr-opened");
  assert.equal(pr.type, "completed", "the completed PR publication selects Await in Definition");
});

for (const contract of finalizationPhaseResultContracts) {
  test(`0717 ${contract.stepId}: single registry keeps ${contract.className}/${contract.kind}/${contract.type}`, () => {
    contract.registration();
  });
}

test("0717 saved finalization Results have one Result-only Definition settlement API", () => {
  assert.equal(typeof definition.settleFinalizationStepResult, "function",
    "FINALIZATION_PHASE_SETTLEMENT_API_MISSING: settleFinalizationStepResult");
});

test("0717 every Result kind owns one exact settlement expectation", () => {
  assert.deepEqual(finalizationPhaseSettlementExpectations.map((entry) => [entry.stepId, entry.resultKind]).sort(),
    finalizationPhaseResultContracts.map((entry) => [entry.stepId, entry.kind]).sort());
  assert.equal(new Set(finalizationPhaseSettlementExpectations.map((entry) => entry.resultKind)).size, 18);
});

for (const contract of finalizationPhaseResultContracts.filter((entry) => entry.type !== "loop-required")) {
  test(`0717 real ${contract.kind} selects its exact terminal or Failure disposition after registry restoration`, () => {
    // Assert registration first: missing migration is a contract red, never an
    // import/constructor setup error. Success evidence belongs to the receipt,
    // publication and claim; these fixed terminal kinds require no invented IO.
    const entry = contract.registration();
    assert.deepEqual(Object.keys(entry.operands ?? {}), [],
      `FINALIZATION_PHASE_LAWFUL_RESULT_PRODUCER_REQUIRED: ${contract.kind} declares operands; its actual producer must supply them`);
    const result = contract.type === "error"
      ? new entry.ResultClass(contract.stepId, Object.assign(new Error("Observed finalization execution failure"), {
        code: "FINALIZATION_OBSERVED_FAILURE", data: { phase: contract.stepId },
      }))
      : new entry.ResultClass();
    const restored = assertFinalizationPhaseResult(result);
    const settlement = assertFinalizationPhaseSettlementRoundtrip(restored);
    const expected = finalizationPhaseSettlementExpectations.find((candidate) => candidate.resultKind === contract.kind);
    assert.equal(settlement.kind, expected.settlementKind);
    if (contract.type === "error") assert.deepEqual(restored.error.data, { phase: contract.stepId });
  });
}

/** This fixture exercises only the expectation assertion, not production
 * Definition, Result registration, receipt serialization or phase acceptance.
 */
class SettlementExpectationFixture {
  constructor(expected, changes = {}) {
    this.sourceStepId = expected.stepId;
    this.resultKind = expected.resultKind;
    this.kind = expected.settlementKind;
    if (expected.settlementKind === "target-connection") {
      this.targetStepId = expected.targetStepId;
      this.connector = Object.defineProperty(class {}, "name", { value: expected.connectorName });
    }
    Object.assign(this, changes);
    Object.freeze(this);
  }
}

for (const expected of finalizationPhaseSettlementExpectations) {
  for (const [label, changes, message] of [
    ["wrong disposition", { kind: expected.settlementKind === "failure" ? "completion" : "failure" }, "KIND_MISMATCH"],
    ...(expected.settlementKind === "target-connection" ? [
      ["wrong target", { targetStepId: "report" }, "TARGET_MISMATCH"],
      ["another valid phase Connector", { connector: Object.defineProperty(class {}, "name", {
        value: expected.connectorName === "FinalizeMergeConnector" ? "FinalizeSyncConnector" : "FinalizeMergeConnector",
      }) }, "CONNECTOR_MISMATCH"],
    ] : [
      ["false target", { targetStepId: "finalize-sync" }, "FALSE_TARGET"],
      ["false Connector", { connector: class FinalizeSyncConnector {} }, "FALSE_CONNECTOR"],
    ]),
  ]) test(`isolated ${expected.resultKind} expectation rejects ${label} and accepts restoration`, () => {
    const lawful = new SettlementExpectationFixture(expected);
    assert.equal(expected.assertSelected(lawful), lawful);
    const malformed = new SettlementExpectationFixture(expected, changes);
    assert.throws(() => expected.assertSelected(malformed), (error) => error.code === "ERR_ASSERTION"
      && error.message.includes(`FINALIZATION_PHASE_SETTLEMENT_${message}`)
      && error.message.includes(expected.resultKind));
    assert.equal(expected.assertSelected(lawful), lawful);
  });
}
