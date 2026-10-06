import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

// Preserve and discover the original generation contract unchanged. These
// fixtures use the current candidate/value APIs, not replacement Result types.
import { candidate, operands, pending, requiredExport, revision } from "./structured-step-result.contract.js";
import * as engine from "../../src/flow/engine/step-result.js";
import * as definition from "../../src/flow/definition.js";
import { StepConnector } from "../../src/flow/engine/step-connector.js";
import {
  RequirementTestBudget, RequirementTestBundleLineage,
  RequirementTestSemanticFinding, RequirementTestSourceAttempt, RequirementTestWorkItem,
} from "../../src/flow/lib/requirement-test-lifecycle.js";
import {
  RequirementTestCandidateBundle, RequirementTestCandidateSource,
  RequirementTestGateObservation, RequirementTestGateResult, RequirementTestSupportArtifact,
} from "../../src/flow/lib/requirement-test-artifacts.js";
import {
  CanonicalTestReviewRepair, TestReviewRepairFinding, TestReviewRepairProgress,
  TEST_REVIEW_REPAIR_BATCH_LIMITS,
} from "../../src/flow/lib/test-review-repair.js";
import { CURRENT_FLOW_SCHEMA_REVISION } from "../../src/lib/flow-schema-revision.js";
import {
  assertRequirementTestEvidenceProjection, assertRequirementTestSettlementProjection,
} from "../support/assertions/requirement-test-result.js";
import { FlowArtifactDescriptor } from "../../src/lib/flow-version.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../src/lib/flow-artifact-contract.js";
import { RequirementTestReviewSource } from "../../src/flow/lib/requirement-test-artifacts.js";
import { ReviewDisposition, ReviewEvidence } from "../../src/flow/lib/review-convergence.js";
import {
  ReviewWorkUnitManifest, ReviewWorkUnitOutput, ReviewWorkUnitSeal,
} from "../../src/flow/lib/review-work-unit-values.js";

const LEAVES = Object.freeze(["approval", "test-generate", "test-review", "test-repair", "test-gate"]);
// Frozen expectations from a1ee / 8e30 section 3. This table is deliberately
// only semantic expectations: runnable types come from the sole product
// registry. New class names beyond the existing generation contract are not
// fixed by those boards and are not invented here.
const CLOSED_RESULTS = Object.freeze([
  ["approval", "approval-awaiting-user", "user-input-required"],
  ["approval", "approval-confirmed-with-tests", "completed"],
  ["approval", "approval-confirmed-without-tests", "completed"],
  ["test-generate", "test-generate-candidate-saved", "completed"],
  ["test-generate", "test-generate-structural-rejected", "branch-required"],
  ["test-review", "test-review-execution-required", "loop-required"],
  ["test-review", "test-review-passed", "completed"],
  ["test-review", "test-review-advisory", "completed"],
  ["test-review", "test-review-rejected", "branch-required"],
  ["test-repair", "test-repair-progress-saved", "loop-required"],
  ["test-repair", "test-repair-candidate-saved", "completed"],
  ["test-repair", "test-repair-structural-rejected", "branch-required"],
  ["test-gate", "test-gate-compatible", "completed"],
  ["test-gate", "test-gate-incompatible", "branch-required"],
  ...LEAVES.slice(1).map((leaf) => [leaf, `${leaf}-tooling-unavailable`, "loop-required"]),
  ...LEAVES.slice(1, 4).map((leaf) => [leaf, `${leaf}-external-blocked`, "error"]),
  ...LEAVES.map((leaf) => [leaf, `${leaf}-error`, "error"]),
].map(Object.freeze));
const FORBIDDEN = Object.freeze([
  "target", "targetStepId", "effect", "effects", "connector", "wholePlan", "plan",
  "payload", "facts", "rawFacts", "bytes", "flowState", "ctx", "manager",
]);

function errorOperands(stepId) {
  if (stepId === "approval") return {
    evidence: new engine.ApprovalResultEvidence({
      runId: "run-result-contract", specId: "result-contract",
      attempt: new RequirementTestSourceAttempt({ id: "attempt-approval", sequence: 2 }),
      specRevision: revision(), approved: true, testsRequired: false,
    }),
  };
  const source = operands({ findings: [] });
  return {
    binding: engine.RequirementTestResultBinding.fromJSON({
      ...source.binding.toJSON(), leaf: stepId,
      attempt: new RequirementTestSourceAttempt({ id: `attempt-${stepId}`, sequence: 3 }).toJSON(),
    }),
    frontier: source.frontier,
    retryState: source.retryState,
  };
}
const json = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash("sha256").update(value).digest("hex");

