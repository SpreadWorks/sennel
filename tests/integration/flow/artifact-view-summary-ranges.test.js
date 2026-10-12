import { it } from "node:test";
import assert from "node:assert/strict";
import {
  AcceptanceArtifactSummaryContract, ArtifactViewSemanticUnit,
  ArtifactViewSummaryChunk,
  ArtifactViewSummaryError, ArtifactViewSummaryService, SpecArtifactSummaryContract,
} from "../../../src/flow/lib/artifact-view-summary.js";
import * as artifactSummary from "../../../src/flow/lib/artifact-view-summary.js";
import { PromptLogicalFootprint, PromptRequestLimit } from "../../../src/lib/prompt-batching.js";

const headings = { purpose: "Purpose", scope: "Scope", constraints: "Constraints",
  openQuestions: "Open questions", requirements: "Requirements", tasks: "Tasks",
  mechanicalBlockers: "Mechanical blockers", hardBlockers: "Hard blockers",
  deferredFindings: "Deferred findings", remainingRisks: "Remaining risks" };

function specView(extra = []) {
  const semanticUnits = [
    ...["purpose", "scope", "constraints", "openQuestions"].map((kind) => (
      { id: `spec.${kind}`, kind, markdown: `## ${kind}\n\nExact ${kind}.\n\n` }
    )), ...extra,
  ];
  return { markdown: semanticUnits.map((unit) => unit.markdown).join(""), semanticUnits };
}

function sourceRecords(prompt) {
  return JSON.parse(prompt.split("Source sections (JSON):\n")[1]);
}

function responseFor(records, schema) {
  const response = {};
  const collections = { requirement: ["requirements", "requirementId"], task: ["tasks", "taskId"],
    requirementJudgment: ["requirements", "requirementId"], mechanicalBlocker: ["mechanicalBlockers", "blockerId"],
    hardBlocker: ["hardBlockers", "blockerId"], deferredFinding: ["deferredFindings", "findingId"],
    remainingRisk: ["remainingRisks", "riskId"] };
  for (const record of records) {
    const excerpt = { sourceRefs: [record.sourceRef], excerpt: record.excerpt };
    const collection = collections[record.kind];
    if (collection) {
      const [property, identityName] = collection;
      (response[property] ??= []).push({ [identityName]: record.identity,
        ...(record.kind === "requirementJudgment" ? { status: record.status } : {}), ...excerpt });
    } else if (schema.properties[record.kind].type === "array") {
      (response[record.kind] ??= []).push(excerpt);
    } else response[record.kind] = excerpt;
  }
  return response;
}

class SourceCopyAgent {
  constructor(mutate = () => {}, limit = 60_000) {
    this.mutate = mutate;
    this.calls = [];
    this.promptCharacterLimit = limit;
  }
  resolve() { return { providerKey: "fixture", profileKey: "copy", profile: { args: [] } }; }
  async call(prompt, options) {
    const records = sourceRecords(prompt);
    const response = responseFor(records, options.jsonSchema);
    this.calls.push({ prompt, options, records });
    this.mutate(response, records, this.calls.length);
    return JSON.stringify(response);
  }
}

class SummaryCache {
  constructor() { this.entries = new Map(); this.writes = 0; }
  read({ fingerprint }) { return this.entries.get(fingerprint) ?? null; }
  write({ fingerprint, markdown }) { this.writes += 1; this.entries.set(fingerprint, { markdown }); return {}; }
}

function service(agent, cache = null) {
  return new ArtifactViewSummaryService({ agent, cache, lang: "ja", i18nRevision: "range-fixture-v1" });
}

