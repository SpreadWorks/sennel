import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-captured-projection.cjs";
function refusesUnresolvedProjection(source) {
  const report = new OsIndependenceChecker(new MemorySourceRepository([[entry, source]]), {
    files: [entry], entrypoints: [entry],
  }).check();
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some(item => item.rule === "OS02" && item.classification === "incomplete"),
    report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.every(item => item.rule !== "OS00"), report.diagnostics.join("\n"));
}

test("captured constructor normalization refuses unresolved instance field provenance finitely", () => {
  refusesUnresolvedProjection(`const fs = require('node:fs');
function record(value) { return value; }
function inspect(input, read=fs.readFileSync) {
  class Copy { constructor(value) { const data = record(value); this.file = data.file; } }
  const copy = new Copy(input); read(copy.file);
}
inspect(runtimeInput);`);
});
test("captured destructured constructor normalization refuses unresolved field aliases finitely", () => {
  refusesUnresolvedProjection(`const fs = require('node:fs');
function record(value) { return value; }
function inspect(input, read=fs.readFileSync) {
  class Copy { constructor({payload}={}) { this.payload = record(payload); this.file = this.payload.file; } }
  const copy = new Copy({payload:input}); read(copy.file);
}
inspect(runtimeInput);`);
});

test("module class normalization refuses unresolved instance fields with a captured reader", () => {
  refusesUnresolvedProjection(`const fs = require('node:fs');
function record(value) { return value; }
class Copy { constructor(value, read) { const data = record(value); this.file = data.file; } }
const copy = new Copy(runtimeInput, fs.readFileSync); fs.readFileSync(copy.file);`);
});
test("module class destructuring refuses unresolved field aliases with a captured reader", () => {
  refusesUnresolvedProjection(`const fs = require('node:fs');
function record(value) { return value; }
class Copy { constructor({payload, read}={}) { this.payload = record(payload); this.file = this.payload.file; } }
const copy = new Copy({payload:runtimeInput, read:fs.readFileSync}); fs.readFileSync(copy.file);`);
});
