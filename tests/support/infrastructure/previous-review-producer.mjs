import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, root, factsPath] = process.argv.slice(2);
const load = relative => import(pathToFileURL(path.join(packageRoot, relative)).href);
const [runtimeModule, managerModule, fixtureModule, gitFixture, workUnitModule, canonicalModule,
  specModule, operationsModule, composition, admission, evidence, processModule, values, targetModule, runtimePackage] = await Promise.all([
  load("src/lib/process-execution-runtime.js"), load("src/lib/flow-manager.js"),
  load("tests/support/infrastructure/flow-setup.js"), load("tests/support/infrastructure/git-repo.js"),
  load("src/flow/lib/review-work-unit.js"), load("src/flow/lib/canonical-review-artifacts.js"),
  load("src/flow/lib/spec-review-artifacts.js"), load("src/flow/lib/spec-review-operations.js"),
  load("src/flow/engine/composition/spec.js"), load("src/flow/lib/process-runtime-admission.js"),
  load("src/flow/lib/process-runtime-evidence.js"), load("src/lib/process.js"),
  load("src/lib/process-execution-values.js"), load("src/flow/lib/review-target-authority.js"),
  load("src/lib/runtime-package.js"),
]);
const expectedRevision = "7d58bd1b4cd78f8e80129b6b7ccf8d56329123a5245bab7d275ae90ac764e833";
assert.equal(runtimePackage.currentRuntimePackage().revision, expectedRevision);
fs.mkdirSync(root);
gitFixture.initGitRepo(root);
fs.writeFileSync(path.join(root, ".gitignore"), ".sennel/\n");
fs.writeFileSync(path.join(root, "README.md"), "Previous canonical Review producer.\n");
gitFixture.commitAll(root, "previous Review baseline");
const specId = "previous-review-producer";
const runId = "run-previous-review-producer";
const manager = new managerModule.FlowManager({ root, mainRoot: root, inWorktree: false, specId });
new fixtureModule.CanonicalFlowFixture({ flowManager: manager, specId, runId,
  request: "Preserve a genuine closed Review producer through explicit evidence migration.",
  execution: { mode: "direct", baseBranch: "main", featureBranch: null },
}).create().registerActive().activate("spec-review");
const context = { root, executionRoot: root, mainRoot: root, specId, flowManager: manager,
  flowState: manager.load(specId), config: {}, skipConfirm: true, phase: "spec",
  _envelopeType: "run", _envelopeKey: "review" };
