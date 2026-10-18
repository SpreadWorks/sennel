import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const file = "src/tagged-input.js";
function check(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
}

for (const [name, source, classification] of [
  ["raw literal", "fs.readFileSync(String.raw`/proc/self/stat`);", "violation"],
  ["raw interpolation", "const root = '/proc'; fs.readFileSync(String.raw`${root}/self/stat`);", "violation"],
  ["dynamic raw interpolation", "fs.readFileSync(String.raw`/proc/${pid}/stat`);", "violation"],
  ["unsupported literal tag", "fs.readFileSync(convert`/proc/self/stat`);", "incomplete"],
  // Ordinary input cannot prove the output of an uninspected conversion.
  ["unsupported ordinary tag", "fs.readFileSync(convert`ordinary/snapshot.json`);", "incomplete"],
  ["tag replacing ordinary input", "function convert() { return '/proc/self/stat'; } fs.readFileSync(convert`ordinary/snapshot.json`);", "incomplete"],
  ["unsupported interpolation tag", "const root = '/proc'; fs.readFileSync(convert`${root}/self/stat`);", "incomplete"],
  ["shadowed raw tag", "function read(String) { return fs.readFileSync(String.raw`/proc/self/stat`); }", "incomplete"],
  ["transformed tag result", "fs.readFileSync(convert`/proc/self/stat`.trim());", "incomplete"],
]) test(`tagged ${name} retains its I/O path origin and recovers`, () => {
  const report = check(`import fs from 'node:fs';\n${source}`);
  const diagnostic = report.diagnostics.find((entry) => entry.rule === "OS01" && entry.classification === classification);
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.equal(diagnostic.file, file);
  assert.equal(diagnostic.line, 2);
  assert.equal(report.ok, false);
  assert.equal(check("import fs from 'node:fs'; fs.readFileSync(String.raw`ordinary/snapshot.json`);").ok, true);
});

for (const source of [
  "import fs from 'node:fs'; fs.readFileSync(String.raw`ordinary/snapshot.json`);",
  "console.log(String.raw`/proc/self/stat`);",
  "console.log(convert`/proc/self/stat`);",
  "console.log(convert`/proc/self/stat`.trim());",
  "console.log(convert`${process.platform}`);",
  "const text = 'fs.readFileSync(String.raw`/proc/self/stat`)'; console.log(text);",
]) test(`inert or ordinary tagged text remains allowed: ${source}`, () => {
  const report = check(source);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});
