import { readSpecJsonValidator } from "../../../src/lib/spec-json.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";

import { validWorkerHandoffTaskSpec } from "../../support/infrastructure/worker-artifact.js";
import {
  applySpecGateRepairOperations,
  applySpecRepairOperations,
  SpecGateRepairAuthority,
  SpecRepairArrayTarget,
  SpecRepairIdEntityTarget,
  specRepairTargetEntries,
} from "../../../src/flow/lib/spec-repair-operations.js";
import { specRepairIncidentR6Description } from "./fixtures/spec-repair-r6-description.js";

const INPUT_DIGEST = "b".repeat(64);
const IDENTITY = { specId: "001-repair", revision: 1, digest: INPUT_DIGEST, byteLength: 1 };
const valueDigest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const requirementTarget = { entity: "requirement", id: "R1", field: "desc" };
const rootTarget = { entity: "spec", field: "background" };

function sourceSpec() { return validWorkerHandoffTaskSpec(); }
function permission(target, operationKinds) { return { target, operationKinds }; }
function triage(findings) { return { findings }; }
function applyFinding(findingId, allowedTargets) {
  return { findingId, disposition: "apply", allowedTargets };
}
function repair(operations, scopeExpansions = []) {
  return {
    version: 2,
    stage: "spec-repair",
    identity: IDENTITY,
    baseReviewDigest: "c".repeat(64),
    findings: [],
    operations,
    ...(scopeExpansions.length === 0 ? {} : { scopeExpansions }),
  };
}
function replace(findingIds, target, replacement, expectedDigest) {
  return {
    findingIds,
    kind: target.entity === "spec" ? "replace-field" : "replace-entity-field",
    target,
    expectedDigest,
    replacement,
    reason: "A bounded correction authorised by triage.",
  };
}
function textEdit(findingIds, target, edits, expectedDigest) {
  return {
    findingIds,
    kind: "edit-text-field",
    target,
    expectedDigest,
    edits,
    reason: "A local UTF-8 correction authorised by triage.",
  };
}
function byteOffset(text, fragment) {
  const offset = Buffer.from(text, "utf8").indexOf(Buffer.from(fragment, "utf8"));
  assert.notEqual(offset, -1, `missing fixture fragment: ${fragment}`);
  return offset;
}
function apply(spec, findings, operations, scopeExpansions = []) {
  return applySpecRepairOperations({ validator: readSpecJsonValidator(),
    spec,
    triage: triage(findings),
    repair: repair(operations, scopeExpansions),
    inputRevision: INPUT_DIGEST,
  });
}

