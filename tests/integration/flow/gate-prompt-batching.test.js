import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkGuardrail, GateProviderCallAdmission, RequirementGateBatch, RequirementGateExecutionPlan } from "../../../src/flow/lib/run-gate.js";
import { buildAcknowledgedRationaleSection } from "../../../src/flow/lib/acknowledged-rationale.js";
import { PromptLogicalFootprint, PromptRequestLimit, PromptExecutionBudget, PromptExecutionLimit } from "../../../src/lib/prompt-batching.js";

const article = Object.freeze({
  id: "explicit-rule", title: "Explicit rule",
  body: "Require a complete section unless an explicit acknowledgment permits the exception.",
  meta: { phase: ["spec"], category: "testing" },
});

describe("Gate prompt batching", () => {
  it("keeps a small parent Spec and all rules in one judgment call", async () => {
    const second = Object.freeze({
      id: "second-rule", title: "Second", body: "Require explicit confirmation.",
      meta: { phase: ["spec"], category: "testing" },
    });
    let calls = 0;
    const result = await checkGuardrail(".", "small Spec", "spec", undefined, [], {
      loadGuardrails: () => [article, second],
      agent: { resolve: () => true, call: async (userPrompt, options) => {
        calls += 1;
        assert.match(userPrompt, /Require a complete section unless an explicit acknowledgment permits the exception/);
        assert.match(userPrompt, /Require explicit confirmation/);
        assert.match(options.systemPrompt, /At the Spec stage, check that confirmation methods and acceptance conditions are stated/);
        return JSON.stringify({ observations: [] });
      } },
    });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(calls, 1);
  });

  it("runs canonical admission before consuming a provider transport attempt", async () => {
    const events = [];
    const base = {
      claim() { events.push("claim"); },
      beforeProviderAttempt() { events.push("provider"); },
      settle() { events.push("settle"); },
      claimed: false,
      attemptCount: 0,
      settled: false,
    };
    const admission = new GateProviderCallAdmission(base, async () => {
      events.push("canonical-read");
      const error = new Error("the exact Gate Attempt is no longer admitted");
      error.code = "FLOW_GATE_EVALUATION_ADMISSION_DENIED";
      throw error;
    });

    admission.claim();
    await assert.rejects(
      admission.beforeProviderAttempt(),
      (error) => error.code === "FLOW_GATE_EVALUATION_ADMISSION_DENIED",
    );
    assert.deepEqual(events, ["claim", "canonical-read"]);
  });

  it("partitions a 133,813-character Requirement body with exact canonical coverage", async () => {
    const description = `REQ_HEAD ${"r".repeat(133795)} REQ_TAIL`;
    assert.equal(description.length, 133813);
    const requirement = { id: "R-LARGE", desc: description };
    const [execution] = RequirementGateExecutionPlan.create(
      new RequirementGateBatch({ requirements: [requirement], diff: "+implemented source" }),
      new PromptRequestLimit(),
    );
    const ranges = [];
    const projectedPrompts = new Set();
    const providerPrompts = [];
    let finalCalls = 0;
    const agent = {
      projectInvocation: (userPrompt) => {
        projectedPrompts.add(userPrompt);
        return { assertWithinLimit: () => {} };
      },
      call: async (userPrompt, options) => {
        providerPrompts.push(userPrompt);
        assert.ok(PromptLogicalFootprint.measure({ userPrompt, ...options }).total <= 120000);
        if (userPrompt.includes("## Canonical input ranges\n")) {
          const supplied = JSON.parse(userPrompt.split("## Canonical input ranges\n")[1]);
          ranges.push(...supplied.filter((range) => range.sourceRef.startsWith("R-LARGE:canonical-obligation")));
          return JSON.stringify({ observations: supplied.map((range) => ({
            requirementId: requirement.id,
            sourceRef: range.sourceRef,
            support: ["REQ_HEAD", "REQ_TAIL"].filter((marker) => range.content.includes(marker)),
            contradictions: [],
            unresolved: [],
          })) });
        }
        finalCalls += 1;
        assert.match(userPrompt, /REQ_HEAD/);
        assert.match(userPrompt, /REQ_TAIL/);
        return JSON.stringify({ evaluations: [{
          guardrail_id: requirement.id,
          result: "pass",
          reason: "[REQ:R-LARGE] complete canonical evidence is implemented",
        }] });
      },
    };

    const result = await execution.execute({
      agent,
      phase: "task-impl",
      executionBudget: new PromptExecutionBudget(new PromptExecutionLimit()),
    });

    const reconstructed = ranges
      .sort((left, right) => left.start - right.start)
      .map((range) => range.content)
      .join("");
    assert.equal(reconstructed, `- R-LARGE: ${description}`);
    assert.ok(ranges.length > 1);
    assert.equal(finalCalls, 1);
    assert.equal(result[0].result, "pass");
    for (const userPrompt of providerPrompts) assert.ok(projectedPrompts.has(userPrompt));
  });

  it("retains same-spec records beyond the retired section and character caps", () => {
    const spec = {
      requirements: Array.from({ length: 70 }, (_, index) => ({ id: `R${index}`, desc: `Contract ${index} ${"x".repeat(1500)}` })),
      overview: { decisions: Array.from({ length: 30 }, (_, index) => ({ text: `Decision ${index} ${"y".repeat(450)}` })) },
      clarifications: Array.from({ length: 30 }, (_, index) => ({ q: `Question ${index}`, a: `Answer ${index} ${"z".repeat(1500)}` })),
    };
    const batch = new RequirementGateBatch({ requirements: [spec.requirements[0]], structuredSpec: spec, diff: "+source" });
    const [execution] = RequirementGateExecutionPlan.create(batch, new PromptRequestLimit());
    const textByOrigin = new Map();
    for (const planned of execution.evidence.plan.batches) {
      assert.ok(planned.footprint.total <= 120000);
      for (const element of planned.elements) {
        textByOrigin.set(element.originId, (textByOrigin.get(element.originId) ?? "") + element.toPromptText());
      }
    }
    for (const section of [batch.sameSpecContractContext.requirements, batch.sameSpecContractContext.decisions, batch.sameSpecContractContext.clarifications]) {
      for (const record of section.records) assert.equal(textByOrigin.get(`R0:contract:${record.locator}`), record.toPromptText());
    }
    assert.equal(textByOrigin.size, 131);
  });

  it("retains every matched acknowledgment beyond the retired entry and text caps", () => {
    const constraints = Array.from({ length: 5 }, (_, index) => `${article.id} reason ${index} ${"r".repeat(1200)} END_${index}`);
    const section = buildAcknowledgedRationaleSection({ spec: { constraints }, guardrails: [article] });
    for (const text of constraints) assert.ok(section.markdown.includes(text));
  });

});
