import assert from "node:assert/strict";
import { test } from "node:test";
import { SpecGateRepairContext, SpecGateRepairSelection } from "../../src/flow/lib/spec-gate-repair-context.js";
import { SpecGateRepairBundle } from "../../src/flow/lib/spec-gate-repair-bundle.js";
import { SpecGateRepairSource } from "../../src/flow/lib/spec-gate-repair-values.js";
import { workerArtifactStableStringify, MAX_WORKER_ARTIFACT_INPUT_BYTES } from "../../src/flow/lib/worker-artifact-input-format.js";

const revision = `sha256:${"a".repeat(64)}`;
const rule = { id: "planned", body: "Specify a planned check. Exceptions require a canonical exception clause." };
const rationale = "The prior acknowledgment preserves the requirement to state planned checks.";
function context({ count = 2, content = "Full read-only source. 漢🧭\"\n", findings = null, spec = null } = {}) {
  const requirements = Array.from({ length: count }, (_, index) => ({
    id: `R${index}`, desc: `Complete planned check ${index}`, task_ids: [], testable: false,
  }));
  return new SpecGateRepairContext({ spec: spec ?? {
    goal: "Bounded repair", background: "Shared background",
    requirements, tasks: [], overview: { decisions: [{ text: "Shared canonical decision" }] },
  }, baseRevision: revision, sources: [new SpecGateRepairSource({
    id: "request", origin: "approved-request.md", revision: "request-revision", content,
  })], guardrails: [rule], acknowledgedRationale: rationale,
  findings: findings ?? requirements.map((requirement, index) => ({
    identity: { sourceArtifact: "gate/result.json", sourceStep: "spec-gate", sourceFindingId: `F${index}`,
      fingerprint: String(index).padStart(64, "0") },
    requirementRef: rule.id, observed: `Complete finding reason ${index}`, specRevision: revision,
    targets: [{ entity: "requirement", id: requirement.id, field: "desc" }],
    allowedTargets: [{ target: { entity: "requirement", id: requirement.id, field: "desc" }, operationKinds: ["edit-text-field"] }],
  })) });
}
function selections(ctx) { return ctx.units().map((unit) => ctx.select(unit.id)); }
function document() { return structuredClone(SpecGateRepairBundle.fromSelections(selections(context())).toJSON()); }
function rewrite(selection, changes) {
  return new SpecGateRepairSelection({ ...selection.toJSON(), unit: selection.unit, ...changes });
}

test("bundle stores full common evidence once and restores exact complete typed unit selections", () => {
  const ctx = context({ count: 6, content: "COMMON_FULL_SOURCE:" + "a".repeat(602722) });
  const selected = selections(ctx);
  const bundle = SpecGateRepairBundle.fromSelections(selected);
  const wire = workerArtifactStableStringify(bundle.toJSON());
  assert.equal(wire.split("COMMON_FULL_SOURCE:").length - 1, 1);
  assert.equal(wire.split(rule.body).length - 1, 1);
  assert.equal(wire.split(rationale).length - 1, 1);
  assert.equal(bundle.toJSON().sources.length, 1);
  const restored = SpecGateRepairBundle.fromJSON(JSON.parse(wire));
  assert.deepEqual(restored.selections(), selected.map((selection) => selection.toJSON()));
  for (const selection of selected) {
    const readback = restored.select(selection.unit.id);
    assert(readback instanceof SpecGateRepairSelection);
    assert.deepEqual(readback.toJSON(), selection.toJSON());
    assert.deepEqual(readback.ranges.find((range) => range.id === "evidence:request"),
      selection.ranges.find((range) => range.id === "evidence:request"));
  }
  const plan = ctx.referencePlan();
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.batches[0].payloadElements.length, 6);
  assert(Buffer.byteLength(workerArtifactStableStringify(ctx.referenceDocument(plan.batches[0])), "utf8") <= MAX_WORKER_ARTIFACT_INPUT_BYTES);
});

