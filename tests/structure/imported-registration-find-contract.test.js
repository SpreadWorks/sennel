import assert from "node:assert/strict";
import { test } from "node:test";
import { StagedExecutionSeed } from "../fixtures/structure/staged-execution.js";
import { StructureChecker } from "../support/structure/checker.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";

function fixture(phase) {
  const seed = new StagedExecutionSeed(phase);
  const files = seed.files();
  const primary = seed.composition;
  const owner = `src/flow/engine/composition/${phase}-owner.js`;
  const original = files.get(primary);
  const declaration = original.match(/export const registrations = \[([\s\S]*?)\];/);
  assert.ok(declaration);
  const map = "const byId = new Map(registrations.map((registration) => [registration.stepId, registration]));";
  assert.ok(original.includes(map));
  files.set(owner, original.replace(declaration[0], `const members = Object.freeze([${declaration[1]}]);`)
    .replace(map, "")
    .replace("commandRegistration", "originalRegistration")
    .replace("return byId.get(stepId) ?? null;", "return members.find((entry) => entry.stepId === stepId) ?? null;"));
  files.set(primary, `import { originalRegistration } from './${phase}-owner.js';\n`
    + original.replace(declaration[0], `export const registrations = Object.freeze([${seed.ids.map((id) => `originalRegistration('${id}')`).join(",")}]);`));
  const inspect = () => new StructureChecker(seed.scope(), new MemorySourceRepository(files)).check();
  const clean = () => {
    const report = inspect();
    assert.equal(report.ok, true, report.diagnostics.map(String).join("\n"));
  };
  return { seed, files, primary, owner, inspect, clean };
}

for (const phase of ["upsilon", "lambda"]) {
  test(`bounded ${phase} find lookup resolves the same immutable original registrations`, () => fixture(phase).clean());
  for (const [name, location, before, after, rule] of [
    ["changed predicate", "owner", "entry.stepId === stepId", "entry.stepId !== stepId", "A10"],
    ["wrong member identity", "owner", "entry.stepId === stepId", "entry.otherId === stepId", "A10"],
    ["constant selection", "owner", "entry.stepId === stepId", "entry.stepId === 'first'", "A10"],
    ["missing null result", "owner", ") ?? null;", ");", "A10"],
    ["mutable collection", "owner", "Object.freeze([", "([", "A10"],
    ["escaped collection", "owner", "const members =", "export const members =", "A10"],
    ["rebound collection", "owner", "const members =", "let members =", "A10"],
    ["mutated collection", "owner", "return members.find", "members.reverse(); return members.find", "A10"],
    ["duplicate constructor identity", "owner", "stepId: 'second'", "stepId: 'first'", "A10"],
    ["duplicate primary member", "primary", "originalRegistration('second')", "originalRegistration('first')", "A10"],
    ["missing primary member", "primary", ",originalRegistration('second')", "", "A10"],
    ["unknown selection", "primary", "originalRegistration('second')", "originalRegistration('unknown')", "A10"],
    ["dynamic selection", "primary", "originalRegistration('second')", "originalRegistration(input.stepId)", "A10"],
    ["changed preparation owner", "owner", "prepareServiceArguments, executionContract", "prepareOtherArguments, executionContract", "A08"],
  ]) {
    test(`bounded ${phase} find lookup rejects ${name} and restores the exact source`, () => {
      const built = fixture(phase);
      built.clean();
      const file = built[location];
      const original = built.files.get(file);
      assert.ok(original.includes(before));
      built.files.set(file, original.replace(before, after));
      try {
        const report = built.inspect();
        const expectedFile = rule === "A08" ? built.owner : built.primary;
        const diagnostic = report.diagnostics.find((entry) => entry.rule === rule && entry.file === expectedFile);
        assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
        assert.ok(diagnostic.line > 0 && diagnostic.column > 0);
        assert.ok(diagnostic.trace.includes(expectedFile));
      } finally { built.files.set(file, original); }
      assert.equal(built.files.get(file), original);
      built.clean();
    });
  }
  for (const name of ["unregistered consumer", "exported alias", "owner-local bypass"]) {
    test(`bounded ${phase} find lookup rejects ${name} outside the declared execution contract`, () => {
      const built = fixture(phase);
      built.clean();
      const local = name === "owner-local bypass";
      const file = local ? built.owner : `src/flow/lib/${phase}-escape.js`;
      const original = built.files.get(file);
      const prefix = local ? original : `import { originalRegistration } from '../engine/composition/${phase}-owner.js';\n`;
      built.files.set(file, prefix + (name === "exported alias"
        ? "\nexport const escaped = originalRegistration;"
        : "\nexport function bypass(input) { return originalRegistration('first').create(input); }"));
      try {
        const report = built.inspect();
        const diagnostic = report.diagnostics.find((entry) => entry.rule === "A11" && entry.file === file);
        assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
        assert.ok(diagnostic.line > 0 && diagnostic.column > 0);
        assert.ok(diagnostic.trace.includes(file));
      } finally {
        if (original === undefined) built.files.delete(file);
        else built.files.set(file, original);
      }
      assert.equal(built.files.get(file), original);
      built.clean();
    });
  }
}
