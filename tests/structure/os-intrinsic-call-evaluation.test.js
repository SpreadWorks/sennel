import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-intrinsic-calls.cjs";
const importedEntry = "src/renamed-intrinsic-imports.mjs";
function check(source, root = entry) {
  return new OsIndependenceChecker(new MemorySourceRepository([[root, source]]), {
    files: [root], entrypoints: [root],
  }).check();
}
function sink(report, line, file = entry) {
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.file === file
    && item.line === line && item.classification === "violation"), report.diagnostics.join("\n"));
}
function finiteRefusal(report) {
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS00" && item.classification === "incomplete"
    && item.message.includes("finite per-module work budget")), report.diagnostics.join("\n"));
}
function repeatedSource(kind, file) {
  const terms = Array.from({ length: 3000 }, (_, index) => {
    if (kind === "unknown") return "input.read()";
    if (kind === "input-path") return "input.isAbsolute(text)";
    if (kind === "global") return "Object.freeze(text)";
    if (kind === "import") return "path.isAbsolute(text)";
    return `input.readFileSync(${index === 2999 ? "last" : "text"})`;
  }).join(",");
  const imported = kind === "import";
  const prelude = imported ? `import fs from 'node:fs'; import path from 'node:path';`
    : `const fs = require('node:fs'); const path = require('node:path');`;
  const input = kind === "input-path" ? "path" : kind === "input-fs" ? "fs" : "unresolvedInput";
  return `${prelude}
function inspect(input, text, last) { return [${terms}]; }
inspect(${input}, 'snapshot.json', ${JSON.stringify(kind === "input-fs" ? file : "snapshot.json")});
${kind === "input-fs" ? "" : `fs.readFileSync(${JSON.stringify(file)});`}`;
}

