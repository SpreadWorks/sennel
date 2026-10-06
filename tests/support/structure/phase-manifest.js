import { TaskStepIdentity } from "../../../src/flow/lib/task-step-identity.js";
import { DefinitionLeafScope, StructureLeaf, StructureScopeContract, TaskStructureLeaf } from "./production-registrations.js";

/** Fixed responsibilities, not a second production registration registry. */
export class PhaseStructureEntry {
  constructor(entry, composition, exportName, leaves) {
    if ([entry, composition, exportName].some((value) => typeof value !== "string" || !value)
      || !Array.isArray(leaves) || !leaves.length || leaves.some((leaf) => !(leaf instanceof StructureLeaf))
      || new Set(leaves.map((leaf) => leaf.scope)).size !== 1) {
      throw new TypeError("PhaseStructureEntry requires one fixed Flow or Task responsibility scope");
    }
    this.entry = entry;
    this.composition = composition;
    this.exportName = exportName;
    this.definition = new DefinitionLeafScope("src/flow/definition.js",
      leaves[0].scope === "task" ? "TASK_DEFINITION" : "FLOW_DEFINITION", leaves);
    Object.freeze(this);
  }

  contract(registry, executionShapes = [], executionForms = {}) {
    const forms = executionForms ?? {};
    const definition = Object.keys(forms).length === 0 ? this.definition
      : new DefinitionLeafScope(this.definition.module, this.definition.declarationName,
        this.definition.leaves.map((leaf) => new StructureLeaf(leaf.stepId, leaf.scope, leaf.nodeId,
          forms[leaf.stepId] ?? leaf.executionForm, leaf.taskIdentity)));
    if (Object.keys(forms).some((stepId) => !this.definition.leaves.some((leaf) => leaf.stepId === stepId))) {
      throw new TypeError("phase execution forms must identify declared leaves");
    }
    return new StructureScopeContract(definition, executionShapes, registry);
  }
}

export class PhaseStructureManifest {
  constructor(id, board, entries) {
    if ([id, board].some((value) => typeof value !== "string" || !value)
      || !Array.isArray(entries) || !entries.length || entries.some((entry) => !(entry instanceof PhaseStructureEntry))) {
      throw new TypeError("PhaseStructureManifest requires fixed entries");
    }
    const leaves = entries.flatMap((entry) => entry.definition.leaves);
    if (new Set(leaves.map((leaf) => leaf.stepId)).size !== leaves.length) {
      throw new TypeError("PhaseStructureManifest cannot repeat a responsibility leaf");
    }
    Object.assign(this, { id, board });
    this.entries = Object.freeze([...entries]);
    this.leaves = Object.freeze(leaves);
    Object.freeze(this);
  }
}

function flowEntry(phase, exportName, ids, composition = phase) {
  return new PhaseStructureEntry(`src/flow/steps/${phase}`,
    `src/flow/engine/composition/${composition}.js`, exportName, ids.map((id) => new StructureLeaf(id)));
}

export const draftStructureManifest = new PhaseStructureManifest("draft", "existing", [
  flowEntry("draft", "draftStepRegistrations", [
    "draft", "draft-questions-review", "draft-questions-triage", "draft-questions-repair",
    "draft-refine", "draft-gate-repair", "draft-coverage-review", "draft-coverage-triage",
    "draft-coverage-repair", "draft-gate",
  ]),
]);

export const specStructureManifest = new PhaseStructureManifest("spec", "existing", [
  flowEntry("spec", "specStepRegistrations", ["spec", "spec-review", "spec-triage", "spec-repair", "spec-gate", "spec-gate-repair"]),
]);

export const futurePhaseManifests = Object.freeze([
  new PhaseStructureManifest("01", "f72f", [flowEntry("prepare", "prepareStepRegistrations", ["branch", "prepare-spec"])]),
  new PhaseStructureManifest("02", "8e30", [flowEntry("test", "requirementTestStepRegistrations", [
    "approval", "test-generate", "test-review", "test-repair", "test-gate",
  ])]),
  new PhaseStructureManifest("03", "3a50", [
    flowEntry("impl", "implStepRegistrations", [
      "implement", "test-execute", "test-result-review", "impl-review", "impl-triage", "impl-repair", "impl-gate",
    ]),
    new PhaseStructureEntry("src/flow/steps/task", "src/flow/engine/composition/task.js", "taskStepRegistrations",
      ["impl", "review", "triage", "repair", "gate"].map((role) =>
        new TaskStructureLeaf(new TaskStepIdentity({ taskId: "T17", role })))),
  ]),
  new PhaseStructureManifest("04", "6af5", [flowEntry("acceptance", "acceptanceStepRegistrations", [
    "retro", "acceptance-review", "acceptance-decision", "final-regression", "report",
  ])]),
  new PhaseStructureManifest("05", "5ab3", [flowEntry("finalize", "finalizationStepRegistrations", [
    "finalize-commit", "finalize-merge", "finalize-sync", "finalize-cleanup",
  ], "finalization")]),
]);
