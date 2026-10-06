import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { StagedExecutionSeed } from "../fixtures/structure/staged-execution.js";
import { checkStructure, StructureChecker } from "../support/structure/checker.js";
import { MemorySourceRepository, SourceRepository } from "../support/structure/source-repository.js";
import { SourceModule } from "../support/structure/source-reader.js";
import { RequirementTestProductionRegistrations, requirementTestManifest, requirementTestScope }
  from "../support/structure/requirement-test-scope.js";
import { requirementTestStructureContract } from "../support/structure/requirement-test-scope.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = new RequirementTestProductionRegistrations(root);
const ids = ["approval", "test-generate", "test-review", "test-repair", "test-gate"];

test("RequirementTest fixes five responsibility leaves, production owner 8e30, and test board a1ee", () => {
  assert.equal(requirementTestManifest.id, "02");
  assert.equal(requirementTestManifest.board, "8e30");
  assert.deepEqual(requirementTestManifest.leaves.map((leaf) => leaf.stepId), ids);
  assert.equal(requirementTestScope.entry, "src/flow/steps/test");
  assert.equal(requirementTestScope.composition, "src/flow/engine/composition/test.js");
  assert.equal(requirementTestScope.exportName, "requirementTestStepRegistrations");
  assert.equal(requirementTestScope.definition.module, "src/flow/definition.js");
  assert.equal(requirementTestScope.definition.declarationName, "FLOW_DEFINITION");
  assert.match(fs.readFileSync(path.join(root, "tests/integration/flow/a1ee-board-source.md"), "utf8"),
    /^# a1ee — frozen board input/m);
});

test("shared checker fixture accepts all five fixed leaves and detects each missing responsibility independently", (t) => {
  // Synthetic registrations belong only to this named checker fixture. The
  // production check below always loads the actual composition and lookup.
  const seed = new StagedExecutionSeed("requirement-test-checker-fixture", ids);
  const inspect = (registrations = seed.registrations) => new StructureChecker(
    seed.scope(registrations), new MemorySourceRepository(seed.files())).check();
  const complete = inspect();
  t.diagnostic(complete.describe());
  assert.equal(complete.ok, true, complete.diagnostics.map((entry) => entry.toString()).join("\n"));
  assert.ok(complete.visited.size > 0);
  assert.ok(complete.reverseIndexed.size > 0);
  assert.ok(complete.serviceBoundaries.size > 0);
  for (const id of ids) {
    const incomplete = inspect(seed.registrations.filter((registration) => registration.stepId !== id));
    const missing = incomplete.diagnostics.find((entry) => entry.rule === "A01"
      && entry.message.includes(`responsibility leaf ${id} has 0`));
    assert.ok(missing, incomplete.diagnostics.map((entry) => entry.toString()).join("\n"));
    assert.equal(missing.file, seed.composition);
    assert.ok(missing.line > 0 && missing.column > 0);
    assert.ok(missing.trace.includes(seed.definition.module));
  }
  assert.equal(inspect().ok, true, "removing each isolated violation restores the shared checker");
});

test("RequirementTest production obeys A01-A12 across fixed leaves and every present phase registration", async (t) => {
  const { selected, registry } = await source.registry();
  const report = checkStructure({ root, entry: requirementTestScope.entry, registrations: selected,
    registrationModule: requirementTestScope.composition, contract: requirementTestStructureContract(registry) });
  t.diagnostic(report.describe());
  assert.equal(report.ok, true, report.diagnostics.map((entry) => entry.toString()).join("\n"));
  assert.ok(report.visited.size > 0);
  assert.ok(report.reverseIndexed.size > 0);
  assert.ok(report.serviceBoundaries.size > 0);
  for (const file of [
    "src/flow/engine/composition/registered-step-execution.js", "src/flow/lib/get-next-action.js",
    "src/flow/lib/run-dispatch.js", "src/flow/registry.js", "src/flow/lib/run-review.js",
    "src/flow/lib/run-requirement-test-gate.js", "src/flow/lib/test-review-repair.js",
  ]) assert.ok(report.reverseIndexed.has(file), `A06/A09/A10/A11 caller or recovery source was not indexed: ${file}`);
});

test("A11 RequirementTest Gate CLI uses its named existing command loader", () => {
  const repository = new SourceRepository(root);
  const file = "src/flow/registry.js";
  const module = new SourceModule(file, repository.read(file));
  const registry = module.declaration("FLOW_COMMANDS");
  assert.ok(registry, "A11 Flow command registry must remain statically inspectable");
  const loaders = [...module.declarationHeaders.values()].filter((entry) => entry.name.startsWith("load"))
    .map((entry) => module.declaration(entry.name))
    .filter((entry) => entry.matchesFunction("", "return import('./lib/run-requirement-test-gate.js');"));
  assert.equal(loaders.length, 1,
    "A11 requirement-test-gate must have exactly one named loader for its existing command module");
  const tokens = registry.tokens;
  const gate = tokens.findIndex((token, index) => token.value === "requirement-test-gate"
    && tokens[index + 1]?.value === ":");
  assert.ok(gate >= 0);
  const command = tokens.findIndex((token, index) => index > gate && token.value === "command"
    && tokens[index + 1]?.value === ":");
  assert.equal(tokens[command + 2]?.value, loaders[0].name,
    "A11 the actual Gate command entry must consume its named loader");
});
