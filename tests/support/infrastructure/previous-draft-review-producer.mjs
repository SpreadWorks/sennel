import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, root, factsPath] = process.argv.slice(2);
const load = relative => import(pathToFileURL(path.join(packageRoot, relative)).href);
const [runtime, managerModule, fixture, git, units, canonicalModule, composition,
  admission, evidence, processes, values, targets, definition, protocol, claims, registry,
  histories, routes, runtimePackage, handoffs, dispatch] = await Promise.all([
  load("src/lib/process-execution-runtime.js"), load("src/lib/flow-manager.js"),
  load("tests/support/infrastructure/flow-setup.js"), load("tests/support/infrastructure/git-repo.js"),
  load("src/flow/lib/review-work-unit.js"), load("src/flow/lib/canonical-review-artifacts.js"),
  load("src/flow/engine/composition/draft.js"), load("src/flow/lib/process-runtime-admission.js"),
  load("src/flow/lib/process-runtime-evidence.js"), load("src/lib/process.js"),
  load("src/lib/process-execution-values.js"), load("src/flow/lib/review-target-authority.js"),
  load("src/flow/definition.js"), load("src/flow/lib/execution-protocol-snapshot.js"),
  load("src/flow/lib/draft-review-execution-claim.js"), load("src/flow/registry.js"),
  load("src/flow/lib/canonical-command-result.js"), load("src/flow/lib/draft-review-routes.js"),
  load("src/lib/runtime-package.js"),
  load("src/flow/lib/worker-artifact-handoff.js"), load("src/flow/lib/run-dispatch.js"),
]);
const expectedRevision = "7d58bd1b4cd78f8e80129b6b7ccf8d56329123a5245bab7d275ae90ac764e833";
assert.equal(runtimePackage.currentRuntimePackage().revision, expectedRevision);
fs.mkdirSync(root);
git.initGitRepo(root);
fs.writeFileSync(path.join(root, ".gitignore"), ".sennel/\n");
fs.writeFileSync(path.join(root, "README.md"), "Previous managed Draft Review producer.\n");
git.commitAll(root, "previous Draft Review baseline");
const specId = "previous-draft-review-producer", runId = "run-previous-draft-review-producer";
const phase = "draft-questions", stepId = "draft-questions-review", logicalKey = "draft.questions.review";
const manager = new managerModule.FlowManager({ root, mainRoot: root, inWorktree: false, specId });
new fixture.CanonicalFlowFixture({ flowManager: manager, specId, runId,
  request: "Preserve an original managed Draft Review and its exact publication through migration.",
  execution: { mode: "direct", baseBranch: "main", featureBranch: null },
}).create().registerActive().activate("draft");
const ctx = { root, executionRoot: root, mainRoot: root, specId, flowManager: manager,
  flowState: manager.load(specId), phase: "draft", config: {}, skipConfirm: true,
  _envelopeType: "run", _envelopeKey: "review" };
// The original fixture's generic confirmation does not create an authorized
// Draft source. Produce it through the original registered worker Step.
const coordinator = new handoffs.WorkerArtifactHandoffCoordinator();
const draftRequest = coordinator.createRequest({ ctx, state: manager.loadReadOnly(specId), invocation: {
  id: "previous-draft-source", target: { digest: "a".repeat(64) },
  action: { digest: "b".repeat(64), nextAction: { step: "draft" } },
} });
fs.writeFileSync(draftRequest.payloadPath("draft.json"), JSON.stringify(fixture.canonicalDraftDocument()));
handoffs.sealWorkerArtifactHandoff({ requestPath: draftRequest.requestPath,
  invocationId: draftRequest.dispatchInvocationId });
const draftResult = await new dispatch.default({ handoffCoordinator: coordinator }).runDraftWorkerStep(ctx, draftRequest,
  composition.draftWorkerStepRegistration("draft"), coordinator.prepareDraftWorker({ ctx, request: draftRequest }));
