import assert from "node:assert/strict";
import { test } from "node:test";
import { SpecGateRepairContext } from "../../src/flow/lib/spec-gate-repair-context.js";
import { SpecGateRepairSource } from "../../src/flow/lib/spec-gate-repair-values.js";
import { SpecGateRepairNavigationSelection } from "../../src/flow/lib/spec-gate-repair-selection.js";
import { SpecGateRepairBundle } from "../../src/flow/lib/spec-gate-repair-bundle.js";
import { workerArtifactStableStringify } from "../../src/flow/lib/worker-artifact-input-format.js";

function fixture() {
  const owner = new SpecGateRepairSource({ id: "source:src/owner.js", origin: "src/owner.js", revision: "capture", content: "漢🧭 captured immutable evidence\n" });
  const issue = new SpecGateRepairSource({ id: "issue", origin: "issue.md", revision: "issue", content: "Complete canonical user intent" });
  const context = new SpecGateRepairContext({ baseRevision: `sha256:${"a".repeat(64)}`,
    spec: { goal: "Plan the check", requirements: Array.from({ length: 40 }, (_, index) => ({ id: `R${index + 1}`, desc: "Planned result", task_ids: [], testable: false })), tasks: [] },
    sources: [owner, issue], guardrails: [{ id: "checks", body: "Complete criterion and exception clause" }],
    acknowledgedRationale: { reason: "Preserve the confirmed decision" },
    findings: ["R1", "R2"].map((id, index) => ({
      identity: { sourceArtifact: "gate.json", sourceStep: "spec-gate", sourceFindingId: "same-id", fingerprint: String(index + 1).repeat(64) },
      requirementRef: "checks", observed: "Specify a measurable planned result", specRevision: `sha256:${"a".repeat(64)}`,
      targets: [{ entity: "requirement", id, field: "desc" }],
      allowedTargets: [{ target: { entity: "requirement", id, field: "desc" }, operationKinds: ["edit-text-field"] }] })) });
  const unit = context.units().find((entry) => entry.findings[0].targets[0].id === "R1");
  const pageId = context.indexManifest().pageRoutes[1].id;
  return { context, owner, issue, unit, pageId };
}

test("navigation readback retains exact findings, target values and visited pages without source bodies or writes", () => {
  const { context, owner, issue, unit, pageId } = fixture();
  const additionalRangeIds = [pageId, "goal"];
  const document = context.continuationDocument({ unitId: unit.id, requestedRangeIds: [pageId], additionalRangeIds });
  const restored = SpecGateRepairNavigationSelection.fromJSON(JSON.parse(workerArtifactStableStringify(document.navigation)));
  assert.equal(document.mode, "navigate");
  assert.deepEqual(restored.unit.toJSON(), unit.toJSON());
  assert(restored.ranges.every((range) => range.toJSON().writable === false));
  assert.equal(restored.ranges.find((range) => range.id === "requirements[R1].desc").value, "Planned result");
  assert.deepEqual(restored.pageRangeIds().sort(), [context.indexManifest().firstPageId, pageId].sort());
  assert(restored.readRangeIds.includes(issue.id));
  assert(!workerArtifactStableStringify(document).includes(owner.content));
  assert(!workerArtifactStableStringify(document).includes(issue.content));
  assert.deepEqual(context.restoreContinuation(JSON.parse(workerArtifactStableStringify(document)), { additionalRangeIds }), document);
});

test("inspection selects immutable bytes read-only and repair return restores full evidence and all remaining units", () => {
  const { context, owner, issue, unit, pageId } = fixture();
  const sourceId = context.tableOfContents().find((entry) => entry.source?.id === owner.id).id;
  const additionalRangeIds = [pageId, sourceId];
  const document = context.continuationDocument({ unitId: unit.id, requestedRangeIds: [sourceId], additionalRangeIds, intent: "inspect" });
  assert.equal(document.mode, "inspect");
  const restored = SpecGateRepairNavigationSelection.fromJSON(JSON.parse(workerArtifactStableStringify(document.navigation)));
  const range = restored.ranges.find((entry) => entry.id === sourceId);
  assert.equal(range.value.content, owner.content);
  assert.equal(range.value.byteEnd, owner.byteLength);
  assert.equal(range.value.snapshotDigest, owner.digest);
  assert.equal(range.toJSON().writable, false);
  assert(!workerArtifactStableStringify(document).includes(issue.content));
  assert.deepEqual(context.restoreContinuation(document, { additionalRangeIds }), document);
  assert.equal(context.continuationDocument({ unitId: unit.id, requestedRangeIds: [sourceId], additionalRangeIds }), null);
  const selections = context.referencePlan({ additionalRanges: { [unit.id]: additionalRangeIds } }).batches
    .flatMap((batch) => SpecGateRepairBundle.fromJSON(context.referenceDocument(batch).bundle).selections());
  assert.deepEqual(selections.map((entry) => entry.unit.id).sort(), context.units().map((entry) => entry.id).sort());
  const complete = selections.find((entry) => entry.unit.id === unit.id);
  assert(complete.ranges.some((entry) => entry.value?.content === issue.content));
  assert(complete.ranges.some((entry) => entry.id === "requirements[R1].desc" && entry.writable));
  assert(!complete.ranges.some((entry) => entry.id === "requirements[R2].desc" && entry.writable));
  assert.deepEqual(complete.unit.findings[0].allowedTargets, unit.findings[0].allowedTargets);
});

test("saved read-only inquiries refuse source, page, revision, target and permission tampering", () => {
  const { context, unit, pageId } = fixture();
  const additionalRangeIds = [pageId, "goal"];
  const document = context.continuationDocument({ unitId: unit.id, requestedRangeIds: [pageId], additionalRangeIds });
  const writable = structuredClone(document.navigation); writable.ranges[0].writable = true;
  assert.throws(() => SpecGateRepairNavigationSelection.fromJSON(writable), /mutation authority/);
  const foreign = structuredClone(document.navigation); foreign.ranges.find((range) => range.id === pageId).id = "repair-index:foreign:0";
  assert.throws(() => SpecGateRepairNavigationSelection.fromJSON(foreign), /Foreign/);
  const stale = structuredClone(document.navigation); stale.unit.findings[0].specRevision = `sha256:${"f".repeat(64)}`;
  assert.throws(() => SpecGateRepairNavigationSelection.fromJSON(stale), /Stale/);
  for (const mutate of [
    (value) => { value.navigation.ranges.find((range) => range.id === "goal").value = "tampered"; },
    (value) => { value.navigation.unit.findings[0].allowedTargets[0].operationKinds.push("replace-entity-field"); },
    (value) => { value.batchDigest = "f".repeat(64); },
  ]) {
    const changed = structuredClone(document); mutate(changed);
    assert.throws(() => context.restoreContinuation(changed, { additionalRangeIds }), /canonical selection/);
  }
});
