import assert from "node:assert/strict";
import { test } from "node:test";
import { SpecGateRepairContext } from "../../src/flow/lib/spec-gate-repair-context.js";
import { SpecGateRepairBundle } from "../../src/flow/lib/spec-gate-repair-bundle.js";
import { specGateRepairValueDigest } from "../../src/flow/lib/spec-gate-repair-selection.js";
import { workerArtifactStableStringify } from "../../src/flow/lib/worker-artifact-input-format.js";

function fixture() {
  const target = { entity: "requirement", id: "R1", field: "desc" };
  const context = new SpecGateRepairContext({ baseRevision: `sha256:${"a".repeat(64)}`,
    spec: { goal: "Preserve the selected canonical target", requirements: Array.from({ length: 60 }, (_, index) => ({
      id: `R${index + 1}`, desc: "Plan a measurable check", task_ids: [], testable: false })), tasks: [] },
    findings: [{ identity: { sourceArtifact: "gate.json", sourceStep: "spec-gate", sourceFindingId: "finding", fingerprint: "b".repeat(64) },
      requirementRef: "checks", observed: "State the planned result", targets: [target],
      allowedTargets: [{ target, operationKinds: ["edit-text-field"] }] }],
    guardrails: [{ id: "checks", body: "Preserve complete canonical criteria" }] });
  return { context, selection: context.select(context.units()[0].id) };
}

test("a recomputed page digest cannot replace descriptors committed by the canonical index", () => {
  const { selection } = fixture();
  const document = structuredClone(SpecGateRepairBundle.fromSelections([selection]).toJSON());
  const page = document.ranges.find((range) => range.id === selection.indexManifest.firstPageId);
  page.value.descriptors[1].digest = "f".repeat(64);
  page.digest = specGateRepairValueDigest(workerArtifactStableStringify(page.value));
  assert.throws(() => SpecGateRepairBundle.fromJSON(document), /repair index page digest/);
});

test("page descriptors must retain their canonical order even after their own digest is recomputed", () => {
  const { selection } = fixture();
  const document = structuredClone(SpecGateRepairBundle.fromSelections([selection]).toJSON());
  const page = document.ranges.find((range) => range.id === selection.indexManifest.firstPageId);
  [page.value.descriptors[1], page.value.descriptors[2]] = [page.value.descriptors[2], page.value.descriptors[1]];
  page.digest = specGateRepairValueDigest(workerArtifactStableStringify(page.value));
  assert.throws(() => SpecGateRepairBundle.fromJSON(document), /route bounds/);
});
