import assert from "node:assert/strict";
import test from "node:test";

// The existing engine is always importable. Future API absence is reported as
// an explicit AssertionError, not an unresolved-module/named-import failure.
import * as engine from "../../src/flow/engine/step-result.js";
import * as definition from "../../src/flow/definition.js";
import {
  RequirementTestBudget,
  RequirementTestBundleLineage,
  RequirementTestBundleRevision,
  RequirementTestPlanPublication,
  RequirementTestSemanticFinding,
  RequirementTestSourceAttempt,
  RequirementTestWorkItem,
} from "../../src/flow/lib/requirement-test-lifecycle.js";
import {
  RequirementTestCandidateBundle,
  RequirementTestCandidateSource,
} from "../../src/flow/lib/requirement-test-artifacts.js";
import { SpecRevisionIdentity } from "../../src/flow/lib/spec-revision-identity.js";

// 8e30 section 3 is authoritative. This is a frozen test expectation, never
// an alternate production registry. Task Result codecs belong to phase 03.
const GENERATION_CONTRACTS = Object.freeze([
  Object.freeze({ name: "TestGenerateCandidateSavedResult", stepId: "test-generate", kind: "test-generate-candidate-saved", type: "completed" }),
  Object.freeze({ name: "TestGenerateStructuralRejectedResult", stepId: "test-generate", kind: "test-generate-structural-rejected", type: "branch-required" }),
]);

export function requiredExport(name) {
  assert.equal(typeof engine[name], "function", `unmet 02 typed Result contract: engine must export ${name}`);
  return engine[name];
}

export function revision() {
  return new SpecRevisionIdentity({ specId: "result-contract", revision: 2, digest: "a".repeat(64), byteLength: 512 });
}

export function candidate({ requirementId = "R1", sequence = 2, bytes = Buffer.from("// spec: R1\n") } = {}) {
  const source = RequirementTestCandidateSource.fromBytes({ testPath: `tests/${requirementId.toLowerCase()}.test.js`, bytes });
  const lineage = new RequirementTestBundleLineage({
    requirementId, specRevision: revision(), bundleRevision: 1, predecessorRevision: null,
    sourceAttempt: new RequirementTestSourceAttempt({ id: "attempt-generate", sequence }),
    sourceFindingFingerprints: [],
  });
  return new RequirementTestCandidateBundle({
    bundle: new RequirementTestBundleRevision({ requirementId, specRevision: revision(), revision: 1, paths: [source.testPath], lineage }),
    sources: [source],
  });
}

export function pending(requirementId) {
  return RequirementTestWorkItem.pending({ requirementId, specRevision: revision(), expectation: "fail" });
}

export function operands({ candidateBundle = candidate(), pendingIds = ["R2", "R3"], budget = new RequirementTestBudget({ autoSemantic: 1, manualSemantic: 2, tooling: 3 }), autoApprove = true, findings = [new RequirementTestSemanticFinding({ requirementId: "R1", bundleRevision: 1, fingerprint: "b".repeat(64) })] } = {}) {
  const Binding = requiredExport("RequirementTestResultBinding");
  const Frontier = requiredExport("RequirementTestResultFrontier");
  const RetryState = requiredExport("RequirementTestRetryState");
  return {
    binding: new Binding({
      runId: "run-result-contract", specId: "result-contract", leaf: "test-generate",
      attempt: candidateBundle.bundle.lineage.sourceAttempt,
      planPublication: new RequirementTestPlanPublication({ logicalKey: "test.requirement.plan", relativePath: "steps/test-generate/plan.json", hash: "c".repeat(64), size: 256, activityId: "activity-plan" }),
      requirementId: candidateBundle.bundle.requirementId, specRevision: revision(), status: "in_progress", candidate: candidateBundle.bundle.lineage,
    }),
    frontier: new Frontier({ staged: [], pending: pendingIds.map(pending) }),
    retryState: new RetryState({ budget, autoApprove, findings }),
    candidateBundle,
  };
}

export function makeResult(contract, values) {
  const ResultClass = requiredExport(contract.name);
  return new ResultClass(values);
}

