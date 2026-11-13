import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-observed-return.cjs";
function check(source) {
  const repository = new MemorySourceRepository([[entry, source]]);
  return new OsIndependenceChecker(repository, { files: [entry], entrypoints: [entry] }).check();
}
const calls = 1300;
function repeatedSource(file) {
  const earlier = Array.from({ length: calls }, () => "relay('snapshot.json');").join("\n");
  return `const fs = require('node:fs');
function relay(input) { return Object.freeze([input]); }
${earlier}
fs.readFileSync(relay(${JSON.stringify(file)})[0]);`;
}

test("already observed data returns permit complete source inspection", () => {
  const report = check(repeatedSource("snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("observed return reuse preserves the later actual filesystem consumer", () => {
  const report = check(repeatedSource("/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === calls + 3
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("return initializer calls still observe each supplied caller input", () => {
  const report = check(`const fs = require('node:fs');
function observe(input) { fs.readFileSync(input); return input; }
function relay(input) { return Object.freeze([observe(input)]); }
relay('snapshot.json');
relay('/proc/self/stat');`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 2
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("an observed getter return retains its actual captured caller environment", () => {
  const report = check(`const fs = require('node:fs');
function metadata(input) { return { get file() { return Object.freeze([input]); } }; }
fs.readFileSync(metadata('snapshot.json').file[0]);
fs.readFileSync(metadata('/proc/self/stat').file[0]);`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 4
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("a nested callable return cannot replace the enclosing data return", () => {
  const report = check(`const fs = require('node:fs');
function relay(input) {
  function unused() { return Object.freeze(['/proc/self/stat']); }
  return Object.freeze([input]);
}
fs.readFileSync(relay('snapshot.json')[0]);`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});

test("a partially scanned parenthesized return still evaluates the complete return", () => {
  const report = check(`const fs = require('node:fs');
function relay(input) { return (Object.freeze([input])); }
fs.readFileSync(relay('/proc/self/stat')[0]);`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 3
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("a return not evaluated by the body scan still reaches its actual consumer", () => {
  const report = check(`const fs = require('node:fs');
function relay(input) { return [input]; }
fs.readFileSync(relay('/proc/self/stat')[0]);`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 3
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("multiple return alternatives retain the unresolved native path refusal", () => {
  const report = check(`const fs = require('node:fs');
function relay(input) { if (condition) return Object.freeze([input]); return Object.freeze(['/proc/self/stat']); }
fs.readFileSync(relay('snapshot.json')[0]);`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 3
    && item.classification === "incomplete"), report.diagnostics.join("\n"));
});

test("written formal origins remain unresolved at the native return consumer", () => {
  const report = check(`const fs = require('node:fs');
function relay(input) { input = '/proc/self/stat'; return Object.freeze([input]); }
fs.readFileSync(relay('snapshot.json')[0]);`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 3
    && item.classification === "incomplete"), report.diagnostics.join("\n"));
});

test("a later body observation remains inspected after an earlier return branch", () => {
  const report = check(`const fs = require('node:fs');
function relay(input, selected) {
  if (selected) return Object.freeze([input]);
  fs.readFileSync(input);
}
relay('/proc/self/stat', condition);`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 4
    && item.classification === "incomplete"), report.diagnostics.join("\n"));
});

test("sensitive returned data retains refusal at an uninspected consumer", () => {
  const report = check(`const fs = require('node:fs');
function relay(input) { return Object.freeze([input]); }
opaque(relay(fs.readFileSync));`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS02" && item.line === 3
    && item.classification === "incomplete" && item.message.includes("uninspected consumer")), report.diagnostics.join("\n"));
});
