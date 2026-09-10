import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AcceptanceArtifactSummaryContract,
  ArtifactViewSummaryError,
  ArtifactViewSummaryFingerprint,
  ArtifactViewSummaryService,
  SpecArtifactSummaryContract,
  splitArtifactViewSummary,
} from "../../../src/flow/lib/artifact-view-summary.js";
import { MAX_SAME_SPEC_CONTRACT_CONTEXT_CHARS } from "../../../src/flow/lib/flow-context-limit.js";
import { PromptLogicalFootprint, PromptRequestLimit } from "../../../src/lib/prompt-batching.js";

const SPEC_HEADINGS = Object.freeze({
  purpose: "Purpose",
  scope: "Scope",
  constraints: "Constraints",
  openQuestions: "Open questions",
  requirements: "Requirements",
  tasks: "Tasks",
});

const ACCEPTANCE_HEADINGS = Object.freeze({
  requirements: "Requirement judgments",
  mechanicalBlockers: "Mechanical blockers",
  hardBlockers: "Hard blockers",
  deferredFindings: "Deferred findings",
  remainingRisks: "Remaining risks",
});

function specView(units = [
  { id: "spec.purpose", kind: "purpose", markdown: "## Purpose\n\nKeep this exact." },
  { id: "spec.scope", kind: "scope", markdown: "## Scope\n\nIn scope: one thing." },
  { id: "spec.constraints", kind: "constraints", markdown: "## Constraints\n\n- Node built-ins only." },
  { id: "spec.open-questions", kind: "openQuestions", markdown: "## Open questions\n\n- None." },
  { id: "spec.requirement.R1", kind: "requirement", identity: "R1", markdown: "## Requirement R1\n\nDo the requested work." },
  { id: "spec.task.T1", kind: "task", identity: "T1", markdown: "## Task T1\n\nImplement it." },
]) {
  return { markdown: units.map((unit) => unit.markdown).join(""), semanticUnits: units };
}

function multiItemSpecView() {
  const view = specView();
  const units = [
    ...view.semanticUnits.slice(0, 5),
    { id: "spec.requirement.R2", kind: "requirement", identity: "R2", markdown: "## Requirement R2\n\nKeep source order." },
    ...view.semanticUnits.slice(5),
    { id: "spec.task.T2", kind: "task", identity: "T2", markdown: "## Task T2\n\nKeep source order." },
  ];
  return specView(units);
}

function multiChunkSpecView() {
  return specView([
    { id: "spec.purpose", kind: "purpose", markdown: `## Purpose\n\n${"p".repeat(23_000)}` },
    { id: "spec.scope", kind: "scope", markdown: `## Scope\n\n${"s".repeat(23_000)}` },
    { id: "spec.constraints", kind: "constraints", markdown: `## Constraints\n\n${"c".repeat(23_000)}` },
    { id: "spec.open-questions", kind: "openQuestions", markdown: "## Open questions\n\n- None." },
    { id: "spec.requirement.R1", kind: "requirement", identity: "R1", markdown: "## Requirement R1\n\nDo the requested work." },
    { id: "spec.task.T1", kind: "task", identity: "T1", markdown: "## Task T1\n\nImplement it." },
  ]);
}

function acceptanceView() {
  const units = [
    { id: "acceptance.judgment.R1", kind: "requirementJudgment", identity: "R1", status: "notVerifiable", markdown: "## Requirement R1 — not verifiable\n\nEvidence is missing." },
    { id: "acceptance.mechanical.M1", kind: "mechanicalBlocker", identity: "M1", markdown: "## Mechanical blocker M1\n\nA tool is unavailable." },
    { id: "acceptance.hard.H1", kind: "hardBlocker", identity: "H1", markdown: "## Hard blocker H1\n\nRisk remains." },
    { id: "acceptance.finding.DF1", kind: "deferredFinding", identity: "DF1", markdown: "## Deferred finding DF1\n\nOriginal review evidence." },
    { id: "acceptance.risk.DF1", kind: "remainingRisk", identity: "DF1-risk", markdown: "## Remaining risk DF1\n\nThe risk remains accepted or unresolved." },
  ];
  return { markdown: units.map((unit) => unit.markdown).join(""), semanticUnits: units };
}