test("unknown input member calls complete within the original finite budget", () => {
  const report = check(repeatedSource("unknown", "snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});
test("unknown member call inspection retains a later actual filesystem sink", () => {
  const report = check(repeatedSource("unknown", "/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 4);
});
test("builtin input member calls complete within the original finite budget", () => {
  const report = check(repeatedSource("input-path", "snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});
test("builtin input call inspection reaches a later actual filesystem sink", () => {
  const report = check(repeatedSource("input-path", "/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 4);
});
test("unbound builtin member calls complete within the original finite budget", () => {
  const report = check(repeatedSource("global", "snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});
test("unbound builtin call inspection retains a later actual filesystem sink", () => {
  const report = check(repeatedSource("global", "/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 4);
});
test("imported builtin member calls complete within the original finite budget", () => {
  const report = check(repeatedSource("import", "snapshot.json"), importedEntry);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});
test("imported builtin call inspection retains a later actual filesystem sink", () => {
  const report = check(repeatedSource("import", "/proc/self/stat"), importedEntry);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 4, importedEntry);
});
test("actual filesystem input calls complete within the original finite budget", () => {
  const report = check(repeatedSource("input-fs", "snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});
test("the final actual filesystem input call retains its unsafe path", () => {
  const report = check(repeatedSource("input-fs", "/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 2);
});

test("intrinsic call arguments retain their actual source helper effects", () => {
  const report = check(`const fs = require('node:fs');
function read(file) { fs.readFileSync(file); return 0; }
function inspect(input, file) { return input.method(read(file)); }
inspect(unresolvedInput, '/proc/self/stat');`);
  sink(report, 2);
});
test("source object methods retain each captured caller input", () => {
  const report = check(`const fs = require('node:fs');
function metadata(file) { return { read() { fs.readFileSync(file); return 0; } }; }
function inspect(input) { return input.read(); }
inspect(metadata('snapshot.json'));
inspect(metadata('/proc/self/stat'));`);
  sink(report, 2);
});
test("source class methods retain their constructor input", () => {
  const report = check(`const fs = require('node:fs');
class Metadata { constructor(file) { this.file = file; }
read() { fs.readFileSync(this.file); return 0; } }
function inspect(input) { return input.read(); }
inspect(new Metadata('snapshot.json'));
inspect(new Metadata('/proc/self/stat'));`);
  sink(report, 3);
});
test("source getters returning callables retain their captured input", () => {
  const report = check(`const fs = require('node:fs');
function metadata(file) { return { get read() { return () => fs.readFileSync(file); } }; }
function inspect(input) { return input.read(); }
inspect(metadata('snapshot.json'));
inspect(metadata('/proc/self/stat'));`);
  sink(report, 2);
});
test("unknown methods still refuse an escaping sensitive argument", () => {
  const report = check(`const fs = require('node:fs');
function inspect(input, callback) { return input.method(callback); }
inspect(unresolvedInput, fs.readFileSync);`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS01" && item.line === 2
    && item.classification === "incomplete"), report.diagnostics.join("\n"));
});
test("optional builtin calls retain their actual filesystem sink", () => {
  const report = check(`const fs = require('node:fs');
function inspect(input, file) { return input?.readFileSync(file); }
inspect(fs, '/proc/self/stat');`);
  sink(report, 2);
});
test("computed builtin calls retain the actual filesystem violation", () => {
  const report = check(`const fs = require('node:fs');
function inspect(input, file) { return input['readFileSync'](file); }
inspect(fs, '/proc/self/stat');`);
  assert.equal(report.complete, true);
  assert.equal(report.ok, false);
  assert.deepEqual(report.diagnostics.map(item => [item.rule, item.file, item.line, item.column, item.classification, item.trace]),
    [["OS01", entry, 2, 40, "violation", [entry]]]);
});
test("builtin function indirection retains its capability refusal", () => {
  const report = check(`const fs = require('node:fs');
function inspect(input, file) { return input.call(null, file); }
inspect(fs.readFileSync, '/proc/self/stat');`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.line === 2 && item.classification === "incomplete"
    && item.message.includes("indirection")), report.diagnostics.join("\n"));
});
test("a source receiver shadowing Object retains its actual method body", () => {
  const report = check(`const fs = require('node:fs');
function metadata(file) { return { freeze(value) { fs.readFileSync(file); return value; } }; }
function inspect(Object) { return Object.freeze('value'); }
inspect(metadata('/proc/self/stat'));`);
  sink(report, 2);
});
test("source imports remain source-backed rather than builtin receivers", () => {
  const root = "src/renamed-source-call.mjs";
  const helper = "src/renamed-call-helper.mjs";
  const report = new OsIndependenceChecker(new MemorySourceRepository([
    [root, `import * as path from './renamed-call-helper.mjs'; path.read('/proc/self/stat');`],
    [helper, `import fs from 'node:fs';
export function read(file) { fs.readFileSync(file); return 0; }`],
  ]), { files: [root, helper], entrypoints: [root] }).check();
  sink(report, 2, helper);
});
test("written receiver inputs retain their unresolved method refusal", () => {
  const report = check(`const fs = require('node:fs');
function inspect(input, file) { input = fs; return input.readFileSync(file); }
inspect({}, '/proc/self/stat');`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.line === 2 && item.classification === "incomplete"), report.diagnostics.join("\n"));
});
test("literal method invocation preserves its transformed native path", () => {
  const report = check(`const fs = require('node:fs');
function inspect(input) { return input.trim(); }
fs.readFileSync(inspect('/proc/self/stat '));`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  sink(report, 3);
});
test("process input calls retain authority provenance at the actual branch", () => {
  const report = check(`function inspect(input) { return input.getuid(); }
const identity = inspect(process);
if (identity === 0) action();`);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.rule === "OS03" && item.line === 3), report.diagnostics.join("\n"));
});
test("intrinsic calls leave unvisited callback bodies for normal inspection", () => {
  const report = check(`const fs = require('node:fs');
function inspect(input) { return input.method(() => fs.readFileSync('/proc/self/stat')); }
inspect(unresolvedInput);`);
  sink(report, 2);
});
test("distinct source method calls retain the original finite work refusal", () => {
  const reads = Array.from({ length: 3000 }, () => "input.read()").join(",");
  finiteRefusal(check(`function inspect(input) { return [${reads}]; }
inspect({ read() { return 0; } });`));
});
test("the native array predicate does not execute or expose its function input", () => {
  const report = check(`const fs = require('node:fs');
Array.isArray(fs.readFileSync);`);
  assert.equal(report.complete, true);
  assert.equal(report.ok, true);
  assert.deepEqual(report.diagnostics, []);
});
test("an unsupported native operation still refuses a sensitive argument", () => {
  const report = check(`const fs = require('node:fs');
Array.uninspectedFutureOperation(fs.readFileSync);`);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.line === 2 && item.classification === "incomplete"), report.diagnostics.join("\n"));
});
test("uncertain source getter reads retain the original finite work refusal", () => {
  const reads = Array.from({ length: 3000 }, () => "input.value").join(",");
  finiteRefusal(check(`function inspect(input) { return [${reads}]; }
const selected = condition ? { get value() { return 0; } } : { get value() { return 1; } };
inspect(selected);`));
});
test("uncertain source getters still inspect their captured filesystem inputs", () => {
  const report = check(`const fs = require('node:fs');
function metadata(file) { return { get value() { fs.readFileSync(file); return 0; } }; }
function inspect(input) { return input.value; }
const selected = condition ? metadata('snapshot.json') : metadata('/proc/self/stat');
inspect(selected);`);
  sink(report, 2);
});
