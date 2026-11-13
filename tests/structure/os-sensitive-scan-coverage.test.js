import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-sensitive-coverage.cjs";
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
function repeatedSource(file) {
  const terms = Array.from({ length: 128 }, () => "input.mode").join(" | ");
  return `const fs = require('node:fs');
function inspect(input) { const combined = ${terms}; return false; }
inspect(fs.statSync('snapshot.json'));
fs.readFileSync(${JSON.stringify(file)});`;
}

test("completed sensitive expression coverage avoids repeated suffix inspection within the finite budget", () => {
  const report = check(repeatedSource("snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});

test("sensitive suffix inspection reaches a later actual filesystem consumer", () => {
  const report = check(repeatedSource("/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 4);
});

test("completed sensitive coverage retains authority at its actual selection", () => {
  const report = check(`const fs = require('node:fs');
function bits(input) { return input.mode | input.mode; }
if (bits(fs.statSync('snapshot.json'))) action();`);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS03" && item.line === 3), report.diagnostics.join("\n"));
});

test("sensitive returned results remain refused at an uninspected consumer", () => {
  const report = check(`const fs = require('node:fs');
function bits(input) { return input.mode | input.mode; }
opaque(bits(fs.statSync('snapshot.json')));`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS02" && item.line === 3
    && item.classification === "incomplete" && item.message.includes("uninspected consumer")), report.diagnostics.join("\n"));
});

test("sensitive getter inspection retains each actual captured caller input", () => {
  const report = check(`const fs = require('node:fs');
function metadata(file) { return { get mode() { fs.readFileSync(file); return fs.statSync('snapshot.json').mode; } }; }
function inspect(input) { const combined = input.mode | input.mode; return false; }
inspect(metadata('snapshot.json'));
inspect(metadata('/proc/self/stat'));`);
  sink(report, 2);
});

test("sensitive class getters retain their constructor input", () => {
  const report = check(`const fs = require('node:fs');
class Metadata { constructor(file) { this.file = file; }
get mode() { fs.readFileSync(this.file); return fs.statSync('snapshot.json').mode; } }
function inspect(input) { const combined = input.mode | input.mode; return false; }
inspect(new Metadata('snapshot.json'));
inspect(new Metadata('/proc/self/stat'));`);
  sink(report, 3);
});

test("sensitive coverage does not combine separate filesystem call environments", () => {
  const report = check(`const fs = require('node:fs');
function inspect(input, file) { const combined = input.mode | input.mode; fs.readFileSync(file); return false; }
inspect(fs.statSync('snapshot.json'), 'snapshot.json');
inspect(fs.statSync('snapshot.json'), '/proc/self/stat');`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 2);
});

test("written inputs retain unresolved native path refusal", () => {
  const report = check(`const fs = require('node:fs');
function inspect(input) { input = '/proc/self/stat'; return input; }
fs.readFileSync(inspect('snapshot.json'));`);
  assert.equal(report.complete, false);
  sink(report, 3, "incomplete");
});

test("sensitive values do not hide an unvisited callback body", () => {
  const report = check(`const fs = require('node:fs');
function inspect(input) { opaque(input.mode, () => fs.readFileSync('/proc/self/stat')); return false; }
inspect(fs.statSync('snapshot.json'));`);
  sink(report, 2);
});

test("sensitive coverage retains a later independent body observation", () => {
  const report = check(`const fs = require('node:fs');
function inspect(input) { const combined = input.mode | input.mode; fs.readFileSync('/proc/self/stat'); return false; }
inspect(fs.statSync('snapshot.json'));`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 2);
});

test("uncertain returned capabilities retain their native consumer refusal", () => {
  const report = check(`const fs = require('node:fs');
function inspect(input) { return condition ? input : '/proc/self/stat'; }
fs.readFileSync(inspect('snapshot.json'));`);
  assert.equal(report.complete, false);
  sink(report, 3, "incomplete");
});

test("distinct source getter reads retain the original finite work refusal", () => {
  const reads = Array.from({ length: 3000 }, () => "input.mode").join(",");
  const report = check(`const fs = require('node:fs');
function inspect(input) { return [${reads}]; }
inspect({ get mode() { return fs.statSync('snapshot.json').mode; } });`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS00" && item.classification === "incomplete"
    && item.message.includes("finite per-module work budget")), report.diagnostics.join("\n"));
});
