import assert from "node:assert/strict";
import { after, describe, mock, test } from "node:test";
import { AcceptancePhaseScenario, acceptanceProviderResponse } from "../../support/acceptance-phase-scenario.js";
import { CanonicalFlowVersionReader, QueryRequest, serializeQueryResponse } from "../../../src/flow/query.js";
import { validateFlowQueryResponse } from "../../../src/flow/query-contract.js";
import { UnknownProviderFailure } from "../../../src/lib/agent-failure.js";

function assertRpcObservations(calls) {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.claim.executionLifecycle.phase, "claimed");
    assert.equal(call.claim.binding.stepId, "acceptance-review");
    assert.equal(call.claim.executionLifecycle.binding.executionGeneration, 0);
    if (call.error === null) assert.equal(typeof call.response, "string");
    else assert.equal(call.response, null);
  }
}

describe("Acceptance external fixture observes RPCs independently from semantic generations", { concurrency: false }, () => {
  let seed;
  const cleanups = [];
  async function copiedSeed() {
    seed ??= await AcceptancePhaseScenario.seed({ mock, after(cleanup) { cleanups.push(cleanup); } }, {
      frontier: "acceptance-review",
      requirements: ["R1", "R2"].map((id) => ({ id, desc: `Preserve independently verified behavior ${id}.`,
        task_ids: ["T1"], preimplementation_test_expectation: "fail" })),
    });
    return seed;
  }
  after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });

  test("scoped callbacks share their actual claim ordinal while every RPC and a later thrown generation remain visible", async (t) => {
    const callbacks = [];
    const lost = new UnknownProviderFailure({ message: "The next semantic generation lost its final response." });
    // Query authenticates the runtime directory/inode; consume the actual producer root.
    // Copied canonical seeds remain suitable only for scenarios without runtime readback.
    let flow;
    flow = AcceptancePhaseScenario.create(t, {
      requirements: ["R1", "R2"].map((id) => ({ id, desc: `Preserve independently verified behavior ${id}.`,
        task_ids: ["T1"], preimplementation_test_expectation: "fail" })),
      providerOptions: { promptCharacterLimit: () => flow?.current() === "acceptance-review" ? 16_000 : null },
      acceptanceResponse: (ordinal, active, _prompt, invocation) => {
        callbacks.push({ ordinal, requirementIds: active.acceptanceContexts.at(-1).requirementIds,
          schema: invocation.jsonSchema, claim: active.acceptanceProviderCalls.at(-1).claim });
        if (ordinal === 2) throw lost;
        return acceptanceProviderResponse(active, { status: "notMet" });
      },
    });
    await flow.advanceTo("acceptance-review");
    const reviewed = await flow.runRegistered("acceptance-review");
    assert.equal(reviewed.verdict, "repair_required", JSON.stringify(reviewed));
    assert.equal(flow.acceptanceCalls.length, 1, "default observer represents one claimed semantic Review generation");
    assert.equal(callbacks.length, 2, "the two actual requirement scopes remain separate callbacks");
    assert.deepEqual(callbacks.map((entry) => entry.ordinal), [1, 1]);
    assert.deepEqual(callbacks.flatMap((entry) => entry.requirementIds).sort(), ["R1", "R2"]);
    const firstRpcs = [...flow.acceptanceProviderCalls];
    assertRpcObservations(firstRpcs);
    assert.ok(firstRpcs.length > callbacks.length, "map RPCs cannot disappear into the semantic-generation count");
    assert.ok(firstRpcs.some((call) => call.options.jsonSchema?.properties?.observations));
    assert.equal(new Set(firstRpcs.map((call) => call.claim.id)).size, 1);
    assert.equal(flow.acceptanceCalls[0].responses.length, callbacks.length);
    for (const call of firstRpcs.filter((entry) => entry.semanticOrdinal === 1)) {
      const response = JSON.parse(call.response);
      assert.equal(response.requirementJudgments.length, 1);
      assert.deepEqual(response.deferredFindingDispositions, []);
    }
    await flow.advanceTo("acceptance-review");
    const interrupted = await flow.runRegistered("acceptance-review");
    assert.equal(interrupted.ok, false);
    assert.equal(flow.acceptanceCalls.length, 2);
    assert.equal(callbacks.at(-1).ordinal, 2);
    assert.notEqual(flow.acceptanceCalls[1].claim.id, flow.acceptanceCalls[0].claim.id);
    assert.notEqual(flow.acceptanceCalls[1].claim.binding.attemptId, flow.acceptanceCalls[0].claim.binding.attemptId);
    assertRpcObservations(flow.acceptanceProviderCalls);
    assert.equal(flow.acceptanceProviderCalls.at(-1).error, lost);
    assert.equal(flow.acceptanceProviderCalls.at(-1).semanticOrdinal, 2);
    const calls = flow.acceptanceProviderCalls.length;
    await flow.dispatch(1);
    assert.equal(flow.acceptanceProviderCalls.length, calls, "recovery cannot silently start another RPC");
    flow.reload();
    const request = new QueryRequest({ resource: "executions", condition: { specId: flow.specId },
      target: { nodeId: "acceptance-review", includeDescendants: false, attemptId: null }, page: { limit: 100, after: null } });
    const captured = await new CanonicalFlowVersionReader({ repositoryRoot: flow.root }).read(request.specId, request.flowVersion, request);
    if (captured.version.projectionError) throw captured.version.projectionError;
    const executions = JSON.parse(serializeQueryResponse(captured.version.response));
    assert.deepEqual(validateFlowQueryResponse(executions), []);
    const attempts = flow.acceptanceCalls.map((call) => call.claim.binding.attemptId);
    assert.deepEqual(new Set(executions.items.filter((item) => item.kind === "step-attempt").map((item) => item.attemptId)), new Set(attempts));
    const agents = executions.items.filter((item) => item.kind === "agent-invocation");
    const logicalOwners = new Map();
    for (const rpc of flow.acceptanceProviderCalls) {
      const logicalInvocationId = rpc.options.logicalInvocationId;
      assert.equal(typeof logicalInvocationId, "string");
      logicalOwners.set(logicalInvocationId, rpc.claim.binding.attemptId);
      const item = agents.find((entry) => entry.logicalInvocationId === logicalInvocationId);
      assert.ok(item, "the actual persisted RPC logical invocation must remain queryable after reload");
      assert.equal(item.binding.stepAttemptId, rpc.claim.binding.attemptId);
    }
    assert.equal(logicalOwners.size, agents.length);
    assert.equal(new Set(agents.map((item) => item.binding.stepAttemptId)).size, 2);
    assert.ok(agents.some((item) => item.response.acceptedAt !== null));
    assert.ok(agents.filter((item) => item.response.acceptedAt !== null).every((item) => item.binding.stepAttemptId === attempts[0]));
  });

  test("explicit provider overrides retain exact per-RPC counts including their thrown response", async (t) => {
    let calls = 0;
    const lost = new UnknownProviderFailure({ message: "The second explicit map response was lost." });
    let flow;
    flow = AcceptancePhaseScenario.fromSeed(t, await copiedSeed(), {
      providerOptions: { promptCharacterLimit: () => flow?.current() === "acceptance-review" ? 16_000 : null },
      acceptanceProvider: (_prompt, invocation) => {
        calls += 1;
        if (calls === 2) throw lost;
        const sourceRefs = invocation.jsonSchema.properties.observations.items.properties.sourceRef.enum;
        return JSON.stringify({ observations: sourceRefs.map((sourceRef) => ({ sourceRef, facts: ["Retained exact source range."] })) });
      },
    });
    const outcome = await flow.runRegistered("acceptance-review");
    assert.equal(outcome.ok, false);
    assert.equal(calls, 2);
    assert.equal(flow.acceptanceCalls.length, calls);
    assert.equal(flow.acceptanceProviderCalls.length, calls);
    assertRpcObservations(flow.acceptanceProviderCalls);
    assert.equal(flow.acceptanceProviderCalls[1].error, lost);
    assert.equal(flow.acceptanceProviderCalls[0].response, flow.acceptanceCalls[0].response);
  });
});