test("bundle shared tables and digest are stable under unit order and JSON object property order", () => {
  const selected = selections(context());
  const first = SpecGateRepairBundle.fromSelections(selected);
  const reversed = SpecGateRepairBundle.fromSelections([...selected].reverse());
  assert.equal(first.digest, reversed.digest);
  assert.equal(first.byteLength, reversed.byteLength);
  const wire = first.toJSON();
  const readback = SpecGateRepairBundle.fromJSON({ units: wire.units, rationales: wire.rationales,
    guardrails: wire.guardrails, sources: wire.sources, ranges: [...wire.ranges].reverse(),
    baseRevision: wire.baseRevision, version: wire.version });
  assert.equal(readback.digest, first.digest);
  assert.equal(readback.byteLength, Buffer.byteLength(workerArtifactStableStringify(wire), "utf8"));
});

test("bundle preserves structured canonical acknowledged rationale across immutable JSON readback", () => {
  const structuredRationale = { markdown: "## Prior acknowledgment\nFull rationale 漢🧭", warning: null };
  const selected = selections(context()).map((selection) => rewrite(selection, { acknowledgedRationale: structuredRationale }));
  const bundle = SpecGateRepairBundle.fromSelections(selected);
  const restored = SpecGateRepairBundle.fromJSON(JSON.parse(workerArtifactStableStringify(bundle.toJSON())));
  assert.deepEqual(restored.selections(), selected.map((selection) => selection.toJSON()));
  assert.equal(restored.toJSON().rationales.length, 1);
  assert.deepEqual(restored.toJSON().rationales[0].value, structuredRationale);
});

test("shared range conflicts and source origin conflicts fail before serialization", () => {
  const selected = selections(context());
  const conflictingRange = selected[1].ranges.map((range) => range.id === "overview.decisions[0]"
    ? { ...range, value: { text: "Conflicting canonical decision" } } : range);
  assert.throws(() => SpecGateRepairBundle.fromSelections([selected[0], rewrite(selected[1], { ranges: conflictingRange })]),
    /Conflicting repair bundle range identity/);
  const conflictingSource = selected[1].ranges.map((range) => range.id === "evidence:request"
    ? { ...range, value: { ...range.value, origin: "foreign-request.md" } } : range);
  assert.throws(() => SpecGateRepairBundle.fromSelections([selected[0], rewrite(selected[1], { ranges: conflictingSource })]),
    /Conflicting repair bundle source identity/);
  assert.throws(() => SpecGateRepairBundle.fromSelections([selected[0], rewrite(selected[1], {
    guardrails: [{ ...rule, body: "Conflicting rule body" }],
  })]), /Conflicting repair bundle guardrail identity/);
});

test("readback rejects missing, foreign, duplicated and unused shared references", () => {
  const cases = [
    ["missing range", (value) => { value.ranges.pop(); }],
    ["foreign range", (value) => { value.units[0].ranges[0].id = "foreign-range"; }],
    ["duplicate range", (value) => { value.units[0].ranges.push(value.units[0].ranges[0]); }],
    ["foreign source", (value) => { value.ranges.find((range) => range.sourceId).sourceId = "evidence:foreign"; }],
    ["missing rule", (value) => { value.units[0].guardrailIds = []; }],
    ["foreign rule", (value) => { value.units[0].guardrailIds = ["foreign-rule"]; }],
    ["foreign rationale", (value) => { value.units[0].rationaleId = "rationale:foreign"; }],
    ["unused rule", (value) => { value.guardrails.push({ id: "unused", body: "Full unused rule" }); }],
    ["duplicate table identity", (value) => { value.ranges.push(value.ranges[0]); }],
    ["duplicate unit", (value) => { value.units.push(value.units[0]); }],
  ];
  for (const [label, change] of cases) {
    const value = document(); change(value);
    assert.throws(() => SpecGateRepairBundle.fromJSON(value), Error, label);
  }
});

