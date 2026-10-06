import assert from "node:assert/strict";
import * as engine from "../../../src/flow/engine/step-result.js";
import * as definition from "../../../src/flow/definition.js";
import { StepConnector } from "../../../src/flow/engine/step-connector.js";
import {
  RequirementTestCandidateBundle, RequirementTestGateResult, RequirementTestReviewSource,
} from "../../../src/flow/lib/requirement-test-artifacts.js";
import { FlowArtifactDescriptor } from "../../../src/lib/flow-version.js";
import { ReviewEvidenceInput } from "../../../src/flow/lib/review-evidence-store.js";
import { CanonicalCommandAttemptArtifactHistory } from "../../../src/flow/lib/canonical-command-result.js";
import {
  ReviewWorkUnitManifest, ReviewWorkUnitSeal, ReviewWorkUnitOutputReceipt,
} from "../../../src/flow/lib/review-work-unit-values.js";

const TEST_LEAVES = new Set(["test-generate", "test-review", "test-repair", "test-gate"]);
const FORBIDDEN_ROOT = ["target", "targetStepId", "effect", "effects", "connector", "wholePlan", "plan", "flowState", "ctx", "manager"];
const FORBIDDEN_EVIDENCE = ["bytes", "payload", "facts", "rawFacts", "wholePlan"];
const json = (value) => JSON.parse(JSON.stringify(value));

function assertMetadataOnly(value, path = "result") {
  if (value === null || typeof value !== "object") return;
  for (const [field, child] of Object.entries(value)) {
    assert.equal(FORBIDDEN_EVIDENCE.includes(field), false, `${path}.${field} is not declared Result evidence`);
    assertMetadataOnly(child, `${path}.${field}`);
  }
}

function containsProjection(value, expected) {
  if (value === null || typeof value !== "object") return false;
  const matches = !Array.isArray(value) && Object.entries(expected).every(([field, wanted]) => {
    const actual = value[field];
    return wanted !== null && typeof wanted === "object"
      ? actual !== null && typeof actual === "object" && containsProjectionAt(actual, wanted)
      : actual === wanted;
  });
  return matches || Object.values(value).some((child) => containsProjection(child, expected));
}

function containsProjectionAt(actual, expected) {
  return Object.entries(expected).every(([field, wanted]) => (
    wanted !== null && typeof wanted === "object"
      ? actual[field] !== null && typeof actual[field] === "object" && containsProjectionAt(actual[field], wanted)
      : actual[field] === wanted
  ));
}

function assertProjection(evidence, expected, label) {
  assert.ok(containsProjection(evidence, expected), `${label} must match canonical source evidence, not an arbitrary typed operand`);
}

function publication(snapshot, logicalKey, stepId, activity) {
  assert.ok(snapshot?.descriptor && Buffer.isBuffer(snapshot.bytes), `${logicalKey} requires a real catalog snapshot`);
  const descriptor = snapshot.descriptor instanceof FlowArtifactDescriptor
    ? snapshot.descriptor : new FlowArtifactDescriptor(snapshot.descriptor);
  descriptor.verifyBytes(snapshot.bytes);
  assert.equal(descriptor.logicalKey, logicalKey);
  assert.equal(descriptor.slot.publicationStep, stepId);
  assert.ok(typeof descriptor.activityId === "string" && descriptor.activityId !== "", `${logicalKey} requires its actual publication Activity identity`);
  // Gate's Result/plan/receipt/Activity/publication are one atomic settlement
  // in a1ee. Review must bind the actual canonical publication, whose producer
  // Activity may precede the Result Activity in the same source Attempt.
  if (stepId === "test-gate") {
    assert.equal(descriptor.activityId, activity.id, `${logicalKey} publication belongs to the atomic Gate Result Activity`);
  }
  return {
    logicalKey: descriptor.logicalKey, relativePath: descriptor.relativePath,
    hash: descriptor.hash, size: descriptor.size, activityId: descriptor.activityId,
  };
}

function assertSourceBinding(binding, source) {
  assert.equal(binding.requirementId, source.requirementId);
  assert.deepEqual(binding.specRevision, source.specRevision.toJSON());
  assert.equal(binding.candidate.requirementId, source.requirementId);
  assert.deepEqual(binding.candidate.specRevision, source.specRevision.toJSON());
  assert.equal(binding.candidate.bundleRevision, source.bundleRevision);
  assert.deepEqual(binding.candidate.sourceAttempt, source.sourceAttempt.toJSON());
}

