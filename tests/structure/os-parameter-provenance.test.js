import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";
import { SourceModule, readParameters } from "../support/structure/source-reader.js";

const entry = "src/renamed-input.cjs";
function check(source) {
  const repository = new MemorySourceRepository([[entry, source]]);
  return new OsIndependenceChecker(repository, { files: [entry], entrypoints: [entry] }).check();
}
function rejectsNativePath(source) {
  const report = check(source);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.file === entry && item.line === 3),
    report.diagnostics.join("\n"));
}

test("a caller argument cannot hide a reassigned helper path at native I/O", () => {
  rejectsNativePath(`const fs = require('node:fs');
function selected(input) { input = '/proc/self/stat'; return input; }
fs.readFileSync(selected('snapshot.json'));`);
});

test("missing and explicit undefined arguments retain their default path at native I/O", () => {
  for (const args of ["", "undefined"]) {
    rejectsNativePath(`const fs = require('node:fs');
function selected(input = '/proc/self/stat') { return input; }
fs.readFileSync(selected(${args}));`);
  }
});

test("an explicit argument overrides a simple parameter default", () => {
  const report = check(`const fs = require('node:fs');
function selected(input = '/proc/self/stat') { return input; }
fs.readFileSync(selected('snapshot.json'));`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("an unsupported destructuring default retains its possible native OS path", () => {
  rejectsNativePath(`const fs = require('node:fs');
function selected({ file = '/proc/self/stat' } = {}) { return file; }
fs.readFileSync(selected({}));`);
});

test("write inspection selects exact local input bindings independently of names", () => {
  const module = new SourceModule("src/renamed-writes.js", `let input = 0;
input = 1;
function first(input) {
  input = 2;
}
function second(input) {
  input = 3;
}`);
  const first = module.bindingAt(readParameters(module.declaration("first").tokens)[0][0]);
  const second = module.bindingAt(readParameters(module.declaration("second").tokens)[0][0]);
  assert.notEqual(first, second);
  assert.deepEqual(module.bindingWrites([first]).map(write => write.token.line), [4]);
  assert.deepEqual(module.bindingWrites([second]).map(write => write.token.line), [7]);
  assert.deepEqual(module.bindingWrites(["input"]).map(write => write.token.line), [2]);
  assert.ok(module.bindingWrites([first]).every(write => write.binding === first));
});
