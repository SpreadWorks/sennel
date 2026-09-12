import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkGuardrail, RequirementGateBatch, RequirementGateExecutionPlan } from "../../../src/flow/lib/run-gate.js";
import { buildAcknowledgedRationaleSection } from "../../../src/flow/lib/acknowledged-rationale.js";
import { PromptLogicalFootprint, PromptRequestLimit, PromptExecutionBudget, PromptExecutionLimit } from "../../../src/lib/prompt-batching.js";

const article = Object.freeze({
  id: "explicit-rule", title: "Explicit rule",
  body: "Require a complete section unless an explicit acknowledgment permits the exception.",
  meta: { phase: ["spec"], category: "testing" },
});

describe("Guardrail complete evidence batching", () => {
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

  it("partitions an oversized Guardrail body instead of repeating it as fixed context", async () => {
    const largeArticle = Object.freeze({
      id: "large-rule",
      title: "Large rule",
      body: `RULE_HEAD ${"g".repeat(133790)} RULE_TAIL`,
      meta: { phase: ["spec"], category: "testing" },
    });
    const ranges = [];
    let finalCalls = 0;
    const agent = {
      resolve: () => true,
      call: async (userPrompt, options) => {
        assert.ok(PromptLogicalFootprint.measure({ userPrompt, ...options }).total <= 120000);
        if (userPrompt.includes("## Canonical input ranges\n")) {
          const supplied = JSON.parse(userPrompt.split("## Canonical input ranges\n")[1]);
          ranges.push(...supplied.filter((range) => range.sourceRef.startsWith("large-rule:canonical-obligation")));
          return JSON.stringify({ observations: supplied.map((range) => ({
            requirementId: largeArticle.id,
            sourceRef: range.sourceRef,
            support: ["RULE_HEAD", "RULE_TAIL"].filter((marker) => range.content.includes(marker)),
            contradictions: [],
            unresolved: [],
          })) });
        }
        finalCalls += 1;
        assert.match(userPrompt, /RULE_HEAD/);
        assert.match(userPrompt, /RULE_TAIL/);
        return JSON.stringify({ observations: [] });
      },
    };

    const result = await checkGuardrail(".", "small source", "spec", undefined, [], {
      agent,
      loadGuardrails: () => [largeArticle],
    });

    const reconstructed = ranges
      .sort((left, right) => left.start - right.start)
      .map((range) => range.content)
      .join("");
    assert.equal(reconstructed, `Guardrail ${largeArticle.id}: ${largeArticle.title}\n${largeArticle.body}`);
    assert.ok(ranges.length > 1);
    assert.equal(finalCalls, 1);
    assert.equal(result.passed, true, JSON.stringify(result));
  });

  it("retains distinct blocking occurrences at the beginning, middle and end of oversized source", async () => {
    const markers = ["HEAD_VIOLATION", "MIDDLE_VIOLATION", "TAIL_VIOLATION"];
    const source = markers.join(`\n${"x".repeat(70000)}\n`);
    const seen = [];
    let judgments = 0;
    const agent = {
      resolve: () => true,
      call: async (userPrompt) => {
        if (userPrompt.includes("## Canonical input ranges\n")) {
          const ranges = JSON.parse(userPrompt.split("## Canonical input ranges\n")[1]);
          return JSON.stringify({ observations: ranges.map((range) => {
            const found = markers.filter((marker) => range.content.includes(marker));
            seen.push(...found);
            return { requirementId: article.id, sourceRef: range.sourceRef, support: [], contradictions: found, unresolved: [] };
          }) });
        }
        judgments += 1;
        for (const marker of markers) assert.ok(userPrompt.includes(marker));
        return JSON.stringify({ observations: markers.map((marker) => ({
          failureMode: "guardrail-violation", requirementRef: article.id,
          where: { file: "source.txt", locator: marker }, observed: marker,
        })) });
      },
    };
    const result = await checkGuardrail(".", source, "spec", undefined, [], { agent, loadGuardrails: () => [article] });
    assert.equal(result.passed, false);
    assert.deepEqual(seen, markers);
    assert.equal(judgments, 1);
    assert.deepEqual(result.evaluations.map((evaluation) => [evaluation.result, evaluation.reason]),
      markers.map((marker) => ["fail", marker]));
  });

  it("reduces oversized evidence while preserving original source references before one final judgment", async () => {
    const sourceRefs = new Set();
    let reductionCalls = 0;
    let finalCalls = 0;
    const agent = {
      promptCharacterLimit: 12000,
      resolve: () => true,
      call: async (userPrompt, options) => {
        assert.ok(PromptLogicalFootprint.measure({ userPrompt, ...options }).total <= 12000);
        if (userPrompt.includes("## Canonical input ranges\n")) {
          const ranges = JSON.parse(userPrompt.split("## Canonical input ranges\n")[1]);
          const reducing = ranges.some((range) => range.coveredSourceRefs);
          if (reducing) reductionCalls += 1;
          return JSON.stringify({ observations: ranges.map((range) => {
            if (!reducing) sourceRefs.add(range.sourceRef);
            return {
              requirementId: article.id, sourceRef: range.sourceRef,
              ...(reducing ? { coveredSourceRefs: range.coveredSourceRefs } : {}),
              support: [reducing ? "Preserved supporting fact" : `Supporting fact ${"x".repeat(Math.floor(6000 / ranges.length))}`],
              contradictions: ["Original source contains a contradictory clause"], unresolved: ["Exception applicability remains unresolved"],
            };
          }) });
        }
        finalCalls += 1;
        assert.ok(reductionCalls > 0, "oversized evidence requires reduction");
        for (const ref of sourceRefs) assert.ok(userPrompt.includes(ref), ref);
        assert.match(userPrompt, /contradictory clause/);
        assert.match(userPrompt, /Exception applicability remains unresolved/);
        return JSON.stringify({ observations: [] });
      },
    };
    const result = await checkGuardrail(".", "s".repeat(40000), "spec", undefined, [], {
      agent, loadGuardrails: () => [article],
    });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(finalCalls, 1);
    assert.ok(sourceRefs.size > 3);
  });

  it("refuses before any call when full coverage plus final judgment cannot fit the call budget", async () => {
    let calls = 0;
    const result = await checkGuardrail(".", "x".repeat(140000), "spec", undefined, [], {
      agent: { resolve: () => true, call: async () => { calls += 1; return "unreachable"; } },
      loadGuardrails: () => [article],
      executionBudget: new PromptExecutionBudget(new PromptExecutionLimit({ maxProviderCallCount: 2 })),
    });
    assert.equal(result.passed, false);
    assert.equal(result.failureCode, "PROMPT_CALL_LIMIT_EXCEEDED");
    assert.deepEqual(result.evaluations, []);
    assert.equal(calls, 0);
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

  it("reconciles all source and acknowledgment ranges before publishing a judgment", async () => {
    const source = `SOURCE_HEAD ${"a".repeat(140000)} SOURCE_TAIL`;
    const rationale = `RATIONALE_HEAD ${"b".repeat(130000)} RATIONALE_TAIL`;
    const seen = new Map();
    let finalCalls = 0;
    let sourceCalls = 0;
    const agent = {
      resolve: () => true,
      call: async (userPrompt, options) => {
        assert.ok(PromptLogicalFootprint.measure({ userPrompt, ...options }).total <= 120000);
        if (userPrompt.includes("## Canonical input ranges\n")) {
          sourceCalls += 1;
          const ranges = JSON.parse(userPrompt.split("## Canonical input ranges\n")[1]);
          return JSON.stringify({ observations: ranges.map((range) => {
            const origin = range.sourceRef.split("@")[0];
            seen.set(origin, (seen.get(origin) ?? "") + range.content);
            return {
              requirementId: article.id, sourceRef: range.sourceRef,
              support: ["SOURCE_HEAD", "SOURCE_TAIL", "RATIONALE_HEAD", "RATIONALE_TAIL"].filter((marker) => range.content.includes(marker)),
              contradictions: [], unresolved: [],
            };
          }) });
        }
        finalCalls += 1;
        assert.ok(sourceCalls > 2);
        for (const marker of ["SOURCE_HEAD", "SOURCE_TAIL", "RATIONALE_HEAD", "RATIONALE_TAIL"]) {
          assert.ok(userPrompt.includes(marker), marker);
        }
        assert.match(userPrompt, /Complete Evidence Judgment/);
        return JSON.stringify({ observations: [] });
      },
    };
    const result = await checkGuardrail(".", source, "spec", undefined, [], {
      agent, loadGuardrails: () => [article], acknowledgedRationale: { markdown: rationale },
    });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(finalCalls, 1);
    assert.equal(seen.get(`${article.id}:source`), source);
    assert.equal(seen.get(`${article.id}:rationale`), rationale);
    assert.equal(result.evaluations[0].result, "pass");
  });

  it("does not publish a partial pass when a later range fails both protocol attempts", async () => {
    const calls = [];
    const agent = {
      resolve: () => true,
      call: async (userPrompt, options) => {
        calls.push(options.cacheMode);
        assert.ok(userPrompt.includes("## Canonical input ranges\n"), "no final judgment may run");
        if (calls.length > 1) return "invalid provider JSON";
        const ranges = JSON.parse(userPrompt.split("## Canonical input ranges\n")[1]);
        return JSON.stringify({ observations: ranges.map((range) => ({
          requirementId: article.id, sourceRef: range.sourceRef,
          support: [], contradictions: [], unresolved: [],
        })) });
      },
    };
    const result = await checkGuardrail(".", "x".repeat(140000), "spec", undefined, [], {
      agent, loadGuardrails: () => [article],
    });
    assert.equal(result.passed, false);
    assert.deepEqual(result.evaluations, []);
    assert.equal(calls.length, 3);
    assert.equal(calls.at(-1), "bypass");
    assert.ok(result.failureCode);
  });
});
