import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { collectFlowLeafIds, collectTaskLeafIds } from "../../src/flow/definition.js";
import { draftStepRegistrations } from "../../src/flow/engine/composition/draft.js";
import { specStepRegistrations } from "../../src/flow/engine/composition/spec.js";
import { canonicalStepState, StepBinding } from "../../src/flow/engine/step-binding.js";
import { CurrentAttemptIdentity } from "../../src/flow/lib/current-flow-state.js";
import { CurrentFlowStateConflictError } from "../../src/flow/lib/current-flow-state-conflict-error.js";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";
import { CanonicalFlowFixture } from "../support/infrastructure/flow-setup.js";
import { checkStructure } from "../support/structure/checker.js";
import { draftStructureManifest, specStructureManifest, futurePhaseManifests } from "../support/structure/phase-manifest.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

class FixtureStepBinding extends StepBinding {}

test("fixed five-phase manifest partitions every actual Definition leaf without changing runtime identities", () => {
  assert.deepEqual(futurePhaseManifests.map((phase) => [phase.id, phase.leaves.length]),
    [["01", 2], ["02", 5], ["03", 12], ["04", 5], ["05", 4]]);
  const leaves = [draftStructureManifest, specStructureManifest, ...futurePhaseManifests].flatMap((phase) => phase.leaves);
  assert.equal(leaves.length, 44);
  assert.equal(new Set(leaves.map((leaf) => leaf.stepId)).size, 44);
  assert.deepEqual(leaves.filter((leaf) => leaf.scope === "flow").map((leaf) => leaf.stepId).sort(), collectFlowLeafIds().sort());
  assert.deepEqual(leaves.filter((leaf) => leaf.scope === "task").map((leaf) => leaf.stepId).sort(), collectTaskLeafIds().sort());
  const implementation = futurePhaseManifests[2];
  assert.deepEqual(implementation.entries.map((entry) => entry.definition.leaves.length), [7, 5]);
  assert.equal(implementation.leaves.some((leaf) => leaf.stepId === "retro"), false);
  assert.equal(futurePhaseManifests[3].leaves.some((leaf) => leaf.stepId === "retro"), true);
});

test("current production scopes retain all sixteen leaves while the entire existing registration set is checked", () => {
  const registry = [...draftStepRegistrations, ...specStepRegistrations];
  for (const [manifest, registrations] of [[draftStructureManifest, draftStepRegistrations], [specStructureManifest, specStepRegistrations]]) {
    const scope = manifest.entries[0];
    const report = checkStructure({ root, entry: scope.entry, registrationModule: scope.composition,
      registrations, contract: scope.contract(registry) });
    assert.equal(report.ok, true, report.diagnostics.map((entry) => entry.toString()).join("\n"));
    assert.equal(registrations.length, manifest.leaves.length);
  }
});

test("future production responsibility deficits are real-source violations separate from accepted Draft and Spec scopes", (context) => {
  const registry = [...draftStepRegistrations, ...specStepRegistrations];
  for (const phase of futurePhaseManifests) {
    for (const scope of phase.entries) {
      // This is an unintroduced scope detection test, not a successful phase acceptance.
      const registrations = registry.filter((registration) => scope.definition.leaves.some((leaf) => leaf.stepId === registration.stepId));
      const report = checkStructure({ root, entry: scope.entry, registrationModule: scope.composition,
        registrations, contract: scope.contract(registry) });
      assert.equal(report.ok, false);
      for (const leaf of scope.definition.leaves) {
        assert.ok(report.diagnostics.some((entry) => entry.rule === "A01"
          && entry.file === scope.composition && entry.line > 0 && entry.column > 0
          && entry.message === `responsibility leaf ${leaf.stepId} has 0 selected registrations`
          && entry.trace.includes("src/flow/definition.js")), report.diagnostics.map((entry) => entry.toString()).join("\n"));
      }
      assert.equal(report.diagnostics.some((entry) => entry.rule === "A11" && entry.file === "src/flow/definition.js"), false,
        "the fixed responsibilities must exist in the actual Definition even before registration migration");
      context.diagnostic(`phase=${phase.id}; board=${phase.board}; entry=${scope.entry}; missing=${scope.definition.leaves.map((leaf) => leaf.stepId).join(",")}`);
    }
  }
});

test("preparing run and journal identities cannot replace a canonical Step Attempt across reload", (context) => {
  const preparationRoot = createTmpDir("fc21-preparing-binding-");
  const canonicalRoot = createTmpDir("fc21-canonical-binding-");
  context.after(() => removeTmpDir(preparationRoot));
  context.after(() => removeTmpDir(canonicalRoot));
  const specId = "001-fc21-binding";
  const preparingManager = new FlowManager({ root: preparationRoot, mainRoot: preparationRoot, specId });
  preparingManager.createPreparingFlow("run-fc21-preparing", { request: "Prepare a canonical Flow." });
  const reloadedPreparing = new FlowManager({ root: preparationRoot, mainRoot: preparationRoot, specId });
  const preparing = reloadedPreparing.loadPreparingFlow("run-fc21-preparing");
  assert.equal(preparing.specId, null);
  const absentVersion = { name: "Error", message: `Version authority path does not exist: specs/${specId}/001` };
  assert.throws(() => reloadedPreparing.canonicalState(specId), absentVersion);
  assert.throws(() => canonicalStepState(reloadedPreparing, specId), absentVersion);
  const journalIdentity = new CurrentAttemptIdentity({ id: "prepare-journal-attempt", nodeId: "draft", sequence: 1 });
  assert.throws(() => new FixtureStepBinding({ flowManager: reloadedPreparing, state: preparing,
    stepId: "draft", attempt: journalIdentity }), TypeError);
  assert.throws(() => new FixtureStepBinding({ flowManager: reloadedPreparing, state: { ...preparing, specId },
    stepId: "draft", attempt: journalIdentity }), CurrentFlowStateConflictError);

  const manager = new FlowManager({ root: canonicalRoot, mainRoot: canonicalRoot, specId });
  new CanonicalFlowFixture({ flowManager: manager, specId, runId: "run-fc21-canonical" })
    .create().registerActive().activate("draft");
  const reloaded = new FlowManager({ root: canonicalRoot, mainRoot: canonicalRoot, specId });
  const state = canonicalStepState(reloaded, specId);
  const before = state.toJSON();
  const binding = new FixtureStepBinding({ flowManager: reloaded, state, stepId: "draft", attempt: state.attempt });
  assert.equal(binding.assertCurrent().attempt.id, state.attempt.id);
  for (const id of [preparing.runId, journalIdentity.id]) {
    const forged = new CurrentAttemptIdentity({ id, nodeId: state.attempt.nodeId, sequence: state.attempt.sequence });
    assert.throws(() => new FixtureStepBinding({ flowManager: reloaded, state, stepId: "draft", attempt: forged }), CurrentFlowStateConflictError);
  }
  assert.deepEqual(canonicalStepState(reloaded, specId).toJSON(), before);
});
