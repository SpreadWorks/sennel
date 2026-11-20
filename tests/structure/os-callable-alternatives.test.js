import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-callable.mjs";
function check(source) {
  const repository = new MemorySourceRepository([[entry, source]]);
  return new OsIndependenceChecker(repository, { files: [entry], entrypoints: [entry] }).check();
}
function rejects(source, line) {
  const report = check(source);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.file === entry && item.line === line
    && item.classification === "incomplete"), report.diagnostics.join("\n"));
}

test("conditional callable results retain each possible native path", () => {
  rejects(`import fs from 'node:fs';
const selected = input ? () => '/proc/self/stat' : () => 'snapshot.json';
fs.readFileSync(selected());`, 3);
});

test("written function declarations retain the reassigned callable result", () => {
  rejects(`import fs from 'node:fs';
function selected() { return 'snapshot.json'; }
selected = () => '/proc/self/stat';
fs.readFileSync(selected());`, 4);
});

test("returned callable alternatives retain their eventual results", () => {
  rejects(`import fs from 'node:fs';
function selected(input) { if (input) return () => '/proc/self/stat'; return () => 'snapshot.json'; }
fs.readFileSync(selected(flag)());`, 3);
});

test("an opaque alternative cannot erase a known callable native path", () => {
  rejects(`import fs from 'node:fs';
const selected = input ? () => '/proc/self/stat' : opaque;
fs.readFileSync(selected());`, 3);
});

test("finite method receivers identify the actual native path sink", () => {
  const report = check(`import fs from 'node:fs';
const selected = input ? { file: '/proc/self/stat', read() { fs.readFileSync(this.file); } } : { file: 'snapshot.json', read() { fs.readFileSync(this.file); } };
selected.read();`);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some(item => item.file === entry && item.line === 2 && item.column === 62
    && item.rule === "OS01" && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("portable callable alternatives remain completely inspected", () => {
  const report = check(`import fs from 'node:fs';
const selected = input ? () => 'snapshot.json' : () => 'another.json';
fs.readFileSync(selected());`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("each alternative native consumer emits its own path observation", () => {
  const report = check(`import fs from 'node:fs';
const selected = input ? fs.readFileSync : fs.accessSync;
selected('/proc/self/stat');`);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.file === entry
    && item.line === 3 && item.classification === "violation"), report.diagnostics.join("\n"));
});

function metadata(file) {
  const references = Array.from({ length: 500 }, () => "tagged").join(",");
  const calls = Array.from({ length: 8 }, (_, index) => `fs.readFileSync(selected('input-${index}.json')[0]);`).join("\n");
  return `import fs from 'node:fs';
function tagged() { return 'metadata'; }
function selected(input) { return [input, ${references}]; }
${calls}
fs.readFileSync(selected(${JSON.stringify(file)})[0]);`;
}

test("immutable named function metadata permits complete source inspection", () => {
  const report = check(metadata("snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("function metadata reuse preserves the later native path consumer", () => {
  const report = check(metadata("/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.file === entry
    && item.line === 12 && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("a local function shadow keeps its own captured input", () => {
  const report = check(`import fs from 'node:fs';
function selected() { return 'snapshot.json'; }
function read(input) { function selected() { return input; } fs.readFileSync(selected()); }
read('/proc/self/stat');`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.file === entry
    && item.line === 3 && item.classification === "violation"), report.diagnostics.join("\n"));
});
