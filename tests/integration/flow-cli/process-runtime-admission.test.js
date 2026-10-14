import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { after, before, test } from "node:test";

import RunClaimNextActionCommand from "../../../src/flow/lib/run-claim-next-action.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import RunGateCommand from "../../../src/flow/lib/run-gate.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { FlowDispatchTarget } from "../../../src/flow/lib/dispatch-invocation.js";
import { flowCommands } from "../../../src/lib/command-registry.js";
import { ProcessIdentity, ProcessIdentitySource } from "../../../src/lib/process-identity.js";
import { readManagedRecord } from "../../../src/lib/managed-process-protocol.js";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { SourceMutationManifest, WorkerArtifactHandoffCoordinator, WorkerArtifactHandoffSubmission } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { Command } from "../../../src/lib/command.js";
import { Envelope } from "../../../src/lib/flow-envelope.js";
import { dispatch } from "../../../src/lib/dispatcher.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { dispatchContainer, fixtureRepository } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { awaitRuntimeBarrier, ProcessRuntimeFlowScenario, recordProcessRuntimeFlowVerification } from "../../support/infrastructure/process-runtime-flow-scenario.js";

let seed;
before(() => {
  recordProcessRuntimeFlowVerification();
  seed = fixtureRepository("sennel-runtime-flow-seed-");
  fs.mkdirSync(path.join(seed, ".sennel"), { recursive: true });
});
after(() => { if (seed) removeTmpDir(seed); });

function assertBusy(value) {
  const code = value.errors?.[0]?.code ?? value.code;
  assert.ok(["PROCESS_EXECUTION_BUSY", "FLOW_DISPATCH_BUSY"].includes(code),
    `checkout admission must own the refusal: ${JSON.stringify(value)}`);
}

function executionSnapshot(scenario) {
  return ProcessExecutionRuntime.inspect({ mainRoot: scenario.root });
}

function assertStoppedReadback(scenario, original) {
  const inventory = executionSnapshot(scenario);
  const stopped = inventory.executions.find((entry) => entry.executionId === original.slot);
  assert.equal(stopped.status, "closed");
  assert.equal(stopped.accepting, false);
  assert.equal(stopped.closure.recovery, true);
  assert.equal(stopped.calls.length, original.executions.find((entry) => entry.executionId === original.slot).calls.length);
  assert.ok(stopped.calls.length > 0);
  for (const call of stopped.calls) {
    assert.equal(call.status, "stopped");
    assert.equal(call.receipt.executionId, stopped.executionId);
    assert.equal(call.receipt.callId, call.callId);
    assert.deepEqual(call.receipt.binding, call.binding);
    assert.equal(call.receipt.stopEvidence.status, "confirmed");
  }
}

async function directResult(command, ctx) {
  try { return await command.execute(ctx); } catch (error) { return error; }
}

for (const phase of ["pre", "post", "onError", "nonblockingPost", "reported-envelope"]) {
  test(`typed process refusal at ${phase} preserves canonical state and bypasses later lifecycle effects`, async (t) => {
    const scenario = new ProcessRuntimeFlowScenario(seed, { test: t });
    const manager = scenario.manager();
    const ctx = scenario.context({ flowManager: manager });
    const before = scenario.snapshot();
    const failure = new ProcessExecutionControlFailure("stop-unconfirmed", "deterministic stop uncertainty");
    const observed = [];
    const observe = (stage) => {
      observed.push(stage);
      if (stage === phase) throw failure;
    };
    t.mock.method(manager, "setStepRuntimeLog", () => { observed.push("metadata"); });
    class RefusingCommand extends Command {
      static outputMode = "envelope";
      execute() {
        observe("execute");
        if (phase === "onError") throw new Error("ordinary execution failure before the control refusal");
        if (phase === "reported-envelope") {
          return Envelope.fail("run", "runtime-control", failure.code, failure.message,
            { processExecutionControlFailure: failure.toJSON() });
        }
        return { completed: true };
      }
    }
    const output = [];
    let exitCode = null;
    await dispatch({ container: dispatchContainer({ root: scenario.root, flowManager: manager, agent: null }),
      entry: { command: async () => ({ default: RefusingCommand }), args: {},
        runtimeLog: { stepId: "draft" },
        pre() { observe("pre"); }, post() { observe("post"); },
        onError() { observe("onError"); }, nonblockingPost() { observe("nonblockingPost"); } },
      argv: [], envelopeType: "run", envelopeKey: "runtime-control", runtimeLog: true,
      stdout: (chunk) => output.push(chunk), stderr: () => {},
      setExitCode: (code) => { exitCode = code; }, buildHookCtx: () => ctx });
    const result = JSON.parse(output.join(""));
    assert.equal(exitCode, 1);
    assert.equal(result.ok, false);
    const restored = ProcessExecutionControlFailure.fromEnvelope(result);
    assert.equal(restored.code, failure.code);
    assert.equal(restored.message, failure.message);
    const expected = phase === "pre" ? ["pre"] : phase === "reported-envelope" ? ["pre", "execute"]
      : phase === "onError" ? ["pre", "execute", "onError"]
        : phase === "post" ? ["pre", "execute", "post"] : ["pre", "execute", "post", "nonblockingPost"];
    assert.deepEqual(observed, expected);
    assert.deepEqual(scenario.snapshot(), before);
    assert.equal(ProcessExecutionRuntime.inspect({ mainRoot: scenario.root }).slot, null);
  });
}

