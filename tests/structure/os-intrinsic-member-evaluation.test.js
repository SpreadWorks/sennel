import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-intrinsic-members.cjs";
function check(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[entry, source]]), {
    files: [entry], entrypoints: [entry],
  }).check();
}
const fields = 3000;
function repeatedSource(file, stat = false) {
  const values = Array.from({ length: fields }, () => "input.size").join(",");
  return `const fs = require('node:fs');
function metadata(input) { return [${values}]; }
metadata(${stat ? "fs.lstatSync('snapshot.json')" : "unresolvedInput"});
fs.readFileSync(${JSON.stringify(file)});`;
}
function sink(report, line, classification = "violation") {
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === line
    && item.classification === classification), report.diagnostics.join("\n"));
}

test("unwritten unknown input members permit complete finite source inspection", () => {
  const report = check(repeatedSource("snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});

test("unknown input member parsing reaches a later actual filesystem sink", () => {
  const report = check(repeatedSource("/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 4);
});

test("actual stat data members permit complete finite source inspection", () => {
  const report = check(repeatedSource("snapshot.json", true));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});

test("actual stat data member parsing reaches the later filesystem sink", () => {
  const report = check(repeatedSource("/proc/self/stat", true));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 4);
});

test("object getter member resolution still executes each actual captured caller context", () => {
  const report = check(`const fs = require('node:fs');
function metadata(file) { return { get value() { fs.readFileSync(file); return 0; } }; }
function read(input) { return input.value; }
read(metadata('snapshot.json'));
read(metadata('/proc/self/stat'));`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 2);
});

test("class getter member resolution retains the actual constructor input", () => {
  const report = check(`const fs = require('node:fs');
class Metadata { constructor(file) { this.file = file; }
get value() { fs.readFileSync(this.file); return 0; } }
function read(input) { return input.value; }
read(new Metadata('snapshot.json'));
read(new Metadata('/proc/self/stat'));`);
  sink(report, 3);
});

test("uncertain member receivers retain unresolved native path refusal", () => {
  const report = check(`const fs = require('node:fs');
function read(input) { return input.value; }
const selected = condition ? { value: '/proc/self/stat' } : { value: 'snapshot.json' };
fs.readFileSync(read(selected));`);
  assert.equal(report.complete, false);
  sink(report, 4, "incomplete");
});

test("written member receivers retain unresolved native path refusal", () => {
  const report = check(`const fs = require('node:fs');
function read(input) { input = { value: '/proc/self/stat' }; return input.value; }
fs.readFileSync(read({ value: 'snapshot.json' }));`);
  assert.equal(report.complete, false);
  sink(report, 3, "incomplete");
});

test("a builtin input shadowing a global retains its actual filesystem method", () => {
  const report = check(`const fs = require('node:fs');
function read(process) { return process.readFileSync; }
read(fs)('/proc/self/stat');`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 3);
});

test("stat mode projection retains authority provenance at the actual condition", () => {
  const report = check(`const fs = require('node:fs');
function read(input) { return input.mode; }
if (read(fs.statSync('snapshot.json')) === 0o755) action();`);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS03" && item.line === 3), report.diagnostics.join("\n"));
});

test("literal method projection retains the original path at its actual consumer", () => {
  const report = check(`const fs = require('node:fs');
function read(input) { return input.trim; }
const selected = read('/proc/self/stat');
fs.readFileSync(selected());`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 4);
});

test("computed builtin members retain the actual filesystem violation", () => {
  const report = check(`const fs = require('node:fs');
function read(input) { return input['readFileSync']; }
read(fs)('/proc/self/stat');`);
  assert.equal(report.complete, true);
  assert.equal(report.ok, false);
  assert.deepEqual(report.diagnostics.map(item => [item.rule, item.file, item.line, item.column, item.classification, item.trace]),
    [["OS01", entry, 3, 1, "violation", [entry]]]);
});

test("optional builtin members retain their actual filesystem consumer", () => {
  const report = check(`const fs = require('node:fs');
function read(input) { return input?.readFileSync; }
read(fs)('/proc/self/stat');`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 3);
});

test("source getter member evaluation retains the original finite work refusal", () => {
  const values = Array.from({ length: fields }, () => "input.value").join(",");
  const report = check(`function metadata(input) { return [${values}]; }
metadata({ get value() { return 'snapshot.json'; } });`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS00" && item.classification === "incomplete"
    && item.message.includes("finite per-module work budget")), report.diagnostics.join("\n"));
});