function registered(leaf, kind, type) {
  const entries = engine.STEP_RESULT_REGISTRY.filter((entry) => entry.kind === kind);
  assert.equal(entries.length, 1, `unmet 02 registry contract: ${kind} requires one concrete class`);
  const entry = entries[0];
  assert.equal(entry.stepId, leaf);
  assert.equal(entry.type, type);
  assert.equal(typeof entry.ResultClass, "function");
  assert.ok(entry.ResultClass.prototype instanceof engine.StepResult);
  assert.ok(Object.isFrozen(entry));
  return entry.ResultClass;
}

function settle(result) {
  assert.equal(typeof definition.settleRequirementTestStepResult, "function",
    "unmet 02 Definition contract: settleRequirementTestStepResult(stepId, savedResult)");
  const restored = engine.rehydrateStepResult(result.stepId, json(result));
  const originalDigest = engine.stepResultDigest(restored);
  const selected = definition.settleRequirementTestStepResult(restored.stepId, restored);
  assert.ok(selected instanceof definition.StepSettlement);
  assert.equal(selected.sourceStepId, restored.stepId);
  assert.equal(selected.resultKind, restored.kind);
  assert.equal(selected.resultType, restored.type);
  assert.deepEqual(selected.toJSON(), definition.settleRequirementTestStepResult(result.stepId, result).toJSON());
  assert.equal(engine.stepResultDigest(restored), originalDigest, "selection cannot mutate saved source evidence");
  assert.equal(Object.hasOwn(selected, "facts"), false, "no second LifecycleFacts authority");
  if (selected.kind === "target-connection") {
    assert.ok(selected instanceof definition.StepRoute);
    assert.equal(typeof selected.connector, "function");
    assert.ok(selected.connector.prototype instanceof StepConnector);
  } else {
    assert.equal("connector" in selected, false, `${selected.kind} has no fake Connector`);
  }
  return selected;
}

test("02 registry is closed for all five leaves and reuses StepErrorResult only for common errors", () => {
  const actual = engine.STEP_RESULT_REGISTRY.filter((entry) => LEAVES.includes(entry.stepId));
  assert.deepEqual(actual.map(({ stepId, kind, type }) => [stepId, kind, type]).sort(), [...CLOSED_RESULTS].sort());
  const semanticClasses = new Set();
  for (const [leaf, kind, type] of CLOSED_RESULTS) {
      const ResultClass = registered(leaf, kind, type);
      if (kind === `${leaf}-error`) assert.equal(ResultClass, engine.StepErrorResult);
      else {
      assert.notEqual(ResultClass, engine.StepErrorResult, `${kind} is a dedicated classification`);
      assert.equal(semanticClasses.has(ResultClass), false, `${kind} cannot alias another kind's class`);
      semanticClasses.add(ResultClass);
    }
  }
});

for (const [leaf, kind, type] of CLOSED_RESULTS) {
  test(`02 ${kind}: fixed registry identity and malformed saved operands are refused`, () => {
    const ResultClass = registered(leaf, kind, type);
    if (kind !== `${leaf}-error`) {
      assert.throws(() => new ResultClass(), TypeError, "source evidence is mandatory");
      assert.throws(() => new ResultClass({}), TypeError, "empty generic facts are not a Result");
    }
    for (const malformed of [
      { kind, type: type === "completed" ? "loop-required" : "completed" },
      ...FORBIDDEN.map((field) => ({ kind, type, [field]: {} })),
      { kind, type, binding: null },
    ]) assert.throws(() => engine.rehydrateStepResult(leaf, malformed), TypeError);
    assert.throws(() => engine.rehydrateStepResult("spec", { kind, type }), TypeError);
  });
}

for (const leaf of LEAVES) {
  test(`02 ${leaf}: common Error codec retains class/code/data and selects connector-free Failure`, () => {
    registered(leaf, `${leaf}-error`, "error");
    const data = { requirementId: "R1", attempt: { id: "failed-attempt", sequence: 2 } };
    const original = new engine.StepErrorResult(leaf,
      Object.assign(new Error("semantic failure"), { code: "SEMANTIC_FAILED", data }), errorOperands(leaf));
    const stored = json(original);
    const restored = engine.rehydrateStepResult(leaf, stored);
    assert.equal(restored.constructor, engine.StepErrorResult);
    assert.equal(restored.error.code, "SEMANTIC_FAILED");
    assert.deepEqual(restored.error.data, data);
    assert.equal(engine.stepResultDigest(restored), engine.stepResultDigest(original));
    for (const field of FORBIDDEN) assert.throws(() => engine.rehydrateStepResult(leaf, { ...stored, [field]: {} }), TypeError);
    for (const error of [{ ...stored.error, payload: {} }, { kind: "flow" }, { kind: "generic" }]) {
      assert.throws(() => engine.rehydrateStepResult(leaf, { ...stored, error }), Error);
    }
    const selected = settle(restored);
    assert.equal(selected.kind, "failure");
    assert.equal(selected.error.code, "SEMANTIC_FAILED");
    assert.deepEqual(selected.error.data, data);
    if (leaf === "approval") assert.ok(restored.evidence instanceof engine.ApprovalResultEvidence);
    else {
      assert.equal(restored.binding.leaf, leaf);
      assert.ok(restored.frontier instanceof engine.RequirementTestResultFrontier);
      assert.ok(restored.retryState instanceof engine.RequirementTestRetryState);
    }
  });
}