function specContract() {
  return new SpecArtifactSummaryContract({ title: "Specification summary", headings: SPEC_HEADINGS });
}

function acceptanceContract() {
  return new AcceptanceArtifactSummaryContract({ title: "Acceptance summary", headings: ACCEPTANCE_HEADINGS });
}

function resolved(profileKey = "codex/gpt-5.6-terra-medium") {
  return {
    providerKey: "codex",
    profileKey,
    profile: {
      command: "codex",
      args: ["exec", "{{PROMPT}}"],
      jsonSchemaFlag: "--output-schema",
      jsonSchemaMode: "file",
    },
  };
}

class FakeAgent {
  constructor(responses, { profileKey } = {}) {
    this.responses = [...responses];
    this.profileKey = profileKey;
    this.calls = [];
  }

  resolve(commandId) {
    this.resolvedCommandId = commandId;
    return resolved(this.profileKey);
  }

  async call(prompt, options) {
    this.calls.push({ prompt, options });
    return this.responses.shift();
  }
}

class MemoryCache {
  constructor() {
    this.entries = new Map();
    this.writes = [];
  }

  key(input) { return `${input.logicalKey}:${input.mode}:${input.fingerprint}`; }
  read(input) { return this.entries.get(this.key(input)) ?? null; }
  write(input) {
    this.writes.push(input);
    this.entries.set(this.key(input), { markdown: input.markdown });
    return { warning: null };
  }
}

function exactSpecResponseForUnits(units) {
  const source = new Map(units.map((unit) => [unit.kind, unit]));
  const req = units.filter((unit) => unit.kind === "requirement");
  const tasks = units.filter((unit) => unit.kind === "task");
  const excerpt = (unit) => ({ sourceRefs: [unit.id], excerpt: unit.markdown });
  const response = {};
  for (const [kind, property] of [["purpose", "purpose"], ["scope", "scope"], ["constraints", "constraints"], ["openQuestions", "openQuestions"]]) {
    if (source.has(kind)) response[property] = excerpt(source.get(kind));
  }
  if (req.length > 0) response.requirements = req.map((unit) => ({ requirementId: unit.identity, ...excerpt(unit) }));
  if (tasks.length > 0) response.tasks = tasks.map((unit) => ({ taskId: unit.identity, ...excerpt(unit) }));
  return JSON.stringify(response);
}

function exactSpecResponse(view) {
  return exactSpecResponseForUnits(view.semanticUnits);
}

function exactAcceptanceResponse(view) {
  const byKind = (kind) => view.semanticUnits.filter((unit) => unit.kind === kind);
  const excerpt = (unit) => ({ sourceRefs: [unit.id], excerpt: unit.markdown });
  return JSON.stringify({
    requirements: byKind("requirementJudgment").map((unit) => ({ requirementId: unit.identity, status: unit.status, ...excerpt(unit) })),
    mechanicalBlockers: byKind("mechanicalBlocker").map((unit) => ({ blockerId: unit.identity, ...excerpt(unit) })),
    hardBlockers: byKind("hardBlocker").map((unit) => ({ blockerId: unit.identity, ...excerpt(unit) })),
    deferredFindings: byKind("deferredFinding").map((unit) => ({ findingId: unit.identity, ...excerpt(unit) })),
    remainingRisks: byKind("remainingRisk").map((unit) => ({ riskId: unit.identity, ...excerpt(unit) })),
  });
}

