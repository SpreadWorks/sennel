import assert from "node:assert/strict";
import { test } from "node:test";
import * as reader from "../support/structure/source-reader.js";
import { StructureChecker, StructureScope } from "../support/structure/checker.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";

for (const expression of ["Base", "Factory(Base)", "namespace.Base", "namespace['Base']",
  "(Base)", "(choose ? First : Second)", "Factory({ value: '{' }, Base)", "(class {})"]) {
  test(`class metadata preserves the complete heritage expression: ${expression}`, () => {
    const module = new reader.SourceModule("heritage.js",
      `class Derived extends ${expression} { static dependencies = [Dependency]; value() { return 1; } }`);
    const entry = module.classes.find(value => value.name === "Derived");
    assert.ok(entry);
    assert.deepEqual(entry.heritage.tokens.map(token => [token.kind, token.value]),
      reader.readTokens(expression).map(token => [token.kind, token.value]));
    assert.equal(entry.parent, expression === "Base" ? "Base" : null);
    assert.equal(entry.heritage.token, entry.heritage.tokens[0]);
    assert.equal(entry.parentToken, entry.heritage.token);
    assert.equal(Object.isFrozen(entry.heritage.tokens), true);
    assert.deepEqual(entry.dependencies, ["Dependency"]);
  });
}

test("classes without extends retain absent heritage", () => {
  const module = new reader.SourceModule("heritage.js", "class Plain {} const value = class {};");
  assert.deepEqual(module.classes.map(entry => entry.parent), [null, null]);
  assert.deepEqual(module.classes.map(entry => entry.heritage), [null, null]);
});

for (const expression of ["Factory(Base)", "namespace.Base", "(Base)"]) {
  test(`unresolved heritage remains a located architecture refusal: ${expression}`, () => {
    const file = "src/flow/steps/alpha/value.js";
    const source = `export class Derived extends ${expression} {}`;
    const inspect = text => new StructureChecker(new StructureScope(".", "src/flow/steps/alpha", []),
      new MemorySourceRepository([[file, text]])).check();
    const report = inspect(source);
    assert.ok(report.diagnostics.some(entry => entry.rule === "A01" && entry.file === file
      && entry.line === 1 && entry.column === source.indexOf(expression) + 1
      && entry.message.includes("cannot resolve class heritage")), report.diagnostics.join("\n"));
    const restored = inspect("export class Derived {}");
    assert.equal(restored.diagnostics.some(entry => entry.message.includes("class heritage")), false,
      restored.diagnostics.join("\n"));
  });
}
