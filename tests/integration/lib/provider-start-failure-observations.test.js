import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentTimeoutDiagnostic } from "../../../src/lib/agent-timeout.js";
import { AgentTimeoutFailure } from "../../../src/lib/agent-failure.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { CanonicalFlowVersionReader, QueryRequest } from "../../../src/flow/query.js";
import { validateFlowQueryResponse } from "../../../src/flow/query-contract.js";
import { createExecutionQueryScenario } from "../../support/infrastructure/execution-query-scenario.js";

// Known start -> managed settlement -> Agent observation -> canonical reload ->
// query summary. Abort and timeout have distinct exceptional transport paths.
// Existing agent-execution-observations and agent-provider-attempt-observation
// tests own unknown start, successful completion and admission refusal.
for (const termination of ["abort", "timeout", "abort-before-start"]) {
  const providerStarted = termination !== "abort-before-start";
  test(`managed ${termination} retains providerStarted=${providerStarted} and the original stop receipt across reload and query`, async (t) => {
    const output = JSON.stringify({ result: "partial", usage: { input_tokens: 7, output_tokens: 0 } });
    const scenario = await createExecutionQueryScenario(t, {
      providerProgram: `process.stdout.write(${JSON.stringify(output)}); setInterval(() => {}, 1000);`,
    });
    const controller = new AbortController();
    const reason = new Error("requested provider interruption");
    const diagnostic = new AgentTimeoutDiagnostic({ reason: "maximum_lifetime", timeoutMs: 10000 });
    let expire;
    let observedOutput = "";
    const receipts = [];
    // The production activity monitor is a clock boundary: expire only after
    // real provider output, without waiting for a wall-clock execution timeout.
    const activityMonitor = termination === "timeout" ? {
      start(callback) { expire = callback; },
      observeOutput() { expire(diagnostic); },
      stop() {},
    } : undefined;
    let failure;
    await assert.rejects(scenario.run({ cacheMode: "bypass", timeoutMs: 10000,
      retryCount: termination === "timeout" ? 0 : 2,
      abortSignal: controller.signal, activityMonitor,
      onSupervisorEvent(event) {
        // hello precedes the start request; the manager checks the abort flag
        // before sending that request. Readback below still verifies the fact.
        if (termination === "abort-before-start" && event.type === "launcher-hello") controller.abort(reason);
      },
      onStdout(bytes) {
        observedOutput += bytes;
        if (termination === "abort") controller.abort(reason);
      },
      onProcessExecutionStop(receipt) { receipts.push(receipt); },
    }), (error) => {
      failure = error;
      if (termination !== "timeout") assert.equal(error, reason);
      else {
        assert.ok(error instanceof AgentTimeoutFailure);
        assert.equal(error.code, "AGENT_TIMEOUT");
        assert.equal(error.retryable, true);
      }
      assert.equal(error.stopEvidence.status, "confirmed");
      return true;
    });
    assert.equal(observedOutput, providerStarted ? output : "");
    assert.equal(receipts.length, 1);
    const transportFailure = failure;
    assert.equal(transportFailure.processExecutionStopReceipt, receipts[0]);
    assert.equal(transportFailure.stdout, observedOutput);
    if (termination === "timeout") {
      assert.equal(transportFailure.timeoutReason, diagnostic.reason);
      assert.equal(transportFailure.timeoutMs, diagnostic.timeoutMs);
    }
    await scenario.shutdown();

    const restarted = scenario.reload();
    const facts = (await restarted.readExecutionObservations({ specId: scenario.specId })).facts;
    const providers = facts.filter((entry) => entry.kind === "provider-settled");
    assert.equal(providers.length, 1);
    assert.equal(providers[0].data.status, "failed");
    if (providerStarted) assert.equal(providers[0].data.usage.input_tokens, 7);
    else assert.equal(providers[0].data.usage, null);
    assert.equal(providers[0].data.startedAt, transportFailure.timing.startedAt);
    assert.equal(facts.filter((entry) => entry.kind === "agent-failed").length, 1);
    assert.equal(facts.some((entry) => entry.kind === "agent-response-ready"), false);
    const history = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: scenario.root, executionRoot: scenario.root,
      runId: scenario.runId, specId: scenario.specId });
    const calls = history.executions.flatMap((execution) => execution.calls);
    assert.equal(calls.length, 1, "failure observation cannot execute another provider");
    assert.equal(calls[0].status, "stopped");
    assert.equal(calls[0].outcome.providerStarted, providerStarted);
    assert.deepEqual(calls[0].receipt, JSON.parse(JSON.stringify(receipts[0])));

    const request = new QueryRequest({ resource: "executions", condition: { specId: scenario.specId }, page: { limit: 100, after: null } });
    const captured = await new CanonicalFlowVersionReader({ repositoryRoot: scenario.root }).read(request.specId, request.flowVersion, request);
    if (captured.version.projectionError) throw captured.version.projectionError;
    const response = captured.version.response;
    assert.deepEqual(validateFlowQueryResponse(response), []);
    const provider = response.items.find((entry) => entry.kind === "provider-attempt");
    const physical = response.items.find((entry) => entry.kind === "process-call");
    assert.equal(provider.providerStarted, providerStarted);
    assert.equal(provider.status, "failed");
    assert.equal(physical.physicalStatus, "stopped");
    assert.equal(physical.stopVerification, "verified");
    assert.equal(physical.timing.startedAt, transportFailure.timing.startedAt);
    assert.deepEqual(response.summary.providerStarts, { confirmed: providerStarted ? 1 : 0, notStarted: providerStarted ? 0 : 1, unknown: 0 });
    assert.equal(providers[0].data.providerStarted, providerStarted);
    assert.equal(transportFailure.providerStarted, providerStarted);
    assert.equal(response.summary.providerAttemptCount, 1);
    assert.equal(response.summary.managedCallCount, 1);
  });
}