assert.equal(draftResult.stepResult.kind, "draft-created");
manager.beginNextAction(specId);
assert.equal(manager.canonicalState(specId).current.at(-1), stepId);
ctx.flowState = manager.loadReadOnly(specId);
let receipt;
await admission.withFlowProcessRuntime(ctx, async () => {
  const state = manager.canonicalState(specId);
  const authority = targets.ReviewTargetAuthority.fromContext(ctx);
  const target = { treeSha: authority.resolveTreeSha(), targetStateDigest: authority.captureTargetStateForPhase(phase).digest };
  const canonical = new canonicalModule.CanonicalReviewWorkUnit({ flowManager: manager, state,
    executionRoot: root, phase, ...target });
  canonical.materializeSpecRecord();
  canonical.materializeFileMap();
  const draftSource = canonical.materializeDraft();
  const workUnit = canonical.workUnit;
  workUnit.writeInput({ logicalKey: "review.execution-options", logicalPath: "execution-options.json",
    bytes: Buffer.from(JSON.stringify({ configDigest: values.executionValueDigest({}), skipConfirm: true })) });
  const manifest = workUnit.manifest();
  const binding = await composition.prepareDraftReviewBinding({ flowManager: manager, state, phase });
  const execution = manager.draftStepExecutionState({ binding });
  const executionBinding = execution.reviewBinding({ manifestDigest: manifest.digest,
    inputDigest: manifest.inputDigest, target: new definition.DraftReviewExecutionTargetIdentity(manifest.target.toJSON()) });
  const contract = protocol.ExecutionProtocolSnapshot.forReview({ manifest, skipConfirm: true }).bind({
    binding, generation: executionBinding.executionGeneration, inputRevision: manifest.inputDigest,
    inputBaselines: canonical.inputBaselines });
  const prepared = await composition.draftStepRegistration(stepId).create({ flowManager: manager, state, binding, executionBinding });
  const checkpointResult = await prepared.step.execute();
  const selection = manager.draftStepExecutionState({ binding }).executionIdentity();
  assert.equal(checkpointResult.kind, "draft-questions-review-execution-required");
  assert.equal(selection.stepResult.kind, checkpointResult.kind);
  claims.claimDraftReviewExecution({ flowManager: manager, binding, stepResult: selection.stepResult,
    settlement: selection.settlement, executionBinding, executionClaim: new definition.DraftReviewExecutionClaim(),
    executionContract: contract });
  workUnit.executionContract = contract;
  const surface = workUnit.finalize();
  const childScript = path.join(root, ".sennel", "previous-draft-review-child.mjs");
  const childUnits = pathToFileURL(path.join(packageRoot, "src/flow/lib/review-work-unit.js")).href;
  fs.writeFileSync(childScript, `import fs from 'node:fs';
import path from 'node:path';
import {ReviewWorkUnit} from ${JSON.stringify(childUnits)};
const unit=ReviewWorkUnit.fromEnvironment(process.env);
const source=JSON.parse(process.env.SENNEL_REVIEW_DRAFT_SOURCE);
fs.writeFileSync(path.join(unit.root,unit.manifestDocument.output.basename),JSON.stringify({
 version:2,phase:'draft-questions',sourceDraft:'draft.json',sourceDraftRevision:source.revision,
 generatedAt:'2026-10-13T00:00:00.000Z',verdict:'PASS',summary:'Original managed Draft Review passed.',
 blockingFindings:[],advisoryFindings:[],repairTargets:[]}));
unit.seal();
`);
  const completed = await processes.runManagedCmdAsync(process.execPath,
    ["--import", pathToFileURL(path.join(packageRoot, "src/sennel.js")).href, childScript], {
      cwd: root, timeout: 15000,
      processExecutionBinding: new values.ProcessExecutionBinding({
        ...admission.FlowProcessExecutionBinding.forContract(contract).toJSON(), workUnitId: surface.manifestPath }),
      env: { ...process.env, [units.REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath,
        SENNEL_REVIEW_DRAFT_SOURCE: JSON.stringify(draftSource) },
    });
  assert.equal(completed.ok, true, completed.stderr);
  receipt = completed.processExecutionStopReceipt;
  assert.equal(receipt.schemaVersion, 3);
  assert.equal(receipt.stopEvidence.confirmed, true);
  const promotion = new canonicalModule.CanonicalReviewPromotion({
    workUnit: units.ReviewWorkUnit.fromEnvironment({ [units.REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath }),
    phase, ...target, executionContract: contract,
    checkoutIdentity: runtime.captureProcessExecutionCheckoutIdentity({ mainRoot: root }),
    processStop: new evidence.FlowProcessStopEvidence(receipt),
  });
  const result = promotion.promote(promotion.resultFromSealedArtifact());
  await registry.FLOW_COMMANDS.run.review.post(ctx, result);
}, { commandId: "review" });
const current = manager.canonicalState(specId);
assert.equal(current.nextAction()?.nodeId, "draft-refine");
const location = manager.specLocation(specId), catalog = manager.artifactCatalog(specId);
catalog.verify(location);
const descriptor = catalog.artifacts.find(entry => entry.logicalKey === logicalKey);
const history = histories.CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey, bytes: descriptor.readBytes(location) });
const record = history.currentRecord;
assert.equal(record.nodeId, stepId);
assert.equal(record.payload.processStop.schemaVersion, 3);
assert.equal(record.payload.processStop.callId, receipt.callId);
const observation = new canonicalModule.CanonicalDraftReviewObservation({ payload: record.payload, state: current,
  route: routes.draftReviewRouteForRetryPhase(phase) });
const activities = manager.activityLedger(specId);
const publication = activities.find(entry => entry.id === descriptor.activityId);
const publicationDigest = observation.settlementPublication(record).digest;
assert.equal(publicationDigest, publication.result.draftSettlementReceipt.publicationDigest);
const terminal = activities.find(entry => entry.nodeId === stepId
  && entry.result?.draftSettlementReceipt?.executionLifecycle?.phase === "terminal");
assert.ok(terminal);
const inventory = runtime.ProcessExecutionRuntime.inspect({ mainRoot: root });
assert.equal(inventory.version, 9);
assert.equal(inventory.slot, null);
assert.ok(inventory.executions.every(execution => execution.status === "closed"));
new runtime.ProcessRuntimeRecordMigrationStorage({ mainRoot: root }).assertQuiescent();
fs.writeFileSync(factsPath, JSON.stringify({ specId, runId, phase, stepId, logicalKey,
  sourcePackageRevision: expectedRevision, sourceRuntimeRecordVersion: inventory.version,
  originalOwnerReleased: true, catalogVerified: true, currentStep: current.nextAction()?.nodeId,
  receipt: receipt.toJSON(), originalReceiptDigest: values.executionValueDigest(receipt),
  historyHash: descriptor.hash, historyRelativePath: descriptor.relativePath,
  publicationActivityId: publication.id, terminalActivityId: terminal.id, publicationDigest,
  locationRelativeDirectory: location.relativeDirectory,
}, null, 2));
