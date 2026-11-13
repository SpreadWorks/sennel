import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

function metadataSource(file) {
  const fields = Array.from({ length: 900 }, (_, index) => JSON.stringify(`field-${index}`)).join(",");
  return `const fs = require('node:fs');
function metadata(input) { return [input, ${fields}]; }
const selected = [metadata('first.json'), metadata('second.json'), metadata('third.json')];
console.log(selected);
fs.readFileSync(metadata(${JSON.stringify(file)})[0]);`;
}

function check(file) {
  const entry = "src/renamed-metadata.cjs";
  const repository = new MemorySourceRepository([[entry, metadataSource(file)]]);
  return new OsIndependenceChecker(repository, { files: [entry], entrypoints: [entry] }).check();
}

test("repeated literal metadata across helper calls permits complete source inspection", () => {
  const report = check("snapshot.json");
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("repeated metadata does not hide a later environment-dependent OS path violation", () => {
  const report = check("/proc/self/stat");
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  const violation = report.diagnostics.find(item => item.rule === "OS01" && item.classification === "violation");
  assert.ok(violation, report.diagnostics.join("\n"));
  assert.equal(violation.file, "src/renamed-metadata.cjs");
  assert.equal(violation.line, 5);
  assert.deepEqual(violation.trace, ["src/renamed-metadata.cjs"]);
});
