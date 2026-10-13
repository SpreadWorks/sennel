import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { ReviewWorkUnit, REVIEW_WORK_UNIT_MANIFEST_ENV } from "../../../src/flow/lib/review-work-unit.js";
import { CanonicalReviewWorkUnit } from "../../../src/flow/lib/canonical-review-artifacts.js";
import { ReviewWorkUnitManifest } from "../../../src/flow/lib/review-work-unit-values.js";
import { ExecutionProtocolSnapshot } from "../../../src/flow/lib/execution-protocol-snapshot.js";
import { claimSpecReviewExecution } from "../../../src/flow/engine/composition/spec.js";
import { FlowExecutionContractRefusal } from "../../../src/flow/lib/flow-execution-contract.js";

function fixture(t) {
  const root = createTmpDir("review-execution-contract-");
  t.after(() => removeTmpDir(root));
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: "review-proof" });
  new CanonicalFlowFixture({ flowManager: manager, specId: "review-proof", runId: "review-proof-run" })
    .create().registerActive().activate("spec-review");
  const state = manager.canonicalState("review-proof");
  const canonical = new CanonicalReviewWorkUnit({ flowManager: manager, state, executionRoot: root,
    phase: "spec", treeSha: "a".repeat(40), targetStateDigest: "b".repeat(64) });
  canonical.materializeSpecRecord();
  canonical.materializeSpecReview();
  const workUnit = canonical.workUnit;
  workUnit.writeInput({ logicalKey: "review.execution-options", logicalPath: "execution-options.json",
    bytes: Buffer.from('{"skipConfirm":true}') });
  return { root, manager, state, workUnit };
}

test("registered Review claim persists its exact logical prompt contract and rejects changed request on resume", async (t) => {
  const value = fixture(t);
  const input = { flowManager: value.manager, state: value.state, manifest: value.workUnit.manifest(), skipConfirm: true };
  const admitted = await claimSpecReviewExecution(input);
  assert.equal(admitted.recoveredClaim, false);
  assert.equal(value.manager.readExecutionContract({ executionContract: admitted.executionContract }).id, admitted.executionContract.id);
  const before = value.manager.activityLedger(value.state.specId).length;
  const reentered = await claimSpecReviewExecution(input);
  assert.equal(reentered.recoveredClaim, true);
  assert.equal(reentered.executionContract.id, admitted.executionContract.id);
  await assert.rejects(claimSpecReviewExecution({ ...input, skipConfirm: false }), /differs/);
  assert.equal(value.manager.activityLedger(value.state.specId).length, before);
});

test("transient Review proof binds the unchanged semantic manifest codec and detects proof or input substitution", (t) => {
  const value = fixture(t);
  const manifest = value.workUnit.manifest();
  const binding = { runId: value.state.runId, specId: value.state.specId, stepId: "spec-review", attempt: value.state.attempt };
  const contract = ExecutionProtocolSnapshot.forReview({ manifest, skipConfirm: true })
    .bind({ binding, generation: 0, inputRevision: manifest.inputDigest });
  value.workUnit.executionContract = contract;
  const finalized = value.workUnit.finalize();
  assert.deepEqual(new ReviewWorkUnitManifest(JSON.parse(fs.readFileSync(finalized.manifestPath))).toJSON(), manifest.toJSON());
  assert.equal(Object.hasOwn(manifest.toJSON(), "executionContract"), false);
  const reader = ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: finalized.manifestPath });
  assert.equal(reader.readExecutionContract().id, contract.id);
  const proofPath = path.join(finalized.directory, "execution.json");
  const proof = JSON.parse(fs.readFileSync(proofPath));
  fs.writeFileSync(proofPath, JSON.stringify({ ...proof, manifestDigest: "f".repeat(64) }));
  assert.throws(() => reader.readExecutionContract(), FlowExecutionContractRefusal);
  fs.writeFileSync(proofPath, JSON.stringify({ ...proof, contractId: "f".repeat(64) }));
  assert.throws(() => reader.readExecutionContract(), FlowExecutionContractRefusal);
  fs.unlinkSync(proofPath);
  assert.throws(() => reader.readExecutionContract(), /unavailable/);
  // Completed semantic evidence remains decodable independently of transient proof.
  assert.deepEqual(new ReviewWorkUnitManifest(manifest.toJSON()).toJSON(), manifest.toJSON());
});
