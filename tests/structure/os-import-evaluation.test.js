import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-imports.js";
function check(source) {
  const repository = new MemorySourceRepository([[entry, source]]);
  return new OsIndependenceChecker(repository, { files: [entry], entrypoints: [entry] }).check();
}
function repeatedImports(file, first = "input-0.json") {
  const metadata = Array.from({ length: 900 }, () => "fs").join(",");
  const calls = Array.from({ length: 8 }, (_, index) =>
    `fs.readFileSync(selected(${JSON.stringify(index === 0 ? first : `input-${index}.json`)})[0]);`).join("\n");
  return `import fs from 'node:fs';
function selected(input) { return [input, ${metadata}]; }
${calls}
fs.readFileSync(selected(${JSON.stringify(file)})[0]);`;
}
function nativePathLines(report) {
  return report.diagnostics.filter(item => item.rule === "OS01" && item.classification === "violation")
    .map(item => { assert.equal(item.file, entry); return item.line; });
}

test("repeated immutable imports across helpers permit complete inspection", () => {
  const report = check(repeatedImports("snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("repeated imports retain a later native path observation", () => {
  const report = check(repeatedImports("/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.deepEqual(nativePathLines(report), [11]);
});

test("each source consumer remains observed after import reuse", () => {
  const report = check(repeatedImports("/sys/kernel", "/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.deepEqual(nativePathLines(report), [3, 11]);
});

test("a helper parameter shadowing an import retains its own changing input", () => {
  const report = check(`import fs from 'node:fs';
import selectedPath from 'node:path';
function selected(selectedPath) { return selectedPath; }
fs.readFileSync(selected('snapshot.json'));
fs.readFileSync(selected('/proc/self/stat'));`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.deepEqual(nativePathLines(report), [5]);
});
