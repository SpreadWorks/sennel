import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { PromptBatchExecutor, PromptBatchPlan, PromptExecutionBudget, PromptExecutionLimit } from "../../../src/lib/prompt-batching.js";
import { PromptExecutionJournal, PromptExecutionJournalWriter, PromptExecutionJournalSnapshot, PromptExecutionScope,
  PromptExecutionReservationContinuation } from "../../../src/lib/prompt-execution-journal.js";
import { ProcessExecutionRuntime, ProcessExecutionBinding } from "../../../src/lib/process-execution-runtime.js";
import { AgentProcessStopEvidence } from "../../../src/lib/agent-failure.js";
import { Agent } from "../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

class SnapshotWriter extends PromptExecutionJournalWriter {
  constructor(binding, snapshot = null) { super(); this.processExecutionBinding = binding; this.snapshot = snapshot; this.events = []; }
  async save(record) { this.snapshot = record.snapshot.toJSON(); this.events.push(record.event); }
  journal(scope) { return new PromptExecutionJournal({ scope, writer: this,
    snapshot: this.snapshot === null ? null : PromptExecutionJournalSnapshot.fromJSON(this.snapshot) }); }
}

async function interruptedReservation(t, boundary) {
  const root = createTmpDir("unused-prompt-reservation-");
  t.after(() => removeTmpDir(root));
  const binding = new ProcessExecutionBinding({ runId: "reservation-run", specId: "reservation-spec", nodeId: "spec-triage",
    taskId: null, attemptId: "reservation-attempt", attemptSequence: 1, executionContractId: "reservation-contract", executionGeneration: 1 });
  const config = { agent: { default: "test/exec", providers: { "test/exec": { command: process.execPath,
    args: ["-e", "process.stdout.write('one reserved result')", "{{PROMPT}}"] } }, timeout: 30, retryCount: 0 } };
  const agent = new Agent({ config, paths: { root, agentWorkDir: path.join(root, ".tmp") }, registry: new ProviderRegistry(config.agent.providers),
    logger: new Logger({ logDir: root, enabled: false }) });
  const resolved = agent.resolve("flow.worker");
  const limit = new PromptExecutionLimit({ maxProviderCallCount: 1 });
  const plan = PromptBatchPlan.fromRequest({ request: "the same selected worker input", limit: limit.requestLimit() });
  const scope = new PromptExecutionScope({ stage: "artifact-worker" });
  const writer = new SnapshotWriter(binding);
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, binding });
  try {
    await assert.rejects(runtime.enter(() => new PromptBatchExecutor({ executionLimit: limit }).executeCompletions({
      plan, executionJournal: writer.journal(scope), responseContract: { parse: (raw) => raw },
      async callAgent(_request, _batch, _retry, _context, admission) {
        admission.claim();
        const context = { attempt: 1, maxAttempts: 1, providerKey: resolved.providerKey, profileKey: resolved.profileKey,
          attemptId: crypto.randomUUID(), logicalInvocationId: crypto.randomUUID() };
        await admission.beforeProviderAttempt(context);
        const invocation = { kind: "provider", providerAttemptId: context.attemptId, logicalInvocationId: context.logicalInvocationId,
          providerAttemptContext: context, promptProcessIdentity: admission.processExecutionIdentity.toJSON() };
        if (boundary === "before-permit") {
          const call = await runtime.reserveCall({ binding, invocation });
          await runtime.finishCall(call, { notStarted: true, stopEvidence: AgentProcessStopEvidence.confirmed() });
        } else if (boundary === "after-permit") {
          await executeManagedProcess(process.execPath, ["-e", "process.stdout.write('already started')"], {
            ...invocation, processExecutionBinding: binding, timeoutMs: 10000, maxBuffer: 1024,
          });
        }
        throw new Error("interrupted after durable reservation");
      },
    })), /interrupted after durable reservation/);
  } finally { await runtime.close(); }
  const saved = PromptExecutionJournalSnapshot.fromJSON(writer.snapshot);
  assert.equal(saved.budget.providerCallCount, 1);
  assert.ok(saved.batches[0].claim);
  let continuation;
  await ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: root, binding }, (evidence) => {
    const identity = saved.batches[0].claim.processIdentity;
    const proof = evidence.forInvocation({ providerAttemptId: identity.providerAttemptId, logicalInvocationId: identity.logicalInvocationId });
    const create = () => new PromptExecutionReservationContinuation({ authorizationId: "a".repeat(64), executionContractId: "reservation-contract",
      previousClaim: saved.batches[0].claim, physicalEvidence: proof.toJSON(), calls: proof.calls.map((call) => ({
        executionId: call.executionId, callId: call.callId, ownerEpoch: call.ownerEpoch, binding: call.binding.toJSON(),
        invocation: call.invocation, startPermitted: call.startPermitted, receipt: call.receipt.toJSON(),
      })) });
    if (boundary === "after-permit") assert.throws(create, /unstarted provider invocation/);
    else continuation = create();
  });
  return { root, binding, agent, limit, plan, scope, writer, saved, continuation };
}

async function consumeReservation(value, writer, continuation, callAgent = null) {
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: value.root, binding: value.binding });
  try {
    return await runtime.enter(() => new PromptBatchExecutor({ executionBudget: PromptExecutionBudget.fromSnapshot(value.limit, writer.snapshot.budget) })
      .executeCompletions({ plan: value.plan, executionJournal: writer.journal(value.scope), reservationContinuation: continuation,
        responseContract: { parse: (raw) => raw, itemCount: () => 1 },
        callAgent: callAgent ?? ((request, _batch, _retry, _context, providerCallAdmission) => value.agent.call(request.userPrompt, {
          commandId: "flow.worker", processExecutionBinding: value.binding, providerCallAdmission, cacheMode: "bypass",
        })),
      }));
  } finally { await runtime.close(); }
}

