import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const file = "src/renamed-intrinsic-mutation.mjs";
function check(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
}

for (const source of [
  "Reflect.set(globalThis, 'Object', foreign); const copy = {...process.env}; Object.freeze(copy);",
  "Reflect.set(Object, 'freeze', foreign); const copy = {...process.env}; Object.freeze(copy);",
  "const intrinsic = Object; Reflect.defineProperty(intrinsic, 'freeze', {value: foreign}); const copy = {...process.env}; Object.freeze(copy);",
  "Object.freeze = foreign; const copy = {...process.env}; Object.freeze(copy);",
  "const intrinsic = Object; intrinsic.freeze = foreign; const copy = {...process.env}; Object.freeze(copy);",
  "Reflect.deleteProperty(globalThis, 'Object'); const copy = {...process.env}; Object.freeze(copy);",
]) test("withdrawn environment inference cannot conceal native intrinsic mutation: " + source, () => {
  const report = check(source);
  assert.equal(report.ok, false);
  assert.equal(report.complete, false);
  // The existing rules classify a process-origin namespace as OS01. The
  // acceptance contract is incomplete/NOT_PASS, independent of the rule label.
  assert.ok(report.diagnostics.some(entry => entry.classification === "incomplete"), report.diagnostics.join("\n"));
});

test("an ordinary lexical object remains ordinary data", () => {
  const report = check("const Object = { value: 'local' }; Object.value = 'changed';");
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});

for (const operator of ["??", "||", "&&"]) test("logical path provenance reaches its actual consumer: " + operator, () => {
  const source = "import fs from 'node:fs'; const file = supplied " + operator + " '/proc/self/stat'; fs.readFileSync(file);";
  const report = check(source);
  assert.equal(report.ok, false);
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some(entry => entry.rule === "OS01" && entry.classification === "incomplete"), report.diagnostics.join("\n"));
});

test("ordinary logical path operands remain portable", () => {
  const report = check("import fs from 'node:fs'; const file = supplied ?? 'snapshot.json'; fs.readFileSync(file);");
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});