describe("artifact view summary", () => {
  it("uses the shared 48k limit and never splits a semantic section", () => {
    assert.equal(MAX_SAME_SPEC_CONTRACT_CONTEXT_CHARS, 48_000);
    const chunks = splitArtifactViewSummary({
      markdown: `${"a".repeat(30_000)}${"b".repeat(30_000)}`,
      semanticUnits: [
        { id: "one", kind: "purpose", markdown: "a".repeat(30_000) },
        { id: "two", kind: "scope", markdown: "b".repeat(30_000) },
      ],
    });

    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks.map((chunk) => chunk.units.map((unit) => unit.id)), [["one"], ["two"]]);
    assert.deepEqual(chunks.map((chunk) => chunk.markdown), ["a".repeat(30_000), "b".repeat(30_000)]);
    assert.throws(
      () => splitArtifactViewSummary({
        markdown: "x".repeat(MAX_SAME_SPEC_CONTRACT_CONTEXT_CHARS + 1),
        semanticUnits: [{ id: "too-large", kind: "purpose", markdown: "x".repeat(MAX_SAME_SPEC_CONTRACT_CONTEXT_CHARS + 1) }],
      }),
      (error) => error instanceof ArtifactViewSummaryError && error.code === "ARTIFACT_VIEW_INPUT_LIMIT",
    );
  });

  it("uses a target-specific spec contract and retains every required source item", async () => {
    const view = specView();
    const contract = specContract();
    const agent = new FakeAgent([exactSpecResponse(view)]);
    const cache = new MemoryCache();
    const service = new ArtifactViewSummaryService({ agent, cache, lang: "en", i18nRevision: "messages-v1" });

    const result = await service.summarize({ fullView: view, contract });

    assert.equal(agent.resolvedCommandId, "flow.artifact.spec");
    assert.equal(agent.calls.length, 1);
    assert.equal(agent.calls[0].options.commandId, "flow.artifact.spec");
    assert.equal(agent.calls[0].options.flowAttribution, "none");
    assert.equal(agent.calls[0].options.cacheMode, "bypass");
    assert.deepEqual(agent.calls[0].options.jsonSchema.required, ["purpose", "scope", "constraints", "openQuestions", "requirements", "tasks"]);
    assert.deepEqual(
      agent.calls[0].options.jsonSchema.properties.purpose.properties.excerpt.enum,
      [view.semanticUnits[0].markdown],
    );
    assert.match(agent.calls[0].prompt, /Include its first Markdown heading and every trailing newline exactly/);
    assert.match(result.markdown, /^# Specification summary/m);
    assert.match(result.markdown, /Keep this exact\./);
    assert.match(result.markdown, /Do the requested work\./);
    assert.equal(result.markdown.match(/^## Purpose$/gm)?.length, 1);
    assert.equal(cache.writes.length, 1);
  });

  it("uses a distinct acceptance contract and keeps judgment/blocker/finding/risk entries individual", async () => {
    const view = acceptanceView();
    const contract = acceptanceContract();
    const agent = new FakeAgent([exactAcceptanceResponse(view)]);
    const result = await new ArtifactViewSummaryService({
      agent,
      lang: "en",
      i18nRevision: "messages-v1",
    }).summarize({ fullView: view, contract });

    assert.equal(agent.resolvedCommandId, "flow.artifact.acceptance");
    assert.deepEqual(agent.calls[0].options.jsonSchema.required, [
      "requirements", "mechanicalBlockers", "hardBlockers", "deferredFindings", "remainingRisks",
    ]);
    assert.match(result.markdown, /^# Acceptance summary/m);
    assert.match(result.markdown, /Requirement R1 — not verifiable/);
    assert.match(result.markdown, /Mechanical blocker M1/);
    assert.match(result.markdown, /Deferred finding DF1/);
    assert.match(result.markdown, /Remaining risk DF1/);
  });

  it("accepts an empty canonical requirement set while retaining the available acceptance evidence", async () => {
    const units = [
      { id: "acceptance.mechanical.M1", kind: "mechanicalBlocker", identity: "M1", markdown: "## Mechanical blocker M1\n\nA tool is unavailable." },
    ];
    const view = { markdown: units[0].markdown, semanticUnits: units };
    const response = JSON.stringify({
      mechanicalBlockers: [{
        blockerId: "M1",
        sourceRefs: ["acceptance.mechanical.M1"],
        excerpt: units[0].markdown,
      }],
    });
    const result = await new ArtifactViewSummaryService({
      agent: new FakeAgent([response]),
      lang: "en",
      i18nRevision: "messages-v1",
    }).summarize({ fullView: view, contract: acceptanceContract() });

    assert.match(result.markdown, /## Requirement judgments/);
    assert.match(result.markdown, /Mechanical blocker M1/);
  });

  it("rejects paraphrase, nonexistent or duplicate sources, free-form output, and actual source-order swaps without a partial cache", async () => {
    const view = multiItemSpecView();
    const valid = JSON.parse(exactSpecResponse(view));
    const invalidResponses = [
      JSON.stringify({ ...valid, purpose: { ...valid.purpose, excerpt: "Paraphrased." } }),
      JSON.stringify({ ...valid, purpose: { ...valid.purpose, sourceRefs: ["spec.not-a-source"] } }),
      JSON.stringify({ ...valid, requirements: [{ ...valid.requirements[0], sourceRefs: ["spec.requirement.R1", "spec.requirement.R1"] }] }),
      JSON.stringify({ ...valid, requirements: [valid.requirements[1], valid.requirements[0]] }),
      JSON.stringify({ ...valid, tasks: [valid.tasks[1], valid.tasks[0]] }),
      "## This is free-form Markdown, not structured JSON",
    ];

    for (const response of invalidResponses) {
      const cache = new MemoryCache();
      const service = new ArtifactViewSummaryService({
        agent: new FakeAgent([response]),
        cache,
        lang: "en",
        i18nRevision: "messages-v1",
      });
      await assert.rejects(
        service.summarize({ fullView: view, contract: specContract() }),
        (error) => error instanceof ArtifactViewSummaryError && error.code === "ARTIFACT_VIEW_SUMMARY_INVALID",
      );
      assert.equal(cache.writes.length, 0);
    }
  });

  it("rejects a later invalid chunk without a partial cache or merge re-summary", async () => {
    const view = multiChunkSpecView();
    const chunks = splitArtifactViewSummary(view);
    assert.equal(chunks.length, 2);
    const cache = new MemoryCache();
    const agent = new FakeAgent([
      exactSpecResponseForUnits([view.semanticUnits[0]]),
      exactSpecResponseForUnits([view.semanticUnits[1]]),
      "not JSON from a later chunk",
    ]);
    const service = new ArtifactViewSummaryService({
      agent,
      cache,
      lang: "en",
      i18nRevision: "messages-v1",
    });

    await assert.rejects(
      service.summarize({ fullView: view, contract: specContract() }),
      (error) => error instanceof ArtifactViewSummaryError && error.code === "ARTIFACT_VIEW_SUMMARY_INVALID",
    );
    assert.equal(agent.calls.length, 3);
    assert.ok(agent.calls.every((call) => PromptLogicalFootprint.measure({
      userPrompt: call.prompt,
      jsonSchema: call.options.jsonSchema,
      fmtFallback: call.options.fmtFallback,
    }).fits(new PromptRequestLimit())));
    assert.equal(cache.writes.length, 0);
  });

  it("includes the resolved provider and profile in cache identity and returns a matching cache hit", async () => {
    const view = specView();
    const mutableResolved = resolved("codex/gpt-5.6-terra-medium");
    const first = new ArtifactViewSummaryFingerprint({
      fullMarkdown: view.markdown,
      contract: specContract(),
      resolved: mutableResolved,
      lang: "en",
      i18nRevision: "messages-v1",
    });
    const changedProfile = new ArtifactViewSummaryFingerprint({
      fullMarkdown: view.markdown,
      contract: specContract(),
      resolved: resolved("codex/gpt-5.6-sol-medium"),
      lang: "en",
      i18nRevision: "messages-v1",
    });
    assert.notEqual(first.toString(), changedProfile.toString());
    const stableIdentity = first.toString();
    mutableResolved.profile.args.push("--mutated-after-fingerprint");
    assert.equal(first.toString(), stableIdentity);
    assert.throws(
      () => first.agent.profile.args.push("--public-mutation"),
      /extensible|read only|object is not extensible/i,
    );

    const cache = new MemoryCache();
    cache.entries.set(`spec.record:summary:${first}`, { markdown: "# Cached summary" });
    const agent = new FakeAgent([], { profileKey: "codex/gpt-5.6-terra-medium" });
    const service = new ArtifactViewSummaryService({ agent, cache, lang: "en", i18nRevision: "messages-v1" });
    const result = await service.summarize({ fullView: view, contract: specContract() });

    assert.equal(result.markdown, "# Cached summary");
    assert.equal(result.cache.hit, true);
    assert.equal(agent.calls.length, 0);
  });
});
