import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GuardrailEvidenceRule, GuardrailEvidencePlan, GuardrailObservationResponse,
  GuardrailFileJudgmentInput, GuardrailJudgmentPlan,
  RequirementEvidenceInput, RequirementEvidencePlan,
  RequirementObservationEnvelope,
  structuredGuardrailSourceInputs, countDistinctGuardrailSourceRanges,
} from "../../src/flow/lib/gate-prompt-plan.js";
import { PromptBatchContext, PromptExecutionBudget, PromptExecutionLimit, PromptLogicalFootprint, PromptRequestLimit,
  RangedTextPromptElement } from "../../src/lib/prompt-batching.js";

const rules = ["first", "second", "third"].map((id) => new GuardrailEvidenceRule({
  id, title: id, body: `Check ${id} at the Spec stage; later execution needs explicit evidence.`,
}));

function planFor(source) {
  return new GuardrailEvidencePlan({
    rules,
    inputs: [
      new RequirementEvidenceInput({ id: "spec", text: source }),
      new RequirementEvidenceInput({ id: "rationale", text: "Exception requires an explicit acknowledgment." }),
    ],
    limit: new PromptRequestLimit({ maxCharacters: 12000 }),
  });
}

it("groups whole file judgments by projected request size and refuses one oversized rule", () => {
  const inputs = rules.map((article) => new GuardrailFileJudgmentInput(article));
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

describe("shared Guardrail evidence", () => {
  it("collects every rule and source range pair with one source scan", async () => {
    const source = `SPEC_HEAD\n${"x".repeat(20000)}\nSPEC_TAIL`;
    const evidencePlan = planFor(source);
    const seen = new Map();
    let calls = 0;
    const evidence = await evidencePlan.execute({
      callAgent: async (request) => {
        calls += 1;
        assert.ok(PromptLogicalFootprint.measure(request).total <= 12000);
        const ranges = JSON.parse(request.userPrompt.split("## Canonical input ranges\n")[1]);
        for (const range of ranges) seen.set(range.sourceRef, range.content);
        return JSON.stringify({ observations: ranges.flatMap((range) => rules.map((rule) => ({
          requirementId: rule.id, sourceRef: range.sourceRef,
          support: ["SPEC_HEAD", "SPEC_TAIL"].filter((marker) => range.content.includes(marker)),
          contradictions: [], unresolved: [],
        }))) });
      },
      protocolPolicy: { execute: async ({ request, batch, call }) => new GuardrailObservationResponse(
        JSON.parse(await call(request)), rules, batch,
      ) },
      executionBudget: new PromptExecutionBudget(new PromptExecutionLimit()),
    });
    assert.equal(calls, evidencePlan.plan.batches.length);
    assert.ok(calls > 1);
    const reconstructed = [...seen].filter(([id]) => id.startsWith("spec"))
      .sort(([a], [b]) => Number(a.split("@")[1]?.split(":")[0] ?? 0) - Number(b.split("@")[1]?.split(":")[0] ?? 0))
      .map(([, content]) => content).join("");
    assert.equal(reconstructed, source);
    for (const rule of rules) {
      const observations = evidence.forRule(rule).observations;
      assert.equal(observations.length, seen.size);
      assert.ok(observations.every((entry) => entry.requirementId === rule.id));
    }
  });

  it("rejects omitted, duplicated and foreign rule-range pairs", () => {
    const plan = planFor("small source");
    const batch = plan.plan.batches[0];
    const pairs = batch.payloadElements.flatMap((range) => rules.map((rule) => ({
      requirementId: rule.id, sourceRef: range.id, support: [], contradictions: [], unresolved: [],
    })));
    assert.equal(new GuardrailObservationResponse({ observations: pairs }, rules, batch).observations.length, pairs.length);
    for (const observations of [
      pairs.slice(1),
      [...pairs.slice(1), pairs[1]],
      [{ ...pairs[0], sourceRef: "invented" }, ...pairs.slice(1)],
      [{ ...pairs[0], requirementId: "invented" }, ...pairs.slice(1)],
    ]) {
      assert.throws(() => new GuardrailObservationResponse({ observations }, rules, batch),
        (error) => error.code === "PROMPT_RESPONSE_COVERAGE_INVALID");
    }
  });

  it("groups fitting rules and partitions a rule that cannot be repeated as context", () => {
    const articles = [
      { id: "small-a", title: "A", body: "A" },
      { id: "large", title: "Large", body: "x".repeat(16000) },
      { id: "small-b", title: "B", body: "B" },
    ];
    const plans = GuardrailEvidencePlan.createGrouped({
      articles,
      inputs: [new RequirementEvidenceInput({ id: "guardrail:source", text: "source" })],
      limit: new PromptRequestLimit({ maxCharacters: 12000 }),
    });
    assert.equal(plans.length, 3);
    assert.ok(plans[0] instanceof GuardrailEvidencePlan);
    assert.ok(plans[1] instanceof RequirementEvidencePlan);
    assert.ok(plans[2] instanceof GuardrailEvidencePlan);
    const largeRanges = plans[1].plan.batches.flatMap((batch) => batch.payloadElements)
      .filter((element) => element.originId === "large:canonical-obligation");
    assert.ok(largeRanges.length > 1);
    assert.equal(largeRanges.map((element) => element.toPromptText()).join(""),
      `Guardrail large: Large\n${articles[1].body}`);
  });

  it("groups rules when the required response structure exceeds the real response limit", () => {
    const articles = rules.map((rule) => ({ id: rule.id, title: rule.title, body: rule.body }));
    const plans = GuardrailEvidencePlan.createGrouped({
      articles,
      inputs: [new RequirementEvidenceInput({ id: "guardrail:source", text: "x" })],
      limit: new PromptRequestLimit({ maxCharacters: 12000 }),
      executionLimit: new PromptExecutionLimit({ maxResponseCharacters: 260 }),
    });
    assert.equal(plans.length, 2);
    assert.deepEqual(plans.flatMap((plan) => plan.rules.map((rule) => rule.id)), rules.map((rule) => rule.id));
    assert.equal(countDistinctGuardrailSourceRanges(plans.map((plan) => plan.plan)), 1);
  });

  it("reduces source ranges per batch before splitting a fitting rule set", () => {
    const articles = rules.map((rule) => ({ id: rule.id, title: rule.title, body: rule.body }));
    const inputs = Array.from({ length: 5 }, (_, index) => new RequirementEvidenceInput({
      id: `guardrail:source:${index}`, text: `field ${index}`,
    }));
    const plans = GuardrailEvidencePlan.createGrouped({
      articles, inputs,
      limit: new PromptRequestLimit({ maxCharacters: 12000 }),
      executionLimit: new PromptExecutionLimit({ maxResponseCharacters: 350 }),
    });
    assert.equal(plans.length, 1);
    assert.ok(plans[0].plan.batches.length > 1);
    assert.deepEqual(plans[0].plan.batches.flatMap((batch) => batch.payloadElements.map((element) => element.originId)),
      inputs.map((input) => input.id));
  });

  it("retains Spec-stage and later-execution ownership instructions during evidence reduction", () => {
    const envelope = new RequirementObservationEnvelope(rules[0], { phase: "spec", reduction: true });
    const element = new RangedTextPromptElement({ id: "facts", sequence: 0, sourceRevision: "revision", text: "fact" });
    const request = envelope.buildRequest([element], new PromptBatchContext({ index: 0, count: 1 }));
    assert.match(request.systemPrompt, /At the Spec stage, identify the confirmation method and acceptance condition/);
    assert.match(request.systemPrompt, /later implementation or test execution is owned by a later step/);
    assert.match(request.systemPrompt, /Do not turn a planned later check into executed evidence/);
  });

  it("retains exact Spec bytes, revision and record identity through field and range planning", () => {
    const document = {
      overview: { summary: "Example" },
      requirements: [{ id: "R-1", desc: "D".repeat(20000) }],
      tasks: [{ id: "T-1", acceptance: ["Check after implementation"] }],
    };
    const source = `${JSON.stringify(document, null, 2)}\n`;
    const inputs = structuredGuardrailSourceInputs(source, document);
    assert.equal(inputs.map((input) => input.text).join(""), source);
    const revision = inputs[0].sourceRevision;
    assert.ok(inputs.every((input) => input.sourceRevision === revision));
    assert.deepEqual(inputs.filter((input) => input.recordId).map((input) => [input.sourcePath, input.recordId]),
      [["/requirements/0", "R-1"], ["/tasks/0", "T-1"]]);
    const plan = new GuardrailEvidencePlan({ rules: rules.slice(0, 2), inputs,
      limit: new PromptRequestLimit({ maxCharacters: 12000 }) });
    const leaves = plan.plan.batches.flatMap((batch) => batch.payloadElements);
    assert.ok(leaves.filter((leaf) => leaf.sourcePath === "/requirements/0").length > 1);
    assert.ok(leaves.every((leaf) => leaf.sourceRevision === revision));
    assert.ok(leaves.every((leaf) => leaf.sourcePath));
    assert.equal(leaves.map((leaf) => leaf.toPromptText()).join(""), source);
  });

  it("coalesces adjacent canonical records without losing member spans or split provenance", () => {
    const document = {
      requirements: Array.from({ length: 24 }, (_, index) => ({
        id: `R-${index}`, desc: `Confirm criterion ${index}. ${"detail ".repeat(16)}`,
      })),
      tasks: [{ id: "T-1", acceptance: "Verify after implementation." }],
    };
    const source = `${JSON.stringify(document, null, 2)}\n`;
    const inputs = structuredGuardrailSourceInputs(source, document, { maxGroupCharacters: 900 });
    assert.equal(inputs.map((input) => input.text).join(""), source);
    const grouped = inputs.filter((input) => input.members?.length > 1);
    assert.ok(grouped.length > 0);
    assert.ok(inputs.length < 27);
    const requirementMembers = inputs.flatMap((input) => input.members ?? [])
      .filter((member) => member.sourcePath.startsWith("/requirements/"));
    assert.equal(requirementMembers.length, 24);
    for (const [index, member] of requirementMembers.entries()) {
      assert.equal(member.recordId, `R-${index}`);
      assert.equal(member.sourcePath, `/requirements/${index}`);
      assert.equal(member.sourceRevision, inputs[0].sourceRevision);
      assert.match(source.slice(member.start, member.end), new RegExp(`R-${index}`));
    }
    const plan = new GuardrailEvidencePlan({ rules: rules.slice(0, 2), inputs,
      limit: new PromptRequestLimit({ maxCharacters: 8000 }) });
    const leaves = plan.plan.batches.flatMap((batch) => batch.payloadElements);
    assert.equal(leaves.map((leaf) => leaf.toPromptText()).join(""), source);
    assert.ok(leaves.flatMap((leaf) => leaf.members ?? []).some((member) => member.recordId === "R-23"));
    for (const leaf of leaves.filter((entry) => entry.members)) {
      assert.ok(leaf.members.every((member) => member.start < leaf.end && member.end > leaf.start));
    }
  });

});
