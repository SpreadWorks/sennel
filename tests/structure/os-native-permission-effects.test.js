import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";
import { SourceFixtureCase } from "../support/structure/source-fixture-variants.js";

const groups = JSON.parse(fs.readFileSync(new URL("../fixtures/os-native-permission-effects.json", import.meta.url), "utf8"));
const cases = SourceFixtureCase.read(groups);

function inspect(file, source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
}
function assertNormal(report, description) {
  assert.equal(report.ok, true, `${description}\n${report.diagnostics.join("\n")}`);
  assert.equal(report.complete, true);
  assert.deepEqual(report.diagnostics, []);
}

for (const fixture of cases) test(`native metadata effect: ${fixture.name}`, () => {
  const report = inspect(fixture.file, fixture.input.render());
  assert.deepEqual(report.diagnostics.filter(diagnostic => diagnostic.rule === "OS00"), [], report.diagnostics.join("\n"));
  if (fixture.positive) assertNormal(report, fixture.name);
  else {
    assert.equal(report.ok, false);
    assert.ok(report.diagnostics.some(diagnostic => diagnostic.file === fixture.file && fixture.expected.matches(diagnostic)),
      `required rule at its protected consumer: ${fixture.name}\n${report.diagnostics.join("\n")}`);
  }
  assert.equal(report.complete, fixture.complete, "preserve the source's complete/violation distinction");
  if (fixture.normal !== null) assertNormal(inspect(fixture.file, fixture.normal.render()), fixture.normalKind);
  if (fixture.unsupported !== null) {
    // An ordinary value in a changed array remains outside the bounded native
    // array model. Removing the mutation above is a distinct normal input.
    const control = inspect(fixture.file, fixture.unsupported.render());
    assert.equal(control.ok, false);
    assert.equal(control.complete, false);
    assert.ok(control.diagnostics.some(diagnostic => diagnostic.file === fixture.file && fixture.unsupportedExpected.matches(diagnostic)),
      control.diagnostics.join("\n"));
  }
});
