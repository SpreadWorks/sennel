import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-empty-object.mjs";
function check(source) {
  const repository = new MemorySourceRepository([[entry, source]]);
  return new OsIndependenceChecker(repository, { files: [entry], entrypoints: [entry] }).check();
}
function defaultMetadata(file) {
  const names = Array.from({ length: 24 }, (_, index) => `field${index}`).join(",");
  const calls = Array.from({ length: 240 }, (_, index) => `fs.readFileSync(selected('input-${index}.json'));`).join("\n");
  return `import fs from 'node:fs';
function selected(input, { ${names} } = {}) { return input; }
${calls}
fs.readFileSync(selected(${JSON.stringify(file)}));`;
}

test("repeated empty object defaults permit complete source inspection", () => {
  const report = check(defaultMetadata("snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("empty object default reuse preserves the later native consumer", () => {
  const report = check(defaultMetadata("/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.file === entry
    && item.line === 243 && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("field defaults keep each caller input after reusing an empty outer default", () => {
  const report = check(`import fs from 'node:fs';
function selected(input, { file = input } = {}) { fs.readFileSync(file); }
selected('snapshot.json');
selected('/proc/self/stat');`);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.file === entry
    && item.line === 2 && item.classification === "incomplete"), report.diagnostics.join("\n"));
});

test("nonempty returned objects keep the later caller field", () => {
  const report = check(`import fs from 'node:fs';
function selected(input) { return { file: input }; }
fs.readFileSync(selected('snapshot.json').file);
fs.readFileSync(selected('/proc/self/stat').file);`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.file === entry
    && item.line === 4 && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("an empty spread does not cache its enclosing object fields", () => {
  const report = check(`import fs from 'node:fs';
function selected(input) { return { ...{}, file: input }; }
fs.readFileSync(selected('snapshot.json').file);
fs.readFileSync(selected('/proc/self/stat').file);`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.file === entry
    && item.line === 4 && item.classification === "violation"), report.diagnostics.join("\n"));
});
