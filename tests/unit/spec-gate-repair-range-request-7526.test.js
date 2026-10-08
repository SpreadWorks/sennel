import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { SpecGateRepairSource, SpecGateRepairSourceRange } from "../../src/flow/lib/spec-gate-repair-values.js";
import { SpecGateRepairContextRequest } from "../../src/flow/lib/spec-gate-repair-context-expansion.js";
import { SpecGateRepairSelectedInputIdentity } from "../../src/flow/lib/spec-gate-repair-input-unavailable.js";
import { RangedTextPromptElement } from "../../src/lib/prompt-batching.js";
import { SpecGateRepairContext } from "../../src/flow/lib/spec-gate-repair-context.js";
import { workerArtifactStableStringify } from "../../src/flow/lib/worker-artifact-input-format.js";

const revision = `sha256:${"a".repeat(64)}`;
const value = { version: 1, stage: "spec-gate-repair-context-request", baseRevision: revision,
  unitId: "selected", additionalRangeIds: ["goal"] };
const identity = (changes = {}) => new SpecGateRepairSelectedInputIdentity({
  binding: { runId: "run", specId: "spec", stepId: "spec-gate-repair", attemptId: "attempt", attemptSequence: 1,
    inputDigest: "input", inputRevision: "revision", requestDigest: "request" },
  baseRevision: revision, selectionDigest: "c".repeat(64), mode: "repair", unitIds: ["selected"],
  findingIdentities: [{ sourceArtifact: "gate", sourceStep: "spec-gate", sourceFindingId: "F1", fingerprint: "b".repeat(64) }], ...changes,
});

test("overlapping available source windows leave the exact uncovered bytes", () => {
  const source = new SpecGateRepairSource({ id: "source:owner", origin: "owner", revision: "capture", content: "0123456789" });
  const element = new RangedTextPromptElement({ id: source.id, sourceRevision: source.revision, sequence: 0, text: source.content });
  const range = (start, end) => new SpecGateRepairSourceRange({ source, element: element.createRange({ start, end }) }).value;
  assert.equal(SpecGateRepairSourceRange.uncoveredBytes(range(0, 10), [range(0, 6), range(3, 8)]), 2);
});

test("same-format canonical requests bind selected unit and revision without source discovery authority", () => {
  const request = new SpecGateRepairContextRequest(value);
  assert.deepEqual(request.toJSON(), value);
  assert.equal(request.assertSelectedIdentity(identity()), request);
  for (const changes of [{ unitIds: ["other"] }, { baseRevision: `sha256:${"f".repeat(64)}` },
    { mode: "locate", unitIds: [] }]) {
    assert.throws(() => request.assertSelectedIdentity(identity(changes)), /selected input unit or revision/);
  }
  for (const field of ["sourceOrigins", "sourceQueries"]) {
    assert.throws(() => new SpecGateRepairContextRequest({ ...value, [field]: ["owner"] }), (error) =>
      error.code === "FLOW_SPEC_GATE_REPAIR_CONTEXT_UNAVAILABLE" && error.data.failureKind === "step-admission");
    assert.throws(() => new SpecGateRepairContextRequest({ ...value, [field]: [] }), /exact canonical/);
  }
  for (const disposition of [{ groups: [] }, { locations: [] }, { operations: [] }, { reason: "unavailable" }]) {
    assert.throws(() => new SpecGateRepairContextRequest({ ...value, ...disposition }), /exact canonical/);
  }
  const inspect = new SpecGateRepairContextRequest({ ...value, intent: "inspect" });
  assert.deepEqual(SpecGateRepairContextRequest.fromJSON(JSON.parse(JSON.stringify(inspect))).toJSON(), { ...value, intent: "inspect" });
  assert.equal(inspect.assertSelectedIdentity(identity({ mode: "inspect" })), inspect);
  for (const intent of ["repair", "unknown"]) {
    assert.throws(() => new SpecGateRepairContextRequest({ ...value, intent }), /exact canonical/);
  }
});

test("only a bound readonly selection may enter repair once without new range progress", () => {
  const target = { entity: "requirement", id: "R1", field: "desc" };
  const context = new SpecGateRepairContext({ baseRevision: revision,
    spec: { goal: "Context", requirements: [{ id: "R1", desc: "Selected target", task_ids: [] }], tasks: [] },
    findings: [{ identity: identity().findingIdentities[0].toJSON(), requirementRef: "rule", observed: "Complete target",
      targets: [target], allowedTargets: [{ target, operationKinds: ["edit-text-field"] }] }],
    guardrails: [{ id: "rule", body: "Preserve complete target" }] });
  const unit = context.units()[0];
  const request = new SpecGateRepairContextRequest({ ...value, unitId: unit.id });
  const first = request.expand(context);
  const document = context.continuationDocument({ unitId: unit.id, requestedRangeIds: ["goal"],
    additionalRangeIds: first.additionalRangeIds, intent: "inspect" });
  const saved = JSON.parse(workerArtifactStableStringify(document));
  const digest = createHash("sha256").update(workerArtifactStableStringify(saved)).digest("hex");
  const inspected = SpecGateRepairSelectedInputIdentity.selectionFromDocument(saved, digest);
  assert.deepEqual(inspected.unitIds, [unit.id]);
  assert.deepEqual(inspected.findingIdentities.map((finding) => finding.toJSON()), unit.findings.map((finding) => finding.identity.toJSON()));
  for (const change of [{ mode: "navigate" }, { baseRevision: `sha256:${"d".repeat(64)}` }, { unitId: "foreign-unit" }]) {
    assert.throws(() => SpecGateRepairSelectedInputIdentity.selectionFromDocument({ ...saved, ...change }, digest), /exact selected mode, unit or revision/);
  }
  const transition = request.expand(context, first.additionalRangeIds, { selectedIdentity: inspected });
  assert.equal(transition.sourceByteProgress, 0);
  assert.deepEqual(transition.indexPageProgress, []);
  assert.deepEqual(transition.additionalRangeIds, first.additionalRangeIds);
  assert.deepEqual(transition.selection.toJSON(), first.selection.toJSON());
  for (const selectedIdentity of [null, identity({ unitIds: [unit.id] })]) {
    assert.throws(() => request.expand(context, first.additionalRangeIds, { selectedIdentity }), /no progress/);
  }
  assert.throws(() => new SpecGateRepairContextRequest({ ...request.toJSON(), intent: "inspect" })
    .expand(context, first.additionalRangeIds, { selectedIdentity: inspected }), /no progress/);
  assert.throws(() => request.expand(context, first.additionalRangeIds, {
    selectedIdentity: identity({ mode: "inspect", unitIds: ["foreign"] }),
  }), /selected input unit or revision/);
  const pageRequest = new SpecGateRepairContextRequest({ ...request.toJSON(), additionalRangeIds: [context.indexManifest().firstPageId] });
  assert.throws(() => pageRequest.expand(context, [], {
    selectedIdentity: identity({ mode: "navigate", unitIds: [unit.id] }),
  }), /no progress/);
});
