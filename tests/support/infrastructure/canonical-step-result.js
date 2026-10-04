import assert from "node:assert/strict";

import { STEP_RESULT_REGISTRY, StepResult } from "../../../src/flow/engine/step-result.js";
import { NodeResult } from "../../../src/flow/lib/current-flow-state.js";

/** Assert a canonical Result's typed value and its unique registered contract. */
export function assertCanonicalStepResult(nodeResult, { stepId, kind, type }) {
  assert.ok(nodeResult instanceof NodeResult, "canonical readback must return a typed NodeResult");
  assert.ok(nodeResult.stepResult instanceof StepResult,
    "canonical readback must expose a rehydrated StepResult instance");
  const result = nodeResult.stepResult;
  assert.equal(result.stepId, stepId);
  assert.equal(result.kind, kind);
  assert.equal(result.type, type);
  const entries = STEP_RESULT_REGISTRY.filter((entry) => entry.kind === kind);
  assert.equal(entries.length, 1, `${kind} must have one existing Result registration`);
  assert.equal(entries[0].stepId, stepId);
  assert.equal(entries[0].type, type);
  assert.equal(result.constructor, entries[0].ResultClass);
  return result;
}