test("shared context never grants writable authority to another unit or an evidence source", () => {
  const ctx = context();
  const selected = selections(ctx);
  const additionalRanges = Object.fromEntries(selected.map((selection) => [selection.unit.id,
    selected.find((other) => other.unit.id !== selection.unit.id).unit.rangeIds]));
  const bundle = SpecGateRepairBundle.fromJSON(ctx.referenceDocument(ctx.referencePlan({ additionalRanges }).batches[0]).bundle);
  for (const selection of bundle.selections()) {
    assert.deepEqual(selection.ranges.filter((range) => range.writable).map((range) => range.id), selection.unit.rangeIds);
    assert.deepEqual(selection.unit.findings[0].allowedTargets, selected.find((original) => original.unit.id === selection.unit.id).unit.findings[0].allowedTargets);
  }
  const leaked = structuredClone(bundle.toJSON());
  const otherTarget = leaked.units[0].ranges.find((range) => !range.writable && leaked.ranges.find((shared) => shared.id === range.id)?.target);
  otherTarget.writable = true;
  assert.throws(() => SpecGateRepairBundle.fromJSON(leaked), /permission leakage/);
  const writableSource = document();
  writableSource.units[0].ranges.find((range) => range.id === "evidence:request").writable = true;
  assert.throws(() => SpecGateRepairBundle.fromJSON(writableSource), /permission leakage/);
  const sharedAuthority = document();
  sharedAuthority.ranges[0].writable = true;
  assert.throws(() => SpecGateRepairBundle.fromJSON(sharedAuthority), /Invalid repair bundle range/);
  const invalidOperation = document();
  invalidOperation.units[0].unit.findings[0].allowedTargets[0].operationKinds = ["foreign-operation"];
  assert.throws(() => SpecGateRepairBundle.fromJSON(invalidOperation), /invalid kind/);
});

test("readback rejects changed source digests, unit identities and stale finding revisions", () => {
  const source = document(); source.sources[0].content += "changed";
  assert.throws(() => SpecGateRepairBundle.fromJSON(source), /source digest/);
  const identity = document(); identity.units[0].unit.findings[0].identity.sourceArtifact = "foreign/result.json";
  assert.throws(() => SpecGateRepairBundle.fromJSON(identity), /unit identity/);
  const stale = document(); stale.units[0].unit.findings[0].specRevision = `sha256:${"b".repeat(64)}`;
  assert.throws(() => SpecGateRepairBundle.fromJSON(stale), /Stale/);
  const range = document(); range.ranges.find((entry) => entry.sourceId).digest = "f".repeat(64);
  assert.throws(() => SpecGateRepairBundle.fromJSON(range), /source range/);
});

test("full distinct UTF-8 unit union splits only when its file limit is exceeded", () => {
  const spec = { requirements: [
    { id: "R0", desc: "漢🧭\"\n".repeat(130000), task_ids: [], testable: false },
    { id: "R1", desc: "🧭漢\n\"".repeat(130000), task_ids: [], testable: false },
  ], tasks: [], overview: { decisions: [] } };
  const ctx = context({ spec });
  const union = SpecGateRepairBundle.fromSelections(selections(ctx));
  assert(union.byteLength > MAX_WORKER_ARTIFACT_INPUT_BYTES);
  const plan = ctx.referencePlan();
  assert.equal(plan.batches.length, 2);
  const restored = plan.batches.flatMap((batch) => {
    const value = ctx.referenceDocument(batch);
    assert(Buffer.byteLength(workerArtifactStableStringify(value), "utf8") <= MAX_WORKER_ARTIFACT_INPUT_BYTES);
    return SpecGateRepairBundle.fromJSON(value.bundle).selections();
  });
  assert.deepEqual(restored, selections(ctx).map((selection) => selection.toJSON()));
});
