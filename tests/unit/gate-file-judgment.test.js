import assert from "node:assert/strict";
import { it } from "node:test";
import { GuardrailFileJudgmentInput, GuardrailJudgmentPlan, RequirementEvidenceInput, RequirementEvidencePlan } from "../../src/flow/lib/gate-prompt-plan.js";
import { PromptRequestLimit, PromptExecutionLimit } from "../../src/lib/prompt-batching.js";

class EvidenceRequirement {
  constructor() { this.id = "R1"; }
  toPromptText() { return "Every result retains its evidence."; }
}

it("plans complete evidence with an unlimited response size while retaining item limits", () => {
  const requirement = new EvidenceRequirement();
  const inputs = [new RequirementEvidenceInput({ id: "source", text: "The result includes its evidence." })];
  const unlimited = new RequirementEvidencePlan({ requirement, inputs,
    executionLimit: new PromptExecutionLimit({ maxResponseCharacters: null }),
  });
  assert.equal(unlimited.plan.batches.length, 1);
  assert.deepEqual(unlimited.plan.batches[0].payloadElements.map((entry) => entry.id), ["R1:canonical-obligation", "source"]);
  const itemBounded = new RequirementEvidencePlan({ requirement, inputs,
    executionLimit: new PromptExecutionLimit({ maxResponseCharacters: null, maxAggregateItemCount: 1 }),
  });
  assert.equal(itemBounded.plan.batches.length, 2);
  assert.ok(itemBounded.plan.batches.every((batch) => batch.payloadElements.length === 1));
  assert.throws(() => new RequirementEvidencePlan({ requirement, inputs,
    executionLimit: new PromptExecutionLimit({ maxResponseCharacters: 1 }),
  }), (error) => error.code === "PROMPT_RESPONSE_TOO_LARGE");
});

it("groups complete file judgments by projected request size and refuses one oversized rule", () => {
  const inputs = ["first", "second", "third"].map((id) =>
    new GuardrailFileJudgmentInput({ id, title: id, body: `Check ${id}.` }));
  const limit = new PromptRequestLimit({ maxCharacters: 1000 });
  const buildRequest = (group) => ({ userPrompt: JSON.stringify(group.map((input) => input.article.id)) });
  const plan = new GuardrailJudgmentPlan({
    inputs, limit, buildRequest,
    projectInvocation: (request) => ({ fits: () => JSON.parse(request.userPrompt).length <= 2 }),
  });
  assert.deepEqual(plan.plans.map((part) => JSON.parse(part.batches[0].request.userPrompt)),
    [["first", "second"], ["third"]]);
  assert.throws(() => new GuardrailJudgmentPlan({
    inputs: inputs.slice(0, 1), limit, buildRequest: () => ({ userPrompt: "x".repeat(1200) }),
  }), (error) => error.code === "PROMPT_ELEMENT_TOO_LARGE");
});
