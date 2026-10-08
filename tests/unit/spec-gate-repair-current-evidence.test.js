import assert from "node:assert/strict";
import { test } from "node:test";
import { SpecGateRepairSource, SpecGateRepairSourceSnapshots } from "../../src/flow/lib/spec-gate-repair-values.js";
import { WorkerArtifactHandoffError } from "../../src/flow/lib/worker-artifact-handoff-error.js";

function fixture() {
  return new SpecGateRepairSourceSnapshots([
    new SpecGateRepairSource({ id: "request", origin: "flow.request", revision: "request-r1", content: "Request A" }),
    new SpecGateRepairSource({ id: "issue.snapshot", origin: "artifacts/issue.md", revision: "issue-r1", content: "Issue A" }),
    new SpecGateRepairSource({ id: "draft", origin: "artifacts/draft.json", revision: "draft-r1", content: "Draft A" }),
    new SpecGateRepairSource({ id: "project-rules:src/AGENTS.md", origin: "src/AGENTS.md", revision: "rule-r1",
      content: "Retain the scoped rule.", required: false, appliesTo: ["src"] }),
    new SpecGateRepairSource({ id: "source:src/owner.js", origin: "src/owner.js", revision: "research-r1",
      content: "export const maximum = 137;", required: false }),
  ]);
}
function changed(snapshots, id, changes) {
  return new SpecGateRepairSourceSnapshots(snapshots.sources().map((source) => source.id !== `evidence:${id}`
    ? source : new SpecGateRepairSource({ ...source.descriptor(), content: source.content,
      id, ...changes })));
}
function identity(snapshots) {
  return snapshots.sources().map((source) => ({ ...source.descriptor(), content: source.content }));
}

// Optional checkout research is validated by immutable manifest publication,
// while canonical inputs and declared rules must still match current evidence.
test("unchanged canonical inputs and scoped rules accept independently changing optional research", () => {
  const saved = fixture();
  const before = identity(saved);
  const current = changed(saved, "source:src/owner.js", { content: "export const maximum = 239;", revision: "research-r2" });
  assert.equal(saved.assertCurrentEvidence(new SpecGateRepairSourceSnapshots([...saved.sources()].reverse())), undefined);
  assert.equal(saved.assertCurrentEvidence(current), undefined);
  assert.notEqual(current.sources().find((source) => source.origin === "src/owner.js").digest,
    saved.sources().find((source) => source.origin === "src/owner.js").digest);
  assert.deepEqual(identity(saved), before);
  assert(Object.isFrozen(saved));
  assert(saved.sources().every((source) => Object.isFrozen(source) && Object.isFrozen(source.appliesTo)));
});

const changes = [
  { name: "request content digest", id: "request", changes: { content: "Request B" } },
  { name: "Issue content digest", id: "issue.snapshot", changes: { content: "Issue B" } },
  { name: "Draft content digest", id: "draft", changes: { content: "Draft B" } },
  { name: "required source revision", id: "issue.snapshot", changes: { revision: "issue-r2" } },
  { name: "required source origin", id: "draft", changes: { origin: "artifacts/different-draft.json" } },
  { name: "required source identity", id: "request", changes: { id: "different-request" } },
  { name: "required source flag", id: "request", changes: { required: false } },
  { name: "missing canonical evidence", id: "draft", changes: { availability: "missing", content: "" } },
  { name: "unavailable canonical evidence", id: "issue.snapshot", changes: { availability: "unavailable", content: "" } },
  { name: "optional scoped rule content", id: "project-rules:src/AGENTS.md", changes: { content: "Replace the scoped rule." } },
  { name: "optional scoped rule scope", id: "project-rules:src/AGENTS.md", changes: { appliesTo: ["src/component"] } },
  { name: "optional scoped rule flag", id: "project-rules:src/AGENTS.md", changes: { required: true } },
];
for (const { name, id, changes: modification } of changes) {
  test(`current evidence rejects changed ${name} without replacing saved evidence`, () => {
    const saved = fixture();
    const before = identity(saved);
    const current = changed(saved, id, modification);
    assert.throws(() => saved.assertCurrentEvidence(current), (error) => {
      assert(error instanceof WorkerArtifactHandoffError);
      assert.equal(error.code, "FLOW_SPEC_GATE_REPAIR_EVIDENCE_CHANGED");
      assert.equal(error.classification, "stale");
      assert.equal(error.retryable, false);
      assert.equal(error.recoveryPossible, false);
      return true;
    });
    assert.deepEqual(identity(saved), before);
  });
}

for (const added of [false, true]) {
  test(`current evidence refuses ${added ? "added" : "absent"} canonical input instead of retaining stale authority`, () => {
    const complete = fixture();
    const absent = new SpecGateRepairSourceSnapshots(complete.sources().filter((source) => source.id !== "evidence:issue.snapshot"));
    const saved = added ? absent : complete;
    const current = added ? complete : absent;
    const before = identity(saved);
    assert.throws(() => saved.assertCurrentEvidence(current), { code: "FLOW_SPEC_GATE_REPAIR_EVIDENCE_CHANGED",
      classification: "stale", retryable: false, recoveryPossible: false });
    assert.deepEqual(identity(saved), before);
  });
}