describe("revision-scoped spec repair operations", () => {
  it("partially adopts valid operations while auditing malformed and unauthorized proposals", () => {
    const spec = sourceSpec();
    const original = spec.requirements[0].desc;
    const result = apply(spec, [applyFinding("F-valid", [permission(requirementTarget, ["replace-entity-field"])])], [
      { findingIds: ["F-valid"], kind: "unknown-kind", target: requirementTarget, expectedDigest: null, replacement: "ignored", reason: "Malformed." },
      replace(["F-unknown"], requirementTarget, "unauthorised", valueDigest(original)),
      replace(["F-valid"], requirementTarget, "Corrected description.", valueDigest(original)),
    ]);
    assert.equal(result.spec.requirements[0].desc, "Corrected description.");
    assert.deepEqual(result.audit.appliedFindings, ["F-valid"]);
    assert.deepEqual(result.audit.discardedOperations.map((entry) => entry.reason).sort(), ["spec-repair.operations[0] kind is invalid", "unauthorized operation"].sort());
  });

  it("requires every finding in a multi-finding operation to permit its target and kind", () => {
    const spec = sourceSpec();
    const original = spec.requirements[0].desc;
    const operation = replace(["F-one", "F-two"], requirementTarget, "Joint correction.", valueDigest(original));
    const permitted = [
      applyFinding("F-one", [permission(requirementTarget, ["replace-entity-field"])]),
      applyFinding("F-two", [permission(requirementTarget, ["replace-entity-field"])]),
    ];
    const accepted = apply(spec, permitted, [operation]);
    assert.equal(accepted.spec.requirements[0].desc, "Joint correction.");
    assert.deepEqual(accepted.audit.appliedFindings, ["F-one", "F-two"]);

    const rejected = apply(sourceSpec(), [
      permitted[0],
      applyFinding("F-two", [permission(rootTarget, ["replace-field"])]),
    ], [operation]);
    assert.equal(rejected.spec.requirements[0].desc, original);
    assert.equal(rejected.audit.discardedOperations[0].reason, "unauthorized operation");
  });

  it("deduplicates identical operations and discards only conflicting targets", () => {
    const spec = sourceSpec();
    const description = spec.requirements[0].desc;
    const background = spec.background;
    const same = replace(["F-description"], requirementTarget, "One correction.", valueDigest(description));
    const result = apply(spec, [
      applyFinding("F-description", [permission(requirementTarget, ["replace-entity-field"])]),
      applyFinding("F-background", [permission(rootTarget, ["replace-field"])]),
    ], [
      same,
      structuredClone(same),
      replace(["F-description"], requirementTarget, "Competing correction.", valueDigest(description)),
      replace(["F-background"], rootTarget, "Independent correction.", valueDigest(background)),
    ]);
    assert.equal(result.spec.requirements[0].desc, description);
    assert.equal(result.spec.background, "Independent correction.");
    assert.deepEqual(result.audit.appliedFindings, ["F-background"]);
    assert.ok(!result.audit.discardedOperations.some((entry) => entry.reason === "duplicate operation"));
    assert.equal(result.audit.discardedOperations.filter((entry) => entry.reason === "conflicting operation").length, 2);
  });

  it("treats partial, empty, and scope-only repair deltas as successful no-ops", () => {
    const spec = sourceSpec();
    const partial = apply(spec, [applyFinding("F", [permission(requirementTarget, ["replace-entity-field"])])], [
      replace(["F"], requirementTarget, "stale", "0".repeat(64)),
    ]);
    assert.deepEqual(partial.spec, spec);
    assert.equal(partial.audit.discardedOperations[0].reason, "stale target digest");

    const empty = apply(spec, [], []);
    assert.deepEqual(empty.spec, spec);
    assert.deepEqual(empty.audit.appliedFindings, []);
    assert.deepEqual(empty.audit.audit, {});
    assert.equal(Object.hasOwn(empty.audit.audit, "missingRequiredTargets"), false);

    const scoped = apply(spec, [], [], [{ requestedScope: "needs a separate product decision" }]);
    assert.deepEqual(scoped.spec, spec);
    assert.deepEqual(scoped.audit.scopeExpansions.map((entry) => entry.proposal), [{ requestedScope: "needs a separate product decision" }]);
  });

  it("discards only an oversized scope proposal while applying an independent valid operation", () => {
    const spec = sourceSpec();
    const original = spec.requirements[0].desc;
    const result = apply(
      spec,
      [applyFinding("F-valid", [permission(requirementTarget, ["replace-entity-field"])])],
      [replace(["F-valid"], requirementTarget, "The valid sibling survives.", valueDigest(original))],
      [{ requestedScope: "x".repeat(33 * 1024) }],
    );
    assert.equal(result.spec.requirements[0].desc, "The valid sibling survives.");
    assert.deepEqual(result.audit.appliedFindings, ["F-valid"]);
    assert.ok(result.audit.discardedOperations.some((entry) => /scope expansion 0 is oversized/.test(entry.reason)));
    assert.deepEqual(result.audit.scopeExpansions, []);
  });

  it("fails closed for a stale immutable revision before mutating the candidate", () => {
    const spec = sourceSpec();
    assert.throws(() => applySpecRepairOperations({ validator: readSpecJsonValidator(),
      spec,
      triage: triage([]),
      repair: { ...repair([]), identity: { ...IDENTITY, digest: "d".repeat(64) } },
      inputRevision: INPUT_DIGEST,
    }), (error) => error.code === "FLOW_SPEC_REPAIR_BASE_REVISION_MISMATCH");
    assert.deepEqual(spec, sourceSpec());
  });

  it("preserves array add, replacement, deletion, immutable-base positions, and expected digests", () => {
    const spec = sourceSpec();
    spec.constraints = ["remove", "same", "same"];
    const arrayTarget = { collection: "constraints" };
    const deleteFirst = {
      findingIds: ["F-array"], kind: "delete-array-element", target: { collection: "constraints", position: 0 },
      expectedDigest: valueDigest("remove"), reason: "Delete the exact immutable-base item.",
    };
    const replaceLast = {
      findingIds: ["F-array"], kind: "replace-array-element", target: { collection: "constraints", position: 2 },
      expectedDigest: valueDigest("same"), replacement: "last only", reason: "Replace the exact immutable-base duplicate.",
    };
    const append = {
      findingIds: ["F-array"], kind: "add-array-element", target: arrayTarget,
      expectedDigest: null, replacement: "new bounded constraint", reason: "Append an independently permitted value.",
    };
    const result = apply(spec, [applyFinding("F-array", [permission(arrayTarget, ["delete-array-element", "replace-array-element", "add-array-element"])])], [deleteFirst, replaceLast, append]);
    assert.deepEqual(result.spec.constraints, ["same", "last only", "new bounded constraint"]);
    const duplicateSpec = sourceSpec();
    duplicateSpec.constraints = ["same", "same"];
    const ambiguous = apply(duplicateSpec, [applyFinding("F-array", [permission(arrayTarget, ["delete-array-element"])])], [{ ...deleteFirst, target: arrayTarget, expectedDigest: valueDigest("same") }]);
    assert.equal(ambiguous.audit.discardedOperations[0].reason, "conflicting target resolution");
  });

  it("coalesces same-content edits across finding IDs only after every permission is proven", () => {
    const spec = sourceSpec();
    const original = spec.requirements[0].desc;
    const one = replace(["F-one"], requirementTarget, "One canonical correction.", valueDigest(original));
    const two = { ...replace(["F-two"], requirementTarget, "One canonical correction.", valueDigest(original)), reason: "Different worker prose." };
    const result = apply(spec, [
      applyFinding("F-one", [permission(requirementTarget, ["replace-entity-field"])]),
      applyFinding("F-two", [permission(requirementTarget, ["replace-entity-field"])]),
    ], [one, two]);
    assert.equal(result.spec.requirements[0].desc, "One canonical correction.");
    assert.deepEqual(result.audit.appliedFindings, ["F-one", "F-two"]);
    assert.equal(result.audit.acceptedOperations.length, 1);
  });

  it("replays immutable-base array lineage after an invalid operation rollback", () => {
    const spec = sourceSpec();
    spec.constraints = ["remove", "same", "same"];
    const arrayTarget = { collection: "constraints" };
    const operations = [
      { findingIds: ["F-array"], kind: "delete-array-element", target: { collection: "constraints", position: 0 }, expectedDigest: valueDigest("remove"), reason: "Delete first immutable-base value." },
      { findingIds: ["F-goal"], kind: "replace-field", target: { entity: "spec", field: "goal" }, expectedDigest: valueDigest(spec.goal), replacement: [], reason: "This proposal intentionally violates the Spec schema." },
      { findingIds: ["F-array"], kind: "replace-array-element", target: { collection: "constraints", position: 2 }, expectedDigest: valueDigest("same"), replacement: "last only", reason: "Address immutable-base duplicate position two." },
    ];
    const result = apply(spec, [
      applyFinding("F-array", [permission(arrayTarget, ["delete-array-element", "replace-array-element"])]),
      applyFinding("F-goal", [permission({ entity: "spec", field: "goal" }, ["replace-field"])]),
    ], operations);
    assert.deepEqual(result.spec.constraints, ["same", "last only"]);
    assert.ok(result.audit.discardedOperations.some((entry) => entry.reason === "operation produces an invalid Spec schema"));
  });

  it("reconstructs the incident R6 UTF-8 text from non-contiguous immutable-base edits without losing 65 inventory leaves", () => {
    const spec = sourceSpec();
    const original = specRepairIncidentR6Description;
    spec.requirements[0].desc = original;
    assert.equal(Buffer.byteLength(original, "utf8"), 9506);
    const inventory = original.match(/@src\/flow\/[^、。 ]+/g) ?? [];
    assert.equal(inventory.length, 65);
    const prefix = byteOffset(original, "R6 の全 probe");
    const suffix = byteOffset(original, "placeholder は表示専用");
    const result = apply(spec, [applyFinding("F-local", [permission(requirementTarget, ["edit-text-field"])])], [
      textEdit(["F-local"], requirementTarget, [
        { startByte: prefix, endByte: prefix + Buffer.byteLength("R6 の全 probe"), replacement: "R6 の対象 probe" },
        { startByte: suffix, endByte: suffix + Buffer.byteLength("placeholder は表示専用"), replacement: "placeholder literal は表示専用" },
      ], valueDigest(original)),
    ]);
    assert.equal(result.spec.requirements[0].desc, original.replace("R6 の全 probe", "R6 の対象 probe").replace("placeholder は表示専用", "placeholder literal は表示専用"));
    for (const leaf of inventory) assert.ok(result.spec.requirements[0].desc.includes(leaf), `lost inventory leaf ${leaf}`);
  });

  it("discards each invalid text edit while retaining an independent valid sibling", () => {
    const spec = sourceSpec();
    const original = "é local target";
    spec.requirements[0].desc = original;
    const local = byteOffset(original, "local");
    const invalidRange = textEdit(["F-text"], requirementTarget, [{ startByte: 0, endByte: Buffer.byteLength(original) + 1, replacement: "bad" }], valueDigest(original));
    const splitUtf8 = textEdit(["F-text"], requirementTarget, [{ startByte: 1, endByte: 2, replacement: "bad" }], valueDigest(original));
    const overlapping = textEdit(["F-text"], requirementTarget, [{ startByte: local, endByte: local + 3, replacement: "one" }, { startByte: local + 2, endByte: local + 5, replacement: "two" }], valueDigest(original));
    const ambiguousInsertions = textEdit(["F-text"], requirementTarget, [{ startByte: local, endByte: local, replacement: "one" }, { startByte: local, endByte: local, replacement: "two" }], valueDigest(original));
    const replacementIncluded = { ...textEdit(["F-text"], requirementTarget, [{ startByte: local, endByte: local + 5, replacement: "fixed" }], valueDigest(original)), replacement: "forbidden" };
    for (const [operation, expectedReason] of [
      [invalidRange, "invalid UTF-8 text edit target or range"],
      [splitUtf8, "invalid UTF-8 text edit target or range"],
      [overlapping, /overlapping or ambiguous/],
      [ambiguousInsertions, /overlapping or ambiguous/],
      [replacementIncluded, /invalid schema/],
    ]) {
      const result = apply(spec, [
        applyFinding("F-text", [permission(requirementTarget, ["edit-text-field"])]),
        applyFinding("F-background", [permission(rootTarget, ["replace-field"])]),
      ], [operation, replace(["F-background"], rootTarget, "Independent correction.", valueDigest(spec.background))]);
      assert.equal(result.spec.requirements[0].desc, original);
      assert.equal(result.spec.background, "Independent correction.");
      assert.ok(result.audit.discardedOperations.some((entry) => typeof expectedReason === "string" ? entry.reason === expectedReason : expectedReason.test(entry.reason)));
    }
    const large = sourceSpec();
    large.requirements[0].desc = "x".repeat((32 * 1024) - 3);
    const oversized = apply(large, [applyFinding("F-text", [permission(requirementTarget, ["edit-text-field"])])], [
      textEdit(["F-text"], requirementTarget, [{ startByte: 0, endByte: 0, replacement: "more" }], valueDigest(large.requirements[0].desc)),
    ]);
    assert.equal(oversized.spec.requirements[0].desc, large.requirements[0].desc);
    assert.equal(oversized.audit.discardedOperations[0].reason, "text edit result is oversized");
  });

  it("keeps whole-field and text-edit capabilities distinct and rejects their same-target conflict", () => {
    const spec = sourceSpec();
    const original = spec.requirements[0].desc;
    const result = apply(spec, [
      applyFinding("F-text", [permission(requirementTarget, ["edit-text-field"])]),
      applyFinding("F-whole", [permission(requirementTarget, ["replace-entity-field"])]),
      applyFinding("F-background", [permission(rootTarget, ["replace-field"])]),
    ], [
      textEdit(["F-text"], requirementTarget, [{ startByte: 0, endByte: 0, replacement: "Prefix. " }], valueDigest(original)),
      replace(["F-whole"], requirementTarget, "A competing whole replacement.", valueDigest(original)),
      replace(["F-background"], rootTarget, "Independent correction.", valueDigest(spec.background)),
    ]);
    assert.equal(result.spec.requirements[0].desc, original);
    assert.equal(result.spec.background, "Independent correction.");
    assert.equal(result.audit.discardedOperations.filter((entry) => entry.reason === "conflicting operation").length, 2);

    const unauthorized = apply(sourceSpec(), [applyFinding("F-whole", [permission(requirementTarget, ["replace-entity-field"])])], [
      textEdit(["F-whole"], requirementTarget, [{ startByte: 0, endByte: 0, replacement: "Prefix. " }], valueDigest(original)),
    ]);
    assert.equal(unauthorized.spec.requirements[0].desc, original);
    assert.equal(unauthorized.audit.discardedOperations[0].reason, "unauthorized operation");

    const localCannotReplace = apply(sourceSpec(), [applyFinding("F-text", [permission(requirementTarget, ["edit-text-field"])])], [
      replace(["F-text"], requirementTarget, "A forbidden whole replacement.", valueDigest(original)),
    ]);
    assert.equal(localCannotReplace.spec.requirements[0].desc, original);
    assert.equal(localCannotReplace.audit.discardedOperations[0].reason, "unauthorized operation");
  });

  it("requires canonical byte ordering and bounded edit payloads, while allowing adjacent immutable-base ranges", () => {
    const spec = sourceSpec();
    spec.background = "abcdef";
    const expected = valueDigest(spec.background);
    const adjacent = apply(spec, [applyFinding("F-root", [permission(rootTarget, ["edit-text-field"])])], [
      textEdit(["F-root"], rootTarget, [
        { startByte: 0, endByte: 3, replacement: "first" },
        { startByte: 3, endByte: 6, replacement: "second" },
      ], expected),
    ]);
    assert.equal(adjacent.spec.background, "firstsecond");

    const stale = apply(spec, [applyFinding("F-root", [permission(rootTarget, ["edit-text-field"])])], [
      textEdit(["F-root"], rootTarget, [{ startByte: 0, endByte: 0, replacement: "prefix " }], "0".repeat(64)),
    ]);
    assert.equal(stale.spec.background, "abcdef");
    assert.equal(stale.audit.discardedOperations[0].reason, "stale target digest");

    const unordered = textEdit(["F-root"], rootTarget, [
      { startByte: 3, endByte: 6, replacement: "second" },
      { startByte: 0, endByte: 3, replacement: "first" },
    ], expected);
    const tooMany = textEdit(["F-root"], rootTarget, Array.from({ length: 65 }, () => ({ startByte: 0, endByte: 0, replacement: "x" })), expected);
    const tooLarge = textEdit(["F-root"], rootTarget, [{ startByte: 0, endByte: 0, replacement: "x".repeat(32 * 1024) }], expected);
    for (const [operation, message] of [[unordered, /canonical stable byte order/], [tooMany, /at most 64 edits/], [tooLarge, /replacements are oversized/]]) {
      const rejected = apply(spec, [applyFinding("F-root", [permission(rootTarget, ["edit-text-field"])])], [operation]);
      assert.equal(rejected.spec.background, "abcdef");
      assert.ok(message.test(rejected.audit.discardedOperations[0].reason));
    }
  });

  it("rejects text-edit capability for a non-string entity field", () => {
    const spec = sourceSpec();
    const target = { entity: "requirement", id: "R1", field: "testable" };
    assert.throws(() => apply(spec, [
      applyFinding("F-non-text", [permission(target, ["edit-text-field"])]),
    ], [textEdit(
      ["F-non-text"],
      target,
      [{ startByte: 0, endByte: 0, replacement: "not text" }],
      valueDigest(spec.requirements[0].testable),
    )]), (error) => error.code === "FLOW_SPEC_REPAIR_TRIAGE_TARGETS_INVALID");
  });

  it("rejects replacement authority for an absent optional field while retaining an existing false value", () => {
    const spec = sourceSpec();
    const absent = { entity: "task", id: "T1", field: "acceptance" };
    assert.equal(Object.hasOwn(spec.tasks[0], "acceptance"), false);
    assert.throws(() => apply(spec, [
      applyFinding("F-absent", [permission(absent, ["replace-entity-field"])]),
    ], []), (error) => error.code === "FLOW_SPEC_REPAIR_TRIAGE_TARGETS_INVALID");
    assert.equal(Object.hasOwn(spec.tasks[0], "acceptance"), false);

    const existing = { entity: "requirement", id: "R1", field: "testable" };
    assert.equal(spec.requirements[0].testable, false);
    const accepted = apply(spec, [applyFinding("F-existing", [permission(existing, ["replace-entity-field"])])], [
      replace(["F-existing"], existing, false, valueDigest(false)),
    ]);
    assert.equal(accepted.spec.requirements[0].testable, false);
    assert.deepEqual(accepted.audit.appliedFindings, ["F-existing"]);
  });
});