export function assertRoundtrip(contract, result, values) {
  const ResultClass = requiredExport(contract.name);
  assert.ok(result instanceof engine.StepResult);
  assert.equal(result.constructor, ResultClass);
  assert.equal(result.stepId, contract.stepId);
  assert.equal(result.kind, contract.kind);
  assert.equal(result.type, contract.type);
  const expected = { kind: contract.kind, type: contract.type, ...Object.fromEntries(Object.entries(values).map(([field, value]) => [field, value.toJSON()])) };
  assert.deepEqual(result.toJSON(), expected, "each declared field must serialize through its dedicated value codec");
  const stored = JSON.parse(JSON.stringify(result));
  const restored = engine.rehydrateStepResult(contract.stepId, stored);
  assert.equal(restored.constructor, ResultClass);
  assert.equal(restored.stepId, contract.stepId);
  assert.deepEqual(restored.toJSON(), expected);
  for (const [field, value] of Object.entries(values)) {
    assert.equal(restored[field].constructor, value.constructor, `typed ${field} class identity`);
    assert.notEqual(restored[field], value, `${field} reconstructed from JSON`);
    assert.ok(Object.isFrozen(restored[field]), `immutable ${field}`);
  }
  assert.ok(restored.candidateBundle.bundle instanceof RequirementTestBundleRevision);
  assert.ok(restored.candidateBundle.bundle.lineage instanceof RequirementTestBundleLineage);
  assert.ok(restored.candidateBundle.bundle.lineage.sourceAttempt instanceof RequirementTestSourceAttempt);
  assert.ok(restored.candidateBundle.bundle.specRevision instanceof SpecRevisionIdentity);
  assert.deepEqual(restored.candidateBundle.toJSON(), values.candidateBundle.toJSON());
  assert.equal(engine.stepResultDigest(restored), engine.stepResultDigest(result));
  return stored;
}

test("generation seed uses existing canonical candidate classes and stores manifest metadata without bytes", () => {
  const value = candidate();
  const stored = JSON.parse(JSON.stringify(value));
  const restored = RequirementTestCandidateBundle.fromJSON(stored);
  assert.equal(restored.bundle.requirementId, "R1");
  assert.equal(restored.bundle.revision, 1);
  assert.equal(restored.bundle.lineage.sourceAttempt.id, "attempt-generate");
  assert.deepEqual(restored.toJSON(), value.toJSON());
  assert.deepEqual(Object.keys(stored.sources[0]).sort(), ["byteLength", "digest", "testPath"]);
});

test("02 operands project only source binding, remaining R identities/statuses and existing retry values", () => {
  const values = operands();
  const source = values.candidateBundle;
  assert.deepEqual(values.binding.toJSON(), {
    runId: "run-result-contract", specId: "result-contract", leaf: "test-generate",
    attempt: source.bundle.lineage.sourceAttempt.toJSON(),
    planPublication: { logicalKey: "test.requirement.plan", relativePath: "steps/test-generate/plan.json", hash: "c".repeat(64), size: 256, activityId: "activity-plan" },
    requirementId: "R1", specRevision: revision().toJSON(), status: "in_progress", candidate: source.bundle.lineage.toJSON(),
  });
  assert.deepEqual(values.frontier.toJSON(), {
    staged: [],
    pending: ["R2", "R3"].map((requirementId) => ({ requirementId, specRevision: revision().toJSON(), status: "pending" })),
  });
  const staged = new RequirementTestWorkItem({
    requirementId: "R0", specRevision: revision(), expectation: "fail", status: "candidate_saved",
    bundleRevision: candidate({ requirementId: "R0" }).bundle,
  });
  const Frontier = requiredExport("RequirementTestResultFrontier");
  const remaining = new Frontier({ staged: [staged], pending: [pending("R2")] });
  const expectedRemaining = {
    staged: [{ requirementId: "R0", specRevision: revision().toJSON(), status: "candidate_saved" }],
    pending: [{ requirementId: "R2", specRevision: revision().toJSON(), status: "pending" }],
  };
  assert.deepEqual(remaining.toJSON(), expectedRemaining);
  assert.deepEqual(Frontier.fromJSON(JSON.parse(JSON.stringify(remaining))).toJSON(), expectedRemaining);
  assert.deepEqual(values.retryState.toJSON(), {
    budget: { autoSemantic: 1, manualSemantic: 2, tooling: 3 }, autoApprove: true,
    findings: [{ requirementId: "R1", bundleRevision: 1, fingerprint: "b".repeat(64) }],
  });
  for (const value of [values.binding, values.frontier, values.retryState]) {
    const restored = value.constructor.fromJSON(JSON.parse(JSON.stringify(value)));
    assert.equal(restored.constructor, value.constructor);
    assert.deepEqual(restored.toJSON(), value.toJSON());
  }
});

