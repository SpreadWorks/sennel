import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  buildDeferredSemanticFindingsPublication,
  CanonicalFlowFindingsStore,
  deferExhaustedSemanticFindings,
} from "../../../src/flow/lib/flow-findings.js";
import RunReopenDraftCommand from "../../../src/flow/lib/run-reopen-draft.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

let tmp = null;

afterEach(() => {
  if (tmp !== null) removeTmpDir(tmp);
  tmp = null;
});

function attemptHistory(logicalKey, payload) {
  return Buffer.from(`${JSON.stringify({
    attempts: [{ attempt: 1, artifact: { logicalKey, payload } }],
  }, null, 2)}\n`, "utf8");
}

function semanticFinding(id) {
  return {
    findingId: id,
    fingerprint: "a".repeat(64),
    disposition: "must-fix",
    rationale: "The behavior remains semantically incomplete.",
  };
}

test("semantic retry deferral publishes flow.findings through the active Version catalog", () => {
  tmp = createTmpDir("flow-findings-catalog-");
  const flowManager = makeFlowManager(tmp);
  const flow = new CanonicalFlowFixture({ flowManager, specId: "001-findings" })
    .create()
    .registerActive()
    .activate("test-review");
  const state = flow.state();
  flowManager.publishArtifacts({
    specId: state.specId,
    nodeId: "test-review",
    artifactWrites: [{
      logicalKey: "test.review",
      mediaType: "application/json",
      bytes: attemptHistory("test.review", {
        verdict: "REJECTED",
        blockingFindings: [semanticFinding("semantic-1")],
      }),
    }],
  });

  const outcome = deferExhaustedSemanticFindings({
    flowManager,
    flowState: state,
    nodeId: "test-review",
    sourceStep: "test-review",
    sourceArtifact: "test.review",
    attempts: 5,
  });

  assert.equal(outcome.deferred.length, 1);
  const findings = new CanonicalFlowFindingsStore({ flowManager, flowState: state, nodeId: "test-review" }).read();
  assert.equal(findings.entries[0].sourceArtifact, "steps/test-review/result.json");
  assert.equal(findings.entries[0].sourceFindingId, "semantic-1");
  assert.equal(findings.entries[0].completionKind, "deferred");
  const location = flowManager.specLocation(state.specId);
  assert.equal(fs.existsSync(path.join(location.directory, "flow-findings.json")), false);
});

test("deferred findings publication binds its snapshot and rejects a stale catalog write", () => {
  tmp = createTmpDir("flow-findings-baseline-");
  const flowManager = makeFlowManager(tmp);
  const flow = new CanonicalFlowFixture({ flowManager, specId: "001-findings-baseline" })
    .create()
    .registerActive()
    .activate("test-review");
  const state = flow.state();
  flowManager.publishArtifacts({
    specId: state.specId,
    nodeId: "test-review",
    artifactWrites: [{
      logicalKey: "test.review",
      mediaType: "application/json",
      bytes: attemptHistory("test.review", {
        verdict: "REJECTED",
        blockingFindings: [semanticFinding("semantic-baseline")],
      }),
    }],
  });
  const build = () => buildDeferredSemanticFindingsPublication({
    flowManager,
    flowState: flow.state(),
    nodeId: "test-review",
    sourceStep: "test-review",
    sourceArtifact: "test.review",
    attempts: 5,
  });
  const absent = build();
  assert.equal(absent.baseline.digest, null);
  assert.equal(absent.baseline.byteLength, 0);

  const emptyFindings = Buffer.from('{"version":2,"entries":[]}\n', "utf8");
  flowManager.publishArtifacts({
    specId: state.specId,
    nodeId: "test-review",
    artifactWrites: [{ logicalKey: "flow.findings", mediaType: "application/json", bytes: emptyFindings }],
  });
  const publication = build();
  const captured = flowManager.readArtifact({
    specId: state.specId,
    logicalKey: "flow.findings",
    consumerNodeId: "test-review",
  });
  assert.equal(publication.baseline.digest, captured.descriptor.hash);
  assert.equal(publication.baseline.byteLength, captured.descriptor.size);

  flowManager.publishArtifacts({
    specId: state.specId,
    nodeId: "test-review",
    artifactWrites: [{
      logicalKey: "flow.findings",
      mediaType: "application/json",
      bytes: Buffer.from('{\n  "version": 2,\n  "entries": []\n}\n', "utf8"),
    }],
  });
  const location = flowManager.specLocation(state.specId);
  const snapshotFiles = () => fs.readdirSync(location.directory, { recursive: true })
    .filter((relative) => fs.statSync(path.join(location.directory, relative)).isFile())
    .sort()
    .map((relative) => [relative, fs.readFileSync(path.join(location.directory, relative)).toString("base64")]);
  const before = {
    state: flowManager.canonicalState(state.specId).toJSON(),
    activities: flowManager.activityLedger(state.specId),
    catalog: flowManager.artifactCatalog(state.specId).toJSON(),
    files: snapshotFiles(),
  };
  assert.throws(() => flowManager.confirmCurrentAttempt({
    specId: state.specId,
    artifactWrites: [publication.artifactWrite()],
    artifactBaselines: [publication.baseline],
  }), /canonical artifact changed after baseline capture/);
  assert.deepEqual({
    state: flowManager.canonicalState(state.specId).toJSON(),
    activities: flowManager.activityLedger(state.specId),
    catalog: flowManager.artifactCatalog(state.specId).toJSON(),
    files: snapshotFiles(),
  }, before);
});

