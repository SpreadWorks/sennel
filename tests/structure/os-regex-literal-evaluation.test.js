import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-regex-metadata.cjs";
function check(source) {
  const repository = new MemorySourceRepository([[entry, source]]);
  return new OsIndependenceChecker(repository, { files: [entry], entrypoints: [entry] }).check();
}
function metadataSource(file) {
  const fields = Array.from({ length: 900 }, (_, index) => `/field-${index}/g`).join(",");
  return `const fs = require('node:fs');
function metadata(input) { return [input, ${fields}]; }
const selected = [metadata('first.json'), metadata('second.json'), metadata('third.json')];
console.log(selected);
fs.readFileSync(metadata(${JSON.stringify(file)})[0]);`;
}

test("repeated regex literal metadata permits complete source inspection", () => {
  const report = check(metadataSource("snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("regex metadata reuse preserves the later native path consumer", () => {
  const report = check(metadataSource("/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.file === entry
    && item.line === 5 && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("regex method conversion retains the later sensitive helper argument as unproven", () => {
  const report = check(`const fs = require('node:fs');
function selected(value) { return /safe/.test(value); }
selected('safe');
selected(fs.readFileSync);`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS02" && item.file === entry && item.line === 2 && item.column === 35
    && item.classification === "incomplete" && item.message === "string coercion has no inspected primitive result"
    && item.trace.length === 1 && item.trace[0] === entry), report.diagnostics.join("\n"));
});

test("a regex formal default does not erase a later native function assignment", () => {
  const report = check(`const fs = require('node:fs');
function selected(value = /safe/) { value = fs.readFileSync; return value; }
selected()('/proc/self/stat');`);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 3
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("regex metadata does not invent a proven boolean platform implementation", () => {
  const report = check(`function matches(value) {
  if (process.platform === 'win32') return /safe/.test(value);
  return typeof value === 'string';
}
module.exports = { matches };`);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01"), report.diagnostics.join("\n"));
});

// Control for the same helper's ordinary first argument, without the later function value.
test("regex method conversion accepts the ordinary helper input", () => {
  const report = check(`const fs = require('node:fs');
function selected(value) { return /safe/.test(value); }
selected('safe');`);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.equal(report.complete, true);
  assert.deepEqual(report.diagnostics, []);
});