test("02 all Result binding/frontier/retry operand codecs reject undeclared saved facts", () => {
  const values = operands();
  for (const [field, value] of Object.entries(values).filter(([field]) => field !== "candidateBundle")) {
    const Codec = value.constructor;
    const stored = json(value);
    assert.ok(Object.isFrozen(value));
    assert.equal(Codec.fromJSON(stored).constructor, Codec);
    for (const forbidden of FORBIDDEN) {
      assert.throws(() => Codec.fromJSON({ ...stored, [forbidden]: {} }), Error, `${field}.${forbidden}`);
    }
    for (const key of Object.keys(stored)) {
      const missing = { ...stored };
      delete missing[key];
      assert.throws(() => Codec.fromJSON(missing), Error, `missing ${field}.${key}`);
    }
  }
});

for (const name of ["TestGenerateCandidateSavedResult", "TestGenerateStructuralRejectedResult"]) {
test(`02 ${name} rejects whole plan/bytes and nested publication or manifest additions`, () => {
  const ResultClass = requiredExport(name);
  const values = operands();
  if (name === "TestGenerateStructuralRejectedResult") values.semanticFinding = new RequirementTestSemanticFinding({
    requirementId: values.binding.requirementId,
    bundleRevision: values.candidateBundle.bundle.revision,
    fingerprint: values.candidateBundle.digest,
  });
  const original = new ResultClass(values);
  const stored = json(original);
  for (const field of FORBIDDEN) {
    assert.throws(() => new ResultClass({ ...values, [field]: {} }), TypeError);
    assert.throws(() => engine.rehydrateStepResult("test-generate", { ...stored, [field]: {} }), TypeError);
  }
  for (const mutate of [
    (saved) => { saved.binding.planPublication.bytes = "plan"; },
    (saved) => { saved.candidateBundle.sources[0].bytes = "source"; },
    (saved) => { saved.candidateBundle.bundle.lineage.facts = {}; },
    (saved) => { saved.frontier.pending[0].candidate = {}; },
    (saved) => { saved.retryState.budget.tooling = -1; },
  ]) {
    const tampered = json(stored);
    mutate(tampered);
    assert.throws(() => engine.rehydrateStepResult("test-generate", tampered), Error);
  }
  assert.deepEqual(engine.rehydrateStepResult("test-generate", stored).toJSON(), stored);
});
}

test("02 candidate manifest binds support owner, primary R, lineage and exact member hash/size without bytes", () => {
  const base = candidate();
  const helperBytes = Buffer.from("export const helper = 1;\n");
  const support = RequirementTestSupportArtifact.fromBytes({ ownerRequirementId: "R1", supportPath: "tests/support/shared.js", bytes: helperBytes });
  const manifest = new RequirementTestCandidateBundle({ bundle: base.bundle, sources: base.sources, support: [support] });
  const saved = json(manifest);
  const restored = RequirementTestCandidateBundle.fromJSON(saved);
  assert.equal(restored.support[0].constructor, RequirementTestSupportArtifact);
  assert.equal(restored.sources[0].constructor, RequirementTestCandidateSource);
  assert.equal(restored.bundle.lineage.constructor, RequirementTestBundleLineage);
  assert.equal(restored.bundle.lineage.sourceAttempt.constructor, RequirementTestSourceAttempt);
  assert.deepEqual(saved.support, [{ ownerRequirementId: "R1", supportPath: "tests/support/shared.js", digest: hash(helperBytes), byteLength: helperBytes.length }]);
  assert.equal(JSON.stringify(saved).includes("bytes"), false);
  for (const mutate of [
    (value) => { value.support[0].ownerRequirementId = "R2"; },
    (value) => { value.support[0].digest = "f".repeat(64); },
    (value) => { value.sources[0].byteLength += 1; },
    (value) => { value.bundle.requirementId = "R2"; },
    (value) => { value.bundle.lineage.predecessorRevision = 1; },
    (value) => { value.sources[0].bytes = "hidden source"; },
    (value) => { value.support[0].bytes = "hidden helper"; },
  ]) {
    const malformed = json(saved);
    mutate(malformed);
    assert.throws(() => RequirementTestCandidateBundle.fromJSON(malformed), Error);
  }
});

