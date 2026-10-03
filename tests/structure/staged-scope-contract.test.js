import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskStepIdentity } from "../../src/flow/lib/task-step-identity.js";
import { StepRegistration } from "../../src/flow/engine/composition/step-registration.js";
import { StagedExecutionSeed } from "../fixtures/structure/staged-execution.js";
import { StructureChecker, StructureScope } from "../support/structure/checker.js";
import { DefinitionLeafScope, DependencyRegistrationIssue, DuplicateRegistrationIssue, InvalidRegistrationIssue, ProductionRegistrations, StructureLeaf, StructureScopeContract, TaskStructureLeaf } from "../support/structure/production-registrations.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";

function inspect(seed, files = seed.files(), scope = seed.scope()) {
  return new StructureChecker(scope, new MemorySourceRepository(files)).check();
}
function successful(report) { assert.equal(report.ok, true, report.diagnostics.map((entry) => entry.toString()).join("\n")); }
function violation(report, rule, file, message) {
  const diagnostic = report.diagnostics.find((entry) => entry.rule === rule && entry.file === file && entry.message.includes(message));
  assert.ok(diagnostic, report.diagnostics.map((entry) => entry.toString()).join("\n"));
  assert.equal(diagnostic.line > 0, true);
  assert.equal(diagnostic.column > 0, true);
  assert.equal(diagnostic.trace.includes(file), true);
}

test("fixed responsibility leaves accept a renamed second phase and another phase's official registrations", () => {
  const seed = new StagedExecutionSeed();
  const other = new StagedExecutionSeed("sigma", ["other"]);
  const files = seed.files();
  for (const [file, source] of other.files()) if (file.startsWith(other.entry) || file === other.composition) files.set(file, source);
  files.set("src/flow/lib/other-phase-command.js", `import { commandRegistration } from '../engine/composition/sigma.js';
    export function runOther(input) { const registration = commandRegistration(input.stepId);
      const selection = registration.executionContract.select(input); return registration.executionContract.execute(selection, input); }`);
  successful(inspect(seed, files, seed.scope(seed.registrations, [...seed.registrations, ...other.registrations])));
});

test("missing responsibility leaf is rejected even when its Step source is removed", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  files.delete(`${seed.entry}/step1.js`);
  files.set(seed.composition, files.get(seed.composition).replace(/import \{ Entry1Step \}[^;]+;/, "")
    .replace(/,new StepRegistration\(\{ stepId: 'second'[^)]+\}\)/, ""));
  violation(inspect(seed, files, seed.scope(seed.registrations.slice(0, 1), seed.registrations.slice(0, 1))),
    "A01", seed.composition, "responsibility leaf second has 0");
  successful(inspect(seed));
});

test("an individual Step cannot be excluded from the selected phase", () => {
  const seed = new StagedExecutionSeed();
  violation(inspect(seed, seed.files(), seed.scope(seed.registrations.slice(0, 1))), "A01", seed.composition, "excluded from phase selection");
  successful(inspect(seed));
});

test("entry Step without production registration fails independently of fixed leaf completeness", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  files.set(`${seed.entry}/unregistered.js`, "import { Step } from '../../engine/step.js'; export class Unregistered extends Step {}");
  violation(inspect(seed, files), "A01", `${seed.entry}/unregistered.js`, "no production registration");
  successful(inspect(seed));
});

test("single registry duplicates and phase selection identity are separate violations", () => {
  const seed = new StagedExecutionSeed();
  violation(inspect(seed, seed.files(), seed.scope(seed.registrations, [...seed.registrations, seed.registrations[0]])),
    "A01", seed.composition, "single production registry duplicates first");
  const alternate = new StagedExecutionSeed();
  violation(inspect(seed, seed.files(), seed.scope(seed.registrations, alternate.registrations)),
    "A01", seed.composition, "selection first does not belong");
  successful(inspect(seed));
});

