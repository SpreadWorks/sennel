import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-binding.cjs";
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

test("a field default cannot hide the supplied native path", () => {
  rejectsNativePath(`const fs = require('node:fs');
function selected({file = 'snapshot.json'} = {}) { return file; }
fs.readFileSync(selected({file:'/proc/self/stat'}));`);
});

test("nested binding defaults retain the supplied member path", () => {
  rejectsNativePath(`const fs = require('node:fs');
function selected({entry:{file} = {file:'snapshot.json'}} = {}) { return file; }
fs.readFileSync(selected({entry:{file:'/proc/self/stat'}}));`);
});

test("a nested object default retains the path selected from that default", () => {
  rejectsNativePath(`const fs = require('node:fs');
function selected({entry:{file} = {file:'/proc/self/stat'}} = {}) { return file; }
fs.readFileSync(selected({}));`);
});

test("an omitted object argument retains its selected default field", () => {
  rejectsNativePath(`const fs = require('node:fs');
function selected({file} = {file:'/proc/self/stat'}) { return file; }
fs.readFileSync(selected());`);
});

test("declaration defaults and argument defaults share native path projection", () => {
  rejectsNativePath(`const fs = require('node:fs');
const {file = 'snapshot.json'} = {file:'/proc/self/stat'};
fs.readFileSync(file);`);
});

test("known portable selected fields do not inherit an unused supplied field", () => {
  const report = check(`const fs = require('node:fs');
function selected({file = 'snapshot.json'} = {}) { return file; }
fs.readFileSync(selected({file:'actual.json', unused:'/proc/self/stat'}));`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});
