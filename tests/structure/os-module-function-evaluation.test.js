import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-function-metadata.cjs";
function check(source) {
  const repository = new MemorySourceRepository([[entry, source]]);
  return new OsIndependenceChecker(repository, { files: [entry], entrypoints: [entry] }).check();
}
function metadataSource(file) {
  const fields = Array.from({ length: 900 }, () => "helper").join(",");
  return `const fs = require('node:fs');
function helper(value) { return value; }
function metadata(input) { return [input, ${fields}]; }
const selected = [metadata('first.json'), metadata('second.json'), metadata('third.json')];
console.log(selected);
fs.readFileSync(metadata(${JSON.stringify(file)})[0]);`;
}

test("repeated module function metadata permits complete source inspection", () => {
  const report = check(metadataSource("snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("module function metadata reuse preserves the later native path consumer", () => {
  const report = check(metadataSource("/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.file === entry
    && item.line === 6 && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("an escaped module function still observes actual body arguments and refuses unresolved caller context", () => {
  const report = check(`const fs = require('node:fs');
function consume(file) { fs.readFileSync(file); }
function metadata(input) { return [consume, input]; }
const first = metadata('snapshot.json'); first[0](first[1]);
const later = metadata('/proc/self/stat'); later[0](later[1]);`);
  assert.equal(report.complete, false, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 2
    && item.classification === "incomplete" && item.message.includes("pseudo-filesystem or fixed OS path")), report.diagnostics.join("\n"));
});

test("a written module function binding retains its native consumer alternative", () => {
  const report = check(`const fs = require('node:fs');
function selected(file) { return file; }
selected = fs.readFileSync;
selected('/proc/self/stat');`);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 4
    && item.classification === "violation"), report.diagnostics.join("\n"));
});

test("a same-named formal input cannot borrow module function metadata", () => {
  const report = check(`const fs = require('node:fs');
function selected(file) { return file; }
function route(selected) { return selected('/proc/self/stat'); }
route(fs.readFileSync);`);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 3
    && item.classification === "violation"), report.diagnostics.join("\n"));
});