test("registered dispatcher child restores a typed control refusal instead of returning an ordinary failed envelope", async (t) => {
  const scenario = new ProcessRuntimeFlowScenario(seed, { test: t });
  const manager = scenario.manager();
  const ctx = scenario.context({ flowManager: manager });
  const before = scenario.snapshot();
  const failure = new ProcessExecutionControlFailure("stop-unconfirmed", "registered child remains uncertain");
  class RefusingCommand extends Command {
    static outputMode = "envelope";
    execute() { throw failure; }
  }
  t.mock.method(flowCommands.run["claim-next-action"], "command", async () => ({ default: RefusingCommand }));
  const command = new RunDispatchCommand();
  command.container = dispatchContainer({ root: scenario.root, flowManager: manager, agent: null });
  const target = FlowDispatchTarget.captureContext({ ...ctx, flowCommandBoundary: true });
  await assert.rejects(command.runRegisteredFlowCommand(ctx, target, "claim-next-action", []),
    (error) => error instanceof ProcessExecutionControlFailure && error.code === failure.code
      && error.message === failure.message);
  assert.deepEqual(scenario.snapshot(), before);
  assert.equal(ProcessExecutionRuntime.inspect({ mainRoot: scenario.root }).slot, null);
});

for (const outcome of ["success", "failure"]) {
  test(`checkout slot spans actual dispatcher ${outcome} hooks and canonical runtime metadata commit`, async (t) => {
    const scenario = new ProcessRuntimeFlowScenario(seed, { test: t });
    const observed = [];
    let executionId = null;
    const observe = (stage) => {
      const current = ProcessExecutionRuntime.current();
      assert.notEqual(current, null, `${stage} lost its process scope`);
      executionId ??= current.executionId;
      assert.equal(current.executionId, executionId);
      const inventory = executionSnapshot(scenario);
      assert.equal(inventory.slot, executionId, `${stage} released checkout admission too early`);
      assert.equal(inventory.executions.find((entry) => entry.executionId === executionId).status, "active");
      observed.push(stage);
    };
    const flowManager = scenario.manager();
    const saveRuntimeMetadata = flowManager.setStepRuntimeLog;
    // Transparent observation surrounds the real public writer. The writer,
    // AtomicFile commit and fresh readback remain unchanged.
    t.mock.method(flowManager, "setStepRuntimeLog", function (...args) {
      observe("metadata-start");
      const saved = saveRuntimeMetadata.apply(this, args);
      observe("metadata-committed");
      return saved;
    });
    const ctx = scenario.context({ flowManager });
    class LifecycleCommand extends Command {
      static outputMode = "envelope";
      execute() {
        observe("execute");
        if (outcome === "failure") throw new Error("deterministic external command failure");
        return Envelope.ok("run", "runtime-lifecycle", { observed: true });
      }
    }
    const output = [];
    await dispatch({ container: dispatchContainer({ root: scenario.root, flowManager, agent: null }),
      entry: { command: async () => ({ default: LifecycleCommand }), args: {},
        runtimeLog: { stepId: "draft" },
        pre() { observe("pre"); }, post() { observe("post"); },
        nonblockingPost() { observe("nonblocking"); }, onError() { observe("onError"); } },
      argv: [], envelopeType: "run", envelopeKey: "runtime-lifecycle", runtimeLog: true,
      buildHookCtx: () => ctx, stdout: (chunk) => {
        assert.equal(executionSnapshot(scenario).slot, null, "response must follow durable slot closure");
        output.push(chunk);
      }, stderr: () => {}, setExitCode: () => {},
    });
    assert.deepEqual(observed.filter((entry) => !entry.startsWith("metadata-")), outcome === "success"
      ? ["pre", "execute", "post", "nonblocking"] : ["pre", "execute", "onError"]);
    assert.deepEqual(observed.filter((entry) => entry.startsWith("metadata-")), ["metadata-start", "metadata-committed"]);
    assert.equal(JSON.parse(output.join("")).ok, outcome === "success");
    assert.equal(executionSnapshot(scenario).slot, null);
    assert.equal(executionSnapshot(scenario).executions.find((entry) => entry.executionId === executionId).status, "closed");
    const savedMetadata = scenario.manager().readRuntimeArtifact({ specId: scenario.specId,
      logicalKey: "runtime.step-metadata", parameters: { stepId: "draft" }, consumerNodeId: "system" });
    assert.equal(JSON.parse(savedMetadata.bytes).exitCode, outcome === "success" ? 0 : 1);
  });
}

