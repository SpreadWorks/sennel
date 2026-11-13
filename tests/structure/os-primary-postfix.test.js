import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/primary-expression.mjs";
const primaryForms = [
  ["function primary postfix", path => `const selected = function () { return ${JSON.stringify(path)}; }();`],
  ["class primary postfix", path => `const selected = class { static file() { return ${JSON.stringify(path)}; } }.file();`],
  ["assigned async await", path => `const select = async function () { return ${JSON.stringify(path)}; }; const selected = await select();`],
];
for (const [name, form] of primaryForms) {
  for (const [kind, file] of [["portable", "snapshot.json"], ["native", "/proc/self/stat"]]) {
    test(`${name} retains its ${kind} returned path`, () => {
      const source = `import fs from "node:fs";\n${form(file)}\nfs.readFileSync(selected);`;
      const repository = new MemorySourceRepository([[entry, source]]);
      const report = new OsIndependenceChecker(repository, { files: [entry], entrypoints: [entry] }).check();
      assert.equal(report.complete, true, report.diagnostics.join("\n"));
      if (kind === "portable") assert.equal(report.ok, true, report.diagnostics.join("\n"));
      else {
        assert.equal(report.ok, false, report.diagnostics.join("\n"));
        assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 3
          && item.classification === "violation"), report.diagnostics.join("\n"));
      }
    });
  }
}

for (const [name, expression] of [
  ["returned callable", `function () { return fs.readFileSync; }()('/proc/self/stat')`],
  ["static returned callable", `class { static reader() { return fs.readFileSync; } }.reader()('/proc/self/stat')`],
  ["async captured callable", `await (async function () { return fs.readFileSync; })()`],
]) test(`${name} retains the actual native consumer`, () => {
  const source = `import fs from "node:fs";\nconst selected = ${expression};\n${name === "async captured callable" ? "selected('/proc/self/stat');" : ""}`;
  const report = new OsIndependenceChecker(new MemorySourceRepository([[entry, source]]), { files: [entry], entrypoints: [entry] }).check();
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.classification === "violation"), report.diagnostics.join("\n"));
});
for (const word of ["function", "class", "async"]) test(`the literal ${word} remains ordinary string data with a postfix`, () => {
  const source = `import fs from "node:fs"; fs.readFileSync(${JSON.stringify(word)}.trim());`;
  const report = new OsIndependenceChecker(new MemorySourceRepository([[entry, source]]), { files: [entry], entrypoints: [entry] }).check();
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});
