import assert from "node:assert/strict";
import { test } from "node:test";
import { createExecutionQueryScenario } from "../../support/infrastructure/execution-query-scenario.js";
import { PromptBatchExecutor, PromptExecutionBudget, PromptExecutionLimit, PromptProtocolRetryLimit } from "../../../src/lib/prompt-batching.js";
import { executeAgentResponseProtocol } from "../../../src/lib/agent-response-protocol.js";
import { PromptExecutionJournal } from "../../../src/lib/prompt-execution-journal.js";
import { CanonicalPromptExecutionJournalWriter } from "../../../src/flow/lib/canonical-prompt-execution-writer.js";
import { CanonicalFlowVersionReader, QueryRequest, serializeQueryResponse } from "../../../src/flow/query.js";
import { validateFlowQueryResponse } from "../../../src/flow/query-contract.js";

test("a real protocol retry persists separate logical invocations in one Step Attempt and queries their exact provider owners", async (t) => {
  const scenario = await createExecutionQueryScenario(t, { executionLimitOptions: { maxProtocolRetryCount: 1 }, providerSequence: [
    { result: "malformed response", inputTokens: 2 }, { result: JSON.stringify({ accepted: true }), inputTokens: 3 },
  ] });
  const limit = new PromptExecutionLimit(scenario.contract.executionLimit);
  const episode = scenario.manager.readPromptExecutionEpisode({ executionContract: scenario.contract, checkoutIdentity: scenario.runtime.checkoutIdentity });
  let protocolEvidence;
  const completions = await scenario.runtime.enter(() => new PromptBatchExecutor({ executionLimit: limit,
    executionBudget: PromptExecutionBudget.fromSnapshot(limit, episode.budget) }).executeCompletions({
    plan: scenario.plan,
    executionJournal: new PromptExecutionJournal({ scope: scenario.scope,
      writer: new CanonicalPromptExecutionJournalWriter({ flowManager: scenario.manager, executionContract: scenario.contract,
        scope: scenario.scope, checkoutIdentity: scenario.runtime.checkoutIdentity }) }),
    protocolRetryLimit: new PromptProtocolRetryLimit(1),
    protocolPolicy: { async execute({ call, accounting }) {
      const result = await executeAgentResponseProtocol({ groupIdentity: "protocol-test", accounting,
        callAgent: (attempt) => call(scenario.plan.batches[0].request, attempt), parseResponse: JSON.parse });
      protocolEvidence = result.evidence;
      return result.value;
    } },
    callAgent: (request, _batch, _retry, attempt, providerCallAdmission) => scenario.agent.call(request.userPrompt, {
      commandId: "protocol-test", providerCallAdmission, cacheMode: attempt.cacheMode, retryCount: 0,
    }),
    responseContract: { parse: (response) => response },
  }));
  assert.deepEqual(completions[0].response, { accepted: true });
  assert.deepEqual(protocolEvidence.groups[0].attempts.map((attempt) => attempt.retryKind), [null, "format"]);
  // An arbitrary protocol can transform several responses; its output alone
  // cannot authorize adopting every response in its journal.
  assert.deepEqual(completions[0].receivedResponses, []);
  await scenario.shutdown();
  const request = new QueryRequest({ resource: "executions", condition: { specId: scenario.specId },
    target: { nodeId: "draft-refine", includeDescendants: false, attemptId: scenario.binding.attempt.id }, page: { limit: 100, after: null } });
  const captured = await new CanonicalFlowVersionReader({ repositoryRoot: scenario.root }).read(request.specId, request.flowVersion, request);
  if (captured.version.projectionError) throw captured.version.projectionError;
  const response = JSON.parse(serializeQueryResponse(captured.version.response));
  assert.deepEqual(validateFlowQueryResponse(response), []);
  const agents = response.items.filter((item) => item.kind === "agent-invocation");
  const providers = response.items.filter((item) => item.kind === "provider-attempt");
  const physical = response.items.filter((item) => item.kind === "process-call");
  assert.equal(agents.length, 2);
  assert.equal(providers.length, 2);
  assert.equal(physical.length, 2);
  assert.equal(new Set(agents.map((item) => item.logicalInvocationId)).size, 2);
  assert.deepEqual(new Set(agents.map((item) => item.binding.stepAttemptId)), new Set([scenario.binding.attempt.id]));
  assert.ok(agents.every((item) => item.response.receivedAt !== null && item.response.acceptedAt === null));
  for (const provider of providers) {
    assert.equal(provider.attempt, 1);
    const owner = response.relations.find((relation) => relation.kind === "attempt-of" && relation.from.id === provider.id);
    assert.ok(agents.some((agent) => agent.id === owner.to.id));
    assert.equal(response.relations.filter((relation) => relation.kind === "realizes" && relation.to.id === provider.id).length, 1);
  }
  assert.equal(new Set(providers.map((provider) => response.relations.find((relation) => relation.kind === "attempt-of" && relation.from.id === provider.id).to.id)).size, 2);
  assert.equal(response.summary.logicalInvocationCount, 2);
  assert.equal(response.summary.providerAttemptCount, 2);
  assert.equal(response.relations.some((relation) => relation.kind === "accepted-by"), false);
});
