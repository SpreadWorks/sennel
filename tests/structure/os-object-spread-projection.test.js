import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-spread-projection.cjs";
function check(source) {
  const repository = new MemorySourceRepository([[entry, source]]);
  return new OsIndependenceChecker(repository, { files: [entry], entrypoints: [entry] }).check();
}
function refusesUnresolvedProjection(source) {
  const report = check(source);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some(item => item.classification === "incomplete" && item.rule === "OS02"),
    report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.every(item => item.rule !== "OS00"), report.diagnostics.join("\n"));
}
function detectsNativePath(source) {
  const report = check(source);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.classification === "violation"),
    report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.every(item => item.rule !== "OS00"), report.diagnostics.join("\n"));
}
function acceptsPortableProjection(source) {
  const report = check(source);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
}

test("a rewritten input spread refuses unresolved member provenance without exhausting the host stack", () => {
  refusesUnresolvedProjection(`const fs = require('node:fs');
function inspect(input) { input = {...input}; fs.readFileSync(input.file); }
inspect(runtimeInput);`);
});
test("a self-spread local write refuses unresolved member provenance without exhausting the host stack", () => {
  refusesUnresolvedProjection(`const fs = require('node:fs');
let input = {}; input = {...input}; fs.readFileSync(input.file);`);
});
test("mutual spread writes refuse unresolved member provenance without exhausting the host stack", () => {
  refusesUnresolvedProjection(`const fs = require('node:fs');
let first = {}; let second = {...first}; first = {...second}; fs.readFileSync(second.file);`);
});
test("a rightmost explicit native path remains visible after an unresolved spread write", () => {
  detectsNativePath(`const fs = require('node:fs');
function inspect(input) { input = {...input, file:'/proc/self/stat'}; fs.readFileSync(input.file); }
inspect(runtimeInput);`);
});
test("a finite spread chain retains a portable selected member", () => {
  acceptsPortableProjection(`const fs = require('node:fs');
const first = {file:'snapshot.json'}; const second = {...first}; const third = {...second}; fs.readFileSync(third.file);`);
});
test("a finite spread chain retains a native selected member", () => {
  detectsNativePath(`const fs = require('node:fs');
const first = {file:'/proc/self/stat'}; const second = {...first}; const third = {...second}; fs.readFileSync(third.file);`);
});
test("repeated sibling spreads may finish with absent members and use an earlier portable member", () => {
  acceptsPortableProjection(`const fs = require('node:fs');
const input = {other:1}; const output = {file:'snapshot.json', ...input, ...input}; fs.readFileSync(output.file);`);
});
test("a completed portable projection does not authorize a distinct call with a native path", () => {
  detectsNativePath(`const fs = require('node:fs');
function inspect(input) { const copy = {...input}; fs.readFileSync(copy.file); }
inspect({file:'snapshot.json'}); inspect({file:'/proc/self/stat'});`);
});
test("an unresolved rightmost spread cannot borrow an earlier portable member", () => {
  refusesUnresolvedProjection(`const fs = require('node:fs');
function inspect(input) { input = {file:'snapshot.json', ...input}; fs.readFileSync(input.file); }
inspect(runtimeInput);`);
});
