import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { SpecGateRepairContext } from "../../src/flow/lib/spec-gate-repair-context.js";
import { SpecGateRepairSource, SpecGateRepairSourceSnapshots } from "../../src/flow/lib/spec-gate-repair-values.js";
import { assertSpecGateRepairSelectedSources } from "../../src/flow/lib/spec-gate-repair-source-storage.js";
import { workerArtifactStableStringify } from "../../src/flow/lib/worker-artifact-input-format.js";

test("inspection bytes and provenance must match the immutable captured source after JSON readback", () => {
  const source = new SpecGateRepairSource({ id: "source:src/owner.js", origin: "src/owner.js", revision: "capture", content: "ABCDE" });
  const context = new SpecGateRepairContext({ baseRevision: `sha256:${"a".repeat(64)}`,
    spec: { goal: "Plan a measurable check" }, sources: [source],
    guardrails: [{ id: "checks", body: "Complete canonical rule" }], findings: [{
      identity: { sourceArtifact: "gate.json", sourceStep: "spec-gate", sourceFindingId: "F1", fingerprint: "b".repeat(64) },
      requirementRef: "checks", observed: "Specify the result", targets: [{ entity: "spec", field: "goal" }],
      allowedTargets: [{ target: { entity: "spec", field: "goal" }, operationKinds: ["edit-text-field"] }] }] });
  const id = context.tableOfContents().find((entry) => entry.source?.id === source.id).id;
  const document = context.continuationDocument({ unitId: context.units()[0].id,
    requestedRangeIds: [id], additionalRangeIds: [id], intent: "inspect" });
  const snapshots = new SpecGateRepairSourceSnapshots([source]);
  const saved = JSON.parse(workerArtifactStableStringify(document));
  assert.equal(assertSpecGateRepairSelectedSources(saved, snapshots), undefined);
  for (const mutate of [
    (range) => { range.value.content = "12345"; range.value.sliceDigest = range.digest = createHash("sha256").update("12345").digest("hex"); },
    (range) => { range.value.revision = "foreign capture"; },
    (range) => { range.value.origin = "src/foreign.js"; },
  ]) {
    const changed = structuredClone(saved);
    mutate(changed.navigation.ranges.find((range) => range.id === id));
    assert.throws(() => assertSpecGateRepairSelectedSources(changed, snapshots), /captured revision or exact byte range/);
  }
});