test("02 Result digest binds same support bytes to their primary publication owner", () => {
  const ResultClass = requiredExport("TestGenerateCandidateSavedResult");
  const base = candidate();
  const support = RequirementTestSupportArtifact.fromBytes({ ownerRequirementId: "R1", supportPath: "tests/support/shared.js", bytes: Buffer.from("export const helper = 1;\n") });
  const manifest = new RequirementTestCandidateBundle({ bundle: base.bundle, sources: base.sources, support: [support] });
  const original = new ResultClass(operands({ candidateBundle: manifest }));
  const alternate = new RequirementTestCandidateBundle({ bundle: base.bundle, sources: base.sources, support: [new RequirementTestSupportArtifact({ ...support.toJSON(), ownerRequirementId: "R2" })] });
  const changed = new ResultClass(operands({ candidateBundle: alternate }));
  assert.notEqual(engine.stepResultDigest(original), engine.stepResultDigest(changed), "support ownership belongs to saved Result identity");
});

test("02 final generation selects Review while remaining R continues the same Attempt without Connector", () => {
  const ResultClass = requiredExport("TestGenerateCandidateSavedResult");
  const pendingResult = new ResultClass(operands());
  const continued = settle(pendingResult);
  assert.equal(continued.kind, "execution");
  const finalResult = new ResultClass(operands({ pendingIds: [] }));
  const reviewed = settle(finalResult);
  assert.equal(reviewed.kind, "target-connection");
  assert.equal(reviewed.targetStepId, "test-review");
  assert.throws(() => definition.settleRequirementTestStepResult("test-review", finalResult), TypeError);
});

for (const autoApprove of [true, false]) {
  test(`02 structural rejection uses saved ${autoApprove ? "automatic" : "manual"} budget/finding to select repair or defer`, () => {
    const ResultClass = requiredExport("TestGenerateStructuralRejectedResult");
    const counted = [];
    const source = operands({ autoApprove, findings: counted, budget: new RequirementTestBudget() });
    source.semanticFinding = new RequirementTestSemanticFinding({
      requirementId: source.binding.requirementId,
      bundleRevision: source.candidateBundle.bundle.revision,
      fingerprint: source.candidateBundle.digest,
    });
    const fresh = new ResultClass(source);
    const repair = settle(fresh);
    assert.equal(repair.kind, "target-connection");
    assert.equal(repair.targetStepId, "test-repair");
    const exhaustedOperands = operands({ autoApprove, pendingIds: [], findings: counted,
      budget: new RequirementTestBudget({ autoSemantic: autoApprove ? 5 : 0, manualSemantic: autoApprove ? 0 : 5 }) });
    exhaustedOperands.semanticFinding = source.semanticFinding;
    const exhausted = new ResultClass(exhaustedOperands);
    const deferred = settle(exhausted);
    assert.equal(deferred.kind, "target-connection");
    assert.equal(deferred.targetStepId, "implement");
  });
}

test("02 binding publication identity includes Activity as well as unchanged bytes", () => {
  const ResultClass = requiredExport("TestGenerateCandidateSavedResult");
  const values = operands();
  const original = new ResultClass(values);
  const Binding = requiredExport("RequirementTestResultBinding");
  const changedBinding = Binding.fromJSON({ ...values.binding.toJSON(), planPublication: { ...values.binding.toJSON().planPublication, activityId: "same-bytes-new-activity" } });
  const changed = new ResultClass({ ...values, binding: changedBinding });
  assert.notEqual(engine.stepResultDigest(changed), engine.stepResultDigest(original));
  assert.deepEqual(engine.rehydrateStepResult("test-generate", json(changed)).binding.toJSON(), changedBinding.toJSON());
});

test("02 frontier refuses duplicate/cross-group R and preserves staged/pending order after readback", () => {
  const Frontier = requiredExport("RequirementTestResultFrontier");
  const staged = new RequirementTestWorkItem({ requirementId: "R0", specRevision: revision(), expectation: "fail", status: "candidate_saved", bundleRevision: candidate({ requirementId: "R0" }).bundle });
  assert.throws(() => new Frontier({ staged: [staged, staged], pending: [] }), TypeError);
  assert.throws(() => new Frontier({ staged: [staged], pending: [pending("R0")] }), TypeError);
  assert.throws(() => new Frontier({ staged: [], pending: [pending("R2"), pending("R2")] }), TypeError);
  const original = new Frontier({ staged: [staged], pending: [pending("R3"), pending("R2")] });
  assert.deepEqual(Frontier.fromJSON(json(original)).toJSON(), original.toJSON());
  assert.deepEqual(original.toJSON().pending.map((item) => item.requirementId), ["R3", "R2"]);
});

