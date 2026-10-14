import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TemporaryPaths } from "../../../src/lib/temporary-paths.js";
import { RuntimeLogFile } from "../../../src/lib/runtime-log.js";
import { Logger } from "../../../src/lib/log.js";
import { Agent } from "../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { TEST_CHECKOUT_ROOT } from "../../test-temporary-root.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function project(t) {
  // Disk-backed fixtures also exercise rejection outside the selected project.
  const root = createTmpDir("temporary-paths-", {
    parent: new TemporaryPaths(TEST_CHECKOUT_ROOT).tests(),
  });
  t.after(() => removeTmpDir(root));
  return root;
}

test("project scratch namespaces accept nested custom directories and reject another disk directory", (t) => {
  const root = project(t);
  const paths = new TemporaryPaths(root);
  assert.equal(paths.flow("spec-a", "run-a"), path.join(root, ".tmp", "flows", "spec-a", "run-a"));
  assert.equal(paths.runtime("agent"), path.join(root, ".tmp", "runtime", "agent"));
  assert.equal(paths.operator(), path.join(root, ".tmp", "operator"));
  const custom = paths.logs(".tmp/logs/custom/nested");
  paths.ensureDirectory(custom);
  TemporaryPaths.writeFile(path.join(custom, "input.json"), "exact bytes");
  assert.equal(fs.readFileSync(path.join(custom, "input.json"), "utf8"), "exact bytes");
  const outside = path.join(root, "other");
  assert.throws(() => paths.ensureDirectory(outside), { code: "TEMPORARY_PATH_OUTSIDE_PROJECT" });
  assert.equal(fs.existsSync(outside), false);
  assert.throws(() => paths.flow("spec-a", "../outside"), /runId/);
});

