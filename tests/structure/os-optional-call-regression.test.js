import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const file = "src/canonical-observation.mjs";
function check(body) {
  const repository = new MemorySourceRepository([[file, `import fs from 'node:fs';\n${body}`]]);
  return new OsIndependenceChecker(repository, { files: [file], entrypoints: [file] }).check();
}
function portable() {
  const report = check("fs.realpathSync.native?.('ordinary');");
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.equal(report.complete, true);
  assert.deepEqual(report.diagnostics, []);
}

test("an optional native filesystem call retains its ordinary portable path", portable);

for (const [name, body, line] of [
  ["native method", "fs.realpathSync.native?.('/proc/self/stat');", 2],
  ["optional member chain", "fs?.realpathSync?.native?.('/proc/self/stat');", 2],
  ["aliased native method", "const resolve = fs.realpathSync.native;\nresolve?.('/proc/self/stat');", 3],
]) test(`${name} retains its actual OS-sensitive operand through an optional call`, () => {
  const report = check(body);
  assert.equal(report.ok, false);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS01" && entry.classification === "violation"
    && entry.file === file && entry.line === line && entry.column > 0), report.diagnostics.join("\n"));
  portable();
});

test("an optional computed filesystem member still refuses unresolved capability selection", () => {
  const report = check("fs?.[runtimeMember]?.('/proc/self/stat');");
  assert.equal(report.ok, false);
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some((entry) => entry.classification === "incomplete" && entry.file === file
    && entry.line === 2), report.diagnostics.join("\n"));
});

for (const [name, body] of [
  ["whitespace", "fs.realpathSync.native ? . ('ordinary');"],
  ["interior comment", "fs.realpathSync.native ?/*gap*/.('ordinary');"],
]) test(`a split optional punctuator with ${name} remains an incomplete source`, () => {
  const report = check(body);
  assert.equal(report.ok, false);
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some((entry) => entry.classification === "incomplete" && entry.file === file
    && entry.line === 2), report.diagnostics.join("\n"));
});
for (const body of [
  "fs.realpathSync.native /* receiver gap */ ?.('ordinary');",
  "fs.realpathSync.native?. /* argument gap */ ('ordinary');",
]) test(`spacing outside a complete optional punctuator remains portable: ${body}`, () => {
  const report = check(body);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.equal(report.complete, true);
  assert.deepEqual(report.diagnostics, []);
});
