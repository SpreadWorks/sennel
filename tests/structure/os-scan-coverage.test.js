import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-nested-scans.cjs";
function check(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[entry, source]]), {
    files: [entry], entrypoints: [entry],
  }).check();
}
const calls = 600;
function repeatedSource(file) {
  const earlier = Array.from({ length: calls }, () => "relay('snapshot.json');").join("\n");
  return `const fs = require('node:fs');
function relay(input) { return Object.freeze([Object.freeze([Object.freeze([input])])]); }
${earlier}
fs.readFileSync(relay(${JSON.stringify(file)})[0][0][0]);`;
}
function actualSink(report, line, classification = "violation") {
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === line
    && item.classification === classification), report.diagnostics.join("\n"));
}

test("nested data initializers complete within the original finite inspection budget", () => {
  const report = check(repeatedSource("snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("nested initializer coverage reaches a later actual filesystem consumer", () => {
  const report = check(repeatedSource("/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  actualSink(report, calls + 3);
});

test("nested effectful arguments inspect each actual caller input", () => {
  const report = check(`const fs = require('node:fs');
function observe(input) { fs.readFileSync(input); return input; }
function relay(input) { return Object.freeze([Object.freeze([observe(input)])]); }
relay('snapshot.json');
relay('/proc/self/stat');`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  actualSink(report, 2);
});

test("callable metadata leaves its unvisited callback body for ordinary inspection", () => {
  const report = check(`const fs = require('node:fs');
function relay() { return opaque(() => fs.readFileSync('/proc/self/stat')); }
relay();`);
  actualSink(report, 2);
});

test("a parenthesized outer expression still inspects its previously unvisited argument", () => {
  const report = check(`const fs = require('node:fs');
function relay(input) { (opaque)(fs.readFileSync(input)); }
relay('/proc/self/stat');`);
  actualSink(report, 2);
});

test("nested getter data keeps the actual receiver and captured input", () => {
  const report = check(`const fs = require('node:fs');
function metadata(input) { return { get file() { return Object.freeze([Object.freeze([input])]); } }; }
fs.readFileSync(metadata('snapshot.json').file[0][0]);
fs.readFileSync(metadata('/proc/self/stat').file[0][0]);`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  actualSink(report, 4);
});

test("nested returned capabilities remain refused at an uninspected consumer", () => {
  const report = check(`const fs = require('node:fs');
function relay(input) { return Object.freeze([Object.freeze([input])]); }
opaque(relay(fs.readFileSync));`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS02" && item.line === 3
    && item.classification === "incomplete" && item.message.includes("uninspected consumer")), report.diagnostics.join("\n"));
});

test("written parameters retain their unresolved source origin after nested calls", () => {
  const report = check(`const fs = require('node:fs');
function relay(input) { input = '/proc/self/stat'; return Object.freeze([Object.freeze([input])]); }
fs.readFileSync(relay('snapshot.json')[0][0]);`);
  assert.equal(report.complete, false);
  actualSink(report, 3, "incomplete");
});

test("unresolved return alternatives still refuse a nested native path", () => {
  const report = check(`const fs = require('node:fs');
function relay(input) { if (condition) return Object.freeze([Object.freeze([input])]); return Object.freeze([Object.freeze(['/proc/self/stat'])]); }
fs.readFileSync(relay('snapshot.json')[0][0]);`);
  assert.equal(report.complete, false);
  actualSink(report, 3, "incomplete");
});

test("an early returned initializer does not conceal a later body effect", () => {
  const report = check(`const fs = require('node:fs');
function relay(input, selected) {
  if (selected) return Object.freeze([Object.freeze([input])]);
  fs.readFileSync(input);
}
relay('/proc/self/stat', condition);`);
  assert.equal(report.complete, false);
  actualSink(report, 4, "incomplete");
});

test("nested local declarations retain their own returns and body inspection", () => {
  const report = check(`const fs = require('node:fs');
function relay(input) {
  function unused() { return Object.freeze([Object.freeze(['/proc/self/stat'])]); }
  return Object.freeze([Object.freeze([input])]);
}
fs.readFileSync(relay('snapshot.json')[0][0]);`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});

test("a different lexical callable at the same argument depth is inspected", () => {
  const report = check(`const fs = require('node:fs');
function relay(input) { return Object.freeze([Object.freeze([input])]); }
function other(input) { fs.readFileSync(input); return input; }
relay('snapshot.json');
relay(other('/proc/self/stat'));`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  actualSink(report, 3);
});
