import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const file = "src/renamed-conditional-boundary.mjs";
function check(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
}
test("an independently scanned true branch ends at its matching colon", () => {
  const report = check(`import fs from 'node:fs';
const read = selected ? fs.readFileSync : fs.readFileSync;
read('snapshot.json');`);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.equal(report.complete, true);
});
test("a conditional boundary does not hide a later native consumer", () => {
  const report = check(`import fs from 'node:fs';
const read = selected ? fs.readFileSync : fs.readFileSync;
read('/proc/self/stat');`);
  assert.equal(report.ok, false);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some(entry => entry.rule === 'OS01' && entry.file === file && entry.line === 3
    && entry.classification === 'violation'), report.diagnostics.join('\n'));
});
for (const [mutation, args] of [
  ["set", "path, 'normalize', foreign"],
  ["defineProperty", "path, 'normalize', {value:foreign}"],
  ["deleteProperty", "path, 'normalize'"],
  ["setPrototypeOf", "path, foreign"],
]) {
  test("reflective native mutation remains incomplete: " + mutation, () => {
    const report = check(`import path from 'node:path';\nReflect.${mutation}(${args});`);
    assert.equal(report.ok, false);
    assert.equal(report.complete, false);
    assert.ok(report.diagnostics.some(entry => entry.rule === 'OS04' && entry.file === file && entry.line === 2
      && entry.classification === 'incomplete'), report.diagnostics.join('\n'));
  });
}