const GATE_REVISION = `sha256:${INPUT_DIGEST}`;
const gateIdentity = (sourceFindingId, fingerprint = "1".repeat(64)) => ({
  sourceArtifact: "artifacts/spec-gate/result.json", sourceStep: "spec-gate", sourceFindingId, fingerprint,
});
function gateAuthority(spec, findings, expectedUnits = findings.map(([identity]) => ({ findingIdentities: [identity] }))) {
  return new SpecGateRepairAuthority({
    baseRevision: GATE_REVISION,
    findings: findings.map(([identity, allowedTargets]) => ({ identity, allowedTargets })),
    expectedUnits,
    spec,
  });
}
function gateOperation(operation) { const { findingIds, ...value } = operation; return value; }
function gateApply(spec, authority, groups, baseRevision = GATE_REVISION) {
  return applySpecGateRepairOperations({ validator: readSpecJsonValidator(),
    spec, authority, inputRevision: INPUT_DIGEST,
    repair: { version: 1, stage: "spec-gate-repair", baseRevision, groups },
  });
}

describe("Gate-authorized atomic Spec repair groups", () => {
  it("accepts a complete valid group after an intermediate schema violation and preserves unrelated UTF-8 bytes", () => {
    const spec = sourceSpec();
    spec.requirements[0].testable = true;
    spec.requirements[0].preimplementation_test_expectation = "fail";
    spec.background = "前文 untouched 後文";
    const testable = { entity: "requirement", id: "R1", field: "testable" };
    const expectation = { entity: "requirement", id: "R1", field: "preimplementation_test_expectation" };
    const identity = gateIdentity("conditional-fields");
    const authority = gateAuthority(spec, [[identity, [
      permission(testable, ["replace-entity-field"]),
      permission(expectation, ["delete-entity-field"]),
      permission(rootTarget, ["edit-text-field"]),
    ]]]);
    const start = Buffer.from(spec.background).indexOf(Buffer.from("untouched"));
    const operations = [
      gateOperation(replace(["unused"], testable, false, valueDigest(true))),
      { kind: "delete-entity-field", target: expectation, expectedDigest: valueDigest("fail"), reason: "Remove forbidden expectation." },
      gateOperation(textEdit(["unused"], rootTarget, [{ startByte: start, endByte: start + 9, replacement: "edited" }], valueDigest(spec.background))),
    ];
    const result = gateApply(spec, authority, [{ findingIdentities: [identity], operations }]);
    assert.equal(result.spec.requirements[0].testable, false);
    assert.equal(Object.hasOwn(result.spec.requirements[0], "preimplementation_test_expectation"), false);
    assert.deepEqual(Buffer.from(result.spec.background), Buffer.from("前文 edited 後文"));
    assert.equal(result.audit.acceptedGroups.length, 1);
    assert.deepEqual(result.audit.discardedGroups, []);
    assert.equal(spec.requirements[0].testable, true);
  });

  it("rejects an entire group when one operation is stale while adopting an independent group", () => {
    const spec = sourceSpec();
    const identity = gateIdentity("mixed");
    const independent = gateIdentity("independent", "2".repeat(64));
    const authority = gateAuthority(spec, [
      [identity, [permission(requirementTarget, ["replace-entity-field"]), permission(rootTarget, ["replace-field"])]],
      [independent, [permission({ entity: "spec", field: "goal" }, ["replace-field"])]],
    ]);
    const result = gateApply(spec, authority, [
      { findingIdentities: [identity], operations: [
        gateOperation(replace(["unused"], rootTarget, "Must roll back.", valueDigest(spec.background))),
        gateOperation(replace(["unused"], requirementTarget, "Stale.", "0".repeat(64))),
      ] },
      { findingIdentities: [independent], operations: [
        gateOperation(replace(["unused"], { entity: "spec", field: "goal" }, "Independent correction.", valueDigest(spec.goal))),
      ] },
    ]);
    assert.equal(result.spec.background, spec.background);
    assert.equal(result.spec.requirements[0].desc, spec.requirements[0].desc);
    assert.equal(result.spec.goal, "Independent correction.");
    assert.deepEqual(result.audit.discardedGroups.map((entry) => entry.reason), ["stale target digest"]);
    assert.equal(result.audit.acceptedGroups.length, 1);
  });

  it("binds authority to the full Gate finding identity and discards competing groups without a winner", () => {
    const spec = sourceSpec();
    const identity = gateIdentity("same-id", "3".repeat(64));
    const changedFingerprint = gateIdentity("same-id", "4".repeat(64));
    const second = gateIdentity("second", "5".repeat(64));
    const authority = gateAuthority(spec, [
      [identity, [permission(rootTarget, ["replace-field"])]],
      [second, [permission(rootTarget, ["replace-field"])]],
    ]);
    const result = gateApply(spec, authority, [
      { findingIdentities: [changedFingerprint], operations: [gateOperation(replace(["unused"], rootTarget, "Untrusted.", valueDigest(spec.background)))] },
      { findingIdentities: [identity], operations: [gateOperation(replace(["unused"], rootTarget, "First.", valueDigest(spec.background)))] },
      { findingIdentities: [second], operations: [gateOperation(replace(["unused"], rootTarget, "Second.", valueDigest(spec.background)))] },
    ]);
    assert.equal(result.spec.background, spec.background);
    assert.deepEqual(result.audit.discardedGroups.map((entry) => entry.reason), ["unauthorized operation", "conflicting operation", "conflicting operation"]);
    assert.deepEqual(result.audit.acceptedGroups, []);
  });

  it("keeps a multi-finding unit whole while each finding permits its own target", () => {
    const spec = sourceSpec();
    const requirement = gateIdentity("requirement-gap", "6".repeat(64));
    const background = gateIdentity("background-gap", "7".repeat(64));
    const interaction = gateIdentity("interaction", "8".repeat(64));
    const goalTarget = { entity: "spec", field: "goal" };
    const authority = gateAuthority(spec, [
      [requirement, [permission(requirementTarget, ["replace-entity-field"])]],
      [background, [permission(rootTarget, ["replace-field"])]],
      [interaction, [permission(goalTarget, ["replace-field"])]],
    ], [{ findingIdentities: [requirement, background, interaction] }]);
    const operations = [
      gateOperation(replace(["unused"], requirementTarget, "Updated requirement.", valueDigest(spec.requirements[0].desc))),
      gateOperation(replace(["unused"], rootTarget, "Updated background.", valueDigest(spec.background))),
      gateOperation(replace(["unused"], goalTarget, "Updated goal.", valueDigest(spec.goal))),
    ];
    const split = gateApply(spec, authority, [
      { findingIdentities: [requirement], operations: [operations[0]] },
      { findingIdentities: [background, interaction], operations: operations.slice(1) },
    ]);
    assert.deepEqual(split.spec, spec);
    assert.deepEqual(split.audit.discardedGroups.map((entry) => entry.reason), ["unauthorized operation", "unauthorized operation"]);
    const together = gateApply(spec, authority, [{ findingIdentities: [requirement, background, interaction], operations }]);
    assert.equal(together.spec.requirements[0].desc, "Updated requirement.");
    assert.equal(together.spec.background, "Updated background.");
    assert.equal(together.spec.goal, "Updated goal.");
    assert.equal(together.audit.acceptedGroups.length, 1);
  });

  it("rejects duplicate proposals for one canonical repair unit before applying either", () => {
    const spec = sourceSpec();
    const identity = gateIdentity("one-unit", "9".repeat(64));
    const authority = gateAuthority(spec, [[identity, [permission(rootTarget, ["replace-field"])]]]);
    const groups = ["First.", "Second."].map((replacement) => ({
      findingIdentities: [identity],
      operations: [gateOperation(replace(["unused"], rootTarget, replacement, valueDigest(spec.background)))],
    }));
    const result = gateApply(spec, authority, groups);
    assert.equal(result.spec.background, spec.background);
    assert.deepEqual(result.audit.discardedGroups.map((entry) => entry.reason), ["duplicate repair unit", "duplicate repair unit"]);
  });

  it("limits a Gate array permission to its declared immutable-base position", () => {
    const spec = sourceSpec();
    spec.constraints = ["first", "second"];
    const identity = gateIdentity("one-array-item", "a".repeat(64));
    const first = { collection: "constraints", position: 0 };
    const second = { collection: "constraints", position: 1 };
    const authority = gateAuthority(spec, [[identity, [permission(first, ["replace-array-element"])]]]);
    const outside = gateApply(spec, authority, [{ findingIdentities: [identity], operations: [{
      kind: "replace-array-element", target: second, expectedDigest: valueDigest("second"),
      replacement: "outside", reason: "Try a different item.",
    }] }]);
    assert.deepEqual(outside.spec.constraints, ["first", "second"]);
    assert.equal(outside.audit.discardedGroups[0].reason, "unauthorized operation");
    const alias = gateApply(spec, authority, [{ findingIdentities: [identity], operations: [{
      kind: "replace-array-element", target: { collection: "constraints" }, expectedDigest: valueDigest("first"),
      replacement: "alias", reason: "Try a digest-only address for the permitted item.",
    }] }]);
    assert.deepEqual(alias.spec, spec);
    assert.equal(alias.audit.discardedGroups[0].reason, "unauthorized operation");
    const inside = gateApply(spec, authority, [{ findingIdentities: [identity], operations: [{
      kind: "replace-array-element", target: first, expectedDigest: valueDigest("first"),
      replacement: "inside", reason: "Correct the named item.",
    }] }]);
    assert.deepEqual(inside.spec.constraints, ["inside", "second"]);
  });

  it("rejects aliases for one immutable-base array element as one atomic conflict and retains an unrelated group", () => {
    const spec = sourceSpec();
    spec.constraints = ["first", "second"];
    const conflicted = gateIdentity("array-conflict", "b".repeat(64));
    const independent = gateIdentity("independent-goal", "c".repeat(64));
    const collection = { collection: "constraints" };
    const authority = gateAuthority(spec, [
      [conflicted, [permission(collection, ["replace-array-element"])]],
      [independent, [permission({ entity: "spec", field: "goal" }, ["replace-field"])]],
    ]);
    const result = gateApply(spec, authority, [
      { findingIdentities: [conflicted], operations: [
        { kind: "replace-array-element", target: { ...collection, position: 0 }, expectedDigest: valueDigest("first"), replacement: "first edit", reason: "Address the first base element." },
        { kind: "replace-array-element", target: collection, expectedDigest: valueDigest("first"), replacement: "second edit", reason: "Address the same base element by digest." },
      ] },
      { findingIdentities: [independent], operations: [
        gateOperation(replace(["unused"], { entity: "spec", field: "goal" }, "Independent correction.", valueDigest(spec.goal))),
      ] },
    ]);
    assert.deepEqual(result.spec, { ...spec, goal: "Independent correction." });
    assert.deepEqual(result.audit.discardedGroups.map((entry) => entry.reason), ["conflicting operation"]);
    assert.deepEqual(result.audit.acceptedGroups.map((entry) => entry.index), [1]);
  });

  it("coalesces the same Gate array edit addressed by position and digest within one group", () => {
    const spec = sourceSpec();
    spec.constraints = ["first", "second"];
    const identity = gateIdentity("same-array-edit", "6".repeat(64));
    const collection = { collection: "constraints" };
    const authority = gateAuthority(spec, [[identity, [permission(collection, ["replace-array-element"])]]]);
    const edit = { kind: "replace-array-element", expectedDigest: valueDigest("first"), replacement: "shared", reason: "One correction with two addresses." };
    const result = gateApply(spec, authority, [{ findingIdentities: [identity], operations: [
      { ...edit, target: { ...collection, position: 0 } },
      { ...edit, target: collection },
    ] }]);
    assert.deepEqual(result.spec.constraints, ["shared", "second"]);
    assert.deepEqual(result.audit.acceptedGroups[0].operations.map((operation) => operation.target), [{ ...collection, position: 0 }, collection]);
    assert.deepEqual(result.audit.discardedGroups, []);
  });

  it("rejects cross-group delete and replace claims on the same base element through different array addresses", () => {
    const spec = sourceSpec();
    spec.constraints = ["first", "second"];
    const deletion = gateIdentity("delete-first", "d".repeat(64));
    const replacement = gateIdentity("replace-first", "e".repeat(64));
    const collection = { collection: "constraints" };
    const authority = gateAuthority(spec, [
      [deletion, [permission(collection, ["delete-array-element"])]],
      [replacement, [permission(collection, ["replace-array-element"])]],
    ]);
    const result = gateApply(spec, authority, [
      { findingIdentities: [deletion], operations: [
        { kind: "delete-array-element", target: { ...collection, position: 0 }, expectedDigest: valueDigest("first"), reason: "Delete the first base element." },
      ] },
      { findingIdentities: [replacement], operations: [
        { kind: "replace-array-element", target: collection, expectedDigest: valueDigest("first"), replacement: "replacement", reason: "Replace the same base element." },
      ] },
    ]);
    assert.deepEqual(result.spec.constraints, ["first", "second"]);
    assert.deepEqual(result.audit.discardedGroups.map((entry) => entry.reason), ["conflicting operation", "conflicting operation"]);
    assert.deepEqual(result.audit.acceptedGroups, []);
  });

  it("keeps distinct duplicate-valued base positions after deletion while rejecting ambiguous and stale digest claims", () => {
    const spec = sourceSpec();
    spec.constraints = ["same", "same", "third"];
    const valid = gateIdentity("distinct-positions", "f".repeat(64));
    const ambiguous = gateIdentity("ambiguous-digest", "2".repeat(64));
    const stale = gateIdentity("stale-digest", "3".repeat(64));
    const collection = { collection: "constraints" };
    const authority = gateAuthority(spec, [
      [valid, [permission(collection, ["delete-array-element", "replace-array-element"])]],
      [ambiguous, [permission(collection, ["replace-array-element"])]],
      [stale, [permission(collection, ["replace-array-element"])]],
    ]);
    const result = gateApply(spec, authority, [
      { findingIdentities: [valid], operations: [
        { kind: "delete-array-element", target: { ...collection, position: 0 }, expectedDigest: valueDigest("same"), reason: "Delete base position zero." },
        { kind: "replace-array-element", target: { ...collection, position: 1 }, expectedDigest: valueDigest("same"), replacement: "second only", reason: "Replace base position one." },
      ] },
      { findingIdentities: [ambiguous], operations: [
        { kind: "replace-array-element", target: collection, expectedDigest: valueDigest("same"), replacement: "ambiguous", reason: "Digest matches two base positions." },
      ] },
      { findingIdentities: [stale], operations: [
        { kind: "replace-array-element", target: { ...collection, position: 2 }, expectedDigest: valueDigest("wrong"), replacement: "stale", reason: "Digest does not match the base position." },
      ] },
    ]);
    assert.deepEqual(result.spec.constraints, ["second only", "third"]);
    assert.deepEqual(result.audit.acceptedGroups.map((entry) => entry.index), [0]);
    assert.deepEqual(result.audit.discardedGroups.map((entry) => entry.reason), ["conflicting target resolution", "stale target digest"]);
  });

  it("applies an identical common array deletion only once across independent Gate groups", () => {
    const spec = sourceSpec();
    spec.constraints = ["first", "second"];
    const first = gateIdentity("shared-one", "4".repeat(64));
    const second = gateIdentity("shared-two", "5".repeat(64));
    const collection = { collection: "constraints" };
    const authority = gateAuthority(spec, [
      [first, [permission(collection, ["delete-array-element"])]],
      [second, [permission(collection, ["delete-array-element"])]],
    ]);
    const operation = { kind: "delete-array-element", target: collection, expectedDigest: valueDigest("first"), reason: "Delete the shared base element." };
    const result = gateApply(spec, authority, [
      { findingIdentities: [first], operations: [{ ...operation, target: { ...collection, position: 0 } }] },
      { findingIdentities: [second], operations: [structuredClone(operation)] },
    ]);
    assert.deepEqual(result.spec.constraints, ["second"]);
    assert.deepEqual(result.audit.acceptedGroups.map((entry) => entry.index), [0, 1]);
    assert.deepEqual(result.audit.acceptedGroups.map((entry) => entry.operations[0].target), [{ ...collection, position: 0 }, collection]);
    assert.deepEqual(result.audit.discardedGroups, []);
  });

  it("requires matching base revisions, typed permissions, and supports an empty no-change proposal", () => {
    const spec = sourceSpec();
    const identity = gateIdentity("one");
    const authority = gateAuthority(spec, [[identity, [permission(rootTarget, ["replace-field"])]]]);
    assert.throws(() => gateApply(spec, authority, [], `sha256:${"0".repeat(64)}`),
      (error) => error.code === "FLOW_SPEC_REPAIR_BASE_REVISION_MISMATCH");
    assert.throws(() => gateAuthority(spec, [[identity, [permission({ entity: "spec", field: "unknown" }, ["replace-field"])]]]),
      /replaceable spec field/);
    const noChange = gateApply(spec, authority, []);
    assert.deepEqual(noChange.spec, spec);
    assert.deepEqual(noChange.audit.acceptedGroups, []);
    assert.deepEqual(noChange.audit.discardedGroups, []);
  });

  it("allows a group to add an absent optional field only with explicit Gate permission", () => {
    const spec = sourceSpec();
    const identity = gateIdentity("add-field");
    const testable = { entity: "requirement", id: "R1", field: "testable" };
    const expectation = { entity: "requirement", id: "R1", field: "preimplementation_test_expectation" };
    const authority = gateAuthority(spec, [[identity, [
      permission(testable, ["replace-entity-field"]), permission(expectation, ["add-entity-field"]),
    ]]]);
    const result = gateApply(spec, authority, [{ findingIdentities: [identity], operations: [
      { kind: "add-entity-field", target: expectation, expectedDigest: null, replacement: "fail", reason: "Add the required expectation." },
      gateOperation(replace(["unused"], testable, true, valueDigest(false))),
    ] }]);
    assert.equal(result.spec.requirements[0].testable, true);
    assert.equal(result.spec.requirements[0].preimplementation_test_expectation, "fail");
    assert.equal(result.audit.acceptedGroups.length, 1);
  });

  it("rejects absent-field replacement and deletion before Gate repair while applying an explicit add", () => {
    const spec = sourceSpec();
    const identity = gateIdentity("task-acceptance");
    const target = { entity: "task", id: "T1", field: "acceptance" };
    for (const kind of ["replace-entity-field", "delete-entity-field"]) {
      assert.throws(() => gateAuthority(spec, [[identity, [permission(target, [kind])]]]), /impossible targets/);
    }
    const authority = gateAuthority(spec, [[identity, [permission(target, ["add-entity-field"])]]]);
    const result = gateApply(spec, authority, [{ findingIdentities: [identity], operations: [
      { kind: "add-entity-field", target, expectedDigest: null, replacement: ["Verify the CLI output."],
        reason: "Add the missing acceptance criterion." },
    ] }]);
    assert.deepEqual(result.spec.tasks[0].acceptance, ["Verify the CLI output."]);
    assert.equal(Object.hasOwn(spec.tasks[0], "acceptance"), false);
    assert.equal(result.audit.acceptedGroups.length, 1);
    assert.deepEqual(result.audit.discardedGroups, []);
  });

  it("enumerates typed edit targets, including absent optional fields and array add anchors", () => {
    const spec = sourceSpec();
    const entries = specRepairTargetEntries(spec);
    const absent = entries.find((entry) => entry.target instanceof SpecRepairIdEntityTarget
      && entry.target.id === "R1" && entry.target.field === "preimplementation_test_expectation");
    assert.equal(absent.exists, false);
    assert.equal(absent.digest, null);
    const collection = entries.find((entry) => entry.target instanceof SpecRepairArrayTarget
      && entry.target.collection === "constraints" && entry.target.position === null);
    assert.equal(collection.exists, true);
    assert.equal(collection.value, null);
    assert.equal(collection.digest, null);
    assert.ok(entries.some((entry) => entry.target instanceof SpecRepairIdEntityTarget
      && entry.target.field === "desc" && entry.digest === valueDigest(spec.requirements[0].desc)));
  });
});