test("02 retry operand retains separate counters/mode/complete recorded finding identity", () => {
  const Retry = requiredExport("RequirementTestRetryState");
  const finding = new RequirementTestSemanticFinding({ requirementId: "R1", bundleRevision: 1, fingerprint: "b".repeat(64) });
  const original = new Retry({ budget: new RequirementTestBudget({ autoSemantic: 5, manualSemantic: 4, tooling: 3 }), autoApprove: false, findings: [finding] });
  assert.deepEqual(Retry.fromJSON(json(original)).toJSON(), original.toJSON());
  assert.throws(() => new Retry({ budget: {}, autoApprove: false, findings: [finding] }), TypeError);
  assert.throws(() => new Retry({ budget: new RequirementTestBudget(), autoApprove: "true", findings: [finding] }), TypeError);
  assert.throws(() => new Retry({ budget: new RequirementTestBudget(), autoApprove: true, findings: [finding, finding] }), TypeError);
});

test("02 named Gate artifact readback retains candidate lineage and distinguishes assertion kinds", () => {
  const selectedCandidate = candidate();
  const observation = new RequirementTestGateObservation({ requirementId: "R1", specRevision: revision(), bundleRevision: 1, candidateDigest: selectedCandidate.digest, testName: "R1: exact assertion", kind: "assertion_failed", sourceAttempt: selectedCandidate.bundle.lineage.sourceAttempt });
  const gate = new RequirementTestGateResult({ observation, command: "node --test", rawOutputPath: "steps/test-gate/output.log", process: { started: true, exitCode: 1, signal: null, timedOut: false, spawnError: null } });
  const stored = json(gate);
  const restored = RequirementTestGateResult.fromJSON(stored);
  assert.equal(restored.observation.constructor, RequirementTestGateObservation);
  assert.equal(restored.observation.testName, "R1: exact assertion");
  assert.deepEqual(restored.observation.sourceAttempt.toJSON(), selectedCandidate.bundle.lineage.sourceAttempt.toJSON());
  assert.equal(restored.observation.kind, "assertion_failed");
  assert.deepEqual(restored.toJSON(), stored);
  for (const mutation of [{ testName: "" }, { kind: "ReferenceError" }, { bytes: "runner output" }]) {
    assert.throws(() => RequirementTestGateResult.fromJSON({ ...stored, observation: { ...stored.observation, ...mutation } }), Error);
  }
  // The Gate publication operand's class and spelling are not fixed in 8e30.
  // Result-specific adoption is covered through the phase scenario's real
  // Gate producer; this checks its existing named observation codec contract.
});

function repairCheckpoint() {
  const selectedCandidate = candidate();
  const findings = ["F1", "F2"].map((findingId) => new TestReviewRepairFinding({ findingId, fingerprint: hash(findingId), target: "r1.test.js:R1", title: findingId, issue: "Missing assertion", requiredChange: "Add assertion" }));
  const state = { schemaRevision: CURRENT_FLOW_SCHEMA_REVISION, runId: "run-result-contract", specId: "result-contract", attempt: { id: "attempt-repair", sequence: 3 } };
  const repair = new CanonicalTestReviewRepair({ state, attempt: 2, artifactDigest: hash("review"), evidenceId: hash("evidence"), sourceCandidate: selectedCandidate, blockingFindings: findings });
  const stagedSources = [{ testPath: "r1.test.js", bytes: Buffer.from("// spec: R1\n// repaired\n") }];
  const initial = TestReviewRepairProgress.start(repair, stagedSources);
  const batch = initial.nextBatch(repair, stagedSources, { ...TEST_REVIEW_REPAIR_BATCH_LIMITS, findingCount: 1 });
  const receipt = { batchId: batch.batchId, findingIds: [...batch.findingIds], beforeTreeDigest: hash("before"), afterTreeDigest: hash("after"), changedPaths: [{ path: "r1.test.js", beforeDigest: hash("before-file"), afterDigest: hash("after-file") }], sourceCandidate: selectedCandidate.toJSON(), handoffDigest: hash("handoff"), requestDigest: hash("request"), payloadDigest: hash("payload") };
  const progress = initial.markBatchComplete(repair, batch, receipt, stagedSources);
  return { repair, progress, batch, receipt, stagedSources };
}

test("02 repair checkpoint seed is a real bounded batch with durable exact finding/receipt/coordinator identity", () => {
  const { repair, progress, batch, receipt } = repairCheckpoint();
  const restored = TestReviewRepairProgress.fromJSON(json(progress), repair);
  assert.equal(restored.complete, false);
  assert.equal(restored.entryFor("F1").status, "done");
  assert.equal(restored.entryFor("F2").status, "pending");
  assert.deepEqual(restored.entryFor("F1").handoff.toJSON(), receipt);
  assert.deepEqual(restored.coordinatorAttempt.toJSON(), { id: "attempt-repair", sequence: 3 });
  assert.equal(restored.entryFor("F1").handoff.batchId, batch.batchId);
  for (const mutate of [
    (saved) => { saved.coordinatorAttempt.sequence = 4; },
    (saved) => { saved.entries[0].fingerprint = hash("another-finding"); },
    (saved) => { saved.entries[0].handoff.findingIds = ["F2"]; },
    (saved) => { saved.entries[0].handoff.sourceCandidate.digest = hash("tamper"); },
  ]) {
    const malformed = json(progress);
    mutate(malformed);
    assert.throws(() => TestReviewRepairProgress.fromJSON(malformed, repair), Error);
  }
});

