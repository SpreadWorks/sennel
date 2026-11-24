import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

test("a foreign evaluation frontier retains a valid root callsite and its actual source location", () => {
  const root = "src/caller.js", helper = "src/helper.js";
  const caller = "import { work } from './helper.js';\nwork();\n";
  const work = Array.from({ length: 3100 }, (_, index) => `console.log(${index});`).join("\n");
  const source = `${"\n".repeat(20)}export function work() {\n${work}\n}\nprocess.kill(-2);\n`;
  const checker = new OsIndependenceChecker(new MemorySourceRepository([[root, caller], [helper, source]]), { files: [root] });
  const inspect = checker.rules.inspect.bind(checker.rules);
  const frontiers = [];
  checker.rules.inspect = (module) => {
    try { return inspect(module); }
    catch (error) { frontiers.push({ root: module.file, file: error.file, line: error.line, column: error.column }); throw error; }
  };
  const report = checker.check();
  const frontier = frontiers.find((entry) => entry.root === root && entry.file === helper);
  assert.ok(frontier, JSON.stringify(frontiers));
  const diagnostic = report.diagnostics.find((entry) => entry.file === root && entry.rule === "OS00" && /work budget/.test(entry.message));
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.ok(diagnostic.line >= 1 && diagnostic.line <= caller.trimEnd().split("\n").length,
    `caller diagnostic must not borrow helper line ${frontier.line}: ${diagnostic}`);
  assert.equal(diagnostic.line, 2);
  assert.ok(diagnostic.message.includes(`${helper}:${frontier.line}:${frontier.column}`), diagnostic.message);
  assert.ok(diagnostic.trace.includes(root) && diagnostic.trace.includes(helper), diagnostic.trace.join(" -> "));
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some((entry) => entry.file === helper && entry.rule === "OS01" && entry.classification === "violation"));
  assert.equal(report.coverage.inspected, 0, "failed root inspections must not be upgraded to complete");
});