it("copies a 23k requirement once in a 60k request without schema body duplication", async () => {
  const body = `## R2\n\n${"日本語の要件。".repeat(3_271)}\n\n`;
  const view = specView([{ id: "spec.requirement.R2", kind: "requirement", identity: "R2", markdown: body }]);
  const agent = new SourceCopyAgent();
  const result = await service(agent).summarize({ fullView: view,
    contract: new SpecArtifactSummaryContract({ title: "Summary", headings }) });
  assert.equal(agent.calls.length, 1);
  assert.ok(result.markdown.includes(body));
  const call = agent.calls[0];
  assert.equal(JSON.stringify(call.options.jsonSchema).includes(body), false);
  assert.equal(call.options.fmtFallback.includes(body), false);
  assert.equal(sourceRecords(call.prompt).filter((record) => record.excerpt === body).length, 1);
  assert.ok(PromptLogicalFootprint.measure({ userPrompt: call.prompt, jsonSchema: call.options.jsonSchema,
    fmtFallback: call.options.fmtFallback }).fits(new PromptRequestLimit({ maxCharacters: 60_000 })));
});

it("reassembles giant requirements, tasks and singular sections with exact Unicode and whitespace across cache readback", async () => {
  const requirement = `## Requirement R1\n${'日本語😀"\\\t'.repeat(12_000)}\n${" ".repeat(70_000)}`;
  const task = `## Task T1\n${"Task 日本語😀\n".repeat(10_000)}\n`;
  const view = specView([
    { id: "spec.requirement.R1", kind: "requirement", identity: "R1", markdown: requirement },
    { id: "spec.requirement.R2", kind: "requirement", identity: "R2", markdown: "## R2\nKeep ordering.\n" },
    { id: "spec.task.T1", kind: "task", identity: "T1", markdown: task },
    { id: "spec.task.T2", kind: "task", identity: "T2", markdown: "## T2\nKeep ordering.\n" },
  ]);
  view.semanticUnits[0].markdown += "Purpose 日本語😀\n".repeat(9_000);
  view.markdown = view.semanticUnits.map((unit) => unit.markdown).join("");
  const original = JSON.stringify(view);
  const observed = [];
  class ObservedContract extends SpecArtifactSummaryContract {
    createResult(units, entries) { observed.push(entries); return super.createResult(units, entries); }
  }
  const contract = new ObservedContract({ title: "Summary", headings });
  const agent = new SourceCopyAgent();
  const cache = new SummaryCache();
  const result = await service(agent, cache).summarize({ fullView: view, contract });
  assert.ok(agent.calls.length > 3);
  assert.deepEqual(observed[0].map((entry) => entry.sourceRefs), view.semanticUnits.map((unit) => [unit.id]));
  assert.deepEqual(observed[0].map((entry) => entry.excerpt), view.semanticUnits.map((unit) => unit.markdown));
  const allRecords = agent.calls.flatMap((call) => call.records);
  for (const unit of view.semanticUnits) {
    const fragments = allRecords.filter((record) => record.parentSourceRef === unit.id);
    assert.equal(fragments.map((record) => record.excerpt).join(""), unit.markdown);
    let end = 0;
    for (const record of fragments) {
      assert.equal(record.start, end);
      assert.equal(record.end - record.start, record.excerpt.length);
      assert.equal(record.sourceLength, unit.markdown.length);
      assert.equal(record.identity, unit.identity ?? null);
      assert.equal(/[\uD800-\uDBFF]$/.test(record.excerpt), false);
      assert.equal(/^[\uDC00-\uDFFF]/.test(record.excerpt), false);
      end = record.end;
    }
    assert.equal(end, unit.markdown.length);
  }
  assert.ok(allRecords.some((record) => record.excerpt.trim() === ""));
  assert.ok(agent.calls.every((call) => PromptLogicalFootprint.measure({ userPrompt: call.prompt,
    jsonSchema: call.options.jsonSchema, fmtFallback: call.options.fmtFallback }).total <= 60_000));
  assert.equal(JSON.stringify(view), original);
  const readbackAgent = new SourceCopyAgent();
  const readback = await service(readbackAgent, cache).summarize({ fullView: JSON.parse(original),
    contract: new SpecArtifactSummaryContract({ title: "Summary", headings }) });
  assert.equal(readback.cache.hit, true);
  assert.equal(readback.markdown, result.markdown);
  assert.equal(readbackAgent.calls.length, 0);
  assert.equal(cache.writes, 1);
});

