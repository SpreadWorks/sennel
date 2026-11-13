import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-selection.cjs";
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

test("member reads retain path alternatives returned by a helper", () => {
  rejectsNativePath(`const fs = require('node:fs');
function selected(flag) { if (flag) return {file:'/proc/self/stat'}; return {file:'snapshot.json'}; }
fs.readFileSync(selected(input).file);`);
});

test("member reads retain path alternatives from a conditional expression", () => {
  rejectsNativePath(`const fs = require('node:fs');
const selected = input ? {file:'/proc/self/stat'} : {file:'snapshot.json'};
fs.readFileSync(selected.file);`);
});

test("nested member reads retain the chosen aggregate path", () => {
  rejectsNativePath(`const fs = require('node:fs');
function selected(flag) { if (flag) return {entry:{file:'/proc/self/stat'}}; return {entry:{file:'snapshot.json'}}; }
fs.readFileSync(selected(input).entry.file);`);
});

test("portable selected members do not inherit an unused data field path", () => {
  const report = check(`const fs = require('node:fs');
function selected(flag) { if (flag) return {file:'first.json', unused:'/proc/self/stat'}; return {file:'second.json', unused:'/proc/self/stat'}; }
fs.readFileSync(selected(input).file);`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("ordinary object member path inspection still reports native OS use", () => {
  rejectsNativePath(`const fs = require('node:fs');
function selected() { return {file:'/proc/self/stat'}; }
fs.readFileSync(selected().file);`);
});

test("selected getter members retain their statically inspected path", () => {
  rejectsNativePath(`const fs = require('node:fs');
function selected(flag) { if (flag) return {get file(){return '/proc/self/stat';}}; return {file:'snapshot.json'}; }
fs.readFileSync(selected(input).file);`);
});