test("02 repair Result requires a metadata-only dedicated progress codec, never staged source bytes", () => {
  const ProgressIdentity = requiredExport("RequirementTestRepairProgressIdentity");
  assert.equal(typeof ProgressIdentity.fromJSON, "function", "typed repair progress readback");
  assert.equal(typeof ProgressIdentity.prototype.toJSON, "function");
  assert.throws(() => new ProgressIdentity(), TypeError);
  assert.throws(() => new ProgressIdentity({}), TypeError);
  const { progress } = repairCheckpoint();
  // Existing progress includes staged byte payloads. It cannot itself serve as
  // the new Result operand: the dedicated identity must reject this envelope.
  assert.throws(() => ProgressIdentity.fromJSON(json(progress)), Error);
  for (const field of FORBIDDEN) assert.throws(() => ProgressIdentity.fromJSON({ [field]: {} }), Error);
});

// These exercise assertion-checker controls using real existing pure value
// classes. The arbitrary outer evidence container is not a proposed Result
// field or a substitute registry/producer. Phase integration supplies genuine
// producer Activity/catalog snapshots to the same checker.
function evidenceSnapshot(logicalKey, payload, activity, { history = true, parameters = {} } = {}) {
  const document = history ? { attempts: [{ attempt: activity.sequence, artifact: { logicalKey, payload } }] } : payload;
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  const resolved = logicalKey === "review.evidence"
    ? FLOW_ARTIFACT_CONTRACTS.reviewEvidence(parameters)
    : FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, parameters);
  const descriptor = new FlowArtifactDescriptor({
    ...resolved.publication({
      mediaType: "application/json", activityId: activity.id,
      ...(logicalKey === "review.evidence" ? { updater: resolved.publicationStep() } : {}),
    }),
    hash: hash(bytes), size: bytes.length,
  });
  return { descriptor, bytes };
}

function evidencePublication(snapshot) {
  const { logicalKey, relativePath, hash, size, activityId } = snapshot.descriptor;
  return { logicalKey, relativePath, hash, size, activityId };
}

function evidenceBinding(leaf, attempt) {
  return {
    runId: "run-result-contract", specId: "result-contract", leaf, attempt,
    requirementId: "R1", specRevision: revision().toJSON(), candidate: candidate().bundle.lineage.toJSON(),
  };
}

test("02 evidence checker binds Gate named observation and publication and rejects arbitrary/stale evidence", () => {
  const activity = { id: "activity-gate", nodeId: "test-gate", attemptId: "attempt-gate", sequence: 1 };
  const selectedCandidate = candidate();
  const observation = new RequirementTestGateObservation({ requirementId: "R1", specRevision: revision(), bundleRevision: 1, candidateDigest: selectedCandidate.digest, testName: "R1: exact named assertion", kind: "assertion_failed", sourceAttempt: selectedCandidate.bundle.lineage.sourceAttempt });
  const gate = new RequirementTestGateResult({ observation, command: "node --test", rawOutputPath: "steps/test-gate/output.log", process: { started: true, exitCode: 1, signal: null, timedOut: false, spawnError: null } });
  const artifact = evidenceSnapshot("test.requirement.gate", gate.toJSON(), activity);
  const expected = { activity, gate: { artifact } };
  const observed = { kind: "test-gate-compatible", binding: evidenceBinding("test-gate", { id: activity.attemptId, sequence: activity.sequence }), evidence: { observation: observation.toJSON(), publication: evidencePublication(artifact) } };
  assertRequirementTestEvidenceProjection("test-gate", observed, expected);
  for (const mutate of [
    (value) => { value.evidence = new RequirementTestBudget().toJSON(); },
    (value) => { value.evidence.observation.testName = "R2: another assertion"; },
    (value) => { value.evidence.observation.kind = "assertion_passed"; },
    (value) => { value.evidence.observation.sourceAttempt.sequence += 1; },
    (value) => { value.evidence.publication.activityId = "same-bytes-another-activity"; },
    (value) => { value.evidence.publication.hash = "f".repeat(64); },
  ]) {
    const malformed = json(observed);
    mutate(malformed);
    assert.throws(() => assertRequirementTestEvidenceProjection("test-gate", malformed, expected), assert.AssertionError);
  }
  assert.throws(() => assertRequirementTestEvidenceProjection("test-gate", observed), assert.AssertionError);
});

