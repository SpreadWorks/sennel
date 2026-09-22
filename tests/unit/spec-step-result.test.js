import assert from "node:assert/strict";
import test from "node:test";

import {
  SpecNextRoute,
  StepErrorDecision,
  settleSpecStepResult,
} from "../../src/flow/definition.js";
import { SpecReviewConnector } from "../../src/flow/engine/connectors/spec/spec-review-connector.js";
import {
  SpecCreatedResult,
  StepErrorResult,
  StepResult,
} from "../../src/flow/engine/step-result.js";
import {
  CanonicalFlowArtifactBaseline,
  CanonicalWorkerSpecPublication,
} from "../../src/flow/lib/current-flow-state.js";
import { SpecWorkerCompletionFacts } from "../../src/flow/lib/spec-step-connection.js";
import { specResult } from "../../src/flow/steps/spec/spec.js";

test("initial Spec facts produce the semantic Result without I/O", () => {
  const facts = new SpecWorkerCompletionFacts({
    publication: new CanonicalWorkerSpecPublication({ version: 1 }),
    baseline: new CanonicalFlowArtifactBaseline({ logicalKey: "spec.record" }),
  });

  const result = specResult(facts);

  assert.equal(result instanceof SpecCreatedResult, true);
  assert.deepEqual(result.toJSON(), { kind: "spec-created", type: "completed" });
});

test("Definition deterministically selects the Spec Review connection after readback", () => {
  const original = new SpecCreatedResult();
  const restored = StepResult.fromStored("spec", original.toJSON());

  for (const result of [original, restored]) {
    const settlement = settleSpecStepResult("spec", result);
    assert.equal(settlement instanceof SpecNextRoute, true);
    assert.equal(settlement.targetStepId, "spec-review");
    assert.equal(settlement.connector, SpecReviewConnector);
    assert.deepEqual(settlement.toJSON(), {
      kind: "target-connection",
      sourceStepId: "spec",
      targetStepId: "spec-review",
      effects: { skipStepIds: [], resetStepIds: [] },
    });
  }
});

test("Spec Error Results select the shared failure settlement", () => {
  const result = specResult(new Error("initial Spec unavailable"));
  const settlement = settleSpecStepResult(result.stepId, result);

  assert.equal(result instanceof StepErrorResult, true);
  assert.equal(result.stepId, "spec");
  assert.equal(settlement instanceof StepErrorDecision, true);
  assert.equal(settlement.error.message, "initial Spec unavailable");
  assert.equal(Object.hasOwn(settlement, "connector"), false);
});
