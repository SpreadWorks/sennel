import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { ImplPhaseRecoveryScenario } from "../../support/infrastructure/impl-phase-recovery.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import RunGateCommand from "../../../src/flow/lib/run-gate.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";
import { CurrentFlowStateInvariantError } from "../../../src/flow/lib/current-flow-state.js";
import { TaskReviewAccounting } from "../../../src/flow/lib/task-review-accounting.js";
import { dispatchContainer, installGateProviderFake } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { WorkerArtifactHandoffCoordinator, WorkerArtifactHandoffRequest, WorkerArtifactInputSnapshot, SourceHandoffSettlement,
  SourceWorkerHandoffIdentity } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { WorkerArtifactHandoffError } from "../../../src/flow/lib/worker-artifact-handoff-error.js";
import { workerArtifactStableStringify, MAX_WORKER_ARTIFACT_INPUT_BYTES }
  from "../../../src/flow/lib/worker-artifact-input-format.js";
import { PromptRequestLimit, ResolvedAgentInvocationProjection } from "../../../src/lib/prompt-batching.js";
import { withSourceHandoffLease } from "../../support/builders/source-handoff-scenario.js";

function assertNoReceipt(scenario, nodeId) {
  const state = scenario.state();
  const attempt = state.attempt;
  assert.equal(state.current?.at(-1), nodeId);
  assert.notEqual(state.findNode(nodeId).status, "done");
  assert.notEqual(state.findNode(nodeId).status, "skipped");
  for (const activity of scenario.manager.activityLedger(scenario.specId)) {
    const receipt = activity.result?.draftSettlementReceipt;
    if (activity.nodeId !== nodeId || receipt === undefined
      || receipt.binding.attemptId !== attempt.id || receipt.binding.attemptSequence !== attempt.sequence) continue;
    assert.equal(receipt.settlementKind, "execution", "the current claim can carry only its nonterminal Execution receipt");
    assert.equal(receipt.targetStepId, null, "a claim/publication-only checkpoint cannot fabricate a target-connection receipt");
    assert.equal(receipt.connector, null);
  }
}

test("I09 start-intent before seal stops recovery and a wrong direct Gate before any evaluator or repeated source worker", async (t) => {
  const scenario = await new ImplPhaseRecoveryScenario(t).prepareRepair();
  const work = scenario.stageHandoff("repair");
  t.after(() => work.release());
  work.release();
  scenario.reload();
  const before = scenario.snapshot();
  const authority = scenario.authority(work.request);
  assert.equal(authority.event.kind, "start-intent");
  assert.equal(authority.settlement, null);
  assert.equal(fs.existsSync(work.request.submissionPath), false);
  assert.throws(() => scenario.recovery(), (error) => error instanceof WorkerArtifactHandoffError
    && error.code === "FLOW_SOURCE_HANDOFF_START_UNCERTAIN" && error.retryable === false);
  assert.equal(scenario.reload().snapshot(), before);
  const provider = installGateProviderFake(() => { scenario.calls.evaluators += 1; return '{"evaluations":[]}'; });
  t.after(() => provider.mock.restore());
  await assert.rejects(() => new RunGateCommand().execute({ ...scenario.context(), phase: "task-impl" }),
    StepAdmissionRefusal, "a live repair claim cannot authorize the later Gate");
  assert.equal(scenario.calls.evaluators, 0);
  assert.equal(scenario.reload().snapshot(), before);
  assertNoReceipt(scenario, `${scenario.taskId}-repair`);
  // This later assertion fixes the new claim Result contract; current product
  // absence is a semantic contract red after all lawful-stop checks above.
  scenario.assertClaims([`${scenario.taskId}-repair`]);
});

