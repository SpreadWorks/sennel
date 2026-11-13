import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

// Exact source inputs of the retained false-acceptance reproductions. These
// are inspected as source only, including the async and getter bodies.
const cases = [
  {
    "name": "functionPrimaryPostfix",
    "entry": "src/renamed-primary.mjs",
    "source": "import fs from 'node:fs';\nconst file = function () { return '/proc/self/stat'; }(); fs.readFileSync(file);"
  },
  {
    "name": "classPrimaryPostfix",
    "entry": "src/renamed-primary.mjs",
    "source": "import fs from 'node:fs';\nconst file = class { static get file() { return '/proc/self/stat'; } }.file; fs.readFileSync(file);"
  },
  {
    "name": "assignedAsyncAwait",
    "entry": "src/renamed-primary.mjs",
    "source": "import fs from 'node:fs';\nconst read = async function () { return '/proc/self/stat'; }; const file = await read(); fs.readFileSync(file);"
  }
];
for (const { name, entry, source } of cases) test(`${name} preserves the native path returned by the expression`, () => {
  const repository = new MemorySourceRepository([[entry, source]]);
  const report = new OsIndependenceChecker(repository, { files: [entry], entrypoints: [entry] }).check();
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.classification === "violation"), report.diagnostics.join("\n"));
});
