import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const api = fs.readFileSync(new URL("../../src/lib/command-invocation.js", import.meta.url), "utf8");
const file = "src/renamed-process-options.js";
const ordinary = "...selected.processOptions(), shell: false";

function inspect(options, before = "") {
  const source = `import { spawnSync as launch } from "node:child_process";
import { NativeExecutableInvocation as LiteralInvocation } from "./indirect.js";
const selected = new LiteralInvocation({ executable: process.execPath, args: ["worker.mjs"], cwd: null, env: null, stdio: "pipe" });
${before}
launch(selected.executable, selected.args, { ${options} });`;
  const repository = new MemorySourceRepository([
    [file, source],
    ["src/indirect.js", 'export { NativeExecutableInvocation } from "./invocation-api.js";'],
    ["src/invocation-api.js", api],
  ]);
  const report = new OsIndependenceChecker(repository, { files: [file] }).check();
  assert.deepEqual(report.diagnostics.filter(entry => entry.rule === "OS00"), [],
    "a failed inspection cannot establish an empty launch diagnostic set");
  const line = source.slice(0, source.lastIndexOf("launch(")).split("\n").length;
  return report.diagnostics.filter(entry => entry.file === file && entry.line === line);
}

// These tests isolate the launch contract. They do not claim that unrelated
// diagnostics in the imported API or the whole-product audit are resolved.
for (const options of [
  ordinary,
  `${ordinary}, encoding: "utf8"`,
  `${ordinary}, timeout: 30000`,
  `${ordinary}, maxBuffer: 64 * 1024`,
  `${ordinary}, killSignal: "SIGKILL"`,
  `${ordinary}, input: "literal stdin"`,
  `${ordinary}, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024`,
  `encoding: "utf8", ${ordinary}, timeout: 30000`,
]) {
  test(`same invocation retains its authority with closed observation options: ${options}`, () => {
    assert.deepEqual(inspect(options), []);
  });
}

for (const options of [
  `${ordinary}, cwd: "elsewhere"`,
  `${ordinary}, env: { NODE_OPTIONS: "--eval=foreign" }`,
  `${ordinary}, stdio: "inherit"`,
  `${ordinary}, uid: 123`,
  `${ordinary}, gid: 123`,
  `${ordinary}, detached: true`,
  `${ordinary}, windowsVerbatimArguments: true`,
  `${ordinary}, shell: true`,
  `${ordinary}, shell: false`,
  `${ordinary}, encoding: "utf8", encoding: "utf8"`,
  `${ordinary}, get encoding() { return "utf8"; }`,
  `${ordinary}, ["encoding"]: "utf8"`,
  `${ordinary}, encoding: opaque()`,
  `${ordinary}, ...foreign`,
  `${ordinary}, unknownOption: true`,
  `${ordinary}, killSignal: "SIGUSR1"`,
]) {
  test(`extra launch authority or uninspected option remains rejected: ${options}`, () => {
    const findings = inspect(options);
    assert.ok(findings.some(entry => ["OS01", "OS02", "OS03"].includes(entry.rule)), JSON.stringify(findings));
    assert.deepEqual(inspect(ordinary), [], "removing the injected option restores the exact launch proof");
  });
}

for (const write of [
  'selected.processOptions = opaque;',
  'LiteralInvocation.prototype.processOptions = opaque;',
  'opaque(selected);',
]) {
  test(`closed extra options cannot conceal changed invocation authority: ${write}`, () => {
    assert.notDeepEqual(inspect(`${ordinary}, encoding: "utf8"`, write), []);
    assert.deepEqual(inspect(ordinary), []);
  });
}

const independent = 'const first = new LiteralInvocation({ executable: process.execPath, args: ["other.mjs"], stdio: "pipe" });';

test("opaque access through another instance can change the shared prototype contract", () => {
  assert.notDeepEqual(inspect(`${ordinary}, encoding: "utf8"`, `${independent} opaque(first);`), []);
  assert.deepEqual(inspect(ordinary), []);
});

test("an own write on another allocation does not change the selected invocation", () => {
  assert.deepEqual(inspect(`${ordinary}, encoding: "utf8"`, `${independent} first.processOptions = opaque;`), []);
});