test("I09 a real publication-only Review remains unfinished and cannot replace the atomic selected Result/receipt", async (t) => {
  const scenario = new ImplPhaseRecoveryScenario(t);
  const result = await scenario.unpostedReview([scenario.finding()]);
  assert.notEqual(result.ok, false, JSON.stringify(result));
  const attempt = scenario.state().attempt;
  const beforePublication = scenario.snapshot();
  try {
    scenario.manager.publishCurrentAttemptResult({ specId: scenario.specId, commandResult: result });
  } catch (error) {
    // A migrated Store may reject this legacy publication-only boundary outright.
    // It need not retain a non-atomic writer to make this scenario possible.
    assert.ok(error instanceof StepAdmissionRefusal || error instanceof CurrentFlowStateInvariantError);
    assert.equal(scenario.reload().snapshot(), beforePublication);
  }
  scenario.reload();
  assert.equal(scenario.state().attempt.id, attempt.id);
  assert.equal(scenario.state().current?.at(-1), `${scenario.taskId}-review`);
  assert.equal(scenario.state().findNode(`${scenario.taskId}-gate`).status, "pending");
  assertNoReceipt(scenario, `${scenario.taskId}-review`);
  assert.equal(TaskReviewAccounting.fromCanonicalState({ flowManager: scenario.manager,
    state: scenario.state(), taskId: scenario.taskId }).completedReviewCount, 0,
  "I09 publication-only history cannot consume a semantic Review ordinal without its atomic selected Result and receipt");
  const before = scenario.snapshot();
  const recovery = await scenario.review(() => {
    assert.fail("publication-only evidence must be consumed from its sealed work unit without another Review process");
  }).execute(scenario.context());
  assert.notEqual(recovery.ok, false, JSON.stringify(recovery));
  assert.equal(scenario.reload().snapshot(), before, "readback alone must not silently complete a publication-only Review");
  await FLOW_COMMANDS.run.review.post(scenario.context(), recovery);
  scenario.reload();
  assert.equal(scenario.state().current?.at(-1), `${scenario.taskId}-triage`);
  const once = scenario.counts();
  await FLOW_COMMANDS.run.review.post(scenario.context(), recovery);
  assert.deepEqual(scenario.reload().counts(), once, "exact replay cannot repeat metric, publication or next activation");
  assert.equal(scenario.calls.reviewProcesses, 1);
  scenario.assertResults([`${scenario.taskId}-review`]);
});

for (const [phase, committed] of [["before-json-rename", false], ["before-json-directory-fsync", true]]) {
  test(`I09 ${phase}: canonical exception ${committed ? "after commit response loss" : "before commit"} resumes without duplicated source, lineage, metrics or Task frontier`, async (t) => {
    const scenario = await new ImplPhaseRecoveryScenario(t).prepareRepair();
    const work = scenario.sealRepair(t);
    scenario.reload();
    const before = scenario.counts();
    const catalog = scenario.manager.specLocation(scenario.specId).catalogFile;
    const stop = Object.assign(new Error(`Injected catalog ${phase}`), { code: "EIO" });
    let hits = 0;
    scenario.reloadWithFault((boundary) => {
      if (boundary.filePath === catalog && boundary.phase === phase && hits++ === 0) throw stop;
    });
    assert.throws(() => scenario.recovery(), WorkerArtifactHandoffError);
    assert.ok(hits > 0, "the real atomic catalog boundary must be reached");
    scenario.reload();
    const authority = scenario.authority(work.request);
    assert.equal(authority.settlement?.kind ?? null, committed ? "accepted" : null);
    assert.equal(scenario.state().current?.at(-1), `${scenario.taskId}-${committed ? "review" : "repair"}`);
    assert.deepEqual(scenario.calls, before.calls, "persistence failure cannot execute a worker or evaluator");
    assert.equal(scenario.recovery()?.completed, true);
    scenario.reload();
    assert.equal(scenario.authority(work.request).settlement.kind, "accepted");
    assert.equal(scenario.state().current?.at(-1), `${scenario.taskId}-review`);
    assert.equal(scenario.manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId })
      .filter((entry) => entry.role === "repair").length, 1);
    const once = scenario.counts();
    assert.equal(scenario.recovery(), null);
    assert.deepEqual(scenario.reload().counts(), once);
    assert.deepEqual(scenario.calls, before.calls);
    scenario.assertResults([`${scenario.taskId}-repair`]);
  });
}

