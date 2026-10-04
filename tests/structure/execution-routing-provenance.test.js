import assert from "node:assert/strict";
import { test } from "node:test";
import { StagedExecutionSeed } from "../fixtures/structure/staged-execution.js";
import { StructureChecker } from "../support/structure/checker.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";

function inspect(seed, files) {
  return new StructureChecker(seed.scope(), new MemorySourceRepository(files)).check();
}
function successful(report) {
  assert.equal(report.ok, true, report.diagnostics.map((diagnostic) => diagnostic.toString()).join("\n"));
}

test("one module can host another phase's registration consumer without granting it this phase's lookup", () => {
  const seed = new StagedExecutionSeed();
  const other = new StagedExecutionSeed("sigma", ["other"]);
  const files = seed.files();
  for (const [file, source] of other.files()) if (file.startsWith(other.entry) || file === other.composition) files.set(file, source);
  const file = seed.callers[1].module;
  files.set(file, `${files.get(file)}
    import { commandRegistration as otherRegistration } from '../engine/composition/sigma.js';
    function executeOtherPhase(input) {
      const registration = otherRegistration(input.stepId);
      const selection = registration.executionContract.select(input);
      return registration.executionContract.execute(selection, input);
    }`);
  successful(inspect(seed, files));
  const invalid = new Map(files);
  invalid.set(file, files.get(file).replace("const registration = otherRegistration", "const registration = commandRegistration"));
  const report = inspect(seed, invalid);
  const diagnostic = report.diagnostics.find((entry) => entry.rule === "A11" && entry.file === file
    && entry.message.includes("unregistered execution lookup caller or capability escape"));
  assert.ok(diagnostic, report.diagnostics.map((entry) => entry.toString()).join("\n"));
  assert.equal(diagnostic.line > 0, true);
  assert.equal(diagnostic.column > 0, true);
  assert.equal(diagnostic.trace.includes(file), true);
  successful(inspect(seed, files));
});


function capabilityViolation(report, file, tokenName, trace = []) {
  const diagnostic = report.diagnostics.find((entry) => entry.rule === "A11" && entry.file === file
    && entry.message.includes("unregistered execution lookup caller or capability escape"));
  assert.ok(diagnostic, report.diagnostics.map((entry) => entry.toString()).join("\n"));
  assert.equal(report.ok, false);
  assert.equal(diagnostic.line > 0, true);
  assert.equal(diagnostic.column > 0, true);
  if (tokenName) assert.equal(diagnostic.message.includes(tokenName), true);
  for (const hop of [file, ...trace]) assert.equal(diagnostic.trace.includes(hop), true);
}

const arrayUses = [
  ["indexed registration", "const registration = selected[0]; return registration.executionContract.execute(input.selection, input);"],
  ["computed registration", "const registration = selected[input.index]; return registration.executionContract.execute(input.selection, input);"],
  ["optional computed registration", "return selected?.[input.index]?.executionContract?.execute(input.selection, input);"],
  ["destructured registration", "const [registration] = selected; return registration.executionContract.execute(input.selection, input);"],
  ["immutable alias chain", "const first = selected; const second = first; return second[0].executionContract.execute(input.selection, input);"],
  ["mutable alias", "let alias = selected; return alias[0].executionContract.execute(input.selection, input);"],
  ["collection lookup", "const registration = selected.find((entry) => entry.stepId === input.stepId); return registration.executionContract.execute(input.selection, input);"],
  ["collection delegation", "return selected.map((registration) => registration.executionContract.execute(input.selection, input));"],
  ["computed collection method", "return selected[input.method](input);"],
  ["capability argument escape", "return external(selected, input);"],
  ["capability return escape", "return selected;"],
  ["capability capture", "return () => selected;"],

];

for (const [name, body] of arrayUses) {
  test(`selected registration array rejects unregistered ${name} and accepts restoration`, () => {
    const seed = new StagedExecutionSeed();
    const files = seed.files();
    const file = seed.callers[1].module;
    const source = files.get(file);
    successful(inspect(seed, files));
    files.set(file, `${source}
      import { registrations as selected } from '../engine/composition/${seed.phase}.js';
      export function bypass(input) { ${body} }`);
    capabilityViolation(inspect(seed, files), file, null, [seed.composition]);
    files.set(file, source);
    successful(inspect(seed, files));
  });
}

for (const [name, body] of [
  ["registration array", "return registry.registrations[0].executionContract.execute(input.selection, input);"],
  ["computed registration array", "return registry['registrations'][input.index].executionContract.execute(input.selection, input);"],
  ["computed export name", "return registry[input.exportName][0].executionContract.execute(input.selection, input);"],
  ["namespace destructuring", "const { registrations: selected } = registry; return selected[0].executionContract.execute(input.selection, input);"],
  ["namespace alias", "const alias = registry; return alias.registrations[0].executionContract.execute(input.selection, input);"],
]) {
  test(`selected registration namespace rejects unregistered ${name} and accepts restoration`, () => {
    const seed = new StagedExecutionSeed();
    const files = seed.files();
    const file = "src/flow/lib/unregistered-array.js";
    files.set(file, `import * as registry from '../engine/composition/${seed.phase}.js';
      export function bypass(input) { ${body} }`);
    capabilityViolation(inspect(seed, files), file, null, [seed.composition]);
    files.delete(file);
    successful(inspect(seed, files));
  });
}

