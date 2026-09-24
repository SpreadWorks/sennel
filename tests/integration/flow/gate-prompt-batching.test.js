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

describe("Guardrail complete evidence batching", () => {
  it("keeps a small parent Spec and all rules in one judgment call", async () => {
    const second = Object.freeze({
      id: "second-rule", title: "Second", body: "Require explicit confirmation.",
      meta: { phase: ["spec"], category: "testing" },
    });
    let calls = 0;
    const result = await checkGuardrail(".", "small Spec", "spec", undefined, [], {
      sharedGuardrailEvidence: true,
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

  it("scans each oversized Spec range once for every rule and keeps full rule text in judgment", async () => {
    const second = Object.freeze({
      id: "second-rule", title: "Second rule",
      body: "The exception applies only when its explicit acknowledgment names this rule.",
      meta: { phase: ["spec"], category: "testing" },
    });
    const source = `SPEC_HEAD\n${"x".repeat(140000)}\nSPEC_TAIL`;
    const scanRefs = new Map();
    const judgmentPrompts = [];
    const metrics = [];
    let scannedSourceChars = 0;
    let scans = 0;
    let judgments = 0;
    const agent = {
      resolve: () => true,
      call: async (userPrompt, options) => {
        assert.ok(PromptLogicalFootprint.measure({ userPrompt, ...options }).total <= 120000);
        if (userPrompt.includes("## Canonical input ranges\n")) {
          scans += 1;
          const ranges = JSON.parse(userPrompt.split("## Canonical input ranges\n")[1]);
          for (const range of ranges) {
            scanRefs.set(range.sourceRef, (scanRefs.get(range.sourceRef) ?? 0) + 1);
            if (range.sourceRef.includes(":source")) scannedSourceChars += range.content.length;
          }
          const listedRules = [article, second].filter((rule) => userPrompt.includes(`Guardrail ${rule.id}:`)
            || userPrompt.includes(`## Obligation identity\n${rule.id}\n`));
          return JSON.stringify({ observations: ranges.flatMap((range) => listedRules.map((rule) => ({
            requirementId: rule.id, sourceRef: range.sourceRef,
            support: ["SPEC_HEAD", "SPEC_TAIL"].filter((marker) => range.content.includes(marker)),
            contradictions: [], unresolved: [],
          }))) });
        }
        judgments += 1;
        judgmentPrompts.push(userPrompt);
        return JSON.stringify({ observations: [] });
      },
    };
    const result = await checkGuardrail(".", source, "spec", undefined, [], {
      agent, loadGuardrails: () => [article, second], sharedGuardrailEvidence: true,
      recordPromptMetric: (metric) => metrics.push(metric),
    });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.ok(scans > 1);
    assert.equal(scannedSourceChars, source.length);
    assert.ok([...scanRefs.values()].every((count) => count === 1));
    assert.equal(metrics.find((metric) => metric.stage === "source-partition").count,
      [...scanRefs.keys()].filter((ref) => ref.includes(":source")).length);
    assert.equal(judgments, 1);
    assert.match(judgmentPrompts[0], /SPEC_HEAD/);
    assert.match(judgmentPrompts[0], /SPEC_TAIL/);
    assert.match(judgmentPrompts[0], /exception applies only when its explicit acknowledgment names this rule/);
    assert.match(judgmentPrompts[0], /Require a complete section unless an explicit acknowledgment permits the exception/);
    assert.deepEqual(result.evaluations.map((entry) => entry.guardrail_id).sort(), [article.id, second.id].sort());
  });

  it("accounts for collection, format repair and judgment transport attempts without duplicate calls", async () => {
    const metrics = [];
    const transports = [];
    let malformed = false;
    const agent = {
      resolve: () => true,
      call: async (userPrompt, options) => {
        options.providerCallAdmission.claim();
        const collecting = userPrompt.includes("## Canonical input ranges\n");
        const repair = options.cacheMode === "bypass";
        const attempts = collecting && !malformed ? 2 : 1;
        for (let index = 0; index < attempts; index += 1) {
          await options.providerCallAdmission.beforeProviderAttempt();
          transports.push({ stage: repair ? "format-repair" : collecting ? "collection" : "judgment",
            characters: PromptLogicalFootprint.measure({ userPrompt, ...options }).total });
        }
        if (collecting && !malformed) {
          malformed = true;
          return "malformed JSON";
        }
        if (!collecting) return JSON.stringify({ observations: [] });
        const ranges = JSON.parse(userPrompt.split("## Canonical input ranges\n")[1]);
        return JSON.stringify({ observations: ranges.map((range) => ({
          requirementId: article.id, sourceRef: range.sourceRef,
          support: [], contradictions: [], unresolved: [],
        })) });
      },
    };
    const result = await checkGuardrail(".", "x".repeat(140000), "spec", undefined, [], {
      agent, loadGuardrails: () => [article], recordPromptMetric: (metric) => metrics.push(metric),
    });
    assert.equal(result.passed, true, JSON.stringify(result));
    const calls = metrics.filter((metric) => metric.callCount > 0);
    assert.equal(calls.reduce((total, metric) => total + metric.callCount, 0), transports.length);
    assert.equal(calls.reduce((total, metric) => total + metric.inputCharacters, 0),
      transports.reduce((total, transport) => total + transport.characters, 0));
    assert.deepEqual(new Set(calls.map((metric) => metric.stage)),
      new Set(["collection", "format-repair", "judgment"]));
    assert.equal(calls.filter((metric) => metric.stage === "format-repair").length, 1);
    assert.ok(calls.every((metric) => Number.isSafeInteger(metric.durationMs) && metric.durationMs >= 0));
  });

  it("rejects a parent Spec rule whose full canonical text cannot fit final judgment", async () => {
    const huge = Object.freeze({
      id: "huge-rule", title: "Huge rule", body: `EXCEPTION_START ${"x".repeat(130000)} EXCEPTION_END`,
      meta: { phase: ["spec"], category: "testing" },
    });
    let calls = 0;
    const result = await checkGuardrail(".", "source", "spec", undefined, [], {
      agent: { resolve: () => true, call: async () => { calls += 1; return "unreachable"; } },
      loadGuardrails: () => [huge], sharedGuardrailEvidence: true,
    });
    assert.equal(result.passed, false);
    assert.equal(result.failureCode, "PROMPT_FIXED_CONTEXT_TOO_LARGE");
    assert.deepEqual(result.evaluations, []);
    assert.equal(calls, 0);
  });

  it("carries structured parent Spec field and record provenance into every source range", async () => {
    const spec = {
      overview: { summary: "Readiness" },
      requirements: [{ id: "R-1", desc: `REQ_HEAD ${"x".repeat(130000)} REQ_TAIL` }],
      tasks: [{ id: "T-1", acceptance: ["Confirm at implementation stage"] }],
    };
    const source = `${JSON.stringify(spec, null, 2)}\n`;
    const ranges = [];
    let judgments = 0;
    const agent = {
      resolve: () => true,
      call: async (userPrompt) => {
        if (userPrompt.includes("## Canonical input ranges\n")) {
          const supplied = JSON.parse(userPrompt.split("## Canonical input ranges\n")[1]);
          ranges.push(...supplied.filter((range) => range.sourceRef.startsWith("guardrail:source:")));
          return JSON.stringify({ observations: supplied.map((range) => ({
            requirementId: article.id, sourceRef: range.sourceRef,
            support: ["REQ_HEAD", "REQ_TAIL"].filter((marker) => range.content.includes(marker)),
            contradictions: [], unresolved: [],
          })) });
        }
        judgments += 1;
        return JSON.stringify({ observations: [] });
      },
    };
    const result = await checkGuardrail(".", source, "spec", undefined, [], {
      agent, loadGuardrails: () => [article], sharedGuardrailEvidence: true, structuredSource: spec,
    });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(judgments, 1);
    assert.equal(ranges.sort((left, right) => left.start - right.start).map((range) => range.content).join(""), source);
    assert.equal(new Set(ranges.map((range) => range.revision)).size, 1);
    assert.ok(ranges.some((range) => range.sourcePath === "/requirements/0"
      && range.recordId === "R-1" && range.fields.includes("desc")));
    assert.ok(ranges.some((range) => range.sourcePath === "/tasks/0"
      && range.recordId === "T-1" && range.fields.includes("acceptance")));
  });

  it("coalesces repeated Spec records before shared G×B collection while retaining each canonical member", async () => {
    const spec = { requirements: Array.from({ length: 80 }, (_, index) => ({
      id: `R-${index}`, desc: `Plan observable criterion ${index}. ${"detail ".repeat(18)}`,
    })) };
    const source = `${JSON.stringify(spec, null, 2)}\n`;
    const observed = [];
    const metrics = [];
    const agent = { promptCharacterLimit: 18000, resolve: () => true,
      call: async (userPrompt) => {
        if (!userPrompt.includes("## Canonical input ranges\n")) return JSON.stringify({ observations: [] });
        const ranges = JSON.parse(userPrompt.split("## Canonical input ranges\n")[1]);
        observed.push(...ranges.filter((range) => range.sourceRef.startsWith("guardrail:source:")));
        return JSON.stringify({ observations: ranges.map((range) => ({
          requirementId: article.id, sourceRef: range.sourceRef,
          ...(range.coveredSourceRefs ? { coveredSourceRefs: range.coveredSourceRefs } : {}),
          support: [], contradictions: [], unresolved: [],
        })) });
      } };
    const result = await checkGuardrail(".", source, "spec", undefined, [], {
      agent, loadGuardrails: () => [article], sharedGuardrailEvidence: true, structuredSource: spec,
      recordPromptMetric: (metric) => metrics.push(metric),
    });
    assert.equal(result.passed, true, JSON.stringify(result));
    const ranges = observed.sort((left, right) => left.start - right.start);
    assert.equal(ranges.map((range) => range.content).join(""), source);
    const members = ranges.flatMap((range) => range.members ?? [])
      .filter((member) => member.sourcePath.startsWith("/requirements/"));
    assert.equal(members.length, 80);
    assert.deepEqual(members.map((member) => member.recordId),
      Array.from({ length: 80 }, (_, index) => `R-${index}`));
    assert.ok(new Set(ranges.map((range) => range.sourceRef)).size < 80);
    assert.equal(metrics.find((metric) => metric.stage === "source-partition").count,
      new Set(ranges.map((range) => JSON.stringify([range.revision, range.start, range.end]))).size);
  });

  it("rejects a required rule-range response that exceeds the shared aggregate budget before calling AI", async () => {
    let calls = 0;
    const result = await checkGuardrail(".", "x".repeat(140000), "spec", undefined, [], {
      agent: { resolve: () => true, call: async () => { calls += 1; return "unreachable"; } },
      loadGuardrails: () => [article], sharedGuardrailEvidence: true,
      executionBudget: new PromptExecutionBudget(new PromptExecutionLimit({ maxAggregateItemCount: 1 })),
    });
    assert.equal(result.passed, false);
    assert.equal(result.failureCode, "PROMPT_RESPONSE_TOO_LARGE");
    assert.deepEqual(result.evaluations, []);
    assert.equal(calls, 0);
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
