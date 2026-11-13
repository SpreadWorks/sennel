import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-captured-class.cjs";
function check(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[entry, source]]), {
    files: [entry], entrypoints: [entry],
  }).check();
}
function noInspectionFailure(report) {
  assert.equal(report.diagnostics.some(item => item.rule === "OS00"), false, report.diagnostics.join("\n"));
}
function safe(report) {
  noInspectionFailure(report);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
}
function escape(report, line) {
  noInspectionFailure(report);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS02" && item.file === entry
    && item.line === line && item.classification === "incomplete"
    && item.message.includes("capability escapes")), report.diagnostics.join("\n"));
}
function sink(report, line) {
  noInspectionFailure(report);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.file === entry
    && item.line === line && item.classification === "violation"), report.diagnostics.join("\n"));
}

test("a class default remains inspectable after its own parameter is bound", () => {
  safe(check(`class Metadata {}
function create(Type = Metadata) { return new Type(); }
create();`));
});
test("an explicit undefined class default remains inspectable", () => {
  safe(check(`class Metadata {}
function create(Type = Metadata) { return new Type(); }
create(undefined);`));
});
test("an array default can capture a class without recursive sensitivity failure", () => {
  safe(check(`class Metadata {}
function inspect(context = [Metadata]) { return context[0]; }
inspect();`));
});
test("an object default can capture a class without recursive sensitivity failure", () => {
  safe(check(`class Metadata {}
function inspect(context = { Type: Metadata }) { return context.Type; }
inspect();`));
});
test("a class capture retains a later bound filesystem capability", () => {
  const report = check(`const fs = require('node:fs'); class Metadata {}
function inspect(Type = Metadata, read = fs.readFileSync) {
  unknownConsumer(Type);
}
inspect();`);
  escape(report, 3);
});
test("a class capture retains a later bound native path", () => {
  const report = check(`class Metadata {}
function inspect(Type = Metadata, file = '/proc/self/stat') {
  unknownConsumer(Type);
}
inspect();`);
  escape(report, 3);
});
test("array capture cycles retain later bound filesystem capabilities", () => {
  const report = check(`const fs = require('node:fs'); class Metadata {}
function inspect(context = [Metadata], read = fs.readFileSync) {
  unknownConsumer(context[0]);
}
inspect();`);
  escape(report, 3);
});
test("object capture cycles retain later bound filesystem capabilities", () => {
  const report = check(`const fs = require('node:fs'); class Metadata {}
function inspect(context = { Type: Metadata }, read = fs.readFileSync) {
  unknownConsumer(context.Type);
}
inspect();`);
  escape(report, 3);
});
test("a default class constructor retains its actual unsafe filesystem input", () => {
  const report = check(`const fs = require('node:fs');
class Reader { constructor(file) { this.file = file; }
  read() { fs.readFileSync(this.file); }
}
function create(file, Type = Reader) { return new Type(file); }
create('/proc/self/stat').read();`);
  sink(report, 3);
});
test("later class-default calls retain their distinct constructed inputs", () => {
  const report = check(`const fs = require('node:fs');
class Reader { constructor(file) { this.file = file; }
  read() { fs.readFileSync(this.file); }
}
function create(file, Type = Reader) { return new Type(file); }
create('snapshot.json').read();
create('/proc/self/stat').read();`);
  sink(report, 3);
});
test("an ordinary object default keeps its portable data result", () => {
  safe(check(`function inspect(context = { name: 'snapshot.json' }) { return context.name; }
inspect();`));
});