test("I09 canonical checkpoint readback EIO preserves the sealed repair and budget until the actual FS boundary recovers", async (t) => {
  const scenario = await new ImplPhaseRecoveryScenario(t).prepareRepair();
  const work = scenario.sealRepair(t);
  scenario.reload();
  const location = scenario.manager.specLocation(scenario.specId);
  const descriptor = scenario.authority(work.request).checkpointDescriptor;
  assert.ok(descriptor, "normal handoff preparation publishes its actual checkpoint before worker admission");
  const checkpoint = location.resolve(descriptor.relativePath);
  const before = scenario.snapshot();
  const ctx = scenario.context();
  const read = fs.readFileSync;
  const fault = t.mock.method(fs, "readFileSync", function (file, ...args) {
    if (String(file) === checkpoint) throw Object.assign(new Error("checkpoint read temporarily unavailable"), { code: "EIO" });
    return read.call(this, file, ...args);
  });
  try {
    assert.throws(() => new WorkerArtifactHandoffCoordinator().recoverPending({ ctx }), (error) => error instanceof WorkerArtifactHandoffError
      && error.code === "FLOW_SOURCE_HANDOFF_RECOVERY_UNAVAILABLE" && error.retryable === true);
  } finally { fault.mock.restore(); }
  assert.equal(scenario.reload().snapshot(), before);
  assert.equal(scenario.authority(work.request).settlement, null);
  assert.equal(scenario.recovery()?.completed, true);
  scenario.reload();
  const once = scenario.counts();
  assert.equal(scenario.recovery(), null);
  assert.deepEqual(scenario.reload().counts(), once);
  scenario.assertResults([`${scenario.taskId}-repair`]);
});

test("I09 exact pre-start terminal receipt replays; changed binding, Task, Attempt or sequence cannot borrow its authority", async (t) => {
  const scenario = await new ImplPhaseRecoveryScenario(t).prepareRepair();
  const coordinator = new WorkerArtifactHandoffCoordinator();
  const attempt = scenario.state().attempt;
  const invocation = { id: `pre-start-${attempt.id}`, target: { digest: "a".repeat(64) },
    action: { digest: "b".repeat(64), nextAction: { step: "task-repair", taskId: scenario.taskId } } };
  const request = withSourceHandoffLease({ root: scenario.root }, () => coordinator.createRequest({
    ctx: scenario.context(), state: scenario.manager.loadReadOnly(scenario.specId), invocation,
  }));
  scenario.reload();
  assert.equal(scenario.authority(request).event.kind, "prepared");
  assert.equal(scenario.recovery()?.completed, true);
  scenario.reload();
  const receipt = scenario.authority(request).settlement;
  assert.equal(receipt.kind, "aborted-before-start");
  const before = scenario.snapshot();
  assert.equal(scenario.manager.settleSourceHandoff({ specId: scenario.specId, settlement: receipt }).settlement.digest, receipt.digest);
  assert.equal(scenario.reload().snapshot(), before);
  for (const [label, mutate] of [
    ["checkpoint", (value) => { value.checkpointDigest = "1".repeat(64); }],
    ["event", (value) => { value.eventDigest = "2".repeat(64); }],
    ["action", (value) => { value.identity.actionDigest = "3".repeat(64); }],
    ["Task", (value) => { value.identity.taskId = "T-foreign"; value.identity.nodeId = "T-foreign-repair"; value.identity.attempt.nodeId = value.identity.nodeId; }],
    ["Attempt", (value) => { value.identity.attempt.id = "attempt-foreign"; }],
    ["sequence", (value) => { value.identity.attempt.sequence += 1; }],
  ]) {
    const changed = structuredClone(receipt.unsignedJSON());
    mutate(changed);
    const modified = new SourceHandoffSettlement({ ...changed, identity: new SourceWorkerHandoffIdentity(changed.identity) });
    assert.throws(() => scenario.manager.settleSourceHandoff({ specId: scenario.specId, settlement: modified }),
      (error) => ["CURRENT_FLOW_STATE_CONFLICT", "CURRENT_FLOW_STATE_INVARIANT_INVALID"].includes(error.code), label);
    assert.equal(scenario.reload().snapshot(), before, `${label} replay must be atomic and leave next Task untouched`);
  }
  scenario.assertClaims([`${scenario.taskId}-repair`]);
});

const unicode = `HEAD serial\n${"日本語 \\\\ 😀\n".repeat(1_200)}TAIL parallel`;