test("live CLI runtime refuses lifecycle pre and direct Review/Gate/claim across runs without canonical effects", async (t) => {
  const scenario = new ProcessRuntimeFlowScenario(seed, { test: t });
  const second = new CanonicalFlowFixture({ flowManager: scenario.manager(),
    specId: "runtime-other-run", runId: "runtime-other-run-id" }).create().registerActive();
  const independent = scenario.createIndependentCheckout();
  const owner = await scenario.startProvider();
  const before = scenario.snapshot();
  const runtimeBefore = executionSnapshot(scenario);
  for (const [name, args] of [
    ["review", ["run", "review", "--phase", "draft"]],
    ["gate", ["run", "gate", "--phase", "draft"]],
    ["claim", ["run", "claim-next-action"]],
    ["resume", ["run", "dispatch"]],
  ]) {
    const refused = await scenario.invoke(args);
    assert.notEqual(refused.status, 0, `${name}: ${refused.stderr}`);
    assertBusy(refused.envelope);
    assert.deepEqual(scenario.snapshot(), before, `${name} changed canonical state before admission`);
  }
  for (const command of [new RunReviewCommand(), new RunGateCommand(), new RunClaimNextActionCommand()]) {
    const refused = await directResult(command, scenario.context({ phase: "draft" }));
    assertBusy(refused);
    assert.deepEqual(scenario.snapshot(), before, `${command.constructor.name} bypassed checkout admission`);
  }
  assert.throws(() => new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: scenario.context() }),
    (error) => { assertBusy(error); return true; });
  assert.deepEqual(scenario.snapshot(), before, "direct publication recovery bypassed checkout admission");
  const query = await scenario.invoke(["get", "next-action"]);
  assert.equal(query.status, 0, query.stderr);
  assert.deepEqual(scenario.snapshot(), before, "read-only query must not stop or mutate the live execution");

  const otherBefore = scenario.manager().canonicalState(second.specId).toJSON();
  const refusedOther = await scenario.invoke(["run", "claim-next-action", "--expect-spec", second.specId,
    "--expect-run-id", second.runId], { target: false });
  assertBusy(refusedOther.envelope);
  assert.deepEqual(scenario.manager().canonicalState(second.specId).toJSON(), otherBefore);
  assert.deepEqual(scenario.snapshot(), before);
  const independentResult = await new RunClaimNextActionCommand().execute(independent);
  assert.equal(independentResult.ok, true, JSON.stringify(independentResult));
  const independentReadback = new independent.flowManager.constructor({ root: independent.root,
    mainRoot: independent.mainRoot, inWorktree: true }).canonicalState(independent.specId);
  assert.equal(independentReadback.attempt.id, independentResult.data.attemptId);
  assert.equal(independentReadback.current.at(-1), "draft");
  assert.deepEqual(scenario.snapshot(), before, "another checkout must not claim the owner's Flow");
  assert.equal(Number(fs.readFileSync(scenario.count, "utf8")), 1);
  assert.deepEqual(executionSnapshot(scenario), runtimeBefore, "contenders must not take or close the live slot");
  assert.equal(owner.child.exitCode, null, "a contender must not terminate the live owner");
  scenario.releaseProvider();
  await owner.result;
  const closed = executionSnapshot(scenario);
  assert.equal(closed.slot, null);
  assert.equal(closed.executions.find((entry) => entry.executionId === runtimeBefore.slot).status, "closed");
});

