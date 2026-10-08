import assert from "node:assert/strict";
import { rehydrateStepResult, stepResultDigest } from "../../../src/flow/engine/step-result.js";
import * as definition from "../../../src/flow/definition.js";
import { StepConnector } from "../../../src/flow/engine/step-connector.js";

/** Shared Result-only selection and exact serialization boundary. The caller
 * supplies only the owning Definition API and fixed phase-specific contracts. */
export function assertPhaseSettlementRoundtrip(result, { name, missingCode,
  nonTargetKinds = ["execution", "await", "failure"], connectorNames = null }) {
  assert.equal(typeof definition[name], "function", `${missingCode}: ${name}`);
  const stored = result.toJSON();
  const restored = rehydrateStepResult(result.stepId, stored);
  const digest = stepResultDigest(restored);
  const selected = definition[name](result.stepId, restored);
  assert.ok(selected instanceof definition.StepSettlement);
  assert.equal(selected.sourceStepId, result.stepId);
  assert.equal(selected.resultKind, result.kind);
  assert.equal(selected.resultType, result.type);
  assert.equal(Object.hasOwn(selected, "facts"), false, "Result-only selection must not retain arbitrary facts");
  const repeated = definition[name](result.stepId, rehydrateStepResult(result.stepId, stored));
  assert.equal(repeated.constructor, selected.constructor);
  assert.deepEqual(repeated.toJSON(), selected.toJSON());
  assert.equal(stepResultDigest(restored), digest, "settlement selection cannot mutate its persisted Result");
  if (selected.kind === "target-connection") {
    assert.ok(selected instanceof definition.StepRoute);
    assert.ok(selected.connector.prototype instanceof StepConnector);
    assert.equal(repeated.connector, selected.connector, "restored Result must select the exact same Connector class");
    if (connectorNames !== null) assert.ok(connectorNames.includes(selected.connector.name),
      `unexpected phase Connector ${selected.connector.name}`);
  } else {
    assert.ok(nonTargetKinds.includes(selected.kind));
    assert.equal("connector" in selected, false);
    assert.equal("targetStepId" in selected, false);
  }
  return selected;
}