test("I05 genuine Review producer hands complete UTF-8 finding bytes, digest and byteLength to the immutable repair worker reference", async (t) => {
  const scenario = new ImplPhaseRecoveryScenario(t);
  await scenario.prepareRepair([scenario.finding({ issue: unicode })]);
  const work = scenario.stageHandoff("repair");
  t.after(() => work.release());
  const reference = work.request.toPromptReference();
  const input = WorkerArtifactHandoffRequest.readInput({ requestPath: reference.requestPath,
    name: "task-review.json", mainRoot: scenario.root, flowManager: scenario.manager });
  const actual = input.document.blockingFindings[0].issue;
  assert.equal(actual, unicode);
  const bytes = Buffer.from(workerArtifactStableStringify(input.document), "utf8");
  assert.equal(input.byteLength, bytes.length);
  assert.equal(input.digest, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(bytes.includes(Buffer.from("HEAD serial")), true);
  assert.equal(bytes.includes(Buffer.from("TAIL parallel")), true);
  assert.equal(reference.requestDigest, work.request.requestDigest);
  assert.equal(JSON.stringify(reference).includes(unicode), false, "large authority travels by immutable reference, never provider argv");
  work.release();
  scenario.reload();
  const reread = WorkerArtifactHandoffRequest.readInput({ requestPath: reference.requestPath,
    name: "task-review.json", mainRoot: scenario.root, flowManager: scenario.manager });
  assert.equal(reread.digest, input.digest);
  assert.equal(workerArtifactStableStringify(reread.document), bytes.toString("utf8"));
  scenario.assertResults([`${scenario.taskId}-review`, `${scenario.taskId}-triage`]);
  scenario.assertClaims([`${scenario.taskId}-repair`]);
});

for (const alteration of ["changed", "missing"]) {
  test(`I05 ${alteration} genuine immutable worker request stops before another source worker or canonical publication`, async (t) => {
    const scenario = await new ImplPhaseRecoveryScenario(t).prepareRepair();
    const work = scenario.stageHandoff("repair");
    t.after(() => work.release());
    const before = scenario.snapshot();
    const bytes = fs.readFileSync(work.request.requestPath);
    if (alteration === "missing") fs.unlinkSync(work.request.requestPath);
    else {
      const document = JSON.parse(bytes);
      document.workerInstructions.schemaGuidance = "Altered immutable instruction";
      fs.writeFileSync(work.request.requestPath, `${JSON.stringify(document)}\n`);
    }
    try {
      assert.throws(() => work.request.toPromptReference(), (error) => error instanceof WorkerArtifactHandoffError
        && (alteration === "changed" ? error.code === "FLOW_ARTIFACT_HANDOFF_STALE" : error.classification === "missing"));
    } finally { fs.writeFileSync(work.request.requestPath, bytes); work.release(); }
    assert.equal(scenario.reload().snapshot(), before);
    assert.equal(scenario.authority(work.request).settlement, null);
    assertNoReceipt(scenario, `${scenario.taskId}-repair`);
    scenario.assertClaims([`${scenario.taskId}-repair`]);
  });
}

test("I05 actual worker projection argv overflow refuses provider admission before worker invocation and preserves semantic budget", async (t) => {
  const scenario = await new ImplPhaseRecoveryScenario(t).prepareRepair();
  const attempt = scenario.state().attempt;
  let calls = 0;
  const agent = { call: () => { calls += 1; assert.fail("oversized argv must be refused before the external worker"); },
    promptCharacterLimit: new PromptRequestLimit({ maxCharacters: 60_000 }),
    projectInvocation: (prompt) => new ResolvedAgentInvocationProjection({
    providerKey: "fixture", profileKey: "fixture", command: "fixture", finalArgs: ["日本語".repeat(40_000)],
    promptCharacterCount: prompt.length, systemPromptCharacterCount: 0, schemaCharacterCount: 0,
    inlineArgvByteCount: Buffer.byteLength("日本語".repeat(40_000)), schemaMode: "none", usesStdin: false,
  }) };
  const command = new RunDispatchCommand({ agent, maxDispatches: 1 });
  command.container = dispatchContainer({ root: scenario.root, flowManager: scenario.manager, agent });
  const result = await command.execute({ ...scenario.context(),
    expectBinding: FlowTargetBinding.capture({ flowState: scenario.manager.loadReadOnly(scenario.specId),
      mainRoot: scenario.root, authorityRoot: scenario.root }).serialize(), _envelopeType: "run", _envelopeKey: "dispatch" });
  assert.equal(calls, 0);
  assert.ok(result.errors?.some((error) => error.code === "PROMPT_INVOCATION_PROJECTION_OVERFLOW"), JSON.stringify(result));
  scenario.reload();
  assert.equal(scenario.state().attempt.id, attempt.id);
  assert.equal(scenario.state().attempt.consumption.semantic, 0);
  assert.equal(scenario.state().findNode(`${scenario.taskId}-gate`).status, "pending");
  assertNoReceipt(scenario, `${scenario.taskId}-repair`);
});

test("I05 an oversized genuine immutable worker reference is refused by the actual file byte boundary before publication", async (t) => {
  const scenario = await new ImplPhaseRecoveryScenario(t).prepareRepair();
  const work = scenario.stageHandoff("repair");
  t.after(() => work.release());
  const reference = work.request.toPromptReference();
  const bytes = fs.readFileSync(reference.requestPath);
  const before = scenario.snapshot();
  // This is deliberately malformed system-boundary input after a legal
  // producer, rather than an impossible oversized sealed Review. The existing
  // request JSON reader admits at most 8MiB before parsing or capability use.
  fs.writeFileSync(reference.requestPath, Buffer.concat([bytes,
    Buffer.alloc(8 * 1024 * 1024 + 1 - bytes.length, " ")]));
  try {
    assert.throws(() => work.request.toPromptReference(), (error) => error instanceof WorkerArtifactHandoffError
      && error.code === "FLOW_ARTIFACT_HANDOFF_INVALID" && error.retryable === false);
  } finally { fs.writeFileSync(reference.requestPath, bytes); work.release(); }
  assert.equal(scenario.reload().snapshot(), before);
  assert.equal(scenario.authority(work.request).settlement, null);
  assertNoReceipt(scenario, `${scenario.taskId}-repair`);
  scenario.assertClaims([`${scenario.taskId}-repair`]);
});

test("I05 malformed named input descriptor over the 2MiB contract is rejected by the actual worker reader before delivery", async (t) => {
  const scenario = await new ImplPhaseRecoveryScenario(t).prepareRepair();
  const work = scenario.stageHandoff("repair");
  t.after(() => work.release());
  const reference = work.request.toPromptReference();
  const read = () => WorkerArtifactHandoffRequest.readInput({ requestPath: reference.requestPath,
    name: "task-review.json", mainRoot: scenario.root, flowManager: scenario.manager });
  const original = read();
  assert.ok(original instanceof WorkerArtifactInputSnapshot);
  assert.ok(original.byteLength <= MAX_WORKER_ARTIFACT_INPUT_BYTES);
  const before = scenario.snapshot();
  const attempt = scenario.state().attempt;
  const bytes = fs.readFileSync(reference.requestPath);
  const document = JSON.parse(bytes);
  const input = document.inputs.find((entry) => entry.name === original.name);
  // Explicitly malformed system-boundary metadata after a legal producer.
  // The request envelope remains below its distinct 8MiB cap; the real parser
  // must enforce MAX_WORKER_ARTIFACT_INPUT_BYTES while constructing this input.
  input.byteLength = MAX_WORKER_ARTIFACT_INPUT_BYTES + 1;
  fs.writeFileSync(reference.requestPath, `${JSON.stringify(document)}\n`);
  let rejection;
  let sourceWorkerCalls = 0;
  const externalWorker = () => { sourceWorkerCalls += 1; };
  try {
    try { externalWorker(read()); }
    catch (error) { rejection = error; }
  } finally { fs.writeFileSync(reference.requestPath, bytes); work.release(); }
  assert.ok(rejection, "the actual reader must refuse an input descriptor above the named 2MiB contract");
  assert.equal(sourceWorkerCalls, 0);
  assert.equal(scenario.reload().snapshot(), before);
  assert.equal(scenario.state().attempt.id, attempt.id);
  assert.equal(scenario.state().attempt.sequence, attempt.sequence);
  assert.equal(scenario.state().attempt.consumption.semantic, attempt.consumption.semantic);
  assert.equal(scenario.authority(work.request).settlement, null);
  const restored = read();
  assert.ok(restored instanceof WorkerArtifactInputSnapshot);
  assert.equal(restored.byteLength, original.byteLength);
  assert.equal(restored.digest, original.digest);
  assert.deepEqual(restored.document, original.document);
  assert.ok(rejection instanceof WorkerArtifactHandoffError,
    `IMPL_PHASE_INPUT_LIMIT_BOUNDARY_UNTYPED: the 2MiB input refusal must be typed; observed ${rejection.constructor.name}: ${rejection.message}`);
  assert.equal(rejection.code, "FLOW_ARTIFACT_HANDOFF_INVALID");
  assert.equal(rejection.retryable, false);
});
