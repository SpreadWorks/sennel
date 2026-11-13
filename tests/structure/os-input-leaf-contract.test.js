import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-input-leaves.js";
function check(source) {
  const repository = new MemorySourceRepository([[entry, source]]);
  return new OsIndependenceChecker(repository, { files: [entry], entrypoints: [entry] }).check();
}
function pathDiagnostic(report, line, classification) {
  return report.diagnostics.some(item => item.rule === "OS01" && item.file === entry
    && item.line === line && item.classification === classification);
}

test("unbound public input compound writes fail closed at native I/O", () => {
  const reports = ["||=", "??="].map(operator => check(`import fs from 'node:fs';
export function read(input) { input ${operator} '/proc/self/stat';
fs.readFileSync(input);
}`));
  assert.deepEqual(reports.map(report => report.ok), [false, false]);
  for (const report of reports) assert.ok(pathDiagnostic(report, 3, "incomplete"), report.diagnostics.join("\n"));
});

test("unbound input defaults and ordinary writes retain their inspected path", () => {
  const reports = ["export function read(input) { input = '/proc/self/stat';",
    "export function read(input = '/proc/self/stat') {"].map(declaration => check(`import fs from 'node:fs';
${declaration}
fs.readFileSync(input);
}`));
  assert.deepEqual(reports.map(report => [report.complete, report.ok]), [[true, false], [true, false]]);
  for (const report of reports) assert.ok(pathDiagnostic(report, 3, "violation"), report.diagnostics.join("\n"));
});

test("unwritten public inputs permit complete inspection of repeated native consumers", () => {
  const calls = Array.from({ length: 3200 }, () => "fs.readFileSync(input);").join("\n");
  const report = check(`import fs from 'node:fs';
export function read(input) {
${calls}
}`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

function keywordMetadata(file) {
  const fields = Array.from({ length: 900 }, (_, index) => ["null", "false", "true", "undefined"][index % 4]).join(",");
  const calls = Array.from({ length: 8 }, (_, index) => `fs.readFileSync(selected('input-${index}.json')[0]);`).join("\n");
  return `import fs from 'node:fs';
function selected(input) { return [input, ${fields}]; }
${calls}
fs.readFileSync(selected(${JSON.stringify(file)})[0]);`;
}

test("literal keywords across helper contexts permit complete source inspection", () => {
  const report = check(keywordMetadata("snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("literal keyword reuse preserves the later caller native path", () => {
  const report = check(keywordMetadata("/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(pathDiagnostic(report, 11, "violation"), report.diagnostics.join("\n"));
});

test("a parameter named undefined keeps its lexical input rather than the keyword value", () => {
  const report = check(`import fs from 'node:fs';
function read(undefined) { fs.readFileSync(undefined); }
read('snapshot.json');
read('/proc/self/stat');`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(pathDiagnostic(report, 2, "violation"), report.diagnostics.join("\n"));
});
