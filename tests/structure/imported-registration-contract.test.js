import assert from "node:assert/strict";
import { test } from "node:test";
import { StagedExecutionSeed } from "../fixtures/structure/staged-execution.js";
import { ExecutionLoader, NamedExecutionShape, StructureScopeContract } from "../support/structure/production-registrations.js";
import { StructureChecker, StructureScope } from "../support/structure/checker.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";

for (const phase of ["omega", "sigma"]) {
  test(`imported immutable ${phase} registrations retain identity and fail closed on changed selection`, () => {
    const seed = new StagedExecutionSeed(phase);
    const files = seed.files();
    const primary = seed.composition;
    const shared = `src/flow/engine/composition/${phase}-source.js`;
    const original = files.get(primary);
    const declaration = original.match(/export const registrations = \[([\s\S]*?)\];/);
    assert.ok(declaration);
    files.set(shared, original.replace(declaration[0], `export const registrations = Object.freeze([${declaration[1]}]);`)
      .replaceAll("commandRegistration", "sourceRegistration"));
    files.set(primary, `import { sourceRegistration } from './${phase}-source.js';\n`
      + original.replace(declaration[0], `export const registrations = Object.freeze([${seed.ids.map((id) => `sourceRegistration('${id}')`).join(",")}]);`));
    const inspect = (sources) => new StructureChecker(seed.scope(), new MemorySourceRepository(sources)).check();
    const success = (sources) => {
      const report = inspect(sources);
      assert.equal(report.ok, true, report.diagnostics.map((entry) => entry.toString()).join("\n"));
    };
    success(files);
    for (const [file, before, after, rule, diagnosticFile] of [
      [shared, "return byId.get(stepId) ?? null;", "return stepId === 'first' ? byId.get(stepId) : null;", "A10", primary],
      [shared, "Object.freeze([", "([", "A10", primary],
      [shared, "return byId.get(stepId) ?? null;", "return byId.get(stepId) ?? null; } byId.set('first', null); function extra() {", "A10", primary],
      [primary, "sourceRegistration('second')", "sourceRegistration('first')", "A10", primary],
      [primary, "sourceRegistration('second')", "sourceRegistration('unknown')", "A10", primary],
      [primary, "sourceRegistration('second')", "sourceRegistration(input.stepId)", "A10", primary],
      [shared, "prepareServiceArguments, executionContract", "prepareOtherArguments, executionContract", "A08", shared],
    ]) {
      const originalSource = files.get(file);
      assert.ok(originalSource.includes(before));
      const changed = new Map(files);
      changed.set(file, originalSource.replace(before, after));
      const report = inspect(changed);
      const diagnostic = report.diagnostics.find((entry) => entry.rule === rule && entry.file === diagnosticFile);
      assert.ok(diagnostic, `${before}: ${report.diagnostics.map((entry) => entry.toString()).join("\n")}`);
      assert.ok(diagnostic.line > 0 && diagnostic.column > 0);
      assert.ok(diagnostic.trace.includes(diagnosticFile));
      success(files);
    }
  });
}

test("named loader metadata binds one exact command descriptor and rejects unknown routes", () => {
  const seed = new StagedExecutionSeed();
  const source = seed.shape;
  const originalLoader = source.loaders[0];
  const loader = new ExecutionLoader(originalLoader.module, originalLoader.declarationName,
    originalLoader.commandModule, "run", "execute");
  const shape = new NamedExecutionShape(source.form, source.adapterModule, source.contractName,
    source.selectorName, source.projectorName, source.executorName, source.callers, [loader]);
  const scope = new StructureScope("/virtual", seed.entry, seed.registrations, seed.composition,
    new StructureScopeContract(seed.definition, [shape], seed.registrations));
  const files = seed.files();
  const original = files.get(loader.module)
    + "export const FLOW_COMMANDS = { run: { execute: { command: loadCommand } } };";
  files.set(loader.module, original);
  const inspect = () => new StructureChecker(scope, new MemorySourceRepository(files)).check();
  assert.equal(inspect().ok, true);
  for (const invalid of [
    original.replace("command: loadCommand", "command: loadOtherCommand"),
    original.replace("execute: { command: loadCommand }", "execute: { command: loadCommand }, execute: { command: loadCommand }"),
    original.replace("execute:", "[dynamicName]:"),
  ]) {
    files.set(loader.module, invalid);
    const diagnostic = inspect().diagnostics.find((entry) => entry.rule === "A11" && entry.file === loader.module);
    assert.ok(diagnostic);
    assert.ok(diagnostic.line > 0 && diagnostic.column > 0);
    files.set(loader.module, original);
    assert.equal(inspect().ok, true);
  }
});
