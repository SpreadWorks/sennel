import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test, mock } from "node:test";

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


const roots = [];
let observation;
const observerEnabled = process.env.SENNEL_RETENTION_DISABLE_OBSERVER !== "1";
async function produceObservedSave(observe = observerEnabled) {
  const root = fixtureRepository("impl-publication-observer-retention-");
  roots.push(root);
  const specId = "906-publication-observer-control";
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  new CanonicalFlowFixture({ flowManager: manager, specId, runId: "run-publication-observer-control",
    request: "Preserve exact publication authentication after reload.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
  }).create().registerActive().activate("draft");
  const leaves = draftStructureManifest.entries[0].definition.leaves.filter((leaf) => leaf.stepId === "draft");
  const observer = observation ?? (observe ? new ImplPhasePublicationObserver({ mock, after() {} }, { leaves }) : null);
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

  observation = observer;
  return new WeakRef(manager._store);
}
try {
  // Complete the same real dispatcher once outside observation. Node18's
  // ESM import Promise retains its first AsyncLocalStorage runtime in the
  // module graph; that module initialization is not observer-owned state.
  const warmupReference = await produceObservedSave(false);
  const reference = await produceObservedSave();
  const latestReference = await produceObservedSave();
  for (let round = 0; round < 5; round++) {
    await new Promise(resolve => setImmediate(resolve));
    global.gc();
  }
  const retained = reference.deref() !== undefined;
  process.stdout.write(JSON.stringify({ actualTypedSaveProduced: true, actualTypedSaveCount: 3, warmupSaveCount: 1, measuredSaveCount: 2, observerEnabled, oldStoreRetained: retained }) + "\n");
  assert.equal(retained, false, "a typed publication audit must not retain its old producer Store and caches solely for an identity comparison");
} finally {
  observation?.restore();
  for (const root of roots) removeTmpDir(root);
}
