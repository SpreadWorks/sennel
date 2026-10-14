import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { ProcessExecutionRuntime, ProcessExecutionBinding, ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { FlowExecutionContractRefusal } from "../../../src/flow/lib/flow-execution-contract.js";
import { FlowProcessExecutionBinding } from "../../../src/flow/lib/process-runtime-admission.js";
import { FlowProcessStopEvidence } from "../../../src/flow/lib/process-runtime-evidence.js";
import { WorkerArtifactHandoffCoordinator, canonicalWorkerExecutionClaimForStored, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { DraftGateRepairScenario } from "../../support/infrastructure/draft-gate-repair-scenario.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";

function fixture(t) {
  const root = createTmpDir("conditional-stop-", { parent: path.resolve(".tmp/c2f6/conditional-stop-fixtures") });
  const owned = [];
  t.after(async () => { try { for (const runtime of owned) if (!runtime.closed) await runtime.close(); } finally { removeTmpDir(root); } });
  initGitRepo(root); fs.writeFileSync(path.join(root, "README.md"), "conditional recovery fixture\n"); commitAll(root, "Create conditional recovery fixture");
  const specId = "conditional-process-stop";
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const flow = new CanonicalFlowFixture({ flowManager: manager, specId, runId: "conditional-stop-run", issue: 521,
    request: "Preserve exact stopped conditional worker ownership.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null } }).create().registerActive().activate("draft");
  manager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft", mediaType: "application/json",
    bytes: Buffer.from(JSON.stringify(canonicalDraftDocument({ goal: "Retain the selected behavior", questions: [] }))) }] });
  flow.activate("draft-gate");
  const scenario = new DraftGateRepairScenario({ flowManager: manager, root, specId }).select({ issueLogId: "conditional-stop-issue",
    observations: [{ kind: "violation", failureMode: "guardrail-violation", requirementRef: "R-1",
      where: { file: "draft.json", locator: "goal" }, observed: "Specify the selected behavior.", severity: "blocking", refs: ["R-1"] }] });
  const request = scenario.createRequest();
  const payload = scenario.replacement("goal", "Retain the exact selected behavior with a durable observation.");
  const reload = () => new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const context = (flowManager) => ({ root, mainRoot: root, executionRoot: root, flowManager, specId, flowState: flowManager.loadReadOnly(specId) });
  const snapshot = (flowManager) => JSON.parse(JSON.stringify({ state: flowManager.canonicalState(specId).toJSON(),
    activities: flowManager.activityLedger(specId), catalog: flowManager.artifactCatalog(specId).toJSON(),
    claim: canonicalWorkerExecutionClaimForStored({ flowManager, stored: request })?.toJSON(),
    draft: flowManager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: request.stepId }).bytes.toString("base64"),
    request: fs.readFileSync(request.requestPath).toString("base64"),
    payload: fs.existsSync(request.payloadPath("draft-gate-repair.json")) ? fs.readFileSync(request.payloadPath("draft-gate-repair.json")).toString("base64") : null,
    submission: fs.existsSync(request.submissionPath) ? fs.readFileSync(request.submissionPath).toString("base64") : null }));
  return { root, manager, specId, scenario, request, payload, owned, reload, context, snapshot };
}

async function produceStoppedSealedWorker(value, change) {
  const { root, request, payload } = value;
  const binding = new ProcessExecutionBinding({ ...FlowProcessExecutionBinding.forContract(request.executionContract).toJSON(),
    dispatchInvocationId: request.dispatchInvocationId, requestDigest: request.requestDigest, ...change });
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, runId: request.runId, specId: request.specId });
  value.owned.push(runtime);
  const handoffModule = pathToFileURL(path.resolve("src/flow/lib/worker-artifact-handoff.js")).href;
  const script = `import fs from 'node:fs';import{sealWorkerArtifactHandoff}from ${JSON.stringify(handoffModule)};
    fs.writeFileSync(${JSON.stringify(request.payloadPath("draft-gate-repair.json"))},${JSON.stringify(JSON.stringify(payload))});
    sealWorkerArtifactHandoff({requestPath:${JSON.stringify(request.requestPath)},invocationId:${JSON.stringify(request.dispatchInvocationId)}});
    process.stdout.write('sealed-and-stopped');`;
  const result = await runtime.enter(() => executeManagedProcess(process.execPath,
    ["--import", pathToFileURL(path.resolve("src/sennel.js")).href, "--input-type=module", "-e", script],
    { cwd: root, timeoutMs: 90000, maxBuffer: 4096, graceMs: 100, processExecutionBinding: binding }));
  assert.equal(result.code, 0); assert.equal(result.stdout, "sealed-and-stopped");
  await runtime.close();
  const [receipt] = runtime.stopReceipts(binding);
  assert.equal(receipt.callId, result.processExecutionStopReceipt.callId);
  assert.equal(receipt.binding.value.executionContractId, request.executionContract.id);
  assert.equal(receipt.stopEvidence.status, "confirmed");
  return [new FlowProcessStopEvidence(receipt)];
}

test("conditional sealed recovery refuses wrong request and dispatch stop bindings before any canonical or capability change", async (t) => {
  for (const [name, change, errorType] of [
    ["request", { requestDigest: "f".repeat(64) }, FlowExecutionContractRefusal],
    ["dispatch", { dispatchInvocationId: "foreign-dispatch" }, ProcessExecutionControlFailure],
  ]) await t.test(name, async (t) => {
    const value = fixture(t);
    const stops = await produceStoppedSealedWorker(value, change);
    const before = value.snapshot(value.manager);
    const manager = value.reload();
    assert.throws(() => new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: value.context(manager), processStops: stops }),
      (error) => error instanceof errorType && (name === "request" ? error.code === "FLOW_EXECUTION_CONTRACT_MISMATCH" : error.code === "PROCESS_EXECUTION_STOP_BINDING_MISMATCH"));
    assert.deepEqual(value.snapshot(value.reload()), before);
    assert.equal(canonicalWorkerExecutionClaimForStored({ flowManager: manager, stored: value.request }).phase, "claimed");
  });
});

test("an exact stopped conditional worker preserves its sealed claimed execution across manager reload", async (t) => {
  const value = fixture(t), stops = await produceStoppedSealedWorker(value, {});
  const before = value.snapshot(value.manager), manager = value.reload();
  assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: value.context(manager), processStops: stops }), null);
  assert.deepEqual(value.snapshot(value.reload()), before);
});

test("a conditional sealed claim with no OS invocation keeps its existing zero-process recovery authority", (t) => {
  const value = fixture(t);
  fs.writeFileSync(value.request.payloadPath("draft-gate-repair.json"), JSON.stringify(value.payload));
  sealWorkerArtifactHandoff({ requestPath: value.request.requestPath, invocationId: value.request.dispatchInvocationId });
  assert.equal(ProcessExecutionRuntime.inspect({ mainRoot: value.root }), null);
  const before = value.snapshot(value.manager), manager = value.reload();
  assert.equal(new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: value.context(manager), processStops: [] }), null);
  assert.deepEqual(value.snapshot(value.reload()), before);
});
