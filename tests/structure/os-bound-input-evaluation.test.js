import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-bound-input.js";
function check(file) {
  const metadata = Array.from({ length: 900 }, () => "input").join(",");
  const calls = Array.from({ length: 8 }, (_, index) =>
    `fs.readFileSync(selected('input-${index}.json')[0]);`).join("\n");
  const source = `import fs from 'node:fs';
function selected(input) { return [input, ${metadata}]; }
${calls}
fs.readFileSync(selected(${JSON.stringify(file)})[0]);`;
  const repository = new MemorySourceRepository([[entry, source]]);
  return new OsIndependenceChecker(repository, { files: [entry], entrypoints: [entry] }).check();
}

test("repeated reads of unwritten helper inputs permit complete source inspection", () => {
  const report = check("snapshot.json");
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("reusing a bound input preserves the later caller's native path", () => {
  const report = check("/proc/self/stat");
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  const violations = report.diagnostics.filter(item => item.rule === "OS01" && item.classification === "violation");
  assert.equal(violations.length, 1, report.diagnostics.join("\n"));
  assert.equal(violations[0].file, entry);
  assert.equal(violations[0].line, 11);
  assert.deepEqual(violations[0].trace, [entry]);
});
