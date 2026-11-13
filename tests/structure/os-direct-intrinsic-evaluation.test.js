import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-direct-intrinsics.cjs";
function check(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[entry, source]]), {
    files: [entry], entrypoints: [entry],
  }).check();
}
function sink(report, line, classification = "violation") {
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === line
    && item.classification === classification), report.diagnostics.join("\n"));
}
function repeatedConstructors(file) {
  const calls = Array.from({ length: 1500 }, () => "metadata()").join(",");
  return `const fs = require('node:fs');
function metadata() { return new Error('entry'); }
function visit() { return [${calls}]; }
visit();
fs.readFileSync(${JSON.stringify(file)});`;
}

test("repeated intrinsic constructors complete within the original work budget", () => {
  const report = check(repeatedConstructors("snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});
test("repeated intrinsic constructors retain a later actual filesystem sink", () => {
  const report = check(repeatedConstructors("/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 5);
});
test("direct calls resolve the actual callee again after an unknown input", () => {
  const report = check(`const fs = require('node:fs');
function read(input, file) { return input(file); }
read(unresolvedInput, 'snapshot.json');
read(fs.readFileSync, '/proc/self/stat');`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 2);
});
test("direct constructors resolve the actual callee again after an unknown input", () => {
  const report = check(`const fs = require('node:fs');
function read(input, file) { return new input(file); }
read(unresolvedInput, 'snapshot.json');
read(fs.readFileSync, '/proc/self/stat');`);
  sink(report, 2);
});
test("source callables supplied after unknown inputs still execute their bodies", () => {
  const report = check(`const fs = require('node:fs');
function consume(file) { fs.readFileSync(file); return 0; }
function read(input, file) { return input(file); }
read(unresolvedInput, 'snapshot.json');
read(consume, '/proc/self/stat');`);
  sink(report, 2, "incomplete");
});
test("a source function shadowing Error retains its actual body", () => {
  const report = check(`const fs = require('node:fs');
function Error(file) { fs.readFileSync(file); return 0; }
function read(file) { return new Error(file); }
read('/proc/self/stat');`);
  sink(report, 2);
});
test("direct intrinsic arguments execute their actual helper effects", () => {
  const report = check(`const fs = require('node:fs');
function consume(file) { fs.readFileSync(file); return 0; }
function read(input, file) { return new Error(consume(file)); }
read(unresolvedInput, 'snapshot.json');
read(unresolvedInput, '/proc/self/stat');`);
  sink(report, 2);
});
test("direct unknown consumers still refuse an escaping filesystem capability", () => {
  const report = check(`const fs = require('node:fs');
function read(input, callback) { return input(callback); }
read(unresolvedInput, fs.readFileSync);`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.line === 2 && item.classification === "incomplete"
    && ["OS01", "OS02"].includes(item.rule)), report.diagnostics.join("\n"));
});
test("written direct callee inputs retain their unresolved capability refusal", () => {
  const report = check(`const fs = require('node:fs');
function read(input, file) { input = fs.readFileSync; return input(file); }
read(unresolvedInput, '/proc/self/stat');`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.line === 2 && item.classification === "incomplete"), report.diagnostics.join("\n"));
});
test("an intrinsic constructor with a suffix retains the consumed native path", () => {
  const report = check(`const fs = require('node:fs');
function read(file) { return new URL(file).pathname; }
fs.readFileSync(read('file:///proc/self/stat'));`);
  sink(report, 3);
});
test("direct source helpers retain the original finite work refusal", () => {
  const calls = Array.from({ length: 3000 }, () => "input()").join(",");
  const report = check(`function inspect(input) { return [${calls}]; }
inspect(() => 0);`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS00" && item.classification === "incomplete"
    && item.message.includes("finite per-module work budget")), report.diagnostics.join("\n"));
});

test("imported direct filesystem calls retain the actual native path", () => {
  const report = check(`import { readFileSync as read } from 'node:fs';
function inspect(file) { return read(file); }
inspect('/proc/self/stat');`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 2);
});
