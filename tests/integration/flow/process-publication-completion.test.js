import assert from "node:assert/strict";
import { test } from "node:test";
import { FreshFlowFixture, makeFlowManager, setupFlowConfig } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { withFlowProcessRuntime } from "../../../src/flow/lib/process-runtime-admission.js";
import { FlowProcessEventWriter } from "../../../src/flow/lib/flow-process-event.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutionControlFailure, ProcessExecutionStopReceipt, ProcessExecutionFailureDiagnostic,
  ProcessExecutionCommunicationDiagnostic } from "../../../src/lib/process-execution-values.js";
import { NativeExecutableInvocation } from "../../../src/lib/command-invocation.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { runCmd, runManagedCmdAsync } from "../../../src/lib/process.js";
import { completeManagedOperation } from "../../../src/lib/process-execution-completion.js";

function containsCause(failure, expected) {
  return failure === expected
    || (failure instanceof AggregateError && failure.errors.some((cause) => containsCause(cause, expected)))
    || (failure?.cause !== undefined && containsCause(failure.cause, expected));
}

class PublicationCompletionScenario {
  constructor(t) {
    this.root = createTmpDir("process-publication-completion-");
    t.after(() => removeQuiescentRuntimeFixture({ mainRoot: this.root }));
    setupFlowConfig(this.root);
    this.manager = makeFlowManager(this.root);
    this.specId = "001-publication-completion";
    this.runId = "publication-completion-run";
    new FreshFlowFixture({ flowManager: this.manager, specId: this.specId, runId: this.runId,
      execution: { mode: "direct" } }).create().registerActive();
    this.manager.beginNextAction(this.specId);
    this.context = { root: this.root, mainRoot: this.root, executionRoot: this.root,
      specId: this.specId, flowManager: this.manager, flowState: this.manager.loadReadOnly(this.specId) };
    this.output = "completed-publication-body";
  }

