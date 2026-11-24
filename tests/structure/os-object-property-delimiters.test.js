import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const file = "src/property-delimiters.mjs";
function inspect(source) {
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
  assert.deepEqual(report.diagnostics.filter(entry => entry.rule === "OS00"), [], report.diagnostics.join("\n"));
  return report;
}
for (const marker of ["{", "[", "(", ","]) {
  test(`literal delimiter data preserves ordinary filesystem input: ${marker}`, () => {
    const report = inspect(`import fs from 'node:fs'; const holder = {marker: ${JSON.stringify(marker)}, file: 'ordinary'}; fs.readFileSync(holder.file);`);
    assert.equal(report.ok, true, report.diagnostics.join("\n"));
    assert.equal(report.complete, true);
  });
  test(`literal delimiter data does not hide later native capability or path: ${marker}`, () => {
    for (const source of [
      `import fs from 'node:fs'; const holder = {marker: ${JSON.stringify(marker)}, file: '/proc/self/stat'}; fs.readFileSync(holder.file);`,
      `import fs from 'node:fs'; const holder = {marker: ${JSON.stringify(marker)}, read: fs.readFileSync}; holder.read('/proc/self/stat');`,
    ]) {
      const report = inspect(source);
      assert.equal(report.ok, false);
      assert.equal(report.diagnostics.some(entry => entry.rule === "OS01" && entry.classification === "violation"), true, report.diagnostics.join("\n"));
    }
  });
}