it("accepts separate ranges of one logical identity in a single target-specific schema", () => {
  for (const kind of ["purpose", "requirement", "task", "requirementJudgment"]) {
    const parent = new ArtifactViewSemanticUnit({ id: `source.${kind}`, kind,
      identity: kind === "purpose" ? null : "one", status: kind === "requirementJudgment" ? "notVerifiable" : null,
      markdown: "## Source\n\nExact source.\n\n" });
    const fragments = [0, 10].map((start, index) => new artifactSummary.ArtifactViewSummaryFragment({ parent,
      id: `${parent.id}@${start}:${index === 0 ? 10 : parent.markdown.length}`,
      start, end: index === 0 ? 10 : parent.markdown.length }));
    const chunk = new ArtifactViewSummaryChunk(fragments);
    const contract = kind === "requirementJudgment"
      ? new AcceptanceArtifactSummaryContract({ title: "Summary", headings })
      : new SpecArtifactSummaryContract({ title: "Summary", headings });
    const records = sourceRecords(contract.prompt(chunk));
    const response = responseFor(records, contract.schemaForChunk(chunk));
    const parsed = contract.parseChunk(chunk, JSON.stringify(response));
    assert.deepEqual(parsed.map((entry) => entry.sourceRefs[0]), fragments.map((fragment) => fragment.id));
    assert.equal(parsed.map((entry) => entry.excerpt).join(""), parent.markdown);
  }
});

it("does not reuse cached summary for byte-identical Markdown with changed source identity or status", async () => {
  const units = [{ id: "judgment.R1", kind: "requirementJudgment", identity: "R1",
    status: "notVerifiable", markdown: "## Judgment\nExact evidence.\n" }];
  const fullView = { markdown: units[0].markdown, semanticUnits: units };
  const cache = new SummaryCache();
  const contract = new AcceptanceArtifactSummaryContract({ title: "Summary", headings });
  const first = await service(new SourceCopyAgent(), cache).summarize({ fullView, contract });
  for (const changed of [{ id: "judgment.other" }, { identity: "R2" }, { status: "satisfied" }]) {
    const agent = new SourceCopyAgent();
    const changedView = { markdown: fullView.markdown, semanticUnits: [{ ...units[0], ...changed }] };
    const result = await service(agent, cache).summarize({ fullView: changedView, contract });
    assert.equal(result.cache.hit, false);
    assert.notEqual(result.fingerprint.toString(), first.fingerprint.toString());
    assert.equal(agent.calls.length, 1);
    assert.deepEqual(agent.calls[0].records.map((record) => [record.sourceRef, record.identity, record.status]),
      changedView.semanticUnits.map((unit) => [unit.id, unit.identity, unit.status]));
  }
  assert.equal(cache.writes, 4);
});

it("rejects changed fragment text, refs, identity, status and order without publishing a cache", async () => {
  const units = [
    { id: "judgment.R1", kind: "requirementJudgment", identity: "R1", status: "notVerifiable",
      markdown: `## R1\n${"日本語😀".repeat(20_000)}\n` },
    { id: "judgment.R2", kind: "requirementJudgment", identity: "R2", status: "satisfied", markdown: "## R2\nExact.\n" },
  ];
  const view = { markdown: units.map((unit) => unit.markdown).join(""), semanticUnits: units };
  const original = JSON.stringify(view);
  const mutations = [
    (response) => { response.requirements[0].excerpt += "changed"; },
    (response) => { response.requirements[0].sourceRefs = ["judgment.R1"]; },
    (response) => { response.requirements[0].requirementId = "R2"; },
    (response) => { response.requirements[0].status = "satisfied"; },
    (response) => { response.requirements.reverse(); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    let mutated = false;
    const agent = new SourceCopyAgent((response, records) => {
      if (!mutated && (index === 4 ? records.length > 1 : records[0].start > 0)) {
        mutate(response); mutated = true;
      }
    });
    const cache = new SummaryCache();
    await assert.rejects(service(agent, cache).summarize({ fullView: view,
      contract: new AcceptanceArtifactSummaryContract({ title: "Summary", headings }) }),
    (error) => error instanceof ArtifactViewSummaryError && error.code === "ARTIFACT_VIEW_SUMMARY_INVALID");
    assert.equal(mutated, true);
    assert.equal(cache.writes, 0);
    assert.equal(JSON.stringify(view), original);
  }
});
