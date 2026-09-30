import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { Agent } from "../../../src/lib/agent.js";
import { Logger } from "../../../src/lib/log.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { PromptBatchExecutor, PromptBatchPlan, PromptProtocolRetryLimit,
  PromptProviderAttemptLimit } from "../../../src/lib/prompt-batching.js";
import { AgentResponseProtocolFailure, FileReadUnavailable,
  executeAgentResponseProtocol } from "../../../src/lib/agent-response-protocol.js";

it("preserves actual Agent transport starts when admission stops a read retry", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-protocol-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { agent: { default: "fixture/local", timeout: 300,
    providers: { "fixture/local": { command: "fixture", args: ["{{PROMPT}}"] } } } };
  let providerStarts = 0;
  const agent = new Agent({ config, paths: { root, agentWorkDir: path.join(root, ".tmp") },
    registry: new ProviderRegistry(config.agent.providers),
    logger: new Logger({ enabled: false, logDir: root }),
    supervision: { spawn() {
      providerStarts += 1;
      const child = new EventEmitter();
      child.pid = null;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      const text = providerStarts === 1 ? "malformed" : providerStarts === 2 ? "read-failure" : "";
      queueMicrotask(() => { if (text) child.stdout.emit("data", text); child.emit("close", 0, null); });
      return child;
    } },
  });
  const executor = new PromptBatchExecutor();
  const plan = PromptBatchPlan.fromRequest({ id: "file-group", request: { userPrompt: "exact input reference" } });
  await assert.rejects(executor.executeCompletions({ plan,
    protocolRetryLimit: new PromptProtocolRetryLimit(4), providerAttemptLimit: new PromptProviderAttemptLimit(4),
    callAgent: async (request, _batch, _index, attempt, admission) => {
      const text = await agent.call(request.userPrompt, { commandId: "test", providerCallAdmission: admission,
        cacheMode: attempt.cacheMode, retryCount: 3, retryDelayMs: 1 });
      return { text, cacheOutcome: attempt.cacheMode, fresh: attempt.cacheMode === "bypass",
        providerCalled: admission.attemptCount > 0 };
    },
    protocolPolicy: { async execute({ call, accounting }) {
      const result = await executeAgentResponseProtocol({ groupIdentity: "file-group", accounting, maxFileReadRetries: 3,
        callAgent: (attempt) => call(plan.batches[0].request, attempt),
        parseResponse: (text) => {
          if (text === "malformed") throw new Error("Malformed response");
          return new FileReadUnavailable("The exact input could not be read");
        },
      });
      return result.value;
    } }, responseContract: { parse: (response) => response },
  }), (wrapped) => {
    let error = wrapped;
    while (!(error instanceof AgentResponseProtocolFailure) && error.cause) error = error.cause;
    assert.ok(error instanceof AgentResponseProtocolFailure);
    assert.equal(error.data.failureMode, "provider_call_limit_exhausted");
    const group = error.evidence.groups[0];
    assert.equal(group.providerAttemptCount, 4);
    assert.equal(group.responseCallCount, 3);
    assert.deepEqual(group.attempts.map((attempt) => attempt.providerAttemptCount), [1, 2, 4]);
    assert.equal(group.attempts.at(-1).providerCalled, true);
    return true;
  });
  assert.equal(providerStarts, 4);
});