/**
 * Match stable projections of existing canonical values, without choosing the
 * containing Result operand's name or class. The caller must supply snapshots
 * captured by the real Review/Gate producer and their saving Activity.
 */
export function assertRequirementTestEvidenceProjection(stepId, storedResult, expectedEvidence) {
  const kind = storedResult.kind;
  const reviewRequired = stepId === "test-review"
    && ["test-review-execution-required", "test-review-passed", "test-review-advisory", "test-review-rejected"].includes(kind);
  const gateRequired = stepId === "test-gate"
    && ["test-gate-compatible", "test-gate-incompatible", "test-gate-tooling-unavailable"].includes(kind);
  if (!reviewRequired && !gateRequired) return;
  assert.ok(expectedEvidence?.activity, `${kind} requires independently captured canonical evidence`);
  const activity = expectedEvidence.activity;
  assert.equal(activity.nodeId, stepId);
  assert.equal(storedResult.binding.attempt.id, activity.attemptId);
  assert.equal(storedResult.binding.attempt.sequence, activity.sequence);
  const evidence = Object.fromEntries(Object.entries(json(storedResult)).filter(([field]) => (
    !["kind", "type", "binding", "frontier", "retryState", "error"].includes(field)
  )));

  if (reviewRequired) {
    const expected = expectedEvidence.review;
    assert.ok(expected?.workUnit?.manifest, "Review must bind its actual canonical work-unit manifest");
    const manifest = expected.workUnit.manifest instanceof ReviewWorkUnitManifest
      ? expected.workUnit.manifest : new ReviewWorkUnitManifest(expected.workUnit.manifest);
    assert.equal(manifest.phase, "test");
    assert.equal(manifest.nodeId, stepId);
    assert.equal(manifest.runId, storedResult.binding.runId);
    assert.equal(manifest.specId, storedResult.binding.specId);
    assert.equal(manifest.attemptId, activity.attemptId);
    assertProjection(evidence, {
      manifestDigest: manifest.digest, inputDigest: manifest.inputDigest,
      target: manifest.target.toJSON(),
    }, "Review work-unit identity");
    if (kind === "test-review-execution-required") return;
    assert.ok(expected.workUnit.seal, "accepted Review requires its real sealed output");
    const seal = expected.workUnit.seal instanceof ReviewWorkUnitSeal
      ? expected.workUnit.seal : new ReviewWorkUnitSeal(expected.workUnit.seal);
    seal.assertManifest(manifest);
    assertProjection(evidence, publication(expected.artifact, "test.requirement.review", stepId, activity), "Review artifact publication");
    assertProjection(evidence, publication(expected.evidence, "review.evidence", stepId, activity), "Review evidence publication");
    const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: "test.requirement.review", bytes: expected.artifact.bytes });
    assert.equal(history.current.attempt, activity.sequence);
    const document = history.current.payload;
    const evidenceDocument = JSON.parse(expected.evidence.bytes);
    const canonicalEvidence = new ReviewEvidenceInput(evidenceDocument).evidence;
    assert.deepEqual(document.canonicalEvidence, canonicalEvidence.toJSON());
    assert.equal(canonicalEvidence.phase, "test");
    assert.equal(canonicalEvidence.treeSha, manifest.target.treeSha);
    assert.equal(canonicalEvidence.targetStateDigest, manifest.target.targetStateDigest);
    const expectedVerdict = { "test-review-passed": "PASS", "test-review-advisory": "ADVISORY", "test-review-rejected": "REJECTED" }[kind];
    assert.equal(canonicalEvidence.disposition.value, expectedVerdict);
    const output = new ReviewWorkUnitOutputReceipt(document.workerOutput);
    assert.equal(output.digest, seal.output.digest);
    assert.equal(output.byteLength, seal.output.byteLength);
    assert.equal(output.mediaType, manifest.output.mediaType);
    assertProjection(evidence, output.toJSON(), "Review sealed output receipt");
    assertProjection(evidence, { evidenceDigest: canonicalEvidence.identity.evidenceDigest }, "Review semantic evidence identity");
    const source = new RequirementTestReviewSource({
      runId: manifest.runId, requirementId: document.requirementId, specRevision: document.specRevision,
      bundleRevision: document.bundleRevision, candidateDigest: document.candidateDigest,
      sourceAttempt: document.sourceAttempt,
      candidatePaths: manifest.inputs.filter((input) => input.logicalKey === "test.requirement.candidate.source").map((input) => input.logicalPath),
    });
    assertSourceBinding(storedResult.binding, source);
    assertProjection(evidence, {
      requirementId: source.requirementId, specRevision: source.specRevision.toJSON(),
      bundleRevision: source.bundleRevision, candidateDigest: source.candidateDigest,
      sourceAttempt: source.sourceAttempt.toJSON(),
    }, "Review candidate source identity");
  } else {
    const expected = expectedEvidence.gate;
    assertProjection(evidence, publication(expected?.artifact, "test.requirement.gate", stepId, activity), "Gate observation publication");
    const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: "test.requirement.gate", bytes: expected.artifact.bytes });
    assert.equal(history.current.attempt, activity.sequence);
    const gate = RequirementTestGateResult.fromJSON(history.current.payload);
    if (kind === "test-gate-tooling-unavailable") assert.equal(gate.observation.kind, "tooling_failure");
    assertSourceBinding(storedResult.binding, gate.observation);
    assertProjection(evidence, gate.observation.toJSON(), "Gate exact named observation");
  }
}

