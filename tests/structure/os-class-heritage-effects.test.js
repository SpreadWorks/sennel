import assert from "node:assert/strict";
import { test } from "node:test";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";

const file = "src/heritage.js";
function inspect(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
}

for (const source of [
  "class Base {} function Factory(base){return base;} class Derived extends Factory(Base) {}",
  "class Base {} class Derived extends (Base) {}",
  "class Base {} const namespace={Base}; class Derived extends namespace.Base {}",
]) test(`inspected ordinary heritage retains its source origin: ${source}`, () => {
  const report = inspect(source);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.equal(report.complete, true);
});

for (const expression of ["Factory(Base)", "(Factory(Base))"]) {
  test(`resolved heritage factory retains its actual filesystem violation: ${expression}`, () => {
    const prefix = "import fs from 'node:fs'; class Base {} function Factory(base){";
    const suffix = `return base;} class Derived extends ${expression} {}`;
    const source = `${prefix}fs.readFileSync('/proc/self/stat');${suffix}`;
    const report = inspect(source);
    assert.equal(report.ok, false);
    assert.deepEqual(report.diagnostics.map(entry => [entry.rule, entry.file, entry.line, entry.column, entry.classification, entry.trace]),
      [["OS01", file, 1, prefix.length + 1, "violation", [file]]]);
    assert.equal(report.complete, true);
    const restored = inspect(`${prefix}${suffix}`);
    assert.equal(restored.ok, true, restored.diagnostics.join("\n"));
    assert.equal(restored.complete, true);
  });
}