for (const name of ["RequirementTestResultBinding", "RequirementTestResultFrontier", "RequirementTestRetryState"]) {
  test(`02 dedicated operand export: ${name}`, () => {
    const ValueClass = requiredExport(name);
    assert.equal(typeof ValueClass.prototype.toJSON, "function", `${name} serialization contract`);
    assert.equal(typeof ValueClass.fromJSON, "function", `${name} typed readback contract`);
  });
}

for (const contract of GENERATION_CONTRACTS) {
  test(`${contract.name}: single registry fixes concrete class, kind, type and leaf`, () => {
    const ResultClass = requiredExport(contract.name);
    const entries = engine.STEP_RESULT_REGISTRY.filter((entry) => entry.kind === contract.kind);
    assert.equal(entries.length, 1, `unmet 02 registry kind: ${contract.kind}`);
    assert.equal(entries[0].ResultClass, ResultClass);
    assert.equal(entries[0].stepId, contract.stepId);
    assert.equal(entries[0].type, contract.type);
  });

  test(`${contract.name}: roundtrip retains next R frontier, adopted lineage and retry state`, () => {
    requiredExport(contract.name);
    const values = operands();
    assertRoundtrip(contract, makeResult(contract, values), values);
  });

  test(`${contract.name}: constructor refuses missing, untyped and undeclared operands`, () => {
    const ResultClass = requiredExport(contract.name);
    const values = operands();
    assert.throws(() => new ResultClass(), TypeError);
    for (const [field, value] of Object.entries(values)) {
      const missing = { ...values };
      delete missing[field];
      assert.throws(() => new ResultClass(missing), TypeError, `missing ${field}`);
      assert.throws(() => new ResultClass({ ...values, [field]: value.toJSON() }), TypeError, `untyped ${field}`);
    }
    assert.throws(() => new ResultClass({ ...values, payload: {} }), TypeError);
    assertRoundtrip(contract, new ResultClass(values), values);
  });

  test(`${contract.name}: readback refuses identity, schema and forbidden payload tampering`, () => {
    requiredExport(contract.name);
    const values = operands();
    const result = makeResult(contract, values);
    const stored = assertRoundtrip(contract, result, values);
    for (const malformed of [
      { ...stored, kind: "unknown-result" },
      { ...stored, type: contract.type === "completed" ? "loop-required" : "completed" },
      ...["class", "stepId", "schemaRevision", "payload", "rawFacts", "flowState", "ctx", "manager", "target", "connector", "effect", "displayText"].map((field) => ({ ...stored, [field]: {} })),
    ]) assert.throws(() => engine.rehydrateStepResult(contract.stepId, malformed), TypeError);
    assert.throws(() => engine.rehydrateStepResult("spec", stored), TypeError);
    for (const field of Object.keys(values)) {
      const missing = { ...stored };
      delete missing[field];
      assert.throws(() => engine.rehydrateStepResult(contract.stepId, missing), TypeError, `missing saved ${field}`);
      assert.throws(() => engine.rehydrateStepResult(contract.stepId, { ...stored, [field]: null }), Error, `null saved ${field}`);
      assert.throws(() => engine.rehydrateStepResult(contract.stepId, { ...stored, [field]: { ...stored[field], payload: {} } }), Error, `extra ${field} property`);
    }
    assertRoundtrip(contract, result, values);
  });
}