/** Assert a scenario's expected outcome without duplicating Definition policy. */
export function assertRequirementTestSettlementProjection(stepId, savedResult, selected, expected = null) {
  assert.equal(selected.sourceStepId, stepId);
  assert.equal(selected.resultKind, savedResult.kind);
  assert.equal(selected.resultType, savedResult.type);
  if (expected === null) return;
  assert.equal(selected.kind, expected.kind);
  if (expected.kind === "target-connection") {
    assert.equal(selected.targetStepId, expected.targetStepId);
  } else {
    assert.equal("connector" in selected, false, `${expected.kind} cannot own a Connector`);
    assert.equal("targetStepId" in selected, false, `${expected.kind} cannot activate a target`);
  }
}

/**
 * Assert the real producer's durable Result, without manufacturing a Result
 * class or choosing future constructor/operand names. Consumers pass exactly
 * the saved artifact read through their normal Store after producer execution.
 * This is assertion support, not a second registry or a fixture producer.
 */
export function assertRequirementTestResultRoundtrip(stepId, storedResult, expectedEvidence, expectedSettlement = null) {
  const saved = json(storedResult);
  const entries = engine.STEP_RESULT_REGISTRY.filter((entry) => entry.kind === saved.kind);
  assert.equal(entries.length, 1, `unmet 02 registry contract: ${saved.kind}`);
  const entry = entries[0];
  assert.equal(entry.stepId, stepId);
  assert.equal(entry.type, saved.type);
  const restored = engine.rehydrateStepResult(stepId, saved);
  assert.equal(restored.constructor, entry.ResultClass);
  assert.equal(restored.stepId, stepId);
  assert.ok(restored instanceof engine.StepResult);
  assert.deepEqual(restored.toJSON(), saved);
  const again = engine.rehydrateStepResult(stepId, json(restored));
  assert.equal(again.constructor, restored.constructor);
  assert.equal(engine.stepResultDigest(again), engine.stepResultDigest(restored));
  assert.ok(Object.isFrozen(restored));

  for (const field of FORBIDDEN_ROOT) assert.equal(Object.hasOwn(saved, field), false, `forbidden Result.${field}`);
  // Common Error.data remains the pre-existing structured error contract.
  // Semantic evidence outside that envelope must never contain byte payloads
  // or an alternate facts authority.
  for (const [field, value] of Object.entries(saved)) {
    if (field !== "error") assertMetadataOnly(value, `result.${field}`);
  }
  const operandFields = Object.keys(saved).filter((field) => !["kind", "type", "error"].includes(field));
  for (const field of operandFields) {
    assert.ok(restored[field] !== null && typeof restored[field] === "object", `typed Result.${field}`);
    assert.notEqual(restored[field].constructor, Object, `Result.${field} cannot be an untyped JSON bag`);
    assert.equal(typeof restored[field].toJSON, "function", `Result.${field} codec`);
    assert.equal(again[field].constructor, restored[field].constructor, `Result.${field} readback class identity`);
    assert.ok(Object.isFrozen(restored[field]), `immutable Result.${field}`);
    assert.deepEqual(restored[field].toJSON(), saved[field]);
    const missing = { ...saved };
    delete missing[field];
    assert.throws(() => engine.rehydrateStepResult(stepId, missing), Error, `mandatory saved ${field}`);
    assert.throws(() => engine.rehydrateStepResult(stepId, { ...saved, [field]: { ...saved[field], payload: {} } }), Error, `undeclared ${field} payload`);
  }

  if (stepId === "approval") {
    assert.ok(operandFields.length > 0, "approval requires saved source/approval evidence");
    assert.ok(restored.evidence instanceof engine.ApprovalResultEvidence,
      "approval Result and common Error require the canonical source Attempt evidence");
  }

  if (TEST_LEAVES.has(stepId)) {
    for (const [field, name] of [
      ["binding", "RequirementTestResultBinding"],
      ["frontier", "RequirementTestResultFrontier"],
      ["retryState", "RequirementTestRetryState"],
    ]) {
      assert.equal(typeof engine[name], "function", `unmet 02 operand contract: ${name}`);
      assert.ok(restored[field] instanceof engine[name], `${stepId} mandatory ${field}`);
    }
    assert.equal(restored.binding.toJSON().leaf, stepId);
    if (/-(?:candidate-saved|structural-rejected)$/.test(saved.kind)) {
      assert.ok(operandFields.some((field) => restored[field] instanceof RequirementTestCandidateBundle), "candidate adoption/rejection requires its canonical manifest");
    }
    if (saved.kind === "test-repair-progress-saved") {
      assert.equal(typeof engine.RequirementTestRepairProgressIdentity, "function", "unmet 02 dedicated repair progress identity");
      assert.ok(operandFields.some((field) => restored[field] instanceof engine.RequirementTestRepairProgressIdentity), "repair Result requires batch/finding/receipt/staged digest/coordinator identity");
    }
    assertRequirementTestEvidenceProjection(stepId, saved, expectedEvidence);
    for (const mutation of [{ leaf: "spec" }, { specId: "other-spec" }]) {
      assert.throws(() => engine.rehydrateStepResult(stepId, { ...saved, binding: { ...saved.binding, ...mutation } }), Error);
    }
    if (saved.candidateBundle !== undefined) {
      for (const mutate of [
        (value) => { value.binding.requirementId = "another-R"; },
        (value) => { value.binding.specRevision.digest = "f".repeat(64); },
        (value) => { value.candidateBundle.digest = "f".repeat(64); },
      ]) {
        const malformed = json(saved);
        mutate(malformed);
        assert.throws(() => engine.rehydrateStepResult(stepId, malformed), Error);
      }
    }
  }
  if (saved.kind.endsWith("external-blocked")) {
    assert.ok(restored.error instanceof Error);
    assert.notEqual(restored.error.constructor, Error, "external-blocked requires its dedicated Error classification");
  }

  for (const malformed of [
    { ...saved, kind: "unknown-result-kind" },
    { ...saved, type: saved.type === "completed" ? "loop-required" : "completed" },
    ...[...FORBIDDEN_ROOT, ...FORBIDDEN_EVIDENCE].map((field) => ({ ...saved, [field]: {} })),
  ]) assert.throws(() => engine.rehydrateStepResult(stepId, malformed), TypeError);
  assert.throws(() => engine.rehydrateStepResult("spec", saved), TypeError);

  assert.equal(typeof definition.settleRequirementTestStepResult, "function", "unmet 02 saved Result Settlement API");
  const selected = definition.settleRequirementTestStepResult(stepId, restored);
  assert.ok(selected instanceof definition.StepSettlement);
  assertRequirementTestSettlementProjection(stepId, saved, selected, expectedSettlement);
  assert.deepEqual(selected.toJSON(), definition.settleRequirementTestStepResult(stepId, again).toJSON());
  assert.equal(selected.constructor, definition.settleRequirementTestStepResult(stepId, again).constructor);
  assert.equal(Object.hasOwn(selected, "facts"), false, "saved binding replaces Decision.facts");
  if (selected.kind === "target-connection") {
    assert.ok(selected instanceof definition.StepRoute);
    assert.ok(selected.connector.prototype instanceof StepConnector);
  } else {
    assert.ok(["execution", "await", "failure"].includes(selected.kind));
    assert.equal("connector" in selected, false, `${selected.kind} cannot own a fake Connector`);
  }
  assert.equal(engine.stepResultDigest(restored), engine.stepResultDigest(again), "Definition cannot mutate saved evidence");
  return Object.freeze({ result: restored, settlement: selected });
}