for (const boundary of ["before-reservation", "before-permit"]) {
  test(`a saved ${boundary} proof reuses its single provider reservation without resetting the exhausted budget`, async (t) => {
    const value = await interruptedReservation(t, boundary);
    await assert.rejects(new PromptBatchExecutor({ executionBudget: PromptExecutionBudget.fromSnapshot(value.limit, value.saved.budget) })
      .executeCompletions({ plan: value.plan, executionJournal: value.writer.journal(value.scope), responseContract: { parse: (raw) => raw },
        callAgent: () => assert.fail("uncertain claim started without its saved continuation") }), { code: "PROMPT_EXECUTION_UNCERTAIN" });
    const next = JSON.parse(JSON.stringify(value.saved.toJSON()));
    next.batches[0].reservationContinuation = value.continuation.toJSON();
    await value.writer.journal(value.scope).save("reservation-reconciled", PromptExecutionJournalSnapshot.fromJSON(next));
    const restarted = new SnapshotWriter(value.binding, JSON.parse(JSON.stringify(value.writer.snapshot)));
    const continuation = PromptExecutionReservationContinuation.fromJSON(restarted.snapshot.batches[0].reservationContinuation);
    const completions = await consumeReservation(value, restarted, continuation);
    assert.equal(completions[0].response, "one reserved result");
    assert.equal(restarted.snapshot.budget.providerCallCount, 1);
    assert.equal(restarted.snapshot.batches[0].transportOrdinal, 1);
    assert.equal(restarted.snapshot.batches[0].batchCalls, 1);
    assert.equal(restarted.events[0], "reservation-consumed");
    const consumed = PromptExecutionReservationContinuation.fromJSON(restarted.snapshot.batches[0].reservationContinuation);
    assert.equal(consumed.pending, false);
    assert.deepEqual(consumed.previousClaim, value.saved.batches[0].claim);
    assert.notEqual(consumed.consumedClaim.processIdentity.providerAttemptId, consumed.previousClaim.processIdentity.providerAttemptId);
    assert.throws(() => consumed.consume(consumed.consumedClaim), { code: "PROMPT_EXECUTION_UNCERTAIN" });
  });
}

test("a real start permit refuses reservation reuse even when its managed process has stopped", async (t) => {
  await interruptedReservation(t, "after-permit");
});

test("interruption after consuming the reservation retains a fresh non-execution lineage and the same exhausted budget", async (t) => {
  const value = await interruptedReservation(t, "before-reservation");
  const next = JSON.parse(JSON.stringify(value.saved.toJSON()));
  next.batches[0].reservationContinuation = value.continuation.toJSON();
  await value.writer.journal(value.scope).save("reservation-reconciled", PromptExecutionJournalSnapshot.fromJSON(next));
  let writer = new SnapshotWriter(value.binding, JSON.parse(JSON.stringify(value.writer.snapshot)));
  let continuation = value.continuation;
  for (let interruption = 0; interruption < 2; interruption++) {
    const resolved = value.agent.resolve("flow.worker");
    await assert.rejects(consumeReservation(value, writer, continuation, async (_request, _batch, _retry, _context, admission) => {
      admission.claim();
      await admission.beforeProviderAttempt({ attempt: 1, maxAttempts: 1, providerKey: resolved.providerKey, profileKey: resolved.profileKey,
        attemptId: crypto.randomUUID(), logicalInvocationId: crypto.randomUUID() });
      throw new Error("interrupted after reservation consumption");
    }), /interrupted after reservation consumption/);
    const saved = PromptExecutionJournalSnapshot.fromJSON(JSON.parse(JSON.stringify(writer.snapshot)));
    const consumed = PromptExecutionReservationContinuation.fromJSON(saved.batches[0].reservationContinuation);
    assert.equal(consumed.pending, false);
    assert.equal(saved.budget.providerCallCount, 1);
    await ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: value.root, binding: value.binding }, (evidence) => {
      const identity = saved.batches[0].claim.processIdentity;
      const proof = evidence.forInvocation({ providerAttemptId: identity.providerAttemptId, logicalInvocationId: identity.logicalInvocationId });
      assert.equal(proof.calls.length, 0);
      assert.ok(proof.nonExecution);
      continuation = consumed.reconcile({ physicalEvidence: proof.toJSON(), calls: [] });
    });
    assert.equal(continuation.authorizationId, value.continuation.authorizationId);
    assert.equal(continuation.history.length, interruption + 1);
    const reconciled = JSON.parse(JSON.stringify(saved.toJSON()));
    reconciled.batches[0].reservationContinuation = continuation.toJSON();
    await writer.journal(value.scope).save("reservation-reconciled", PromptExecutionJournalSnapshot.fromJSON(reconciled));
    writer = new SnapshotWriter(value.binding, JSON.parse(JSON.stringify(writer.snapshot)));
  }
  const completions = await consumeReservation(value, writer, continuation);
  assert.equal(completions[0].response, "one reserved result");
  assert.equal(writer.snapshot.budget.providerCallCount, 1);
  assert.equal(writer.snapshot.batches[0].transportOrdinal, 1);
  assert.equal(writer.snapshot.batches[0].reservationContinuation.history.length, 2);
  assert.deepEqual(writer.snapshot.batches[0].reservationContinuation.history[0].previousClaim, value.saved.batches[0].claim);
});
