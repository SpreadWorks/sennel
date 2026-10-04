import assert from "node:assert/strict";
import { test } from "node:test";
import { SpecGateRepairContext } from "../../src/flow/lib/spec-gate-repair-context.js";
import { SpecGateRepairContextExpansion } from "../../src/flow/lib/spec-gate-repair-context-expansion.js";

const revision = `sha256:${"a".repeat(64)}`;
const rule = { id: "checks", title: "Checks", body: "Plan a measurable passing condition. Exception: documented non-testable behavior is exempt." };
function fixture() {
  const target = { entity: "requirement", id: "R1", field: "desc" };
  const context = new SpecGateRepairContext({ baseRevision: revision,
    spec: { goal: "Plan a change", requirements: [{ id: "R1", desc: "Small check", task_ids: ["T1"], testable: true }],
      tasks: [{ id: "T1", goal: "Implement the planned check" }], overview: { decisions: [] } },
    findings: [{ identity: { sourceArtifact: "gate.json", sourceStep: "spec-gate", sourceFindingId: "F1", fingerprint: "b".repeat(64) },
      requirementRef: rule.id, observed: "State the passing condition", targets: [target],
      allowedTargets: [{ target, operationKinds: ["edit-text-field"] }] }], guardrails: [rule] });
  return { context, unitId: context.units()[0].id };
}
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
});


test("registered UTF-8 source coverage and paged index reads make distinct durable progress", async () => {
  const { SpecGateRepairSource } = await import("../../src/flow/lib/spec-gate-repair-values.js");
  const source = new SpecGateRepairSource({ id: "source:src/large.js", origin: "src/large.js", revision: "r1",
    content: "漢🧭 line\r\n".repeat(18000) });
  const context = new SpecGateRepairContext({ spec: { requirements: Array.from({ length: 8 }, (_, index) => ({ id: `R${index + 1}`, desc: "target", task_ids: [], testable: false })), tasks: [] },
    baseRevision: revision, findings: [{ identity: { sourceArtifact: "gate.json", sourceStep: "spec-gate", sourceFindingId: "F1", fingerprint: "a".repeat(64) },
      requirementRef: "rule", observed: "planned check missing", targets: [{ entity: "requirement", id: "R1", field: "desc" }],
      allowedTargets: [{ target: { entity: "requirement", id: "R1", field: "desc" }, operationKinds: ["edit-text-field"] }] }],
    sources: [source], guardrails: [{ id: "rule", body: "Full canonical rule" }] });
  const unitId = context.units()[0].id;
  const fullId = `${source.id}@bytes:0:${source.byteLength}:${source.digest}`;
  const fragments = context.tableOfContents().filter((range) => range.id.startsWith(`${source.id}@bytes:`) && range.id !== fullId);
  assert(fragments.length > 1);
  const bytes = Buffer.from(source.content, "utf8");
  let previousRangeIds = [];
  for (const descriptor of fragments.sort((a, b) => a.byteStart - b.byteStart)) {
    const expansion = new SpecGateRepairContextExpansion({ context, unitId, baseRevision: revision,
      requestedRangeIds: [descriptor.id], previousRangeIds });
    const range = expansion.selection.ranges.find((range) => range.id === descriptor.id);
    assert.equal(range.value.content, bytes.subarray(descriptor.byteStart, descriptor.byteEnd).toString("utf8"));
    assert.equal(range.value.snapshotDigest, source.digest);
    assert.equal(expansion.sourceByteProgress, descriptor.byteEnd - descriptor.byteStart);
    assert.equal(expansion.indexPageProgress.length, 0);
    previousRangeIds = [...expansion.additionalRangeIds];
  }
  assert.throws(() => new SpecGateRepairContextExpansion({ context, unitId, baseRevision: revision,
    requestedRangeIds: [fullId], previousRangeIds }), /no progress/);
  const full = new SpecGateRepairContextExpansion({ context, unitId, baseRevision: revision,
    requestedRangeIds: [fullId] });
  assert.equal(full.sourceByteProgress, source.byteLength);
  assert.equal(full.selection.ranges.filter((range) => range.value?.snapshotId === source.id).length, 1);
  assert.throws(() => new SpecGateRepairContextExpansion({ context, unitId, baseRevision: revision,
    requestedRangeIds: [fragments[0].id], previousRangeIds: [fullId] }), /no progress/);
  assert.throws(() => context.select(unitId, { additionalRangeIds: [fragments[0].id.replace(source.digest, "b".repeat(64))] }), /foreign/);
  const manifest = context.indexManifest();
  assert(manifest.pageCount > 1);
  const pages = [];
  let pageId = manifest.firstPageId;
  while (pageId) {
    const selected = context.select(unitId, { additionalRangeIds: [pageId] });
    const page = selected.ranges.find((range) => range.id === pageId).value;
    pages.push(page);
    if (pageId !== manifest.firstPageId) {
      const expansion = new SpecGateRepairContextExpansion({ context, unitId, baseRevision: revision, requestedRangeIds: [pageId] });
      assert.equal(expansion.sourceByteProgress, 0);
      assert.deepEqual(expansion.indexPageProgress, [pageId]);
      assert.throws(() => new SpecGateRepairContextExpansion({ context, unitId, baseRevision: revision,
        requestedRangeIds: [pageId], previousRangeIds: [pageId] }), /no progress/);
    }
    pageId = page.nextPageId;
  }
  assert.equal(pages.length, manifest.pageCount);
  assert.equal(pages.flatMap((page) => page.descriptors).length, manifest.descriptorCount);
  assert.throws(() => context.select(unitId, { additionalRangeIds: [`repair-index:${manifest.revision}:${manifest.pageCount}`] }), /foreign/);
});
