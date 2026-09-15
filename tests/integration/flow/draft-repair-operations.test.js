import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyDraftRepairOperations,
  DraftGateRepairAuthority,
  DraftRepairOperationBatch,
  DraftRepairOperationsError,
  DraftRepairPath,
} from "../../../src/flow/lib/draft-repair-operations.js";
import {
  GateEvidenceIdentity,
  GateObservationRepair,
  GateRepairObservationRequest,
} from "../../../src/flow/lib/gate-observation-convergence.js";
import { checkDraftJson } from "../../../src/flow/lib/run-gate.js";
import { workerArtifactHandoffPolicy } from "../../../src/flow/lib/worker-artifact-handoff.js";

const INPUT_REVISION = "a".repeat(64);

function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function draft() {
  return {
    devType: "feature", goal: "Original goal", unrelated: "must survive",
    analysis: { problem: "Original problem", proposedApproach: "Original approach", validation: "Original validation" },
    decisionMap: { knownFacts: [], decisionPoints: [], resolvedByProjectRules: [], requiresUserJudgment: [], deferredToSpec: [] },
    questionLedger: { revision: 0, publication: "test", evidenceDigest: "b".repeat(64), questions: [] },
  };
}
function triage({ allowedFieldPaths = ["goal"], requiredFieldPaths = ["goal"] } = {}) {
  return { items: [{ title: "Repair goal", target: "goal", decision: "apply", rationale: "Bounded correction", evidence: "Goal is incomplete", allowedFieldPaths, requiredFieldPaths }] };
}
function operation(overrides = {}) {
  return {
    title: "Repair goal", target: "goal", kind: "replace-value", path: "goal",
    expectedDigest: digest("Original goal"), replacement: "Corrected goal", reason: "Apply the bounded correction.",
    ...overrides,
  };
}
function repair(operations, baseRevision = `sha256:${INPUT_REVISION}`) { return { version: 1, baseRevision, operations }; }
function apply(input = {}) {
  return applyDraftRepairOperations({ draft: input.draft ?? draft(), triage: input.triage ?? triage(), repair: input.repair ?? repair([]), inputRevision: INPUT_REVISION, phase: "draft-coverage-repair" });
}
function gateAuthority() {
  const attempt = { id: "draft-gate-attempt", sequence: 1 };
  const catalogFingerprint = "c".repeat(64);
  return new DraftGateRepairAuthority(new GateObservationRepair({
    repairId: "plan-gate-repair-fixture",
    sourceEvidence: new GateEvidenceIdentity({
      sourceAttempt: attempt,
      resultLogicalKey: "draft.gate",
      publicationActivityId: "draft-gate-published",
      catalogFingerprint,
      transitionLineage: {
        sourceAttempt: attempt,
        canonicalAttempt: attempt,
        sourceFingerprint: catalogFingerprint,
        canonicalFingerprint: catalogFingerprint,
      },
    }),
    targetAttempt: { id: "draft-gate-repair-attempt", sequence: 1 },
    publicationActivityId: "draft-gate-repair-started",
    recordFingerprint: "d".repeat(64),
    handoffRevision: INPUT_REVISION,
    requests: [new GateRepairObservationRequest({ fingerprint: "e".repeat(64) })],
  }));
}
function gateRepair(operations, overrides = {}) {
  return {
    version: 1,
    baseRevision: `sha256:${INPUT_REVISION}`,
    operations,
    report: { version: 1, summary: "fixture", results: [] },
    ...overrides,
  };
}
function gateOperation(overrides = {}) {
  const { title: _title, target: _target, ...bounded } = operation(overrides);
  return bounded;
}
function validGateDraft() {
  const source = draft();
  delete source.unrelated;
  return source;
}
function applyGate(repair, source = validGateDraft()) {
  return applyDraftRepairOperations({
    draft: source,
    repair,
    inputRevision: INPUT_REVISION,
    phase: "draft-gate-repair",
    authority: gateAuthority(),
  });
}
function prompt(name) {
  return fs.readFileSync(fileURLToPath(new URL(`../../../src/flow/prompts/plan/${name}.md`, import.meta.url)), "utf8");
}

