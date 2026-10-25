import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Agent } from "../../../src/lib/agent.js";
import { Logger } from "../../../src/lib/log.js";
import { TemporaryPaths } from "../../../src/lib/temporary-paths.js";
import { ReadOnlyInvocationWorkspace } from "../../../src/lib/readonly-invocation-workspace.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { testTemporaryRoot } from "../../test-environment.js";

function schemaAgent(paths) {
  const script = "const fs=require('node:fs');const file=process.argv[process.argv.indexOf('--schema')+1];process.stdout.write(JSON.stringify({cwd:process.cwd(),file,schema:JSON.parse(fs.readFileSync(file,'utf8'))}));";
  return new Agent({ paths, config: { agent: { default: "fixture", providers: { fixture: {
    command: process.execPath, args: ["-e", script, "{{PROMPT}}"], jsonSchemaFlag: "--schema", jsonSchemaMode: "file",
  } } } }, logger: new Logger({ enabled: false }) });
}

const schema = { type: "object", properties: { value: { type: "string" } } };

test("Agent keeps worktree execution cwd while its schema uses the explicitly owning repository scratch", async (t) => {
  const mainRoot = createTmpDir("agent-scratch-main-");
  const executionRoot = path.join(mainRoot, "worktree");
  fs.mkdirSync(executionRoot);
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    catch (error) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw error; }
    removeTmpDir(mainRoot);
  });
  const temporaryPaths = new TemporaryPaths(mainRoot);
  const temporaryRoot = temporaryPaths.runtime("selected-agent-scratch");
  const agent = schemaAgent({ root: executionRoot, repositoryRoot: mainRoot, temporaryPaths,
    agentWorkDir: path.join(executionRoot, ".tmp") });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot, executionRoot, environment: {} });
  const output = await runtime.enter(() => agent.call("schema", { jsonSchema: schema, temporaryRoot, cacheMode: "bypass", retryCount: 0 }));
  const observed = JSON.parse(output);
  assert.equal(observed.cwd, fs.realpathSync(executionRoot));
  assert.equal(path.dirname(observed.file), temporaryRoot);
  assert.equal(observed.schema.properties.value.type, "string");
  assert.equal(fs.existsSync(observed.file), false, "owned schema input is removed after use");
  assert.equal(fs.existsSync(path.join(executionRoot, ".tmp", "runtime", "agent")), false);
  const call = runtime.store.read().executions.at(-1).calls[0];
  assert.equal(call.invocation.launch.cwd, executionRoot);
  assert.equal(call.receipt.stopEvidence.confirmed, true);
});

test("Agent reuses a minted readonly workspace without creating project scratch", async (t) => {
  const root = createTmpDir("agent-scratch-readonly-");
  const workspace = ReadOnlyInvocationWorkspace.create();
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    catch (error) { testTemporaryRoot().retainOnUnconfirmedExecution(); throw error; }
    workspace.complete({ generation: workspace.generation, normalExit: true, resourcesReleased: true });
    workspace.cleanup({ generation: workspace.generation });
    removeTmpDir(root);
  });
  const temporaryRoot = workspace.runtime("schema");
  const agent = schemaAgent({ root, repositoryRoot: root, temporaryPaths: workspace, temporaryRoot,
    agentWorkDir: workspace.runtime("agent-work") });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, workspace });
  const output = await runtime.enter(() => agent.call("schema", { jsonSchema: schema, cacheMode: "bypass", retryCount: 0 }));
  const observed = JSON.parse(output);
  assert.equal(observed.cwd, fs.realpathSync(root));
  assert.equal(path.dirname(observed.file), temporaryRoot);
  assert.equal(observed.schema.properties.value.type, "string");
  await runtime.close();
  assert.deepEqual(fs.readdirSync(root), []);
});
