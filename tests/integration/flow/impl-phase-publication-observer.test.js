import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { StepResult } from "../../../src/flow/engine/step-result.js";
import { DraftStepSettlementReceipt, settleDraftStepResult } from "../../../src/flow/definition.js";
import { FlowActivity, CurrentFlowState } from "../../../src/flow/lib/current-flow-state.js";
import { sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { dispatchContainer, fixtureRepository, requestPayloadPath, withScenarioProviderAdmission } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { draftStructureManifest } from "../../support/structure/phase-manifest.js";
import { ImplPhasePublicationObserver, PublicationAuthentication } from "../../support/infrastructure/impl-phase-publication-observer.js";
import { SENNEL_BOOTSTRAP } from "../../support/infrastructure/node-bootstrap.js";

test("publication observer releases unrelated prior call inputs and preserves original call behavior", () => {
  const child = `
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import { FlowManager } from ${JSON.stringify(new URL("../../../src/lib/flow-manager.js", import.meta.url).href)};
    import { ImplPhasePublicationObserver } from ${JSON.stringify(new URL("../../support/infrastructure/impl-phase-publication-observer.js", import.meta.url).href)};
    const original = FlowManager.prototype.savePromptExecutionProgress;
    const observer = new ImplPhasePublicationObserver({ mock, after() {} });
    const receiver = Object.create(FlowManager.prototype);
    receiver._store = { savePromptExecutionProgress(input) { return input.ordinal; } };
    const references = [];
    function invoke() {
      for (let ordinal = 0; ordinal < 160; ordinal++) {
        const input = { ordinal, payload: Array(16384).fill(ordinal) };
        references.push(new WeakRef(input));
        assert.equal(receiver.savePromptExecutionProgress(input), ordinal);
      }
    }
    try {
      invoke();
      for (let round = 0; round < 3; round++) {
        await new Promise(resolve => setImmediate(resolve));
        global.gc();
      }
      const retained = references.filter(reference => reference.deref() !== undefined).length;
      assert.ok(retained <= 1, "publication observation must release unrelated previous inputs");
      const pending = Promise.resolve({ receipt: "original" });
      receiver._store.savePromptExecutionProgress = function () {
        assert.equal(this, receiver._store);
        return pending;
      };
      assert.equal(receiver.savePromptExecutionProgress({}), pending);
      const failure = new Error("original publication failure");
      receiver._store.savePromptExecutionProgress = () => { throw failure; };
      assert.throws(() => receiver.savePromptExecutionProgress({}), error => error === failure);
      console.log(JSON.stringify({ retained, checkedInputs: references.length }));
    } finally {
      observer.restore();
      assert.equal(FlowManager.prototype.savePromptExecutionProgress, original);
    }
  `;
  const observed = spawnSync(process.execPath, ["--expose-gc", "--import", SENNEL_BOOTSTRAP,
    "--input-type=module", "--eval", child], { encoding: "utf8" });
  assert.equal(observed.status, 0, observed.stderr);
  const result = JSON.parse(observed.stdout);
  assert.equal(result.checkedInputs, 160);
  assert.ok(result.retained <= 1);
});

test("publication observer authenticates a real Draft dispatcher save and exact one-Activity replay, then rejects a self-signed foreign publication digest", async (t) => {
  const root = fixtureRepository("impl-publication-observer-control-");
  t.after(() => removeTmpDir(root));
  const specId = "906-publication-observer-control";
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  new CanonicalFlowFixture({ flowManager: manager, specId, runId: "run-publication-observer-control",
    request: "Preserve exact publication authentication after reload.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
  }).create().registerActive().activate("draft");
  const leaves = draftStructureManifest.entries[0].definition.leaves.filter((leaf) => leaf.stepId === "draft");
  const observer = new ImplPhasePublicationObserver(t, { leaves });
  let workerCalls = 0;
  const agent = { async call(_prompt, options) {
    workerCalls += 1;
    const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
    const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    assert.equal(request.stepId, "draft");
    fs.writeFileSync(requestPayloadPath(request, "draft.json"), workerArtifactJson(canonicalDraftDocument({
      goal: "Preserve the exact publication and Result across canonical readback.",
    })));
    sealWorkerArtifactHandoff({ requestPath,
      invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
      mainRoot: root, flowManager: manager });
    return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
  } };
  withScenarioProviderAdmission(agent);
  const command = new RunDispatchCommand({ agent, maxDispatches: 1 });
  command.container = dispatchContainer({ root, flowManager: manager, agent });
  const outcome = await command.execute({ root, mainRoot: root, executionRoot: root, specId,
    flowManager: manager, flowState: manager.loadReadOnly(specId),
    expectBinding: FlowTargetBinding.capture({ flowState: manager.loadReadOnly(specId),
      mainRoot: root, authorityRoot: root }).serialize(), _envelopeType: "run", _envelopeKey: "dispatch" });
  assert.equal(workerCalls, 1);
  assert.ok((outcome.errors ?? []).every((error) => error.code === "FLOW_DISPATCH_LIMIT_REACHED"), JSON.stringify(outcome));
  const fresh = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const activity = fresh.activityLedger(specId).find((entry) => entry.nodeId === "draft"
    && entry.result?.stepResult?.kind === "draft-created"
    && entry.result.draftSettlementReceipt?.settlementKind === "target-connection");
  assert.ok(activity, "normal Draft dispatcher must save its completed Result and receipt");
  const result = StepResult.fromStored("draft", activity.result.stepResult);
  const settlement = settleDraftStepResult("draft", result);
  const beforeAudit = fresh.canonicalState(specId).toJSON();
  const verified = observer.authenticate(fresh, activity, result, settlement);
  assert.ok(verified instanceof PublicationAuthentication);
  assert.ok(verified.activity instanceof FlowActivity);
  assert.ok(verified.afterState instanceof CurrentFlowState);
  assert.equal(verified.receipt.id, activity.result.draftSettlementReceipt.id);
  assert.equal(verified.receipt.publicationDigest, activity.result.draftSettlementReceipt.publicationDigest);
  assert.equal(verified.afterState.confirmationOrder, activity.confirmationOrder);
  assert.deepEqual(verified.afterState.findNode("draft").result.toJSON(), verified.activity.result.toJSON());
  assert.equal(verified.afterState.nextAction().nodeId, "draft-questions-review");
  assert.deepEqual(fresh.canonicalState(specId).toJSON(), beforeAudit, "authentication/pure replay does not mutate the fresh Store");
  assert.throws(() => observer.authenticate(manager, activity, result, settlement), /PUBLICATION_RELOAD_REQUIRED/);

  const forged = structuredClone(activity);
  const receipt = forged.result.draftSettlementReceipt;
  receipt.publicationDigest = "0".repeat(64);
  receipt.id = createHash("sha256").update(JSON.stringify(DraftStepSettlementReceipt.identity(receipt))).digest("hex");
  DraftStepSettlementReceipt.assertStored(receipt, { result, settlement });
  assert.throws(() => observer.authenticate(fresh, forged, result, settlement), /PUBLICATION_AUTHENTICATION_FAILED/,
    "a valid self-signature cannot authenticate a publication the original save did not select");
  assert.deepEqual(fresh.canonicalState(specId).toJSON(), beforeAudit);
  assert.equal(fresh.activityLedger(specId).find((entry) => entry.id === activity.id)
    .result.draftSettlementReceipt.id, activity.result.draftSettlementReceipt.id);
});