describe("command-owned draft repair operations", () => {
  it("keeps repair workers on an operations-only handoff and prompt contract", () => {
    for (const stepId of ["draft-questions-repair", "draft-coverage-repair"]) {
      const policy = workerArtifactHandoffPolicy(stepId);
      assert.deepEqual(policy.payloads.map((payload) => payload.logicalName), [`${stepId}.json`]);
    }
  });

  it("parses only bounded data paths and v1 proposal envelopes", () => {
    assert.deepEqual(new DraftRepairPath("questionLedger.questions[0].question").segments, ["questionLedger", "questions", 0, "question"]);
    assert.throws(() => new DraftRepairPath("goal.__proto__.value"));
    assert.throws(() => new DraftRepairPath("goal."));
    assert.throws(() => new DraftRepairPath("analysis."));
    assert.ok(new DraftRepairOperationBatch(repair([])));
    const malformed = new DraftRepairOperationBatch({ version: 2, baseRevision: "wrong", operations: [] });
    assert.equal(malformed.envelopeErrors.length, 2);
  });

  it("audits malformed and empty envelopes without changing the canonical draft", () => {
    const source = draft();
    const malformed = apply({
      draft: source,
      repair: { version: 2, baseRevision: `sha256:${INPUT_REVISION}`, operations: [operation()] },
    });
    assert.deepEqual(malformed.draft, source);
    assert.equal(malformed.audit.acceptedOperations.length, 0);
    assert.deepEqual(malformed.audit.audit.envelopeErrors, ["draft repair version is invalid"]);
    assert.equal(malformed.audit.discardedOperations[0].reason, "invalid repair envelope");

    const empty = apply({ draft: source, repair: repair([]) });
    assert.deepEqual(empty.draft, source);
    assert.equal(empty.audit.acceptedOperations.length, 0);
    assert.deepEqual(empty.audit.audit.envelopeErrors, []);

    const nonObject = apply({ draft: source, repair: [] });
    assert.deepEqual(nonObject.draft, source);
    assert.deepEqual(nonObject.audit.audit.envelopeErrors, [
      "draft repair version is invalid",
      "draft repair baseRevision is invalid",
      "draft repair operations are invalid",
    ]);

    const invalidBase = apply({
      draft: source,
      repair: { version: 1, baseRevision: "wrong", operations: [operation()] },
    });
    assert.deepEqual(invalidBase.draft, source);
    assert.deepEqual(invalidBase.audit.audit.envelopeErrors, ["draft repair baseRevision is invalid"]);
  });

  it("reconstructs from the immutable draft and preserves unrelated fields", () => {
    const source = draft();
    const result = apply({ draft: source, repair: repair([operation()]) });
    assert.equal(result.draft.goal, "Corrected goal");
    assert.equal(result.draft.unrelated, "must survive");
    assert.deepEqual(result.draft.analysis, source.analysis);
    assert.equal(source.goal, "Original goal");
  });

  it("filters unknown and out-of-scope proposals without suppressing a valid operation", () => {
    const result = apply({ repair: repair([
      operation({ title: "Unknown", target: "other" }),
      operation({ path: "approval.approved" }),
      operation(),
      operation({ kind: "unknown-operation" }),
    ]) });
    assert.equal(result.draft.goal, "Corrected goal");
    assert.equal(result.audit.acceptedOperations.length, 1);
    assert.equal(result.audit.discardedOperations.length, 3);
    assert.ok(result.audit.discardedOperations.every((entry) => entry.reason));
  });

  it("keeps retired approval metadata invalid instead of treating it as completion state", () => {
    const source = draft();
    source.approval = { approved: false };
    const result = apply({ draft: source, repair: repair([]) });
    assert.deepEqual(result.draft, source);
    assert.ok(result.audit.audit.lifecycleIssues.some((issue) => issue.includes("approval")));
    assert.ok(checkDraftJson(result.draft).some((issue) => issue.includes("approval")));
  });

  it("keeps coverage triage and repair outside parent completion ownership", () => {
    const triagePrompt = prompt("draft-coverage-triage");
    const repairPrompt = prompt("draft-coverage-repair");
    assert.match(triagePrompt, /Definition-owned parent completion connector/i);
    assert.match(repairPrompt, /draft schema has no approval field/i);
    assert.match(repairPrompt, /Definition-owned parent completion connector/i);
    assert.doesNotMatch(triagePrompt, /"approval\.approved"/);
    assert.doesNotMatch(repairPrompt, /"approval\.approved"/);
  });

  it("keeps the canonical draft when no valid operation can apply and records the audit", () => {
    const source = draft();
    const result = apply({ draft: source, repair: repair([operation({ expectedDigest: digest("stale") })]) });
    assert.deepEqual(result.draft, source);
    assert.equal(result.audit.acceptedOperations.length, 0);
    assert.equal(result.audit.discardedOperations[0].reason, "stale target");
    assert.deepEqual(result.audit.audit.missingRequiredTargets, [{ key: "Repair goal\u0000goal", path: "goal" }]);
  });

  it("retains structural lifecycle findings for publication", () => {
    const source = draft();
    delete source.questionLedger.questions;
    const result = apply({ draft: source, repair: repair([]) });
    assert.deepEqual(result.draft, source);
    assert.ok(result.audit.audit.lifecycleIssues.some((issue) => issue.includes("questions")));
    assert.ok(checkDraftJson(result.draft).some((issue) => issue.includes("questions")));
  });

  it("applies one strict Gate-authorized batch to the immutable draft", () => {
    const source = validGateDraft();
    const result = applyGate(gateRepair([gateOperation()]), source);
    assert.equal(result.draft.goal, "Corrected goal");
    assert.equal(source.goal, "Original goal");
    assert.equal(result.audit.sourceAuthority.kind, "plan-gate-repair");
    assert.deepEqual(result.audit.audit.lifecycleIssues, []);
  });

  it("rejects a whole Gate batch when any operation is stale or outside authoring authority", () => {
    const source = validGateDraft();
    assert.throws(() => applyGate(gateRepair([
      gateOperation(),
      gateOperation({ path: "questionLedger.questions", expectedDigest: digest(source.questionLedger.questions), replacement: [] }),
    ]), source), (error) => {
      assert.equal(error instanceof DraftRepairOperationsError, true);
      assert.equal(error.code, "FLOW_DRAFT_GATE_REPAIR_INVALID");
      assert.equal(error.audit.acceptedOperations.length, 1);
      assert.equal(error.audit.discardedOperations.length, 1);
      return true;
    });
    assert.equal(source.goal, "Original goal");
  });

  it("rejects malformed, stale, duplicate, overlapping, and lifecycle-invalid Gate envelopes", () => {
    const cases = [
      gateRepair([], { baseRevision: `sha256:${"f".repeat(64)}` }),
      { ...gateRepair([]), draft: draft() },
      gateRepair([gateOperation(), gateOperation()]),
      gateRepair([
        gateOperation({ path: "analysis", expectedDigest: digest(draft().analysis), replacement: draft().analysis }),
        gateOperation({ path: "analysis.problem", expectedDigest: digest("Original problem"), replacement: "Changed" }),
      ]),
      gateRepair([gateOperation({ path: "goal", replacement: "", expectedDigest: digest("Original goal") })]),
      gateRepair([gateOperation({ path: "analysis.missing", expectedDigest: digest(null), replacement: "created" })]),
    ];
    for (const candidate of cases) {
      assert.throws(() => applyGate(candidate), DraftRepairOperationsError);
    }
  });
});
