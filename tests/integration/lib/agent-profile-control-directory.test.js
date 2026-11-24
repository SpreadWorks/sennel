import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Agent, AGENT_EXTERNAL_EXECUTION_INSTRUCTION } from "../../../src/lib/agent.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { ReadOnlyProcessRuntimeStorage } from "../../../src/lib/readonly-invocation-workspace.js";
import { AgentPermissionConfigurationFailure } from "../../../src/lib/agent-failure.js";
import { Logger } from "../../../src/lib/log.js";
import { NodeAgentProviderSequence } from "../../support/infrastructure/node-agent-provider-sequence.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

test("declared control directory arguments share live authority across projection, actual argv and stdin fallback", { timeout: 120000 }, async (t) => {
  const root = createTmpDir("agent-control-directory-");
  let runtime;
  t.after(async () => {
    try { if (runtime !== undefined && !runtime.closed) await runtime.close(); }
    finally { removeQuiescentRuntimeFixture({ mainRoot: root }); }
  });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  await runtime.enter(async () => {
    const directory = ReadOnlyProcessRuntimeStorage.fromGrant(runtime.remoteGrant().endpoint.storage).directory;
    const provider = new NodeAgentProviderSequence(root, [
      { response: { result: "inline" } }, { response: { result: "stdin" } }, { response: { result: "successor" } },
    ], { profile: { args: ["--directory", "{{CONTROL_DIRECTORY}}", "--quoted={{CONTROL_DIRECTORY_JSON}}", "{{PROMPT}}"] } });
    const agentWorkDir = path.join(root, ".tmp", "provider-work");
    let reusableAgent;
    for (const [index, threshold] of [100000, 1].entries()) {
      const config = { agent: { default: "fixture", timeout: 30, retryCount: 0, stdinFallbackThreshold: threshold,
        providers: { fixture: provider.profile } } };
      const value = new Agent({ config, paths: { root, agentWorkDir }, registry: provider.registry("fixture"),
        logger: new Logger({ logDir: path.join(root, "logs"), enabled: false }) });
      reusableAgent = value;
      const prompt = 'literal $& {{CONTROL_DIRECTORY}} 日本語';
      const effectivePrompt = AGENT_EXTERNAL_EXECUTION_INSTRUCTION + "\n\n" + prompt;
      const options = { cacheMode: "bypass", executionEnvironment: { CONTROL_DIRECTORY: "/not-authority" } };
      const beforeProjection = fs.existsSync(agentWorkDir);
      const projection = value.projectInvocation(prompt, options);
      assert.equal(fs.existsSync(agentWorkDir), beforeProjection, "projection must not create runtime/provider storage");
      const materialized = value._buildInvocationForTest(prompt, options);
      assert.deepEqual(materialized.finalArgs, projection.finalArgs);
      assert.equal(materialized.stdinContent, index === 0 ? null : effectivePrompt);
      assert.equal(projection.usesStdin, index === 1);
      assert.equal(projection.argvByteCount, projection.finalArgs.reduce((sum, argument) => sum + Buffer.byteLength(argument), 0));
      const expected = [provider.scriptPath, "--directory", directory, "--quoted=" + JSON.stringify(directory), ...(index === 0 ? [effectivePrompt] : [])];
      assert.deepEqual(projection.finalArgs, expected);
      assert.equal(await value.call(prompt, options), index === 0 ? "inline" : "stdin");
      const call = runtime.inspect().executions.find((execution) => execution.executionId === runtime.executionId).calls[index];
      assert.deepEqual(call.invocation.actualCommand.args, expected);
      assert.equal(call.receipt.callId, call.callId);
      assert.equal(call.receipt.observation.code, 0);
    }
    assert.equal(provider.starts(), 2);
    await runtime.close();
    const value = new Agent({ config: { agent: { default: "fixture", providers: { fixture: provider.profile } } } });
    assert.throws(() => value.projectInvocation("closed"), (error) => error instanceof AgentPermissionConfigurationFailure);
    runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
    await runtime.enter(async () => {
      const successorDirectory = ReadOnlyProcessRuntimeStorage.fromGrant(runtime.remoteGrant().endpoint.storage).directory;
      assert.notEqual(successorDirectory, directory);
      const expected = [provider.scriptPath, "--directory", successorDirectory, "--quoted=" + JSON.stringify(successorDirectory)];
      assert.deepEqual(reusableAgent.projectInvocation("new generation").finalArgs, expected);
      assert.equal(await reusableAgent.call("new generation", { cacheMode: "bypass" }), "successor");
      const call = runtime.inspect().executions.find((execution) => execution.executionId === runtime.executionId).calls[0];
      assert.deepEqual(call.invocation.actualCommand.args, expected);
      assert.equal(call.receipt.observation.code, 0);
      assert.equal(provider.starts(), 3);
    });
  });
});
