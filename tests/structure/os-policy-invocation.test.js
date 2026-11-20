import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const invocationSource = fs.readFileSync(new URL("../../src/lib/command-invocation.js", import.meta.url), "utf8");
const policySource = fs.readFileSync(new URL("../../src/lib/git-repository-environment.js", import.meta.url), "utf8");
const file = "src/renamed-policy-producer.mjs";

function inspect({ stage = false, before = "", options = "...selected.processOptions(), shell: false, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536" } = {}) {
  const source = `import { spawnSync as launch } from 'node:child_process';
import { ${stage ? "GitOwnedStagePolicy" : "GitRepositoryPolicy"} as Policy } from './indirect.mjs';
const policy = new Policy(${stage ? "{repositoryRoot: '/owned-project', gitDir: '/owned-project/.git'}" : "{readOnly: true, isolateConfiguration: true}"});
${before}
const selected = policy.invocation(['rev-parse', '--show-toplevel'], {cwd: '/owned-project', stdio: ['ignore', 'pipe', 'pipe']});
launch(selected.executable, selected.args, {${options}});`;
  const report = new OsIndependenceChecker(new MemorySourceRepository([
    [file, source],
    ["src/indirect.mjs", "export {GitRepositoryPolicy, GitOwnedStagePolicy} from './policy-api.mjs';"],
    ["src/policy-api.mjs", policySource],
    ["src/command-invocation.js", invocationSource],
  ]), { files: [file], entrypoints: [file] }).check();
  assert.deepEqual(report.diagnostics.filter(entry => entry.rule === "OS00"), [],
    "an unavailable inspection cannot establish an empty launch finding set");
  const line = source.slice(0, source.lastIndexOf("launch(")).split("\n").length;
  return report.diagnostics.filter(entry => entry.file === file && entry.line === line);
}

// These isolate actual source-backed factory provenance at the launch. Other
// findings in the imported modules remain the whole-source auditor's concern.
for (const stage of [false, true]) {
  test(`actual policy factory retains its returned typed invocation: owned stage=${stage}`, () => {
    assert.deepEqual(inspect({ stage }), []);
  });
}

for (const before of [
  "policy.invocation = foreign;",
  "Policy.prototype.invocation = foreign;",
  "policy.arguments = foreign;",
  "policy.environment = foreign;",
  "opaque(policy);",
  "opaque(Policy);",
]) test(`changed policy authority cannot manufacture a typed invocation: ${before}`, () => {
  assert.notDeepEqual(inspect({ before }), []);
  assert.deepEqual(inspect(), [], "removing the mutation restores the real factory proof");
});

for (const options of [
  "...selected.processOptions(), shell: true",
  "...selected.processOptions(), shell: false, cwd: '/different-project'",
  "...selected.processOptions(), shell: false, env: foreign",
]) test(`a factory result does not authorize different launch options: ${options}`, () => {
  assert.notDeepEqual(inspect({ options }), []);
  assert.deepEqual(inspect(), [], "removing the override restores the same invocation");
});
