import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

// Inspect the real API as text. Never execute fixture or production source.
const api = fs.readFileSync(new URL("../../src/lib/command-invocation.js", import.meta.url), "utf8");
const fixtures = JSON.parse(fs.readFileSync(new URL("../fixtures/os-native-invocation/cases.json", import.meta.url), "utf8"));
const base = fixtures[0].source;

function reflectionCases(source, statements) {
  for (const [name, statement] of statements) {
    fixtures.push({ name, expectation: "prototype-incomplete",
      source: source.replace("spawn(invocation.executable", `${statement}\nspawn(invocation.executable`) });
  }
}

reflectionCases(base, [
  ["prototype mutation", "NativeExecutableInvocation.prototype.processOptions = function() { return { shell: true }; };"],
  ["prototype reflection", "Object.getPrototypeOf(invocation).processOptions = function() { return { shell: true }; };"],
  ["own method reflection", "Object.defineProperty(invocation, 'processOptions', { value() { return { shell: true }; } });"],
]);
const parentSource = base.replace("{ NativeExecutableInvocation }", "{ NativeExecutableInvocation, CommandInvocation }");
reflectionCases(parentSource, [
  ["parent prototype mutation", "CommandInvocation.prototype.processOptions = function() { return { shell: true }; };"],
  ["parent via constructor reflection", "Object.getPrototypeOf(NativeExecutableInvocation).prototype.processOptions = function() { return { shell: true }; };"],
  ["computed class prototype", "NativeExecutableInvocation['prototype'].processOptions = function() { return { shell: true }; };"],
]);
fixtures.push({ name: "captured data fields cannot be inherited accessors", source: base,
  apiOverride: api.replace("export class CommandInvocation {", "export class CommandInvocation { get args() { return []; }"),
  expectation: "unproven-launch" });
fixtures.push({ name: "changed scalar validator cannot inherit a constructor proof", source: base,
  apiOverride: api.replace("typeof value !== 'string'", "false"), expectation: "unproven-launch" });
const renamedApi = api.replaceAll("NativeExecutableInvocation", "LiteralLaunch").replaceAll("CommandInvocation", "InvocationInput")
  .replaceAll("function token(", "function scalarArgument(").replaceAll(" token(", " scalarArgument(")
  .replaceAll("= token(", "= scalarArgument(").replaceAll("function tokens(", "function literalArguments(")
  .replaceAll("= tokens(", "= literalArguments(");
fixtures.push({ name: "renamed exported classes and validators retain the lexical contract",
  source: base.replaceAll("NativeExecutableInvocation", "LiteralLaunch").replace("const invocation =", "const selected =")
    .replaceAll("invocation.executable", "selected.executable").replaceAll("invocation.args", "selected.args")
    .replaceAll("invocation.processOptions", "selected.processOptions"),
  apiOverride: renamedApi, expectation: "typed-launch" });
fixtures.push({ name: "plain object cannot borrow a different nominal invocation option value",
  source: `import { spawn } from 'node:child_process'; import { NativeExecutableInvocation } from './command-invocation.js';
const trusted = new NativeExecutableInvocation({ executable: process.execPath, args: ['worker.js'], cwd: null, env: null, stdio: 'ignore' });
const invocation = { executable: process.execPath, args: ['worker.js'], processOptions() { return trusted.processOptions(); } };
spawn(invocation.executable, invocation.args, { ...invocation.processOptions(), shell: false });`, expectation: "unproven-launch" });
fixtures.push({ name: "plain object cannot rebind a nominal invocation option method",
  source: `import { spawn } from 'node:child_process'; import { NativeExecutableInvocation } from './command-invocation.js';
const trusted = new NativeExecutableInvocation({ executable: process.execPath, args: ['worker.js'], cwd: null, env: null, stdio: 'ignore' });
const invocation = { executable: process.execPath, args: ['worker.js'], processOptions: trusted.processOptions };
spawn(invocation.executable, invocation.args, { ...invocation.processOptions(), shell: false });`, expectation: "unproven-launch" });
reflectionCases(base, [
  ["instance constructor prototype escape", "invocation.constructor.prototype.processOptions = function() { return { shell: true }; };"],
  ["instance legacy prototype escape", "invocation.__proto__.processOptions = function() { return { shell: true }; };"],
  ["Reflect prototype escape", "Reflect.getPrototypeOf(invocation).processOptions = function() { return { shell: true }; };"],
  ["Object descriptor prototype escape", "Object.getOwnPropertyDescriptor(NativeExecutableInvocation, 'prototype').value.processOptions = function() { return { shell: true }; };"],
  ["uninspected nested constructor escape", "foreign({ nested: [NativeExecutableInvocation] });"],
  ["uninspected nested instance escape", "foreign({ nested: [invocation] });"],
  ["uninspected constructor escape", "foreign(NativeExecutableInvocation);"],
  ["uninspected instance escape", "foreign(invocation);"],
]);

for (const fixture of fixtures) {
  test(fixture.name, () => {
    const file = "src/native-launch-probe.js";
    const repository = new MemorySourceRepository([
      [file, fixture.source], ["src/command-invocation.js", fixture.apiOverride ?? api],
    ]);
    const report = new OsIndependenceChecker(repository, { files: [file] }).check();
    const launchLine = fixture.source.slice(0, fixture.source.lastIndexOf("spawn(")).split("\n").length;
    const findings = report.diagnostics.filter(entry => entry.file === file && entry.line === launchLine);
    const details = report.diagnostics.join("\n");
    assert.ok(!report.diagnostics.some(entry => entry.file === file && entry.rule === "OS00"), details);
    if (fixture.expectation === "typed-launch") assert.deepEqual(findings, [], details);
    else if (fixture.expectation === "shell-violation") {
      assert.ok(findings.some(entry => entry.rule === "OS02" && entry.classification === "violation"
        && /shell:true/.test(entry.message)), details);
    } else if (fixture.expectation === "authority-violation") {
      assert.ok(findings.some(entry => entry.rule === "OS03" && entry.classification === "violation"), details);
    } else if (fixture.expectation === "prototype-incomplete") {
      assert.ok(report.diagnostics.some(entry => entry.file === file && entry.line === launchLine - 1
        && entry.rule === "OS02" && ["violation", "incomplete"].includes(entry.classification)), details);
    } else {
      assert.ok(findings.some(entry => entry.rule === "OS02"
        && ["violation", "incomplete"].includes(entry.classification)), details);
    }
  });
}