function reviewEvidenceCheckerSeed({ resultActivityId = "activity-review", publicationActivityId = resultActivityId } = {}) {
  const activity = { id: resultActivityId, nodeId: "test-review", attemptId: "attempt-review", sequence: 1 };
  const publicationActivity = { ...activity, id: publicationActivityId };
  const selectedCandidate = candidate();
  const manifest = new ReviewWorkUnitManifest({
    version: 1, runId: "run-result-contract", specId: "result-contract", phase: "test", taskId: null,
    nodeId: "test-review", attemptId: activity.attemptId,
    target: { treeSha: "a".repeat(40), targetStateDigest: "b".repeat(64) },
    inputs: [{ logicalKey: "test.requirement.candidate.source", logicalPath: "tests/r1.test.js", relativePath: "inputs/tests/r1.test.js", digest: selectedCandidate.sources[0].digest, byteLength: selectedCandidate.sources[0].byteLength, mediaType: "text/plain" }],
    output: ReviewWorkUnitOutput.forReview({ phase: "test" }),
  });
  const seal = ReviewWorkUnitSeal.forManifest(manifest, { digest: hash("sealed-review-output"), byteLength: 64 });
  const source = new RequirementTestReviewSource({ runId: manifest.runId, requirementId: "R1", specRevision: revision(), bundleRevision: 1, candidateDigest: selectedCandidate.digest, sourceAttempt: selectedCandidate.bundle.lineage.sourceAttempt, candidatePaths: ["tests/r1.test.js"] });
  const evidence = new ReviewEvidence({ phase: "test", taskId: null, treeSha: manifest.target.treeSha, targetStateDigest: manifest.target.targetStateDigest, provenance: { provider: "external-fixture", invocationId: "review-invocation", capturedAt: "2026-10-05T00:00:00.000Z" }, disposition: new ReviewDisposition({ value: "PASS" }) });
  const workerOutput = { digest: seal.output.digest, byteLength: seal.output.byteLength, mediaType: manifest.output.mediaType };
  const normalized = { requirementId: source.requirementId, specRevision: source.specRevision.toJSON(), bundleRevision: source.bundleRevision, candidateDigest: source.candidateDigest, sourceAttempt: source.sourceAttempt.toJSON(), canonicalEvidence: evidence.toJSON(), workerOutput, canonicalTarget: manifest.target.toJSON() };
  const artifact = evidenceSnapshot("test.requirement.review", normalized, publicationActivity);
  const evidenceArtifact = evidenceSnapshot("review.evidence", evidence.toCanonicalJSON(), publicationActivity, { history: false, parameters: { reviewStep: "test-review", digest: evidence.identity.evidenceDigest } });
  const expected = { activity, review: { workUnit: { manifest, seal }, artifact, evidence: evidenceArtifact } };
  const observed = { kind: "test-review-passed", binding: evidenceBinding("test-review", { id: activity.attemptId, sequence: activity.sequence }), evidence: {
    workUnit: seal.toJSON(), publication: evidencePublication(artifact), evidencePublication: evidencePublication(evidenceArtifact),
    source: source.toJSON(), identity: evidence.identity.toJSON(), workerOutput,
  } };
  return { expected, observed };
}

test("02 evidence checker binds Review work-unit/evidence publication and refuses same-size identity substitution", () => {
  const { expected, observed } = reviewEvidenceCheckerSeed({
    resultActivityId: "review-result-activity", publicationActivityId: "review-publication-activity",
  });
  assert.notEqual(expected.activity.id, expected.review.artifact.descriptor.activityId);
  assert.notEqual(expected.activity.id, expected.review.evidence.descriptor.activityId);
  assertRequirementTestEvidenceProjection("test-review", observed, expected);
  for (const mutate of [
    (value) => { value.evidence = new RequirementTestBudget().toJSON(); },
    (value) => { value.evidence.workUnit.manifestDigest = "f".repeat(64); },
    (value) => { value.evidence.workUnit.inputDigest = "f".repeat(64); },
    (value) => { value.evidence.workUnit.target.targetStateDigest = "f".repeat(64); },
    (value) => { value.evidence.evidencePublication.activityId = expected.activity.id; },
    (value) => { value.evidence.identity.evidenceDigest = "f".repeat(64); },
    (value) => { value.evidence.workerOutput.digest = "f".repeat(64); },
    (value) => { value.evidence.source.candidateDigest = "f".repeat(64); },
  ]) {
    const malformed = json(observed);
    mutate(malformed);
    assert.throws(() => assertRequirementTestEvidenceProjection("test-review", malformed, expected), assert.AssertionError);
  }
  assert.throws(() => assertRequirementTestEvidenceProjection("test-review", observed), assert.AssertionError);
});

