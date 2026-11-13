import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-resolution-scans.cjs";
function check(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[entry, source]]), {
    files: [entry], entrypoints: [entry],
  }).check();
}
function graph(entries, root) {
  return new OsIndependenceChecker(new MemorySourceRepository(entries), {
    files: [root], entrypoints: [root],
  }).check();
}
const calls = 250;
const relay = "function relay(input) { return Object.freeze([Object.freeze([Object.freeze([input])])]); }";
function items(file) {
  return Array.from({ length: calls }, (_, index) => `relay(${JSON.stringify(index === calls - 1 ? file : "snapshot.json")})`).join(",");
}
function bindingSource(file) {
  return `const fs = require('node:fs');
${relay}
const records = [${items(file)}];
fs.readFileSync(records[${calls - 1}][0][0][0]);`;
}
function exportedSource(file) {
  const root = "src/renamed-export-consumer.js";
  return graph([
    [root, `import fs from 'node:fs'; import { records } from './renamed-values.js';
fs.readFileSync(records[${calls - 1}][0][0][0]);`],
    ["src/renamed-values.js", `import { relay } from './renamed-relay.js';
export const records = [${items(file)}];`],
    ["src/renamed-relay.js", `export ${relay}`],
  ], root);
}
function sink(report, file, line, classification = "violation") {
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.file === file && item.line === line
    && item.classification === classification), report.diagnostics.join("\n"));
}

test("data inspected through a variable initializer completes within the original finite budget", () => {
  const report = check(bindingSource("snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("variable initializer resolution reaches the later actual filesystem sink", () => {
  const report = check(bindingSource("/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, entry, 4);
});

test("data inspected through an export initializer retains complete source inspection", () => {
  const report = exportedSource("snapshot.json");
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("export initializer resolution reaches its actual importing filesystem consumer", () => {
  const report = exportedSource("/proc/self/stat");
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, "src/renamed-export-consumer.js", 2);
});

test("distinct variable initializers retain their own supplied helper inputs", () => {
  const report = check(`const fs = require('node:fs');
${relay}
const first = relay('snapshot.json');
const second = relay('/proc/self/stat');
fs.readFileSync(first[0][0][0]);
fs.readFileSync(second[0][0][0]);`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, entry, 6);
});

test("binding origin cycles retain a refused capability result", () => {
  const report = check(`const fs = require('node:fs');
${relay}
const value = relay(value);
opaque(value);`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS02" && item.classification === "incomplete"), report.diagnostics.join("\n"));
});

test("written initializer bindings retain unresolved native path refusal", () => {
  const report = check(`const fs = require('node:fs');
${relay}
let input = 'snapshot.json'; input = '/proc/self/stat';
const records = relay(input);
fs.readFileSync(records[0][0][0]);`);
  assert.equal(report.complete, false);
  sink(report, entry, 5, "incomplete");
});

test("unvisited callbacks in a bound initializer still inspect their actual caller input", () => {
  const report = check(`const fs = require('node:fs');
function relay(input) { return opaque(() => fs.readFileSync(input)); }
const metadata = relay('/proc/self/stat');`);
  sink(report, entry, 2);
});

test("an exported getter retains its actual receiver and captured input", () => {
  const root = "src/renamed-getter-consumer.js";
  const report = graph([
    [root, `import fs from 'node:fs'; import { metadata } from './renamed-getter-value.js';
fs.readFileSync(metadata.file[0][0]);`],
    ["src/renamed-getter-value.js", `function metadataFor(input) { return { get file() { return Object.freeze([Object.freeze([input])]); } }; }
export const metadata = metadataFor('/proc/self/stat');`],
  ], root);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, root, 2);
});

test("a capability supplied by a default remains refused through a bound initializer", () => {
  const report = check(`const fs = require('node:fs');
function relay(input = fs.readFileSync) { return Object.freeze([Object.freeze([input])]); }
const metadata = relay();
opaque(metadata);`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS02" && item.classification === "incomplete"
    && item.message.includes("uninspected consumer")), report.diagnostics.join("\n"));
});
