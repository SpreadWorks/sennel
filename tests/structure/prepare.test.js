import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { checkStructure } from "../support/structure/checker.js";
import { PhaseStructureEntry, PhaseStructureManifest, draftStructureManifest,
  specStructureManifest, futurePhaseManifests } from "../support/structure/phase-manifest.js";
import { ExecutionCaller, ExecutionLoader, NamedExecutionShape, ProductionRegistrations,
  StructureLeaf } from "../support/structure/production-registrations.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const responsibility = futurePhaseManifests.find((manifest) => manifest.id === "01");
const source = responsibility.entries[0];
const manifest = new PhaseStructureManifest(responsibility.id, responsibility.board, [
  new PhaseStructureEntry(source.entry, source.composition, source.exportName,
    source.definition.leaves.map((leaf) => new StructureLeaf(leaf.stepId, leaf.scope,
      leaf.nodeId, "prepare-adoption", leaf.taskIdentity))),
]);
const scope = manifest.entries[0];
const lookup = "prepareStepRegistration";
const shape = new NamedExecutionShape("prepare-adoption", "src/flow/lib/execution-admission.js",
  "prepareStepExecutionContract", "selectPrepareExecutionAdmission", "projectPrepareExecutionAdmission",
  "executePrepareSelection", [
    new ExecutionCaller("src/flow/lib/get-next-action.js", "projectPrepareStepExecution", lookup, "project"),
    new ExecutionCaller("src/flow/lib/run-prepare-spec.js", "executePrepareStepExecution", lookup, "execute"),
    new ExecutionCaller("src/flow/lib/run-dispatch.js", "executeSelectedPrepareStepExecution", lookup,
      "execute", null, "consume"),
    new ExecutionCaller("src/flow/registry.js", "executePublishedPrepareStep", lookup,
      "execute", null, "consume"),
    new ExecutionCaller("src/flow/lib/run-prepare-spec.js", "recoverPrepareStepExecution", lookup,
      "execute", "replayPrepareStepReceipt", "consume"),
  ], [
    new ExecutionLoader("src/flow/registry.js", "loadGetNextActionCommand", "src/flow/lib/get-next-action.js"),
    new ExecutionLoader("src/flow/registry.js", "loadDispatchCommand", "src/flow/lib/run-dispatch.js"),
    new ExecutionLoader("src/flow/registry.js", "loadPrepareCommand", "src/flow/lib/run-prepare-spec.js"),
  ]);

test("Prepare fixes all two responsibility leaves and the shared adoption execution shape", () => {
  assert.equal(manifest instanceof PhaseStructureManifest, true);
  assert.equal(manifest.board, "f72f");
  assert.equal(scope.entry, "src/flow/steps/prepare");
  assert.equal(scope.composition, "src/flow/engine/composition/prepare.js");
  assert.equal(scope.exportName, "prepareStepRegistrations");
  assert.equal(scope.definition.module, "src/flow/definition.js");
  assert.equal(scope.definition.declarationName, "FLOW_DEFINITION");
  assert.deepEqual(manifest.leaves.map((leaf) => leaf.stepId), ["branch", "prepare-spec"]);
  assert.deepEqual(manifest.leaves.map((leaf) => leaf.executionForm), ["prepare-adoption", "prepare-adoption"]);
  assert.equal(shape.callers.length, 5);
  assert.equal(shape.loaders.length, 3);
});

test("Prepare source obeys A01-A12 through all production registrations and named execution routes", async (context) => {
  assert.equal(fs.existsSync(path.join(root, scope.composition)), true,
    `A01 ${scope.composition}: missing production ${scope.exportName} for branch and prepare-spec`);
  // Inspect every present official phase export without requiring absent future
  // phases. This is an inspection snapshot, not an execution registry.
  const entries = [draftStructureManifest, specStructureManifest].flatMap((entry) => entry.entries)
    .concat(futurePhaseManifests.flatMap((entry) => entry.entries)
      .filter((entry) => fs.existsSync(path.join(root, entry.composition))));
  const selections = await Promise.all(entries.map((entry) => new ProductionRegistrations(
    new URL(`../../${entry.composition}`, import.meta.url), entry.exportName).load()));
  const registrations = selections[entries.findIndex((entry) => entry.composition === scope.composition)];
  const registry = selections.flat();
  const report = checkStructure({ root, entry: scope.entry, registrations,
    registrationModule: scope.composition, contract: scope.contract(registry, [shape]) });
  context.diagnostic(report.describe());
  assert.equal(report.ok, true,
    `${report.describe()}\n${report.diagnostics.map((diagnostic) => diagnostic.toString()).join("\n")}`);
  assert.ok(report.visited.size > 0);
  assert.ok(report.reverseIndexed.size > 0);
  assert.ok(report.serviceBoundaries.size > 0);
});