test("02 evidence checker requires exact unexecuted Review work-unit without fabricating an accepted publication", () => {
  const { expected, observed } = reviewEvidenceCheckerSeed();
  const manifest = expected.review.workUnit.manifest;
  const execution = { ...observed, kind: "test-review-execution-required", evidence: { workUnit: {
    manifestDigest: manifest.digest, inputDigest: manifest.inputDigest, target: manifest.target.toJSON(),
  } } };
  const expectedExecution = { activity: expected.activity, review: { workUnit: { manifest: expected.review.workUnit.manifest } } };
  assertRequirementTestEvidenceProjection("test-review", execution, expectedExecution);
  const malformed = json(execution);
  malformed.evidence.workUnit.manifestDigest = "f".repeat(64);
  assert.throws(() => assertRequirementTestEvidenceProjection("test-review", malformed, expectedExecution), assert.AssertionError);
});

test("02 evidence checker binds tooling Gate Result evidence to the actual named runner observation", () => {
  const activity = { id: "activity-gate-tooling", nodeId: "test-gate", attemptId: "attempt-gate", sequence: 1 };
  const selectedCandidate = candidate();
  const observation = new RequirementTestGateObservation({ requirementId: "R1", specRevision: revision(),
    bundleRevision: 1, candidateDigest: selectedCandidate.digest, testName: "R1: exact named assertion",
    kind: "tooling_failure", sourceAttempt: selectedCandidate.bundle.lineage.sourceAttempt });
  const gate = new RequirementTestGateResult({ observation, command: "node --test", rawOutputPath: "steps/test-gate/output.log",
    process: { started: true, exitCode: 2, signal: null, timedOut: false, spawnError: null } });
  const artifact = evidenceSnapshot("test.requirement.gate", gate.toJSON(), activity);
  const expected = { activity, gate: { artifact } };
  // Oracle inputs only: production Result/codec/Settlement coverage is in the
  // phase scenario. These projections never enter a production consumer.
  const observed = { kind: "test-gate-tooling-unavailable",
    binding: evidenceBinding("test-gate", { id: activity.attemptId, sequence: activity.sequence }),
    evidence: { observation: observation.toJSON(), publication: evidencePublication(artifact) } };
  assertRequirementTestEvidenceProjection("test-gate", observed, expected);
  for (const mutate of [
    (value) => { value.evidence.observation.kind = "assertion_passed"; },
    (value) => { value.evidence.observation.sourceAttempt.sequence += 1; },
    (value) => { value.evidence.publication.activityId = "other-activity"; },
    (value) => { delete value.evidence; },
  ]) {
    const malformed = json(observed);
    mutate(malformed);
    assert.throws(() => assertRequirementTestEvidenceProjection("test-gate", malformed, expected), assert.AssertionError);
  }
});

test("02 Settlement outcome checker rejects wrong source/result, target, and connector-bearing stops", () => {
  // This tests the assertion oracle, not a synthetic StepResult or registry.
  // The actual saved-only Definition calls remain in the production scenarios.
  for (const [stepId, suffix, type, expected] of [
    ["test-review", "execution-required", "loop-required", { kind: "execution" }],
    ["test-generate", "tooling-unavailable", "loop-required", { kind: "target-connection", targetStepId: "test-generate" }],
    ["test-repair", "external-blocked", "error", { kind: "failure" }],
  ]) {
    const saved = { kind: `${stepId}-${suffix}`, type };
    const selected = { sourceStepId: stepId, resultKind: saved.kind, resultType: saved.type, ...expected };
    assertRequirementTestSettlementProjection(stepId, saved, selected, expected);
    for (const mutation of [
      { sourceStepId: "spec" }, { resultKind: "wrong-result" }, { resultType: "completed" },
      { kind: "await" }, { targetStepId: "implement" },
      ...(expected.kind === "target-connection" ? [] : [{ connector: {} }]),
    ]) assert.throws(() => assertRequirementTestSettlementProjection(stepId, saved,
      { ...selected, ...mutation }, expected), assert.AssertionError);
  }
});

test("02 Settlement checker without an expected route still binds the saved Result identity", () => {
  const saved = { kind: "test-review-passed", type: "completed" };
  const selected = { sourceStepId: "test-review", resultKind: saved.kind, resultType: saved.type,
    kind: "target-connection", targetStepId: "test-gate" };
  assertRequirementTestSettlementProjection("test-review", saved, selected);
  for (const mutation of [
    { sourceStepId: "test-gate" }, { resultKind: "test-review-advisory" }, { resultType: "loop-required" },
  ]) assert.throws(() => assertRequirementTestSettlementProjection("test-review", saved,
    { ...selected, ...mutation }), assert.AssertionError);
});