test("02 binding refuses another R, Spec, leaf, Attempt or candidate publication identity", () => {
  const contract = GENERATION_CONTRACTS[0];
  const ResultClass = requiredExport(contract.name);
  const values = operands();
  const stored = makeResult(contract, values).toJSON();
  for (const binding of [
    { ...stored.binding, requirementId: "R2" },
    { ...stored.binding, specId: "another-spec" },
    { ...stored.binding, leaf: "test-review" },
    { ...stored.binding, attempt: { ...stored.binding.attempt, sequence: 3 } },
    { ...stored.binding, specRevision: { ...stored.binding.specRevision, digest: "d".repeat(64) } },
    { ...stored.binding, candidate: { ...stored.binding.candidate, sourceAttempt: { id: "another-attempt", sequence: 2 } } },
  ]) assert.throws(() => engine.rehydrateStepResult(contract.stepId, { ...stored, binding }), Error);
  assert.throws(() => new ResultClass({ ...values, candidateBundle: candidate({ requirementId: "R2" }) }), TypeError);
  assert.throws(() => engine.rehydrateStepResult(contract.stepId, { ...stored, candidateBundle: candidate({ requirementId: "R2" }).toJSON() }), Error);
  assertRoundtrip(contract, makeResult(contract, values), values);
});

test("02 digest includes R frontier order, candidate lineage/bytes, auto mode and each retry counter", () => {
  const contract = GENERATION_CONTRACTS[0];
  requiredExport(contract.name);
  const originalValues = operands();
  const original = makeResult(contract, originalValues);
  const variants = [
    operands({ pendingIds: ["R3", "R2"] }),
    operands({ candidateBundle: candidate({ sequence: 3 }) }),
    operands({ candidateBundle: candidate({ bytes: Buffer.from("// spec: R1\n// changed bytes\n") }) }),
    operands({ autoApprove: false }),
    operands({ findings: [new RequirementTestSemanticFinding({ requirementId: "R1", bundleRevision: 1, fingerprint: "d".repeat(64) })] }),
    ...["autoSemantic", "manualSemantic", "tooling"].map((counter) => operands({ budget: new RequirementTestBudget({ autoSemantic: 1, manualSemantic: 2, tooling: 3 }).increment(counter) })),
  ];
  for (const values of variants) {
    const changed = makeResult(contract, values);
    assert.notEqual(engine.stepResultDigest(changed), engine.stepResultDigest(original));
    assertRoundtrip(contract, changed, values);
  }
});

test("02 Definition selects the same final-candidate Settlement from saved Result alone", () => {
  assert.equal(typeof definition.settleRequirementTestStepResult, "function", "unmet 02 Definition contract: settleRequirementTestStepResult(stepId, result)");
  const contract = GENERATION_CONTRACTS[0];
  requiredExport(contract.name);
  const values = operands({ pendingIds: [] });
  const original = makeResult(contract, values);
  const restored = engine.rehydrateStepResult(contract.stepId, JSON.parse(JSON.stringify(original)));
  const expected = definition.settleRequirementTestStepResult(contract.stepId, original);
  const selected = definition.settleRequirementTestStepResult(contract.stepId, restored);
  assert.equal(selected.kind, "target-connection");
  assert.equal(selected.targetStepId, "test-review");
  assert.deepEqual(selected.toJSON(), expected.toJSON());
});

// Existing complete Result/Error matrices stay in flow-engine-step-result,
// spec-step-result and spec-gate-step-result. This checks the extension cannot
// replace their original codec with a generic payload escape hatch.
test("existing ordinary/Error codecs retain kind/type and code/data while refusing generic payload", () => {
  const ordinary = new engine.SpecCreatedResult();
  const error = new engine.StepErrorResult("spec", Object.assign(new Error("failed"), { code: "TEST_FAILURE", data: { count: 2 } }));
  for (const result of [ordinary, error]) {
    const stored = JSON.parse(JSON.stringify(result));
    assert.throws(() => engine.rehydrateStepResult("spec", { ...stored, payload: { nextRequirement: "R2" } }), TypeError);
    assert.deepEqual(engine.rehydrateStepResult("spec", stored).toJSON(), stored);
  }
  assert.deepEqual(ordinary.toJSON(), { kind: "spec-created", type: "completed" });
  const restored = engine.rehydrateStepResult("spec", error.toJSON());
  assert.equal(restored.error.code, "TEST_FAILURE");
  assert.deepEqual(restored.error.data, { count: 2 });
});
