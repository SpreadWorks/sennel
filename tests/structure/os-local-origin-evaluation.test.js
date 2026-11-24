import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-local-origin.mjs";
function check(source, dependencies = []) {
  const repository = new MemorySourceRepository([[entry, source], ...dependencies]);
  return new OsIndependenceChecker(repository, { files: [entry], entrypoints: [entry] }).check();
}
function diagnostic(report, line, classification = "violation", rule = "OS01") {
  return report.diagnostics.some(item => item.file === entry && item.line === line
    && item.rule === rule && item.classification === classification);
}
function metadata(file, delegated = false) {
  const references = Array.from({ length: 900 }, () => "selectedPath").join(",");
  const calls = Array.from({ length: 8 }, (_, index) => `fs.readFileSync(selected('input-${index}.json')[0]);`).join("\n");
  return `import fs from 'node:fs';
${delegated ? "function observed(input) { fs.readFileSync(input); return input; }\n" : ""}function selected(input) { const selectedPath = ${delegated ? "observed(input)" : "input"}; return [selectedPath, ${references}]; }
${calls}
fs.readFileSync(selected(${JSON.stringify(file)})[0]);`;
}

test("repeated reads of one local initializer permit complete source inspection", () => {
  const report = check(metadata("snapshot.json"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("a later helper invocation retains its own local native path", () => {
  const report = check(metadata("/proc/self/stat"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(diagnostic(report, 11), report.diagnostics.join("\n"));
});

test("written local bindings still merge their unsafe origins", () => {
  const report = check(`import fs from 'node:fs';
function selected() { let file = 'snapshot.json'; file = '/proc/self/stat';
fs.readFileSync(file); }
selected();`);
  assert.equal(report.ok, false);
  assert.ok(diagnostic(report, 3, "incomplete"), report.diagnostics.join("\n"));
});

test("a local builtin alias observes the later native consumer", () => {
  const report = check(`import fs from 'node:fs';
function selected(input) { const load = fs.readFileSync;
load('snapshot.json');
load(input); }
selected('/proc/self/stat');`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(diagnostic(report, 4), report.diagnostics.join("\n"));
  assert.equal(diagnostic(report, 3), false);
});

test("delegated local initializers preserve their own native observation", () => {
  const report = check(metadata("/proc/self/stat", true));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(diagnostic(report, 2), report.diagnostics.join("\n"));
  assert.ok(diagnostic(report, 12), report.diagnostics.join("\n"));
});

test("local getter consumers keep their captured invocation input", () => {
  const report = check(`import fs from 'node:fs';
function selected(input) { const captured = { get file() { return input; } }; return [captured.file, captured.file]; }
fs.readFileSync(selected('snapshot.json')[0]);
fs.readFileSync(selected('/proc/self/stat')[1]);`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(diagnostic(report, 4), report.diagnostics.join("\n"));
});

test("local origin reuse cannot lend nominal invocation options to a plain object", () => {
  const api = fs.readFileSync(new URL("../../src/lib/command-invocation.js", import.meta.url), "utf8");
  const report = check(`import { spawn } from 'node:child_process'; import { NativeExecutableInvocation } from './command-invocation.js';
function selected() {
const trusted = new NativeExecutableInvocation({ executable: process.execPath, args: ['worker.js'], cwd: null, env: null, stdio: 'ignore' });
const invocation = { executable: process.execPath, args: ['worker.js'], processOptions: trusted.processOptions };
const options = invocation.processOptions();
spawn(invocation.executable, invocation.args, { ...options, shell: false });
}
selected();`, [["src/command-invocation.js", api]]);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.file === entry && item.line === 6
    && item.rule === "OS02" && ["violation", "incomplete"].includes(item.classification)), report.diagnostics.join("\n"));
});