test("actual draft reopen starts a ledger-derived flow-finding cycle for both publication and reads", async () => {
  tmp = createTmpDir("flow-findings-reopen-cycle-");
  const flowManager = makeFlowManager(tmp);
  const flow = new CanonicalFlowFixture({ flowManager, specId: "001-findings-reopen" })
    .create()
    .registerActive()
    .activate("test-review");
  const publishReview = () => {
    const state = flow.state();
    flowManager.publishArtifacts({
      specId: state.specId,
      nodeId: "test-review",
      artifactWrites: [{
        logicalKey: "test.review",
        mediaType: "application/json",
        bytes: attemptHistory("test.review", {
          verdict: "REJECTED",
          blockingFindings: [semanticFinding("semantic-reopen")],
        }),
      }],
    });
    return flow.state();
  };
  const defer = (state) => deferExhaustedSemanticFindings({
    flowManager,
    flowState: state,
    nodeId: "test-review",
    sourceStep: "test-review",
    sourceArtifact: "test.review",
    attempts: 5,
  });

  const beforeReopen = defer(publishReview());
  assert.equal(beforeReopen.deferred.length, 1);
  const reopen = await new RunReopenDraftCommand().execute({
    root: tmp,
    flowManager,
    flowState: flow.state(),
  });
  assert.equal(reopen.ok, true, JSON.stringify(reopen));
  const reopenedState = flow.state();
  const reopenActivity = flowManager.activityLedger(reopenedState.specId).findLast((activity) => (
    activity.transition.operation === "reopen_draft_preimplementation"
  ));
  assert.ok(reopenActivity);

  const afterReopenStore = new CanonicalFlowFindingsStore({
    flowManager,
    flowState: reopenedState,
    nodeId: "test-review",
  });
  assert.equal(afterReopenStore.cycle.planRewindAt, reopenActivity.timing.finishedAt);
  assert.deepEqual(afterReopenStore.read({ filterCurrentRun: true }).entries, []);

  flow.activate("test-review");
  const afterReopen = defer(publishReview());
  assert.equal(afterReopen.deferred.length, 1);
  const currentState = flow.state();
  const store = new CanonicalFlowFindingsStore({
    flowManager,
    flowState: currentState,
    nodeId: "test-review",
  });
  const all = store.read();
  const current = store.read({ filterCurrentRun: true });
  assert.equal(all.entries.length, 2);
  assert.equal(all.entries[0].planRewindAt, null);
  assert.equal(all.entries[1].planRewindAt, reopenActivity.timing.finishedAt);
  assert.deepEqual(current.entries.map((entry) => entry.findingId), [all.entries[1].findingId]);
  assert.equal(current.entries[0].planRewindAt, store.cycle.planRewindAt);
});
