import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, mock, test } from "node:test";
import { ImplPhaseScenario } from "../../support/impl-phase-scenario.js";
import { SeedCleanupScope } from "../../support/builders/seed-work-root.js";
import { CanonicalPersistenceSnapshot } from "../../support/assertions/canonical-persistence.js";
import { CanonicalTestArtifactStore } from "../../../src/flow/lib/canonical-test-artifacts.js";
import { readAuthenticatedTestExecutionCompletion, readCurrentTestChainSettlement } from "../../../src/flow/lib/test-chain-transition-facts.js";

const scope = new SeedCleanupScope(after, mock);
let executionSeed;
async function scenario(t) {
  executionSeed ??= ImplPhaseScenario.seed(scope, {
    frontier: "test-result-review",
    requirements: [{ id: "R1", desc: "Review the explanatory wording manually.", task_ids: ["T1"], testable: false }],
  });
  const flow = ImplPhaseScenario.fromSeed(t, await executionSeed);
  assert.equal(new CanonicalTestArtifactStore({ flowManager: flow.manager,
    state: flow.manager.loadReadOnly(flow.specId) }).testSourceRevision().members.length, 0);
  return flow;
}

test("an empty source authenticates its actual completed execution receipt without changes", async t => {
  const flow = await scenario(t);
  const produced = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "test-execute", completed: true });
  assert.equal(produced.result.kind, "test-execute-observed");
  const before = new CanonicalPersistenceSnapshot(flow.manager, flow.specId);
  const replay = readCurrentTestChainSettlement({ flowManager: flow.manager, specId: flow.specId,
    stepId: "test-execute", completed: true });
  assert.equal(replay.receipt.id, produced.receipt.id);
  assert.deepEqual(replay.result.toJSON(), produced.result.toJSON());
  before.assertUnchanged(flow.manager, flow.specId, "completed empty-source receipt readback");
});

test("an empty source retains execution completion after optional diagnostics disappear and the actual Review consumes it", async t => {
  const flow = await scenario(t);
  const produced = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "test-execute", completed: true });
  const rawPath = path.join(flow.root, flow.manager.specLocation(flow.specId).relativeArtifact("test.execute.raw-log"));
  assert.equal(fs.existsSync(rawPath), true);
  fs.unlinkSync(rawPath);
  flow.reload();
  const before = new CanonicalPersistenceSnapshot(flow.manager, flow.specId);
  const completion = readAuthenticatedTestExecutionCompletion({ flowManager: flow.manager, specId: flow.specId });
  assert.equal(completion.receiptId, produced.receipt.id);
  assert.equal(completion.resultDigest, produced.receipt.resultDigest);
  before.assertUnchanged(flow.manager, flow.specId, "empty-source completion without optional diagnostic");
  await flow.executeCurrent();
  flow.reload();
  const reviewed = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "test-result-review", completed: true });
  assert.equal(reviewed.result.kind, "test-result-review-evidence-accepted");
  assert.equal(flow.current(), "impl-review");
  const after = new CanonicalPersistenceSnapshot(flow.manager, flow.specId);
  const replay = readCurrentTestChainSettlement({ flowManager: flow.manager, specId: flow.specId,
    stepId: "test-result-review", completed: true });
  assert.equal(replay.receipt.id, reviewed.receipt.id);
  assert.equal(fs.existsSync(rawPath), false);
  after.assertUnchanged(flow.manager, flow.specId, "completed Review receipt readback without optional diagnostic");
});