  invocation() {
    return new NativeExecutableInvocation({ executable: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(this.output)})`], cwd: this.root });
  }

  async verify(invoke, makeFailure, expectedCode, { repeatFailure = false, encoding = "utf8", outputLimit = false } = {}) {
    const before = this.manager.canonicalState(this.specId);
    let executionId;
    await withFlowProcessRuntime(this.context, async () => {
      const parent = ProcessExecutionRuntime.current();
      const writer = new FlowProcessEventWriter(this.manager);
      let interrupted = false;
      let startedPublications = 0;
      let firstPublicationFailure;
      const binding = { ...parent.binding.toJSON(), commandId: "publication-completion" };
      await parent.withBinding(binding, async () => {
        const runtime = ProcessExecutionRuntime.current();
        executionId = runtime.executionId;
        let replayVerified = false;
        await completeManagedOperation(async () => {
          const error = await Promise.resolve().then(() => invoke(this))
            .then(() => assert.fail("publication failure must reject the command"), (failure) => failure);
          const saved = runtime.inspect().executions.find((entry) => entry.executionId === executionId);
          const calls = saved.calls.filter((call) => call.binding.commandId === binding.commandId);
          assert.equal(calls.length, 1);
          const call = calls[0];
          // Physical completion is independent of the failed canonical ACK.
          // Check the durable fact first, before error-envelope assertions.
          assert.ok(call.receipt, "canonical publication failure must retain the actual child receipt");
          assert.equal(call.status, "stopped");
          assert.equal(call.observation.kind, "exited");
          if (!outputLimit) assert.equal(call.observation.code, 0);
          assert.equal(call.receipt.executionId, executionId);
          assert.equal(call.receipt.callId, call.callId);
          const expectedOutput = outputLimit ? "" : this.output;
          assert.equal(call.receipt.output.stdoutBytes, Buffer.byteLength(expectedOutput));
          assert.equal(interrupted, true);
          assert.equal(startedPublications, 1, "the command boundary must not retry failed canonical publication");
          assert.ok(error instanceof ProcessExecutionControlFailure);
          assert.equal(containsCause(error, firstPublicationFailure), true, "the original writer failure must remain reachable");
          assert.equal(error.code, expectedCode);
          assert.equal(error.executionId, executionId);
          assert.equal(error.callId, call.callId);
          assert.equal(error.diagnostic.phase, "stopped");
          assert.deepEqual(error.stdout, encoding === "buffer" ? Buffer.from(expectedOutput) : expectedOutput);
          assert.deepEqual(error.stderr, encoding === "buffer" ? Buffer.alloc(0) : "");
          assert.equal(error.providerStarted, true);
          assert.equal(error.signal, call.observation.signal);
          assert.equal(error.stopEvidence.confirmed, true);
          assert.ok(error.processExecutionStopReceipt instanceof ProcessExecutionStopReceipt);
          assert.deepEqual(error.processExecutionStopReceipt.toJSON(), call.receipt);
          if (outputLimit) {
            assert.equal(call.controlFailure.code, "PROCESS_EXECUTION_OUTPUT_LIMIT");
            assert.deepEqual(error.primaryCause.toJSON(), call.controlFailure.primaryCause);
            assert.deepEqual(error.diagnostic.toJSON(), call.controlFailure.diagnostic);
            assert.deepEqual(error.timing, call.outcome.timing);
            assert.equal(error.processExecutionStopReceipt.output.completion, "truncated");
          }
          const events = saved.events.filter((event) => event.callId === call.callId);
          assert.deepEqual(events.filter((event) => event.type !== "stop-requested").map((event) => event.type),
            ["reserved", "started", "exited", "result-finalized"]);
          assert.equal(events.some((event) => event.type === "stop-requested"), outputLimit);
          assert.deepEqual(saved.eventAcknowledgements.map((ack) => ack.eventId), [events[0].eventId]);

          const restart = makeFlowManager(this.root);
          const publications = restart.activityLedger(this.specId).filter((activity) => activity.processEvent?.executionId === executionId);
          assert.deepEqual(publications.map((activity) => activity.processEvent.type), ["reserved", "started"]);
          const replayWriter = new FlowProcessEventWriter(restart);
          assert.deepEqual(await runtime.drainEvents((event) => replayWriter.write(event)), events.slice(1).map((event) => event.eventId));
          assert.deepEqual(await runtime.drainEvents((event) => replayWriter.write(event)), []);
          const replayed = makeFlowManager(this.root).activityLedger(this.specId)
            .filter((activity) => activity.processEvent?.executionId === executionId);
          assert.deepEqual(replayed.map((activity) => activity.processEvent), saved.events);
          assert.equal(new Set(replayed.map((activity) => activity.id)).size, events.length);
          const acknowledged = runtime.inspect().executions.find((entry) => entry.executionId === executionId);
          assert.deepEqual(acknowledged.eventAcknowledgements.map((ack) => ack.eventId), events.map((event) => event.eventId));
          replayVerified = true;
          const after = restart.canonicalState(this.specId);
          assert.equal(after.attempt.id, before.attempt.id);
          assert.equal(after.attempt.sequence, before.attempt.sequence);
          assert.equal(after.attempt.nodeId, before.attempt.nodeId);
        }, async () => {
          if (replayVerified) return;
          // A failing before-fix assertion must still close this owned fixture
          // through real canonical publication, without erasing that failure.
          const cleanupWriter = new FlowProcessEventWriter(makeFlowManager(this.root));
          await runtime.drainEvents((event) => cleanupWriter.write(event));
        });
      }, { eventWriter: (event) => {
        const acknowledgement = writer.write(event);
        if (event.type === "started") {
          startedPublications++;
          if (!interrupted || repeatFailure) {
            interrupted = true;
            const failure = makeFailure(event);
            firstPublicationFailure ??= failure;
            throw failure;
          }
        }
        return acknowledgement;
      } });
    }, { commandId: "publication-completion-boundary" });
    const closed = ProcessExecutionRuntime.inspect({ mainRoot: this.root });
    assert.equal(closed.slot, null);
    assert.equal(closed.executions.find((entry) => entry.executionId === executionId).status, "closed");
  }
}

test("a typed canonical publication failure retains child completion and replays only missing acknowledgements", { timeout: 120000 }, async (t) => {
  await new PublicationCompletionScenario(t).verify(
    (scenario) => executeManagedProcess(scenario.invocation(), [], { timeoutMs: 20000 }),
    (event) => new ProcessExecutionControlFailure("observation-save-failed", "Canonical publication acknowledgement interrupted.",
      { executionId: event.executionId, callId: event.callId }),
    "PROCESS_EXECUTION_OBSERVATION_SAVE_FAILED");
});

for (const repeatFailure of [false, true]) {
  test(`synchronous canonical publication failure stays exceptional without a second drain (${repeatFailure ? "repeated" : "once"})`, { timeout: 120000 }, async (t) => {
    const encoding = repeatFailure ? "utf8" : "buffer";
    await new PublicationCompletionScenario(t).verify(
      (scenario) => runCmd(scenario.invocation(), { timeout: 20000, encoding }),
      () => Object.assign(new Error("Synchronous canonical acknowledgement interrupted."), { code: "PUBLICATION_INTERRUPTED" }),
      "PROCESS_EXECUTION_ACTIVITY_PENDING", { repeatFailure, encoding });
  });
}

test("synchronous typed publication refusal retains its reason and the actual completion receipt", { timeout: 120000 }, async (t) => {
  await new PublicationCompletionScenario(t).verify(
    (scenario) => runCmd(scenario.invocation(), { timeout: 20000 }),
    (event) => new ProcessExecutionControlFailure("observation-save-failed", "Synchronous canonical acknowledgement interrupted.",
      { executionId: event.executionId, callId: event.callId }),
    "PROCESS_EXECUTION_OBSERVATION_SAVE_FAILED");
});

test("synchronous typed output failure and publication failure preserve the first diagnostic and real receipt", { timeout: 120000 }, async (t) => {
  await new PublicationCompletionScenario(t).verify(
    (scenario) => runCmd(scenario.invocation(), { timeout: 20000, maxBuffer: 0 }),
    () => new Error("Canonical acknowledgement failed after the output limit."),
    "PROCESS_EXECUTION_ACTIVITY_PENDING", { outputLimit: true });
});

test("a plain canonical publication failure stays exceptional through the result-style command adapter", { timeout: 120000 }, async (t) => {
  await new PublicationCompletionScenario(t).verify(
    (scenario) => runManagedCmdAsync(scenario.invocation(), { timeout: 20000 }),
    () => Object.assign(new Error("Canonical publication acknowledgement interrupted."), { code: "PUBLICATION_INTERRUPTED" }),
    "PROCESS_EXECUTION_ACTIVITY_PENDING");
});


test("a typed producer abort retains its diagnostic and communication when canonical publication also fails", { timeout: 120000 }, async (t) => {
  const scenario = new PublicationCompletionScenario(t);
  const before = scenario.manager.canonicalState(scenario.specId);
  let executionId;
  await withFlowProcessRuntime(scenario.context, async () => {
    const parent = ProcessExecutionRuntime.current();
    const writer = new FlowProcessEventWriter(scenario.manager);
    const publicationFailure = new Error("Canonical started save completed before its acknowledgement failed.");
    let interrupted = false;
    await parent.withBinding({ ...parent.binding.toJSON(), commandId: "producer-abort-publication" }, async () => {
      const runtime = ProcessExecutionRuntime.current();
      executionId = runtime.executionId;
      const controller = new AbortController();
      let producerFailure = null;
      const error = await executeManagedProcess(scenario.invocation(), [], { timeoutMs: 20000,
        abortSignal: controller.signal,
        onStdout: () => {
          if (producerFailure !== null) return;
          const execution = runtime.inspect().executions.find((entry) => entry.executionId === executionId);
          assert.equal(execution.calls.length, 1);
          const call = execution.calls[0];
          const primaryCause = { code: "PROCESS_EXECUTION_PRODUCER_REFUSED", message: "Output consumer refused its input." };
          // This is supplied producer failure metadata at the public abort
          // boundary, not a simulated runtime transport or termination fact.
          const communication = new ProcessExecutionCommunicationDiagnostic({ operation: "consume-output",
            budgetMs: 0, elapsedMs: 0, cutoff: "refused", acceptance: "rejected", attempts: [] });
          producerFailure = new ProcessExecutionControlFailure("producer-refused", primaryCause.message, {
            executionId, callId: call.callId, communication,
            diagnostic: new ProcessExecutionFailureDiagnostic({ executionId, callId: call.callId,
              operation: "consume-output", role: "executor", phase: call.observation?.kind ?? "running",
              executor: { executorId: call.executor.executorId, executorSession: call.executor.executorSession }, primaryCause }),
          });
          controller.abort(producerFailure);
        },
      }).then(() => assert.fail("producer and publication failures must reject the command"), (failure) => failure);
      const saved = runtime.inspect().executions.find((entry) => entry.executionId === executionId);
      assert.equal(saved.calls.length, 1);
      const call = saved.calls[0];
      assert.ok(producerFailure instanceof ProcessExecutionControlFailure);
      assert.equal(controller.signal.reason, producerFailure);
      assert.ok(call.receipt, "the aborted real child must have its exact durable completion receipt");
      assert.equal(call.status, "stopped");
      assert.equal(call.observation.kind, "exited");
      assert.equal(call.outcome.aborted, true);
      assert.equal(call.receipt.output.stdoutBytes, Buffer.byteLength(scenario.output));
      assert.deepEqual(producerFailure.processExecutionStopReceipt.toJSON(), call.receipt);
      assert.equal(interrupted, true);
      assert.ok(error instanceof ProcessExecutionControlFailure);
      assert.equal(error.code, "PROCESS_EXECUTION_ACTIVITY_PENDING");
      assert.equal(error.executionId, executionId);
      assert.equal(error.callId, call.callId);
      assert.equal(error.stdout, scenario.output);
      assert.ok(error.processExecutionStopReceipt instanceof ProcessExecutionStopReceipt);
      assert.deepEqual(error.processExecutionStopReceipt.toJSON(), call.receipt);
      assert.deepEqual(error.primaryCause.toJSON(), producerFailure.primaryCause.toJSON());
      assert.deepEqual(error.diagnostic.toJSON(), producerFailure.diagnostic.toJSON());
      assert.ok(error.communication instanceof ProcessExecutionCommunicationDiagnostic);
      assert.deepEqual(error.communication.toJSON(), producerFailure.communication.toJSON());
      const events = saved.events.filter((event) => event.callId === call.callId);
      assert.equal(events[0].type, "reserved");
      assert.equal(events[1].type, "started");
      assert.equal(events.at(-1).type, "result-finalized");
      assert.ok(events.some((event) => event.type === "exited"));
      assert.deepEqual(saved.eventAcknowledgements.map((ack) => ack.eventId), [events[0].eventId]);
      const restart = makeFlowManager(scenario.root);
      const prefix = restart.activityLedger(scenario.specId).filter((activity) => activity.processEvent?.executionId === executionId);
      assert.deepEqual(prefix.map((activity) => activity.processEvent), events.slice(0, 2));
      const replayWriter = new FlowProcessEventWriter(restart);
      assert.deepEqual(await runtime.drainEvents((event) => replayWriter.write(event)), events.slice(1).map((event) => event.eventId));
      assert.deepEqual(await runtime.drainEvents((event) => replayWriter.write(event)), []);
      const replayed = makeFlowManager(scenario.root).activityLedger(scenario.specId)
        .filter((activity) => activity.processEvent?.executionId === executionId);
      assert.deepEqual(replayed.map((activity) => activity.processEvent), events);
      assert.equal(new Set(replayed.map((activity) => activity.id)).size, events.length);
      assert.deepEqual(runtime.inspect().executions.find((entry) => entry.executionId === executionId)
        .eventAcknowledgements.map((ack) => ack.eventId), events.map((event) => event.eventId));
      const after = restart.canonicalState(scenario.specId);
      assert.equal(after.attempt.id, before.attempt.id);
      assert.equal(after.attempt.sequence, before.attempt.sequence);
      assert.equal(after.attempt.nodeId, before.attempt.nodeId);
    }, { eventWriter: (event) => {
      const acknowledgement = writer.write(event);
      if (!interrupted && event.type === "started") { interrupted = true; throw publicationFailure; }
      return acknowledgement;
    } });
  }, { commandId: "producer-abort-publication-boundary" });
  const closed = ProcessExecutionRuntime.inspect({ mainRoot: scenario.root });
  assert.equal(closed.slot, null);
  assert.equal(closed.executions.find((entry) => entry.executionId === executionId).status, "closed");
});