test("runtime log rechecks a formerly absent directory before reading through a later symlink", (t) => {
  const root = project(t);
  const outside = path.join(root, "outside");
  fs.mkdirSync(path.join(outside, "logs"), { recursive: true });
  const sentinel = path.join(outside, "logs", "selected-flow.log");
  fs.writeFileSync(sentinel, "outside-sentinel\n");
  const file = new RuntimeLogFile(root, "selected-flow");
  assert.equal(file.read(), "");
  fs.symlinkSync(outside, path.join(root, ".tmp"));
  assert.throws(() => file.read(), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
  assert.throws(() => file.append("must not escape"), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
  assert.equal(fs.readFileSync(sentinel, "utf8"), "outside-sentinel\n");
});

test("runtime log rejects a file symlink without altering its destination", (t) => {
  const root = project(t);
  const file = new RuntimeLogFile(root, "selected-flow");
  fs.mkdirSync(path.dirname(file.filePath), { recursive: true });
  const sentinel = path.join(root, "untouched.log");
  fs.writeFileSync(sentinel, "original");
  fs.symlinkSync(sentinel, file.filePath);
  assert.throws(() => file.append("must not escape"), { code: "TEMPORARY_FILE_INVALID" });
  assert.throws(() => file.read(), { code: "TEMPORARY_FILE_INVALID" });
  assert.equal(fs.readFileSync(sentinel, "utf8"), "original");
});

test("runtime log reads a regular log appearing after its initial missing-directory check", (t) => {
  const root = project(t);
  const file = new RuntimeLogFile(root, "selected-flow");
  assert.equal(file.read(), "");
  fs.mkdirSync(path.dirname(file.filePath), { recursive: true });
  fs.writeFileSync(file.filePath, "exact new log\n");
  assert.equal(file.read(), "exact new log\n");
});

test("Logger refuses an existing daily file symlink before its first event", (t) => {
  const root = project(t);
  const logDir = new TemporaryPaths(root).ensureDirectory(path.join(root, ".tmp", "logs"));
  const sentinel = path.join(root, "untouched.jsonl");
  fs.writeFileSync(sentinel, "original");
  const today = new Date();
  const date = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0")].join("-");
  fs.symlinkSync(sentinel, path.join(logDir, `sennel-${date}.jsonl`));
  assert.throws(() => new Logger({ logDir, enabled: true }), { code: "TEMPORARY_FILE_INVALID" });
  assert.equal(fs.readFileSync(sentinel, "utf8"), "original");
});

const providerScript = `
  const fs = require("node:fs");
  const args = process.argv.slice(2);
  const schemaPath = args[args.indexOf("--schema") + 1];
  process.stdout.write(JSON.stringify({ cwd: process.cwd(), schemaPath,
    schema: JSON.parse(fs.readFileSync(schemaPath, "utf8")),
    workDir: args.includes("--work-root") ? args[args.indexOf("--work-root") + 1] : null }));
`;

test("non-Flow Agent schemas use canonical runtime storage independently of its configured execution directory", async (t) => {
  const root = project(t);
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(checkout);
  const providerFile = path.join(root, "provider.cjs");
  fs.writeFileSync(providerFile, `#!/usr/bin/env node\n${providerScript}`, { mode: 0o755 });
  const profile = { command: providerFile, args: ["{{PROMPT}}"], workDirFlag: "--work-root",
    jsonSchemaFlag: "--schema", jsonSchemaMode: "file" };
  const config = { agent: { default: "test/exec", providers: { "test/exec": profile } } };
  const configuredExecution = path.join(checkout, "configured-execution");
  const agent = new Agent({ config, paths: { root: checkout, repositoryRoot: root, agentWorkDir: configuredExecution },
    registry: new ProviderRegistry(config.agent.providers),
    logger: new Logger({ logDir: new TemporaryPaths(root).logs(), enabled: false }) });
  const schema = { type: "object" };
  const result = JSON.parse(await agent.call("input", { jsonSchema: schema,
    flowAttribution: "none", retryCount: 0 }));
  assert.equal(path.dirname(result.schemaPath), path.join(root, ".tmp", "runtime", "agent"));
  assert.deepEqual(result.schema, schema);
  assert.equal(result.cwd, checkout);
  assert.equal(result.workDir, configuredExecution);
  assert.equal(fs.existsSync(result.schemaPath), false);
  assert.deepEqual(fs.readdirSync(configuredExecution), []);
  assert.equal(fs.existsSync(path.join(checkout, ".tmp")), false);
});

for (const workDirFlag of [null, "--work-root"]) {
  test(`Agent consumes independent Flow schema scopes while preserving execution directory (${workDirFlag ?? "cwd only"})`, async (t) => {
    const root = project(t);
    const checkout = path.join(root, "checkout");
    const execution = path.join(checkout, "execution");
    fs.mkdirSync(execution, { recursive: true });
    const providerFile = path.join(root, "provider.cjs");
    fs.writeFileSync(providerFile, `#!/usr/bin/env node\n${providerScript}`, { mode: 0o755 });
    const profile = { command: providerFile, args: ["{{PROMPT}}"],
      workDirFlag, jsonSchemaFlag: "--schema", jsonSchemaMode: "file" };
    const config = { agent: { default: "test/exec", providers: { "test/exec": profile } } };
    const logs = new TemporaryPaths(root).logs();
    const logger = new Logger({ logDir: logs, enabled: true, cwd: root });
    const agent = new Agent({ config, paths: { root: checkout, repositoryRoot: root,
      agentWorkDir: path.join(checkout, "configured-execution"), logDir: logs },
      registry: new ProviderRegistry(config.agent.providers), logger });
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
    const scopes = ["run-a", "run-b"].map((run) => new TemporaryPaths(root).flow("spec-a", run));
    const results = await Promise.all(scopes.map((temporaryRoot) => agent.call("input", {
      temporaryRoot, executionWorkDir: execution, jsonSchema: schema,
      flowAttribution: "none", retryCount: 0,
    }).then(JSON.parse)));
    await logger.flush();
    for (const [index, result] of results.entries()) {
      assert.equal(path.dirname(result.schemaPath), scopes[index]);
      assert.deepEqual(result.schema, schema);
      assert.equal(result.cwd, execution);
      assert.equal(result.workDir, workDirFlag ? execution : null);
      assert.equal(fs.existsSync(result.schemaPath), false);
    }
    assert.equal(new Set(results.map((result) => result.schemaPath)).size, 2);
    assert.equal(fs.existsSync(path.join(checkout, "configured-execution")), false);
    assert.equal(fs.existsSync(path.join(checkout, ".tmp")), false);
    const jsonl = fs.readdirSync(logs).find((name) => name.endsWith(".jsonl"));
    const events = fs.readFileSync(path.join(logs, jsonl), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.filter((entry) => entry.type === "agent" && entry.phase === "end").length, 2);
  });
}
