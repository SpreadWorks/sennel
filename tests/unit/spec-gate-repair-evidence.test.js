import assert from "node:assert/strict";
import { test } from "node:test";
import { SpecGateRepairContext } from "../../src/flow/lib/spec-gate-repair-context.js";
import { planSpecGateRepairEvidence, nextSpecGateRepairEvidence, SpecGateRepairContextExpansion } from "../../src/flow/lib/spec-gate-repair-evidence.js";
import { PromptRequestLimit, PromptExecutionBudget } from "../../src/lib/prompt-batching.js";

const revision = `sha256:${"a".repeat(64)}`;
const rule = { id: "checks", title: "Checks", body: "Plan a measurable passing condition. Exception: documented non-testable behavior is exempt." };
function fixture(long = true) {
  const target = { entity: "requirement", id: "R1", field: "desc" };
  const context = new SpecGateRepairContext({ baseRevision: revision,
    spec: { goal: "Plan a change", requirements: [{ id: "R1", desc: long ? "Check a measurable condition. ".repeat(900) : "Small check", task_ids: ["T1"], testable: true }],
      tasks: [{ id: "T1", goal: "Implement the planned check" }], overview: { decisions: [] } },
    findings: [{ identity: { sourceArtifact: "gate.json", sourceStep: "spec-gate", sourceFindingId: "F1", fingerprint: "b".repeat(64) },
      requirementRef: rule.id, observed: "State the passing condition", targets: [target],
      allowedTargets: [{ target, operationKinds: ["edit-text-field"] }] }], guardrails: [rule] });
  return { context, unitId: context.units()[0].id, limit: new PromptRequestLimit({ maxCharacters: 7000 }) };
}
function publication(work, support = "Exact cited planned condition.") {
  return { context: { mode: "evidence", unitId: work.selection.unit.id,
    evidenceDepth: work.evidenceDepth, evidenceContextDigest: work.evidenceContextDigest, baseRevision: revision, batchDigest: work.batch.digest },
  proposal: { stage: "spec-gate-repair-evidence", baseRevision: revision, unitId: work.selection.unit.id,
    observations: work.batch.payloadElements.map((entry) => ({ requirementId: work.selection.unit.id,
      sourceRef: entry.id, ...(entry.coveredSourceRefs ? { coveredSourceRefs: entry.coveredSourceRefs } : {}),
      support: [support], contradictions: [], unresolved: [] })) } };
}

test("small repair units keep their original direct bounded proposal", () => {
  const options = fixture(false);
  const prepared = planSpecGateRepairEvidence(options);
  assert.equal(prepared.mode, "direct");
  assert.equal(nextSpecGateRepairEvidence(options).mode, "repair");
  assert(prepared.plan.batches[0].request.userPrompt.includes("Small check"));
});

test("large units collect all ranges across restart before one atomic proposal", () => {
  const options = fixture();
  const prepared = planSpecGateRepairEvidence(options);
  assert.equal(prepared.mode, "evidence");
  assert(prepared.plan.batches.length > 1);
  const publications = [];
  let work;
  for (let count = 0; count < 40; count += 1) {
    work = nextSpecGateRepairEvidence({ ...options, publications: JSON.parse(JSON.stringify(publications)) });
    assert(work.batch.footprint.total <= options.limit.maxCharacters);
    if (work.mode === "repair") break;
    assert(work.batch.request.userPrompt.includes(rule.body));
    publications.push(publication(work));
  }
  assert.equal(work.mode, "repair");
  assert.equal(publications.filter((entry) => entry.context.evidenceDepth === 0).length, prepared.plan.batches.length);
  assert.deepEqual(work.selection.unit, prepared.selection.unit);
  assert.deepEqual(work.selection.guardrails, [rule]);
  assert(work.selection.ranges.every((range) => !Object.hasOwn(range, "value")));
  assert(work.batch.request.userPrompt.includes(rule.body));
  const first = nextSpecGateRepairEvidence(options);
  const bad = publication(first);
  bad.proposal.observations.pop();
  assert.throws(() => nextSpecGateRepairEvidence({ ...options, publications: [bad] }), /cover every/);
  assert.throws(() => nextSpecGateRepairEvidence({ ...options, publications: [publication(first), publication(first)] }), /duplicate/);
});

test("durable evidence reduction reuses strict shrink and shared budget without refunding claims", () => {
  const options = fixture();
  const budget = new PromptExecutionBudget();
  budget.consumeProviderCall();
  const publications = [];
  let reduced = false;
  let work;
  for (let count = 0; count < 50; count += 1) {
    work = nextSpecGateRepairEvidence({ ...options, publications, executionBudget: budget });
    if (work.mode === "repair") break;
    reduced ||= work.evidenceDepth > 0;
    publications.push(publication(work, work.evidenceDepth === 0 ? "Cited support. ".repeat(100) : "Cited support."));
  }
  assert.equal(work.mode, "repair");
  assert.equal(reduced, true);
  assert.equal(budget.snapshot().providerCallCount, 1);
  assert.deepEqual(work.selection.guardrails, [rule]);
});

test("foreign additional context and oversized canonical rule fail before execution", () => {
  const options = fixture();
  assert.throws(() => planSpecGateRepairEvidence({ ...options, additionalRangeIds: ["missing"] }), /foreign/);
  assert.throws(() => planSpecGateRepairEvidence({ ...options, limit: new PromptRequestLimit({ maxCharacters: 100 }) }));
});

test("extra context requests are revision-bound, read-only and must add new information", () => {
  const options = fixture();
  const expansion = new SpecGateRepairContextExpansion({ ...options, baseRevision: revision,
    requestedRangeIds: ["goal"] });
  assert(expansion.selection.ranges.some((range) => range.id === "goal" && !range.writable));
  assert.throws(() => new SpecGateRepairContextExpansion({ ...options, baseRevision: revision,
    previousRangeIds: expansion.additionalRangeIds, requestedRangeIds: ["goal"] }), /no progress/);
  assert.throws(() => new SpecGateRepairContextExpansion({ ...options, baseRevision: "sha256:stale",
    requestedRangeIds: ["goal"] }), /stale/);
  assert.throws(() => new SpecGateRepairContextExpansion({ ...options, baseRevision: revision,
    requestedRangeIds: ["nonexistent"] }), /foreign/);
  const first = nextSpecGateRepairEvidence(options);
  const next = nextSpecGateRepairEvidence({ ...options, additionalRangeIds: ["goal"], publications: [publication(first)] });
  assert.notEqual(next.evidenceContextDigest, first.evidenceContextDigest);
  assert.equal(next.batch.index, 0);
});
