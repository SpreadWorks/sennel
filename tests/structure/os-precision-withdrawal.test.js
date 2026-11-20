import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

test("a nested alias write prevents default projection from borrowing the original field", () => {
  const file = "src/renamed-nested-alias.mjs";
  const source = `import fs from "node:fs";
function read({entry:{file="snapshot.json"}={}}={}) { fs.readFileSync(file); }
const input={entry:{file:"snapshot.json"},unused:fs};
const alias=input.entry; alias.file="/proc/self/stat";
read(input);`;
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
  assert.equal(report.ok, false);
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some(entry => entry.rule === "OS02" && entry.file === file && entry.line === 2
    && entry.classification === "incomplete"), report.diagnostics.join("\n"));
});

test("a native alternative cannot borrow identity through a mutable global intrinsic", () => {
  const file = "src/renamed-intrinsic-choice.mjs";
  const source = `import path from "node:path";
Object.freeze=opaque;
const api=choice?Object.freeze(path.win32):path.posix;
api.basename("snapshot.json");`;
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
  assert.equal(report.ok, false);
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some(entry => entry.rule === "OS02" && entry.file === file && entry.line === 4
    && entry.classification === "incomplete"), report.diagnostics.join("\n"));
});
