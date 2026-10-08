import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { ImplPhaseScenario } from "../../support/impl-phase-scenario.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { completeImplReviewPublication } from "../../../src/flow/engine/composition/impl.js";
import { attachedCanonicalReviewWorkUnit } from "../../../src/flow/lib/canonical-review-artifacts.js";
import { attachedCanonicalCommandResultArtifact, attachedCanonicalCommandResultPublications,
  attachCanonicalCommandResultArtifact, attachCanonicalCommandResultPublications,
  CanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import { CurrentFlowStateConflictError } from "../../../src/flow/lib/current-flow-state-conflict-error.js";

function replayInput(output, artifact, publications) {
  const originalArtifact = attachedCanonicalCommandResultArtifact(output);
  const originalPublications = attachedCanonicalCommandResultPublications(output);
  const input = Object.create(Object.getPrototypeOf(output));
  for (const key of Reflect.ownKeys(output)) {
    const descriptor = Object.getOwnPropertyDescriptor(output, key);
    if (typeof key === "symbol" && (descriptor.value === originalArtifact
      || Array.isArray(descriptor.value) && descriptor.value.length === originalPublications.length
        && descriptor.value.every((value, index) => value === originalPublications[index]))) continue;
    Object.defineProperty(input, key, descriptor);
  }
  attachCanonicalCommandResultArtifact(input, artifact);
  if (publications.length > 0) attachCanonicalCommandResultPublications(input, publications);
  return input;
}

test("Impl Review exact terminal post survives cleanup and fresh-manager replay without repeating effects", async (t) => {
  const scenario = ImplPhaseScenario.create(t);
  try { await scenario.advanceTo("impl-review"); }
  catch (cause) {
    const state = scenario.state();
    const activity = scenario.manager.activityLedger(scenario.specId).findLast((entry) => entry.nodeId === state.current?.at(-1)
      && entry.attemptId === state.attempt?.id && entry.result?.stepResult != null);
    throw new Error(`${cause.message}; actual producer stop=${JSON.stringify({ current: state.current,
      attempt: state.attempt?.toJSON(), result: activity?.result })}`, { cause });
  }
  const ctx = { ...scenario.context(), phase: "impl" };
  const output = await new RunReviewCommand().execute(ctx);
  assert.notEqual(output.ok, false, JSON.stringify(output));
  assert.equal(output.artifacts.phase, "impl");
  assert.equal(output.artifacts.taskId ?? null, null);
  const artifact = attachedCanonicalCommandResultArtifact(output);
  const publications = attachedCanonicalCommandResultPublications(output);
  const workUnit = attachedCanonicalReviewWorkUnit(output);
  await FLOW_COMMANDS.run.review.post(ctx, output);
  assert.equal(fs.existsSync(workUnit.root), false, "normal post cleans the sealed worker surface");
  const originalManager = scenario.manager;
  scenario.reload();
  assert.notEqual(scenario.manager, originalManager);
  const saved = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "impl-review", completed: true });
  const expected = saved.receipt.toJSON();
  const before = scenario.snapshot();
  const counts = { workers: scenario.requests.length, reviews: scenario.phaseReviews.length,
    metrics: before.activities.filter((activity) => activity.metric !== null).map((activity) => activity.metric) };
  const replayCtx = { ...scenario.context(), phase: "impl" };
  const replay = await completeImplReviewPublication({ flowManager: scenario.manager, specId: scenario.specId, commandResult: output });
  assert.equal(replay.completed, true);
  assert.equal(replay.receipt.id, expected.id);
  assert.deepEqual(replay.receipt.toJSON(), expected);
  await FLOW_COMMANDS.run.review.post(replayCtx, output);
  await FLOW_COMMANDS.run.review.post(replayCtx, output);
  assert.deepEqual(scenario.snapshot(), before, "exact repeated posts must retain the producer, receipt and frontier");

  const changed = replayInput(output, new CanonicalCommandResultArtifact({ logicalKey: artifact.logicalKey,
    payload: { ...artifact.payload, verdict: "REJECTED" } }), publications);
  await assert.rejects(() => completeImplReviewPublication({ flowManager: scenario.manager,
    specId: scenario.specId, commandResult: changed }), CurrentFlowStateConflictError);
  const omitted = replayInput(output, artifact, []);
  await assert.rejects(() => completeImplReviewPublication({ flowManager: scenario.manager,
    specId: scenario.specId, commandResult: omitted }), CurrentFlowStateConflictError);
  scenario.reload();
  assert.deepEqual(scenario.snapshot(), before, "altered replay inputs must refuse before canonical effects");
  assert.deepEqual({ workers: scenario.requests.length, reviews: scenario.phaseReviews.length,
    metrics: scenario.snapshot().activities.filter((activity) => activity.metric !== null).map((activity) => activity.metric) }, counts);
  assert.equal(fs.existsSync(workUnit.root), false, "replay must not rematerialize a provider work unit");
});
