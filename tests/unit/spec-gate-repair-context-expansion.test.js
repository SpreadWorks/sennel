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