let contract, receipt, result;
await admission.withFlowProcessRuntime(context, async () => {
  const state = manager.canonicalState(specId);
  const authority = targetModule.ReviewTargetAuthority.fromContext(context);
  const target = { treeSha: authority.resolveTreeSha(), targetStateDigest: authority.captureTargetStateForPhase("spec").digest };
  const canonical = new canonicalModule.CanonicalReviewWorkUnit({ flowManager: manager, state,
    executionRoot: root, phase: "spec", ...target });
  canonical.materializeSpecRecord();
  canonical.materializeSpecReview();
  const workUnit = canonical.workUnit;
  workUnit.writeInput({ logicalKey: "review.execution-options", logicalPath: "execution-options.json",
    bytes: Buffer.from(JSON.stringify({ configDigest: values.executionValueDigest({}), skipConfirm: true })) });
  const claim = await composition.claimSpecReviewExecution({ flowManager: manager, state,
    manifest: workUnit.manifest(), skipConfirm: true });
  contract = claim.executionContract;
  workUnit.executionContract = contract;
  const surface = workUnit.finalize();
  const childScript = path.join(root, ".sennel", "previous-review-child.mjs");
  const imports = Object.fromEntries(["review-work-unit.js", "spec-review-artifacts.js"].map(name =>
    [name, pathToFileURL(path.join(packageRoot, "src/flow/lib", name)).href]));
  fs.writeFileSync(childScript, `import fs from 'node:fs';
import path from 'node:path';
import {ReviewWorkUnit,assertReviewWorkUnitInputSnapshot} from ${JSON.stringify(imports["review-work-unit.js"])};
import {CanonicalSpecReview,SpecReviewDelta} from ${JSON.stringify(imports["spec-review-artifacts.js"])};
const unit=ReviewWorkUnit.fromEnvironment(process.env);
const input=unit.manifestDocument.inputs.find(entry=>entry.logicalKey==='spec.review');
const before=new CanonicalSpecReview(JSON.parse(assertReviewWorkUnitInputSnapshot(input,unit.root).bytes));
const delta=new SpecReviewDelta({version:2,stage:'spec-review',identity:before.identity.toJSON(),baseReviewDigest:before.digest,findings:[],operations:[]});
fs.writeFileSync(path.join(unit.root,unit.manifestDocument.output.basename),JSON.stringify(delta.toJSON()));
unit.seal();
`);
  const binding = new values.ProcessExecutionBinding({
    ...admission.FlowProcessExecutionBinding.forContract(contract).toJSON(), workUnitId: surface.manifestPath });
  const completed = await processModule.runManagedCmdAsync(process.execPath,
    ["--import", pathToFileURL(path.join(packageRoot, "src/sennel.js")).href, childScript],
    { cwd: root, timeout: 15000, processExecutionBinding: binding,
      env: { ...process.env, [workUnitModule.REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath } });
  assert.equal(completed.ok, true, completed.stderr);
  receipt = completed.processExecutionStopReceipt;
  assert.equal(receipt.schemaVersion, 3);
  assert.equal(receipt.stopEvidence.confirmed, true);
  const promotion = new canonicalModule.CanonicalReviewPromotion({
    workUnit: workUnitModule.ReviewWorkUnit.fromEnvironment({
      [workUnitModule.REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath }),
    phase: "spec", ...target, executionContract: contract,
    checkoutIdentity: runtimeModule.captureProcessExecutionCheckoutIdentity({ mainRoot: root }),
    processStop: new evidence.FlowProcessStopEvidence(receipt), specReviewSource: canonical.specReviewSource,
  });
  const commandResult = promotion.promote(promotion.resultFromSealedArtifact());
  operationsModule.SpecReviewOperations.publish({ flowManager: manager, specId, commandResult });
  result = await composition.completeSpecReviewPublication({ flowManager: manager,
    state: manager.canonicalState(specId), executionRoot: root });
  assert.equal(result.artifacts.verdict, "PASS");
}, { commandId: "review" });
const current = manager.canonicalState(specId);
assert.equal(current.nextAction()?.nodeId, "spec-triage");
const read = manager.readCurrentSpecReview({ specId, consumerNodeId: "spec-triage" });
assert.equal(read.descriptor.hash, read.review.digest);
assert.equal(read.review.processStop.schemaVersion, 3);
assert.equal(read.review.processStop.callId, receipt.callId);
const replay = await operationsModule.SpecReviewOperations.terminalReplay({ flowManager: manager, state: current, executionRoot: root });
assert.equal(replay.artifacts.verdict, "PASS");
assert.equal(replay.artifacts.reviewDigest, read.review.digest);
manager.artifactCatalog(specId).verify(manager.specLocation(specId));
const inventory = runtimeModule.ProcessExecutionRuntime.inspect({ mainRoot: root });
assert.equal(inventory.version, 9);
assert.equal(inventory.slot, null);
assert.ok(inventory.executions.every(execution => execution.status === "closed"));
new runtimeModule.ProcessRuntimeRecordMigrationStorage({ mainRoot: root }).assertQuiescent();
const manifests = manager.artifactCatalog(specId).artifacts.filter(entry => entry.logicalKey === "execution.source.manifest");
assert.ok(manifests.length > 0);
const sourceManifests = manifests.map(descriptor => JSON.parse(descriptor.readBytes(manager.specLocation(specId))));
assert.ok(sourceManifests.every(document => document.schemaRevision === 1));
const activities = manager.activityLedger(specId);
assert.ok(activities.some(activity => activity.reviewPublication?.stage === "spec-review"));
assert.ok(activities.some(activity => activity.result?.draftSettlementReceipt?.executionLifecycle?.phase === "terminal"));
fs.writeFileSync(factsPath, JSON.stringify({ specId, runId, sourcePackageRevision: expectedRevision,
  genuinePreviousProductSource: true, sourceRuntimeRecordVersion: inventory.version,
  originalOwnerReleased: true, sourceManifestRevisions: sourceManifests.map(value => value.schemaRevision),
  currentStep: current.nextAction()?.nodeId, oldTerminalReplayVerdict: replay.artifacts.verdict,
  catalogVerified: true, reviewDigest: read.review.digest, receipt: receipt.toJSON(),
  contract: contract.toJSON(), originalReceiptDigest: values.executionValueDigest(receipt),
  flowHash: values.executionValueDigest(current.toJSON()), activityCount: activities.length,
  locationRelativeDirectory: manager.specLocation(specId).relativeDirectory,
}, null, 2));
