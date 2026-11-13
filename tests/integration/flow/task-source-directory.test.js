import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { SourceMutationBaseline, SourceMutationManifest } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { CurrentTaskSourceSnapshot, TaskExecutionBudget, TaskMutationLineage, TaskMutationLineageSet } from "../../../src/flow/lib/task-mutation-lineage.js";
import { CanonicalTaskContext } from "../../../src/flow/lib/task-canonical-context.js";
import { TaskReviewPromptPlan } from "../../../src/flow/lib/task-review-prompt-plan.js";
import { CanonicalSourceRequirementAuthority } from "../../../src/flow/lib/canonical-file-map.js";

const identity = { runId: "directory-run", specId: "directory-spec", taskId: "T1" };
const attempt = { id: "directory-attempt", nodeId: "T1-impl", sequence: 1 };
const spec = {
  tasks: [{ id: "T1", title: "Create source", goal: "Preserve directory changes", origin: "plan", added_round: 0, status: "pending" }],
  requirements: [{ id: "R1", desc: "Retain all certified source paths", task_ids: ["T1"], testable: false }],
  overview: { modules: [], data_flow: [], decisions: [] },
};

function certify(root, mutate) {
  const baseline = SourceMutationBaseline.capture({ root, attempt });
  mutate();
  const manifest = SourceMutationManifest.capture({ baseline });
  manifest.assertBinding(baseline);
  const lineage = new TaskMutationLineage({ ...identity, role: "implementation", attempt,
    budget: new TaskExecutionBudget({ round: 1, reviewAttemptSequenceAtStart: 0, gateAttemptSequenceAtStart: 0 }),
    sourceFingerprint: manifest.digest, manifest: manifest.toJSON() });
  return new TaskMutationLineageSet({ ...identity, lineages: [lineage] });
}

function reloadAndConsume(root, lineageSet, expected) {
  const snapshot = CurrentTaskSourceSnapshot.capture({ root, lineageSet });
  snapshot.assertMatchesLineages(lineageSet);
  assert.deepEqual(snapshot.entries.map((entry) => [entry.path, entry.toJSON().status]), expected);
  const stored = path.join(root, ".tmp", "source-boundary.json");
  fs.mkdirSync(path.dirname(stored), { recursive: true });
  fs.writeFileSync(stored, JSON.stringify({ lineages: lineageSet.lineages.map((lineage) => lineage.toJSON()), source: snapshot.toJSON() }));
  const document = JSON.parse(fs.readFileSync(stored, "utf8"));
  const restoredLineages = new TaskMutationLineageSet({ ...identity, lineages: document.lineages });
  const restored = CurrentTaskSourceSnapshot.fromStored(document.source, { lineageSet: restoredLineages });
  assert.deepEqual(restored.toJSON(), snapshot.toJSON());
  restored.assertMatchesLineages(restoredLineages);
  const context = new CanonicalTaskContext({ state: { ...identity, currentTaskId: "T1" }, spec, sourceFingerprint: restored.fingerprint });
  const projection = context.projectWorkerContext({ stepId: "task-review", source: restored }).toJSON();
  assert.deepEqual(projection.source, restored.toJSON(), "the real Review input consumes the reloaded structural source");
  assert.doesNotMatch(JSON.stringify(projection.source), /foreign\.js|untouched/);
  const authority = CanonicalSourceRequirementAuthority.fromTaskRequirements(context.requirements);
  assert.deepEqual(authority.bindPaths(projection.source.entries.map((entry) => entry.path)).toJSON(), { R1: expected.map(([name]) => name) });
  const plan = TaskReviewPromptPlan.create({ sourceEntries: projection.source.entries,
    buildPrompt: ({ sourceText }) => ({ systemPrompt: "Review the canonical Task source.", userPrompt: sourceText }),
    maxChars: 120000 });
  assert.equal(plan.chunks.length, 1);
  assert.deepEqual(plan.chunks[0].segments.map((segment) => [segment.path, segment.status]), expected);
  for (const [name, status] of expected) {
    if (status === "directory") assert.ok(plan.chunks[0].prompt.userPrompt.includes(`## ${name}\n(directory)`));
    if (status === "deleted") assert.ok(plan.chunks[0].prompt.userPrompt.includes(`## ${name}\n(deleted)`));
  }
  assert.doesNotMatch(plan.chunks[0].prompt.userPrompt, /undefined/);
  return { restored, restoredLineages, document };
}

it("preserves worker-created Git directories through Task Review source reload and Gate comparison", (t) => {
  const root = createTmpDir("sennel-task-git-directory-");
  t.after(() => removeQuiescentRuntimeFixture({ mainRoot: root }));
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "README.md"), "untouched\n");
  fs.writeFileSync(path.join(root, "foreign.js"), "untouched\n");
  fs.writeFileSync(path.join(root, "obsolete.js"), "old\n");
  commitAll(root, "Directory source baseline");
  const lineages = certify(root, () => {
    fs.mkdirSync(path.join(root, "src", "empty"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "implementation.js"), "export const implementation = true;\n");
    fs.unlinkSync(path.join(root, "obsolete.js"));
  });
  assert.deepEqual(lineages.paths, ["obsolete.js", "src", "src/empty", "src/implementation.js"], "structural mutations remain part of the Task authority");
  const { restored, restoredLineages, document } = reloadAndConsume(root, lineages, [
    ["obsolete.js", "deleted"], ["src", "directory"], ["src/empty", "directory"], ["src/implementation.js", "present"],
  ]);
  const changedStored = structuredClone(document.source);
  changedStored.entries.find((entry) => entry.path === "src").content = "invented file content";
  assert.throws(() => CurrentTaskSourceSnapshot.fromStored(changedStored, { lineageSet: restoredLineages }), /Task source snapshot/);
  fs.rmdirSync(path.join(root, "src", "empty"));
  const changed = CurrentTaskSourceSnapshot.capture({ root, lineageSet: restoredLineages });
  assert.notEqual(changed.fingerprint, restored.fingerprint);
  assert.throws(() => changed.assertMatchesLineages(restoredLineages), /no longer matches/);
});

for (const scenario of ["file-to-directory", "directory-to-file", "directory-deletion"]) {
  it(`retains certified ${scenario} paths across source persistence and Review consumption`, (t) => {
    const root = createTmpDir("sennel-task-source-kind-");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, "foreign.js"), "untouched\n");
    if (scenario === "file-to-directory") fs.writeFileSync(path.join(root, "source"), "old\n");
    else {
      fs.mkdirSync(path.join(root, "source"));
      fs.writeFileSync(path.join(root, "source", "child.js"), "old\n");
    }
    const lineages = certify(root, () => {
      fs.rmSync(path.join(root, "source"), { recursive: true });
      if (scenario === "file-to-directory") {
        fs.mkdirSync(path.join(root, "source"));
        fs.writeFileSync(path.join(root, "source", "child.js"), "new\n");
      } else if (scenario === "directory-to-file") fs.writeFileSync(path.join(root, "source"), "new\n");
    });
    const expected = scenario === "file-to-directory" ? [["source", "directory"], ["source/child.js", "present"]]
      : scenario === "directory-to-file" ? [["source", "present"], ["source/child.js", "deleted"]]
        : [["source", "deleted"], ["source/child.js", "deleted"]];
    reloadAndConsume(root, lineages, expected);
  });
}
