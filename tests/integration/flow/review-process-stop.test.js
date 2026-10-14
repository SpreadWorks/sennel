import { test } from "node:test";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { TaskStepBinding } from "../../../src/flow/engine/connectors/task/task-step-binding.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { ProcessExecutionRuntime, ProcessExecutionBinding, captureProcessExecutionCheckoutIdentity } from "../../../src/lib/process-execution-runtime.js";
import { currentRuntimePackage } from "../../../src/lib/runtime-package.js";
import { runManagedCmdAsync } from "../../../src/lib/process.js";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { FlowExecutionContract } from "../../../src/flow/lib/flow-execution-contract.js";
import { captureFlowProcessExecutionBinding, FlowProcessExecutionBinding } from "../../../src/flow/lib/process-runtime-admission.js";
import { FlowProcessStopEvidence } from "../../../src/flow/lib/process-runtime-evidence.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { ReviewWorkUnitOutput } from "../../../src/flow/lib/review-work-unit-values.js";
import { CanonicalReviewPromotion, CanonicalDraftReviewObservation, assertStoredReviewProcessStop } from "../../../src/flow/lib/canonical-review-artifacts.js";
import { attachedCanonicalCommandResultArtifact, attachedCanonicalCommandResultPublications } from "../../../src/flow/lib/canonical-command-result.js";
import { CanonicalSpecReview, SpecReviewDelta, mergeSpecReviewDelta } from "../../../src/flow/lib/spec-review-artifacts.js";
import { draftReviewRouteForRetryPhase } from "../../../src/flow/lib/draft-review-routes.js";

for (const phase of ["draft-questions", "spec"]) {
  test(`${phase} Review retains the exact child stop receipt through promotion and readback`, async (t) => {
    const mainRoot = createTmpDir("review-process-stop-");
    const root = path.join(mainRoot, "execution-checkout");
    fs.mkdirSync(root);
    let runtime;
    t.after(async () => { try { if (runtime && !runtime.closed) await runtime.close(); } finally { removeTmpDir(mainRoot); } });
    const state = { runId: "review-stop-run", specId: "review-stop-spec" };
    const nodeId = `${phase}-review`;
    const activity = { nodeId, attemptId: "review-stop-attempt", sequence: 1 };
    const target = { treeSha: "a".repeat(40), targetStateDigest: "b".repeat(64) };
    const workUnit = new ReviewWorkUnit({ executionRoot: root, ...state, phase, ...activity, target,
      output: ReviewWorkUnitOutput.forReview({ phase }) });
    const manifest = workUnit.manifest();
    const contract = new FlowExecutionContract({ ...state, stepId: nodeId, nodeId, attemptId: activity.attemptId,
      attemptSequence: 1, generation: 0, inputRevision: manifest.inputDigest,
      runtimeRevision: currentRuntimePackage().revision, promptDigest: "c".repeat(64), schemaDigest: "d".repeat(64) });
    workUnit.executionContract = contract;
    const surface = workUnit.finalize();
    const review = phase === "spec" ? new CanonicalSpecReview({ version: 2,
      identity: { specId: state.specId, revision: 1, digest: "e".repeat(64), byteLength: 1 },
      generation: 0, findings: [], audit: [] }) : null;
    const output = review ? new SpecReviewDelta({ version: 2, stage: "spec-review", identity: review.identity.toJSON(),
      baseReviewDigest: review.digest, findings: [], operations: [] }).toJSON() : {
      version: 2, phase, sourceDraft: "draft.json", sourceDraftRevision: { version: 1, ...state, sourceStepId: "draft",
        digest: "e".repeat(64), byteLength: 1, finalizedAt: "2026-01-01T00:00:00.000Z" },
      generatedAt: "2026-01-01T00:00:00.000Z", verdict: "PASS", summary: "No findings.",
      blockingFindings: [], advisoryFindings: [], repairTargets: [],
    };
    const script = path.join(root, "review-child.mjs");
    fs.writeFileSync(script, `import fs from 'node:fs';
      import {ReviewWorkUnit} from ${JSON.stringify(new URL("../../../src/flow/lib/review-work-unit.js", import.meta.url).href)};
      fs.writeFileSync(${JSON.stringify(surface.outputPath)}, ${JSON.stringify(JSON.stringify(output))});
      ReviewWorkUnit.fromEnvironment({SENNEL_REVIEW_WORK_UNIT_MANIFEST:${JSON.stringify(surface.manifestPath)}}).seal();`);
    runtime = await ProcessExecutionRuntime.acquire({ mainRoot, executionRoot: root, ...state });
    const binding = new ProcessExecutionBinding({ ...FlowProcessExecutionBinding.forContract(contract).toJSON(), workUnitId: surface.manifestPath });
    const completed = await runtime.enter(() => runManagedCmdAsync(process.execPath, [script], {
      cwd: root, timeout: 15000, processExecutionBinding: binding,
    }));
    assert.equal(completed.ok, true, completed.stderr);
    const processStop = new FlowProcessStopEvidence(completed.processExecutionStopReceipt);
    const checkoutIdentity = captureProcessExecutionCheckoutIdentity({ mainRoot, executionRoot: root });
    const options = { workUnit: ReviewWorkUnit.fromEnvironment({ SENNEL_REVIEW_WORK_UNIT_MANIFEST: surface.manifestPath }),
      phase, ...target, processStop, checkoutIdentity, executionContract: contract,
      ...(review ? { specReviewSource: { revision: 1, review } } : {}) };
    const promotion = new CanonicalReviewPromotion(options);
    const result = promotion.promote(promotion.resultFromSealedArtifact());
    const payload = review ? attachedCanonicalCommandResultPublications(result)[0].payload : attachedCanonicalCommandResultArtifact(result).payload;
    new AtomicFile(path.join(root, "canonical-review.json")).write(JSON.stringify(payload));
    const reloaded = JSON.parse(fs.readFileSync(path.join(root, "canonical-review.json"), "utf8"));
    assert.deepEqual(reloaded.processStop, JSON.parse(JSON.stringify(processStop)));
    assert.equal(Object.hasOwn(reloaded.workerOutput ?? {}, "processStop"), false);
    assert.equal(processStop.receipt.stopEvidence.confirmed, true);
    assertStoredReviewProcessStop({ processStop: reloaded.processStop,
      contractDocument: { id: contract.id, contract: contract.toJSON() }, contractActivity: activity, activity, state, checkoutIdentity });
    if (review) {
      const restored = new CanonicalSpecReview(reloaded);
      assert.equal(result.artifacts.reviewDigest, restored.digest);
      const triage = new SpecReviewDelta({ version: 2, stage: "spec-triage", identity: restored.identity.toJSON(),
        baseReviewDigest: restored.digest, findings: [], operations: [] });
      assert.deepEqual(mergeSpecReviewDelta({ review: restored, delta: triage }).processStop, restored.processStop);
    } else {
      const restored = new CanonicalDraftReviewObservation({ payload: reloaded, state, route: draftReviewRouteForRetryPhase(phase) });
      assert.deepEqual(restored.processStop.receipt, processStop.receipt);
      assert.equal(restored.document.verdict, "PASS");
    }
    const originalOutput = fs.readFileSync(surface.outputPath);
    for (const bindingChange of [{ workUnitId: `${surface.manifestPath}.foreign` }, { executionContractId: "f".repeat(64) }, { attemptId: "foreign-attempt" }]) {
      const changed = { ...processStop.toJSON(), binding: { ...binding.toJSON(), ...bindingChange } };
      assert.throws(() => new CanonicalReviewPromotion({ ...options, processStop: FlowProcessStopEvidence.fromStored(changed) }),
        { code: "PROCESS_EXECUTION_STOP_BINDING_MISMATCH" });
    }
    const foreign = createTmpDir("foreign-review-checkout-");
    try {
      assert.throws(() => new CanonicalReviewPromotion({ ...options,
        checkoutIdentity: captureProcessExecutionCheckoutIdentity({ mainRoot: foreign, executionRoot: foreign }) }),
      { code: "PROCESS_EXECUTION_STOP_CHECKOUT_MISMATCH" });
    } finally { removeTmpDir(foreign); }
    assert.deepEqual(fs.readFileSync(surface.outputPath), originalOutput);
    await runtime.close();
    const recovered = await ProcessExecutionRuntime.acquire({ mainRoot, executionRoot: root, ...state });
    try { assert.deepEqual(recovered.stopReceipts().find((receipt) => receipt.callId === processStop.receipt.callId), processStop.receipt); }
    finally { await recovered.close(); }
    fs.rmSync(root, { recursive: true });
    const repositoryIdentity = captureProcessExecutionCheckoutIdentity({ mainRoot });
    assertStoredReviewProcessStop({ processStop: reloaded.processStop,
      contractDocument: { id: contract.id, contract: contract.toJSON() }, contractActivity: activity, activity, state, repositoryIdentity });
    const foreignRepository = createTmpDir("foreign-review-repository-");
    try {
      assert.throws(() => assertStoredReviewProcessStop({ processStop: reloaded.processStop,
        contractDocument: { id: contract.id, contract: contract.toJSON() }, contractActivity: activity, activity, state,
        repositoryIdentity: captureProcessExecutionCheckoutIdentity({ mainRoot: foreignRepository }) }),
      { code: "PROCESS_EXECUTION_STOP_REPOSITORY_MISMATCH" });
    } finally { removeTmpDir(foreignRepository); }
  });
}


