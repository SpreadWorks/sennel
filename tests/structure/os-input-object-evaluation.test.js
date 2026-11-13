import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-input-object.cjs";
function check(source) {
  const repository = new MemorySourceRepository([[entry, source]]);
  return new OsIndependenceChecker(repository, { files: [entry], entrypoints: [entry] }).check();
}
function metadataSource(file) {
  const fields = Array.from({ length: 600 }, () => "{ field: input }").join(",");
  return `const fs = require('node:fs');
function wrap(value) { return value; }
function metadata(input) { return wrap([input, ${fields}]); }
const selected = [metadata('first.json'), metadata('second.json'), metadata('third.json')];
console.log(selected);
fs.readFileSync(metadata(${JSON.stringify(file)})[0]);`;
}

test("repeated input-only object origins permit complete source inspection", () => {
  const report = check(metadataSource("snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("input-only object origin reuse preserves the later native path consumer", () => {
  const report = check(metadataSource("/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 6
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("object initializer calls still inspect each caller input", () => {
  const report = check(`const fs = require('node:fs');
function observe(file) { fs.readFileSync(file); return file; }
function wrap(value) { return value; }
function metadata(input) { return wrap({ file: observe(input) }); }
metadata('snapshot.json');
metadata('/proc/self/stat');`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 2
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("object getter origins retain their actual caller environment", () => {
  const report = check(`const fs = require('node:fs');
function wrap(value) { return value; }
function metadata(input) { return wrap({ get file() { return input; } }); }
fs.readFileSync(metadata('snapshot.json').file);
fs.readFileSync(metadata('/proc/self/stat').file);`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 5
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("a written formal cannot reuse an input-only object origin", () => {
  const report = check(`const fs = require('node:fs');
function wrap(value) { return value; }
function metadata(input) { input = '/proc/self/stat'; return wrap({ file: input }); }
fs.readFileSync(metadata('snapshot.json').file);`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 4
    && item.classification === "incomplete" && item.message.includes("pseudo-filesystem or fixed OS origin")), report.diagnostics.join("\n"));
});

test("input object fields remain distinct across invocations", () => {
  const report = check(`const fs = require('node:fs');
function wrap(value) { return value; }
function metadata(file) { return wrap({ file }); }
fs.readFileSync(metadata('snapshot.json').file);
fs.readFileSync(metadata('/proc/self/stat').file);`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 5
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("a later sensitive input object remains visible to an uninspected consumer", () => {
  const report = check(`const fs = require('node:fs');
function wrap(value) { return value; }
function metadata(value) { return wrap({ value }); }
opaque(metadata('snapshot.json'));
opaque(metadata(fs.readFileSync));`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS02" && item.line === 5
    && item.classification === "incomplete" && item.message.includes("uninspected consumer")), report.diagnostics.join("\n"));
});