test("double SIGKILL resume stops old provider and descendant before refusing an unsealed claim", async (t) => {
  const scenario = new ProcessRuntimeFlowScenario(seed, { test: t, descendant: true });
  const dispatcher = await scenario.startProvider();
  const before = scenario.snapshot();
  const runtimeBefore = executionSnapshot(scenario);
  const pids = JSON.parse(fs.readFileSync(scenario.started, "utf8"));
  assert.ok(pids.descendantPid > 0);
  dispatcher.kill();
  const crashed = await dispatcher.result;
  assert.equal(crashed.signal, "SIGKILL");
  const firstResume = scenario.start();
  const secondResume = scenario.start();
  const resumed = await Promise.all([firstResume.result, secondResume.result]);
  for (const result of resumed) assert.notEqual(result.status, 0, result.stderr);
  assert.equal(Number(fs.readFileSync(scenario.count, "utf8")), 1,
    "uncertain input must not launch a replacement provider");
  assert.deepEqual(scenario.snapshot(), before, "unsealed recovery changed Attempt, budget or publication");
  assertStoppedReadback(scenario, runtimeBefore);
  assert.throws(() => process.kill(pids.pid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(pids.descendantPid, 0), { code: "ESRCH" });
  assert.ok(fs.existsSync(scenario.request), "the unsealed request must remain available for diagnosis");
});

for (const migratedDescendant of [false, true]) {
  test(`sealed crash recovery${migratedDescendant ? " waits for a known migrated member then" : ""} publishes once and a fresh canonical consumer reads the original digest`, async (t) => {
    const scenario = new ProcessRuntimeFlowScenario(seed, { test: t, sealed: true, migratedDescendant });
    const dispatcher = await scenario.startProvider();
    const request = JSON.parse(fs.readFileSync(scenario.request, "utf8"));
    const payload = request.payloads.find((entry) => entry.logicalName === "draft.json");
    const original = fs.readFileSync(payload.payloadPath);
    const sealedOutput = JSON.parse(fs.readFileSync(scenario.started, "utf8")).sealedOutput;
    const submission = new WorkerArtifactHandoffSubmission(JSON.parse(fs.readFileSync(sealedOutput.handoffPath, "utf8")));
    assert.equal(submission.handoffDigest, sealedOutput.handoffDigest);
    const sealedDraft = submission.payloadManifest.find((entry) => entry.logicalName === "draft.json");
    assert.equal(sealedDraft.digest, createHash("sha256").update(original).digest("hex"));
    assert.equal(sealedDraft.byteLength, original.length);
    const before = scenario.snapshot();
    let migratedCall = null;
    let member = null;
    const identities = new ProcessIdentitySource();
    if (migratedDescendant) {
      const started = JSON.parse(fs.readFileSync(scenario.started, "utf8"));
      member = new ProcessIdentity(started.descendantIdentity);
      const active = executionSnapshot(scenario);
      migratedCall = active.executions.find((entry) => entry.executionId === active.slot).calls
        .find((call) => call.invocation.kind === "provider" && call.binding.nodeId === "draft");
      assert.ok(migratedCall, "the actual provider must belong to a managed physical call");
      const captured = await scenario.awaitOutcome(migratedCall.callId,
        (record) => record.members.some((entry) => member.sameBirth(new ProcessIdentity(entry))));
      assert.ok(captured.members.some((entry) => new ProcessIdentity(started.providerIdentity).sameBirth(new ProcessIdentity(entry))),
        "the durable outcome must identify this exact provider birth");
      const originalMember = identities.observe(member);
      assert.equal(originalMember.status, "live");
      assert.equal(originalMember.stat.pgrp, captured.pgid);
      assert.notEqual(member.pid, captured.pgid, "setsid must exec without forking a new birth");
      scenario.migrateMember();
      await awaitRuntimeBarrier(scenario.migrated);
      const moved = JSON.parse(fs.readFileSync(scenario.migrated, "utf8"));
      assert.equal(member.sameBirth(new ProcessIdentity(moved.identity)), true);
      assert.equal(moved.stat.pgrp, member.pid);
      assert.equal(moved.stat.sessionId, member.pid);
      assert.notEqual(moved.stat.pgrp, captured.pgid);
      const provider = identities.observe(new ProcessIdentity(started.providerIdentity));
      assert.equal(provider.status, "live");
      assert.equal(provider.stat.pgrp, captured.pgid, "only the descendant may leave the provider group");
      scenario.releaseProvider();
      const exited = await scenario.awaitOutcome(migratedCall.callId, (record) => {
        assert.equal(record.controlFailure, null, "a known member migration must preserve managed control");
        return record.outcome.code === 0;
      });
      assert.notEqual(exited.state, "finished", "provider exit must not finish while the migrated birth is live");
      assert.equal(identities.observe(member).terminated, false);
      assert.deepEqual(scenario.snapshot(), before, "a live migrated member must prevent initial publication");
    }
    const runtimeBefore = executionSnapshot(scenario);
    dispatcher.kill();
    assert.equal((await dispatcher.result).signal, "SIGKILL");
    const recovery = scenario.start();
    if (migratedDescendant) {
      const waiting = new AbortController();
      try {
        await Promise.race([
          scenario.awaitOutcome(migratedCall.callId, (record) => {
            assert.equal(record.controlFailure, null);
            return record.state === "stopping";
          }, { signal: waiting.signal }),
          recovery.result.then((result) => { throw new Error(`recovery exited with a live migrated member: ${JSON.stringify(result)}`); }),
        ]);
        const recovering = executionSnapshot(scenario);
        const originalExecution = recovering.executions.find((entry) => entry.executionId === runtimeBefore.slot);
        const originalCall = originalExecution.calls.find((entry) => entry.callId === migratedCall.callId);
        assert.equal(recovering.slot, runtimeBefore.slot);
        assert.equal(originalExecution.status, "stopping");
        assert.equal(originalCall.receipt, null);
        assert.ok(originalCall.members.some((entry) => member.sameBirth(new ProcessIdentity(entry))),
          "a fresh manager must merge the durably captured migrated birth before stop confirmation");
        assert.equal(identities.observe(member).terminated, false);
        assert.equal(Number(fs.readFileSync(scenario.count, "utf8")), 1);
        assert.deepEqual(scenario.snapshot(), before, "recovery must not publish or spend budget before all members stop");
      } catch (error) {
        t.diagnostic(`migrated recovery diagnostic: ${scenario.preserveFailureEvidence("migrated-recovery")}`);
        throw error;
      } finally {
        waiting.abort(new Error("recovery barrier observation finished"));
        scenario.releaseMember();
      }
    }
    const resumed = await recovery.result;
    if (migratedDescendant) {
      await awaitRuntimeBarrier(scenario.memberExited);
      assert.equal(JSON.parse(fs.readFileSync(scenario.memberExited, "utf8")).reason, "released");
      assert.equal(identities.observe(member).terminated, true);
      const settlement = readManagedRecord(scenario.outcomePath(migratedCall.callId));
      assert.equal(settlement.controlFailure, null);
      assert.equal(settlement.outcome.code, 0);
      assert.equal(settlement.outcome.signal, null);
      assert.ok(settlement.state === "finished"
        || (settlement.state === "stopping" && settlement.outcome.finalAction === "SIGKILL"),
      "recovery requires the production launcher seal, before any fixture teardown");
    }
    if (resumed.status !== 0) t.diagnostic(`sealed failure diagnostic: ${scenario.preserveFailureEvidence("sealed")}`);
    assert.equal(resumed.status, 0, `stdout:\n${resumed.stdout}\nstderr:\n${resumed.stderr}`);
    if (Number(fs.readFileSync(scenario.count, "utf8")) !== 1) {
      t.diagnostic(`initial Draft call-count failure: ${scenario.preserveFailureEvidence("draft-call-count")}`);
    }
    assert.equal(Number(fs.readFileSync(scenario.count, "utf8")), 1,
      "validated sealed output must be replayed without another call for its original Draft step");
    assertStoppedReadback(scenario, runtimeBefore);
    if (migratedDescendant) {
      const recovered = executionSnapshot(scenario).executions.find((entry) => entry.executionId === runtimeBefore.slot);
      const call = recovered.calls.find((entry) => entry.callId === migratedCall.callId);
      assert.ok(call.receipt.members.some((entry) => member.sameBirth(new ProcessIdentity(entry))),
        "fresh durable receipt readback must retain the exact migrated member birth");
      assert.deepEqual(call.receipt.members, call.members);
      assert.equal(call.outcome.code, 0);
    }
    const manager = scenario.manager();
    // The real Review provider records a fresh Store read while the initial
    // publication is current. Refine subsequently promotes q1 and replaces it.
    const initial = JSON.parse(fs.readFileSync(scenario.reviewInput, "utf8"));
    const initialBytes = Buffer.from(initial.bytes);
    assert.deepEqual(JSON.parse(initialBytes), JSON.parse(original));
    assert.equal(createHash("sha256").update(initialBytes).digest("hex"), initial.descriptor.hash);
    assert.equal(initialBytes.length, initial.descriptor.size);
    const publications = manager.activityLedger(scenario.specId).filter((entry) => entry.nodeId === "draft"
      && entry.attemptId === request.executionContract.attemptId
      && entry.result?.artifactRefs?.some((ref) => ref.kind === "worker-handoff-request" && ref.id === submission.requestDigest)
      && entry.result.artifactRefs.some((ref) => ref.kind === "worker-handoff" && ref.id === submission.handoffDigest));
    assert.equal(publications.length, 1, "the original sealed Draft must have exactly one canonical publication");
    assert.equal(publications[0].id, initial.descriptor.activityId);
    const latest = scenario.assertAwaitingQuestionBoundary();
    assert.notEqual(latest.descriptor.hash, initial.descriptor.hash,
      "lawful Refine promotion must produce a distinct question revision");
    assert.notDeepEqual(manager.canonicalState(scenario.specId).toJSON(), before.state);
    const reviewSource = JSON.parse(fs.readFileSync(scenario.reviewSource, "utf8"));
    assert.equal(reviewSource.revision.digest, initial.descriptor.hash);
    const review = JSON.parse(manager.readArtifact({ specId: scenario.specId, logicalKey: "draft.questions.review",
      consumerNodeId: "draft-questions-triage" }).bytes).attempts.at(-1).artifact.payload;
    assert.equal(review.sourceDraftRevision.digest, initial.descriptor.hash);
    assert.equal(review.verdict, "PASS");
    assert.equal(fs.existsSync(path.dirname(path.dirname(payload.payloadPath))), false,
      "successful canonical publication must clean its transient handoff");
    const inventory = executionSnapshot(scenario);
    const nestedReviewCalls = inventory.executions.flatMap((execution) => execution.calls
      .filter((call) => call.parentCallId !== null && call.invocation.kind === "provider"
        && call.binding.nodeId === "draft-questions-review")
      .map((call) => ({ call, parent: execution.calls.find((entry) => entry.callId === call.parentCallId) })));
    assert.ok(nestedReviewCalls.length > 0, "the actual Review child must attach its provider to the root execution");
    for (const { call, parent } of nestedReviewCalls) {
      assert.equal(parent.invocation.kind, "command");
      assert.notEqual(call.pgid, parent.pgid, "Review CLI and provider require separate managed groups");
      assert.deepEqual(call.binding, parent.binding, "nested physical calls must retain the exact Review execution contract");
      assert.equal(call.receipt.stopEvidence.status, "confirmed");
      assert.equal(parent.receipt.stopEvidence.status, "confirmed");
    }
    const published = scenario.snapshot();
    const query = await scenario.invoke(["get", "next-action"]);
    assert.equal(query.status, 0, query.stderr);
    assert.deepEqual(scenario.snapshot(), published, "readback must not publish or spend budget again");
  });
}

test("source worker crash preserves unaccepted partial edits after exact runtime termination", async (t) => {
  const scenario = new ProcessRuntimeFlowScenario(seed, { test: t, step: "implement", sourceMutation: true,
    nestedUpgrade: true });
  const dispatcher = await scenario.startProvider();
  try { await awaitRuntimeBarrier(scenario.nestedUpgrade); }
  catch (cause) {
    const output = ["stdout", "stderr"].map((stream) => {
      const file = `${scenario.nestedUpgrade}.${stream}`;
      return `${stream}: ${fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "<no output>"}`;
    }).join("\n");
    throw new Error(`authenticated source-worker upgrade did not complete\n${output}`, { cause });
  }
  const nestedUpgrade = JSON.parse(fs.readFileSync(scenario.nestedUpgrade, "utf8"));
  assert.equal(nestedUpgrade.status, 0, JSON.stringify(nestedUpgrade));
  const before = scenario.manager().canonicalState(scenario.specId);
  const authoritiesBefore = scenario.manager().sourceHandoffAuthorities({ specId: scenario.specId });
  assert.equal(authoritiesBefore.length, 1);
  assert.equal(authoritiesBefore[0].settlement, null);
  const observedMutation = SourceMutationManifest.capture({ baseline: authoritiesBefore[0].checkpoint.baseline });
  assert.ok(observedMutation.mutations.some((entry) => entry.path === "source.txt"));
  assert.ok(observedMutation.mutations.some((entry) => entry.path === ".sennel/process-runtime-lookalike.txt"),
    "only the registered directory prefix may be ignored");
  assert.equal(observedMutation.mutations.some((entry) => entry.path.startsWith(".sennel/process-runtime/")), false,
    "durable call records and endpoints must not enter source mutation evidence");
  const partial = fs.readFileSync(path.join(scenario.root, "source.txt"));
  const runtimeBefore = executionSnapshot(scenario);
  const externalUpgrade = await scenario.startCommand(["upgrade"]).result;
  assert.notEqual(externalUpgrade.status, 0, externalUpgrade.stdout + externalUpgrade.stderr);
  assert.deepEqual(scenario.manager().canonicalState(scenario.specId).toJSON(), before.toJSON(),
    "external upgrade must refuse before canonical maintenance publication");
  const runtimeAfterUpgrade = executionSnapshot(scenario);
  if (!isDeepStrictEqual(runtimeAfterUpgrade, runtimeBefore)) {
    t.diagnostic(`external upgrade runtime difference: ${scenario.preserveFailureEvidence("external-upgrade")}`);
    t.diagnostic(`external upgrade result: ${JSON.stringify(externalUpgrade)}`);
    const dispatcherResult = await dispatcher.result;
    t.diagnostic(`original dispatcher result after inventory difference: ${JSON.stringify(dispatcherResult)}`);
    t.diagnostic(`completed dispatcher diagnostic: ${scenario.preserveFailureEvidence("external-upgrade-completed")}`);
  }
  assert.deepEqual(runtimeAfterUpgrade, runtimeBefore,
    "external upgrade must not borrow source-worker runtime ownership");
  dispatcher.kill();
  assert.equal((await dispatcher.result).signal, "SIGKILL");
  const resumed = await scenario.invoke(["run", "dispatch"]);
  assert.notEqual(resumed.status, 0, resumed.stderr);
  assertStoppedReadback(scenario, runtimeBefore);
  const manager = scenario.manager();
  const afterState = manager.canonicalState(scenario.specId);
  assert.equal(afterState.attempt.id, before.attempt.id);
  assert.equal(afterState.attempt.sequence, before.attempt.sequence);
  assert.deepEqual(afterState.attempt.consumption.toJSON(), before.attempt.consumption.toJSON());
  assert.equal(afterState.findNode("implement").status, "in_progress");
  assert.deepEqual(fs.readFileSync(path.join(scenario.root, "source.txt")), partial);
  assert.equal(Number(fs.readFileSync(scenario.count, "utf8")), 1);
  const preserved = manager.sourceHandoffAuthorities({ specId: scenario.specId });
  assert.equal(preserved[0].checkpoint.digest, authoritiesBefore[0].checkpoint.digest);
  assert.equal(preserved[0].settlement, null, "a stop receipt must not manufacture source acceptance or rollback");
});
