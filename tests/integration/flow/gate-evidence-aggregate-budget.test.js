import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RequirementEvidenceInput,
  RequirementEvidencePlan,
  RequirementObservationResponse,
} from "../../../src/flow/lib/gate-prompt-plan.js";
import { PromptExecutionLimit } from "../../../src/lib/prompt-batching.js";

class EvidenceRequirement {
  constructor() { this.id = "R1"; }
  toPromptText() { return "Retain all cited evidence."; }
}

function evidencePlan(executionLimit) {
  return new RequirementEvidencePlan({
    requirement: new EvidenceRequirement(),
    inputs: Array.from({ length: 12 }, (_, index) => new RequirementEvidenceInput({
      id: `source-${index}`, text: "e".repeat(80_000),
    })),
    ...(executionLimit ? { executionLimit } : {}),
  });
}

function providerBoundary() {
  const measured = { calls: 0, characters: 0 };
  return {
    measured,
    callAgent: async (_request, batch) => {
      measured.calls += 1;
      const response = JSON.stringify({ observations: batch.payloadElements.map((element, index) => ({
        requirementId: "R1", sourceRef: element.id,
        support: index === 0 ? ["s".repeat(90_000)] : [],
        contradictions: [], unresolved: [],
      })) });
      assert.ok(response.length < 120_000, "Each provider response stays below its independent limit");
      measured.characters += response.length;
      return response;
    },
    protocolPolicy: {
      async execute({ batch, call }) {
        return new RequirementObservationResponse(JSON.parse(await call()), "R1", batch);
      },
    },
  };
}

test("executes the Flow evidence plan default above one million without losing source coverage", async () => {
  const plan = evidencePlan();
  const boundary = providerBoundary();
  const result = await plan.execute(boundary);
  assert.ok(boundary.measured.characters > 1_000_000);
  assert.equal(boundary.measured.calls, plan.plan.batches.length);
  assert.deepEqual(result.completions.flatMap((completion) => completion.response.observations)
    .map((observation) => observation.sourceRef),
  plan.plan.batches.flatMap((batch) => batch.payloadElements.map((element) => element.id)));
  assert.deepEqual(new Set(result.completions.flatMap((completion) => completion.response.observations)
    .map((observation) => observation.sourceRef)),
  new Set(["R1:canonical-obligation", ...Array.from({ length: 12 }, (_, index) => `source-${index}`)]));
});

test("honors a caller's finite evidence execution limit before the remaining calls", async () => {
  const plan = evidencePlan(new PromptExecutionLimit({ maxAggregateCharacters: 100_000 }));
  const boundary = providerBoundary();
  await assert.rejects(plan.execute(boundary), (error) => {
    assert.equal(error.code, "PROMPT_BATCH_EXECUTION_INCOMPLETE");
    assert.equal(error.details.causeCode, "PROMPT_RESPONSE_TOO_LARGE");
    return true;
  });
  assert.equal(boundary.measured.calls, 2);
  assert.ok(boundary.measured.calls < plan.plan.batches.length);
});
