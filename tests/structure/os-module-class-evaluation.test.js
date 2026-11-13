import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-class-metadata.cjs";
function check(source) {
  const repository = new MemorySourceRepository([[entry, source]]);
  return new OsIndependenceChecker(repository, { files: [entry], entrypoints: [entry] }).check();
}
function metadataSource(file) {
  const references = Array.from({ length: 900 }, () => "Metadata").join(",");
  return `const fs = require('node:fs');
class Metadata {}
function wrap(value) { return value; }
function metadata(input) { return wrap([input, ${references}]); }
const selected = [metadata('first.json'), metadata('second.json'), metadata('third.json')];
console.log(selected);
fs.readFileSync(metadata(${JSON.stringify(file)})[0]);`;
}

test("repeated stable module class references permit complete source inspection", () => {
  const report = check(metadataSource("snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("module class metadata reuse preserves the later native path consumer", () => {
  const report = check(metadataSource("/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 7
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("module class static methods inspect each actual caller input", () => {
  const report = check(`const fs = require('node:fs');
class Metadata { static read(file) { fs.readFileSync(file); } }
function inspect(file) { Metadata.read(file); }
inspect('snapshot.json');
inspect('/proc/self/stat');`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 2
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("module class construction still observes its actual argument calls", () => {
  const report = check(`const fs = require('node:fs');
function observe(file) { fs.readFileSync(file); return file; }
class Metadata { constructor(file) { this.file = file; } }
function inspect(file) { new Metadata(observe(file)); }
inspect('snapshot.json');
inspect('/proc/self/stat');`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 2
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("a written module class retains its actual native callable alternative", () => {
  const report = check(`const fs = require('node:fs');
class Metadata {}
Metadata = fs.readFileSync;
Metadata('/proc/self/stat');`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 4
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("a formal shadow of a module class retains the supplied callable", () => {
  const report = check(`const fs = require('node:fs');
class Metadata {}
function inspect(Metadata, file) { Metadata(file); }
inspect(fs.readFileSync, '/proc/self/stat');`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 3
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("a local class shadow cannot resolve to the module class metadata", () => {
  const report = check(`const fs = require('node:fs');
class Metadata {}
function inspect(file) {
  class Metadata { static read(input) { fs.readFileSync(input); } }
  Metadata.read(file);
}
inspect('/proc/self/stat');`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 4
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("escaping class metadata retains its current invocation input environment", () => {
  const report = check(`const fs = require('node:fs');
class Metadata {}
function metadata(input) { return Metadata; }
opaque(metadata('snapshot.json'));
opaque(metadata(fs.readFileSync));`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS02" && item.line === 5
    && item.classification === "incomplete" && item.message.includes("uninspected consumer")), report.diagnostics.join("\n"));
});