test("shared registry inspection returns concrete issues for both diagnostic and load boundaries", () => {
  const seed = new StagedExecutionSeed();
  assert.deepEqual(ProductionRegistrations.inspect(seed.registrations), []);
  const original = seed.registrations[0];
  const sameClass = new StepRegistration({ ...original, stepId: "other-id" });
  for (const [member, Issue, message] of [
    [null, InvalidRegistrationIssue, "invalid registration type"],
    [original, DuplicateRegistrationIssue, "duplicates first"],
    [sameClass, DuplicateRegistrationIssue, "duplicates other-id"],
  ]) {
    const issues = ProductionRegistrations.inspect([...seed.registrations, member]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0] instanceof Issue, true);
    assert.equal(issues[0].toRegistryMessage().includes(message), true);
    assert.equal(issues[0].toLoadError("fixture.mjs", "registrations") instanceof TypeError, true);
    assert.equal(Object.isFrozen(issues[0]), true);
  }
  class IsolatedStep extends original.StepClass { static dependencies = [original.ServiceClass]; }
  const inconsistent = new StepRegistration({ ...original, stepId: "isolated", StepClass: IsolatedStep });
  IsolatedStep.dependencies = [];
  const issues = ProductionRegistrations.inspect([inconsistent]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0] instanceof DependencyRegistrationIssue, true);
  assert.equal(issues[0].toRegistryMessage(), "single production registry dependency mismatch isolated");
  assert.equal(issues[0].toLoadError("fixture.mjs").message, "fixture.mjs has inconsistent registration dependency isolated");
  IsolatedStep.dependencies = [original.ServiceClass];
  assert.deepEqual(ProductionRegistrations.inspect([inconsistent]), []);
});

test("a foreign single-registry member is rejected as a registry type violation", () => {
  const seed = new StagedExecutionSeed();
  for (const foreign of [{}, null]) {
    violation(inspect(seed, seed.files(), seed.scope(seed.registrations, [...seed.registrations, foreign])),
      "A01", seed.composition, "invalid registration type");
  }
  successful(inspect(seed));
});

test("the fixed registry is an immutable snapshot of the supplied selection source", () => {
  const seed = new StagedExecutionSeed();
  const registry = [...seed.registrations];
  const scope = seed.scope(seed.registrations, registry);
  registry.push(null);
  assert.deepEqual(scope.contract.registry, seed.registrations);
  assert.equal(Object.isFrozen(scope.contract.registry), true);
  successful(inspect(seed, seed.files(), scope));
});

test("Task scope fixes roles and reuses canonical TaskStepIdentity for materialized nodes", () => {
  const leaves = ["impl", "review", "triage", "repair", "gate"].map((role) =>
    new TaskStructureLeaf(new TaskStepIdentity({ taskId: "T17", role }), "command"));
  assert.deepEqual(leaves.map((leaf) => leaf.taskIdentity.definitionId), leaves.map((leaf) => leaf.stepId));
  assert.equal(leaves.every((leaf) => leaf.taskIdentity.matchesNode(leaf.nodeId)), true);
  const seed = new StagedExecutionSeed("task-phase", leaves.map((leaf) => leaf.stepId), leaves);
  successful(inspect(seed));
  const badLeaves = [...leaves.slice(0, -1), new StructureLeaf("task-gate", "task", "T17-review", "command")];
  const badContract = new StructureScopeContract(new DefinitionLeafScope(seed.definition.module, "TASK_DEFINITION", badLeaves), [seed.shape], seed.registrations);
  violation(inspect(seed, seed.files(), new StructureScope("/virtual", seed.entry, seed.registrations, seed.composition, badContract)),
    "A11", seed.definition.module, "does not match node");
  const mixed = new StructureScopeContract(new DefinitionLeafScope(seed.definition.module, "FLOW_DEFINITION", leaves), [seed.shape], seed.registrations);
  const files = seed.files();
  files.set(seed.definition.module, files.get(seed.definition.module).replace("TASK_DEFINITION", "FLOW_DEFINITION"));
  violation(inspect(seed, files, new StructureScope("/virtual", seed.entry, seed.registrations, seed.composition, mixed)),
    "A11", seed.definition.module, "belongs to task scope");
  successful(inspect(seed));
});