test("Task Review canonical binding preserves its Task identity through physical stop delivery and reload", async (t) => {
  const scenario = new TaskReviewScenario(t);
  const binding = new TaskStepBinding({ flowManager: scenario.manager, specId: scenario.specId,
    definitionStepId: "task-review" });
  const contract = FlowExecutionContract.fromBinding({ binding, generation: 0,
    inputRevision: "a".repeat(64), promptDigest: "b".repeat(64), schemaDigest: "c".repeat(64) });
  assert.equal(contract.taskId, scenario.taskId);
  scenario.manager.claimExecutionContract({ binding, executionContract: contract });
  const restored = scenario.manager.readStoredExecutionContract({ binding, generation: 0 });
  assert.equal(restored.taskId, scenario.taskId);
  assert.equal(restored.id, contract.id);
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: scenario.root, executionRoot: scenario.root,
    runId: binding.runId, specId: binding.specId });
  try {
    let delivered;
    const result = await runtime.enter(() => runManagedCmdAsync(process.execPath,
      ["-e", "process.stdout.write('review-completed')"], { cwd: scenario.root, timeout: 20000,
        processExecutionBinding: captureFlowProcessExecutionBinding(scenario.context(), { executionContract: restored }),
        onProcessExecutionStop(receipt) { delivered = new FlowProcessStopEvidence(receipt).assertContract(restored); },
      }));
    assert.equal(result.ok, true);
    assert.equal(result.stdout, "review-completed");
    assert.equal(delivered.receipt.binding.value.taskId, scenario.taskId);
    await runtime.close();
    const inventory = ProcessExecutionRuntime.inspect({ mainRoot: scenario.root });
    const saved = inventory.executions.find((entry) => entry.executionId === runtime.executionId).calls[0].receipt;
    assert.equal(FlowProcessStopEvidence.fromStored(saved).assertContract(restored).receipt.callId, delivered.receipt.callId);
  } finally { if (!runtime.closed) await runtime.close(); }
});