for (const [name, declaration, imported] of [
  ["named alias", "export { registrations as selected }", "{ selected }"],
  ["default alias", "export { registrations as default }", "selected"],
  ["wildcard", "export *", "{ registrations as selected }"],
  ["namespace", "export * as selected", "{ selected }"],
]) {
  test(`selected registration capability follows lawful ${name} re-export to a downstream bypass`, () => {
    const seed = new StagedExecutionSeed();
    const files = seed.files();
    const barrel = "src/flow/lib/array-barrel.js";
    const forward = "src/flow/lib/array-forward.js";
    const file = "src/flow/lib/unregistered-array.js";
    const publicArray = "src/flow/lib/public-array.js";
    files.set(publicArray, `export { registrations } from '../engine/composition/${seed.phase}.js';`);
    files.set(barrel, `${declaration} from './public-array.js';`);
    files.set(forward, `export ${name === "default alias" ? "{ default }" : "*"} from './array-barrel.js';`);
    files.set(file, `import ${imported} from './array-forward.js';
      export function bypass(input) { return selected${name === "namespace" ? ".registrations" : ""}[0].executionContract.execute(input.selection, input); }`);
    successful(inspect(seed, new Map([...files].filter(([entry]) => entry !== file))));
    const report = inspect(seed, files);
    capabilityViolation(report, file, "selected", [forward, barrel, seed.composition]);
    for (const entry of [publicArray, barrel, forward, file]) files.delete(entry);
    successful(inspect(seed, files));
  });
}

test("selected registration array cannot be exported through a local alias without a call", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  const file = "src/flow/lib/array-alias.js";
  files.set(file, `import { registrations as selected } from '../engine/composition/${seed.phase}.js';
    const alias = selected; export { alias };`);
  capabilityViolation(inspect(seed, files), file, null, [seed.composition]);
  files.delete(file);
  successful(inspect(seed, files));
});

test("another phase's registration array and ordinary contract values remain usable in the same execution module", () => {
  const seed = new StagedExecutionSeed();
  const other = new StagedExecutionSeed("sigma", ["other"]);
  const files = seed.files();
  for (const [file, source] of other.files()) if (file.startsWith(other.entry) || file === other.composition) files.set(file, source);
  const file = seed.callers[1].module;
  files.set(file, `${files.get(file)}
    import { registrations as selected } from '../engine/composition/sigma.js';
    function executeOtherPhase(input) { return selected[0].executionContract.execute(input.selection, input); }
    function consumeValue(input) { return input.executionContract.execute(input.selection, input); }`);
  successful(inspect(seed, files));
  const invalid = new Map(files);
  invalid.set(file, files.get(file).replace("registrations as selected } from '../engine/composition/sigma.js'",
    `registrations as selected } from '../engine/composition/${seed.phase}.js'`));
  capabilityViolation(inspect(seed, invalid), file, "selected", [seed.composition]);
  successful(inspect(seed, files));
});

test("imported capability identity distinguishes local shadows, property names, and independent parameter bindings", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  const file = "src/flow/lib/array-shadows.js";
  files.set(file, `import { registrations as selected, commandRegistration } from '../engine/composition/${seed.phase}.js';
    import * as registry from '../engine/composition/${seed.phase}.js';
    function independent(selected, commandRegistration, registry) { return [selected[0].executionContract.execute(), commandRegistration(), registry.registrations]; }
    function local() { const selected = []; const commandRegistration = () => null; const registry = {}; return [selected, commandRegistration(), registry]; }
    const metadata = { selected: 'value', commandRegistration: 'lookup', registry: 'namespace' };`);
  successful(inspect(seed, files));
  const invalid = new Map(files);
  invalid.set(file, `${files.get(file)}\nfunction captured() { return selected[0]; }`);
  capabilityViolation(inspect(seed, invalid), file, "selected", [seed.composition]);
  successful(inspect(seed, files));
});

test("a target capability in an unsupported lexical shape fails with an incomplete A11 inspection", () => {
  const seed = new StagedExecutionSeed();
  const files = seed.files();
  const file = "src/flow/lib/array-unsupported.js";
  files.set(file, `import { registrations as selected } from '../engine/composition/${seed.phase}.js';
    function bypass() { var registration = selected[0]; return registration.executionContract.execute(); }`);
  const report = inspect(seed, files);
  const diagnostic = report.diagnostics.find((entry) => entry.rule === "A11" && entry.file === file
    && entry.message.includes("cannot inspect execution capability bindings"));
  assert.ok(diagnostic, report.diagnostics.map((entry) => entry.toString()).join("\n"));
  assert.equal(diagnostic.line, 2);
  assert.equal(diagnostic.column > 0, true);
  files.delete(file);
  successful(inspect(seed, files));
});


test("selected registration provenance comes from the validated collection binding rather than its spelling", () => {
  const seed = new StagedExecutionSeed("renamed-phase");
  const files = seed.files();
  files.set(seed.composition, files.get(seed.composition).replaceAll("registrations", "chosenSteps"));
  successful(inspect(seed, files));
  const file = "src/flow/lib/renamed-array.js";
  files.set(file, `import { chosenSteps as selected } from '../engine/composition/${seed.phase}.js';
    export function bypass(input) { const registration = selected[0]; return registration.executionContract.execute(input.selection, input); }`);
  capabilityViolation(inspect(seed, files), file, null, [seed.composition]);
  files.delete(file);
  successful(inspect(seed, files));
});
