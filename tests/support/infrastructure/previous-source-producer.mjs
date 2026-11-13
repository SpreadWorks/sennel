import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, root, factsPath, _lifecycle, _mainRoot, mode = "settled"] = process.argv.slice(2);
assert.ok(["settled", "sealed-pending"].includes(mode));
const load = relative => import(pathToFileURL(path.join(packageRoot, relative)).href);
const [runtimeModule, managerModule, fixtureModule, gitFixture, leaseModule, handoffModule,
  admission, evidenceModule, managedModule, values, composition, runtimePackage] = await Promise.all([
  load("src/lib/process-execution-runtime.js"), load("src/lib/flow-manager.js"),
  load("tests/support/infrastructure/flow-setup.js"), load("tests/support/infrastructure/git-repo.js"),
  load("src/lib/flow-handoff-authority-lease.js"), load("src/flow/lib/worker-artifact-handoff.js"),
  load("src/flow/lib/process-runtime-admission.js"), load("src/flow/lib/process-runtime-evidence.js"),
  load("src/lib/managed-process.js"), load("src/lib/process-execution-values.js"),
  load("src/flow/engine/composition/source-step.js"), load("src/lib/runtime-package.js"),
]);
const expectedRevision = "7d58bd1b4cd78f8e80129b6b7ccf8d56329123a5245bab7d275ae90ac764e833";
assert.equal(runtimePackage.currentRuntimePackage().revision, expectedRevision);
fs.mkdirSync(root);
gitFixture.initGitRepo(root);
fs.writeFileSync(path.join(root, ".gitignore"), ".sennel/\n");
fs.writeFileSync(path.join(root, "product.js"), "export const value = 1;\n");
gitFixture.commitAll(root, "previous Source baseline");
const specId = "previous-source-producer", runId = "run-previous-source-producer";
const manager = new managerModule.FlowManager({ root, mainRoot: root, inWorktree: false, specId });
new fixtureModule.CanonicalFlowFixture({ flowManager: manager, specId, runId,
  execution: { mode: "direct", baseBranch: "main", featureBranch: null }, specRecord: {
    goal: "Retain a genuine source worker exit across explicit migration.",
    requirements: [{ id: "R1", desc: "Persist the actual stopped Source worker.", task_ids: ["T1"], testable: false }],
  },
}).create().addTask({ id: "T1", title: "Source receipt", goal: "Preserve the real Source producer.",
  origin: "plan", added_round: 0, status: "pending" }).registerActive().activate("implement");
const ctx = { root, mainRoot: root, executionRoot: root, specId, flowManager: manager,
  flowState: manager.loadReadOnly(specId), config: {} };
const invocation = { id: "previous-source-invocation", target: { digest: "a".repeat(64) },
  action: { digest: "b".repeat(64), nextAction: { step: "implement" } } };
const runtime = await runtimeModule.ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root, runId, specId });
const lease = new leaseModule.FlowHandoffAuthorityLease({ mainRoot: root, executionRoot: root });
const coordinator = new handoffModule.WorkerArtifactHandoffCoordinator();
let request, receipt;
try {
  await runtime.enter(async () => {
    lease.acquire();
    try {
      request = coordinator.createRequest({ ctx, state: ctx.flowState, invocation });
      coordinator.startSourceWorker({ ctx, request, invocation });
      const effect = { version: 1, stepId: "implement", completionStatus: "done", issues: [],
        overview: null, triage: null, repair: null, noChangeReason: null };
      const script = `require('node:fs').writeFileSync('product.js', ${JSON.stringify("export const value = 2;\n")});process.stdout.write(${JSON.stringify(JSON.stringify(effect))});`;
      const result = await managedModule.executeManagedProcess(process.execPath, ["-e", script], {
        cwd: root, timeoutMs: 40000, graceMs: 100, maxBuffer: 4096, kind: "provider",
        processExecutionBinding: admission.captureFlowProcessExecutionBinding(ctx, {
          executionContract: request.executionContract, dispatchInvocationId: request.dispatchInvocationId,
          requestDigest: request.requestDigest,
        }),
        onProcessExecutionStop(value) { receipt = value; },
      });
      assert.equal(result.code, 0);
      assert.equal(receipt.schemaVersion, 3);
      assert.equal(receipt.stopEvidence.confirmed, true);
      coordinator.finishSourceWorker({ ctx, request, processStopEvidence: new evidenceModule.FlowProcessStopEvidence(receipt) });
      handoffModule.materializeSourceWorkerEffect({ request, responseText: result.stdout });
      handoffModule.sealParentMaterializedSourceWorkerEffect({ request });
      if (mode === "settled") {
        const preparation = coordinator.prepareSourceStepHandoff({ ctx, request,
          mutationAuthority: coordinator.sourceMutationAuthority({ ctx, request }) });
        const prepared = composition.sourceStepRegistration("implement").create({ ctx, request,
          preparation, handoffCoordinator: coordinator });
        const selected = await prepared.step.execute();
        assert.equal(selected.kind, "implement-applied");
      }
    } finally { lease.release(); }
  });
} finally { await runtime.close(); }
const authority = manager.readSourceHandoffAuthority({ specId, identity: request.sourceHandoffIdentity });
if (mode === "settled") assert.equal(authority.settlement.kind, "accepted");
else {
  assert.equal(authority.settlement, null);
  assert.equal(authority.event.kind, "worker-exited");
  assert.equal(manager.canonicalState(specId).current.at(-1), "implement");
}
const stopped = authority.events.find(event => event.kind === "worker-exited");
assert.equal(stopped.processStopEvidence.toJSON().schemaVersion, 3);
assert.equal(stopped.processStopEvidence.receipt.callId, receipt.callId);
manager.artifactCatalog(specId).verify(manager.specLocation(specId));
const inventory = runtimeModule.ProcessExecutionRuntime.inspect({ mainRoot: root });
assert.equal(inventory.version, 9);
assert.equal(inventory.slot, null);
assert.ok(inventory.executions.every(execution => execution.status === "closed"));
new runtimeModule.ProcessRuntimeRecordMigrationStorage({ mainRoot: root }).assertQuiescent();
fs.writeFileSync(factsPath, JSON.stringify({ specId, runId, sourcePackageRevision: expectedRevision,
  producerMode: mode,
  sourceRuntimeRecordVersion: inventory.version, originalOwnerReleased: true, catalogVerified: true,
  sourceIdentity: request.sourceHandoffIdentity.toJSON(), originalReceiptDigest: values.executionValueDigest(receipt),
  sourceEventDigests: authority.events.map(event => event.digest), settlementDigest: authority.settlement?.digest ?? null,
  nextStep: manager.canonicalState(specId).nextAction()?.nodeId,
  locationRelativeDirectory: manager.specLocation(specId).relativeDirectory,
  sourceArtifacts: manager.artifactCatalog(specId).artifacts.filter(descriptor => descriptor.logicalKey?.startsWith("source.handoff."))
    .map(descriptor => ({ relativePath: descriptor.relativePath, hash: descriptor.hash, size: descriptor.size })),
}, null, 2));
