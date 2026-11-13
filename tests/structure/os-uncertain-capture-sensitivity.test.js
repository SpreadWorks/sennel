import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-uncertain-class-capture.cjs";
function check(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[entry, source]]), {
    files: [entry], entrypoints: [entry],
  }).check();
}
function safe(report) {
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
}
function escape(report, line) {
  assert.equal(report.diagnostics.some(item => item.rule === "OS00"), false, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS02" && item.file === entry
    && item.line === line && item.classification === "incomplete"
    && item.message.includes("capability escapes")), report.diagnostics.join("\n"));
}

test("an uncertain class default with ordinary captures remains inspectable", () => {
  safe(check(`function inspect(choice, Type = choice
  ? class First { reader() { return read; } }
  : class Second { reader() { return read; } }, read = () => 0) {
  unknownConsumer(Type);
}
inspect(unknownChoice);`));
});
test("an uncertain class default retains its later bound captured reader", () => {
  const report = check(`const fs = require('node:fs');
function inspect(choice, Type = choice
  ? class First { reader() { return read; } }
  : class Second { reader() { return read; } }, read = fs.readFileSync) {
  unknownConsumer(Type);
}
inspect(unknownChoice);`);
  escape(report, 5);
});
test("a class selection inside an array retains its later captured reader", () => {
  const report = check(`const fs = require('node:fs');
function inspect(choice, context = [choice
  ? class First { reader() { return read; } }
  : class Second { reader() { return read; } }], read = fs.readFileSync) {
  unknownConsumer(context[0]);
}
inspect(unknownChoice);`);
  escape(report, 5);
});
test("a class selection inside an object retains its later captured reader", () => {
  const report = check(`const fs = require('node:fs');
function inspect(choice, context = { Type: choice
  ? class First { reader() { return read; } }
  : class Second { reader() { return read; } } }, read = fs.readFileSync) {
  unknownConsumer(context.Type);
}
inspect(unknownChoice);`);
  escape(report, 5);
});
