import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { AtomicJsonFile } from "../../../src/lib/atomic-json-file.js";
import { CurrentAttemptIdentity, CurrentFlowState, FlowActivity, NodeResult } from "../../../src/flow/lib/current-flow-state.js";
import { buildCurrentFlowDefinition, settleImplStepResult, settleTaskStepResult } from "../../../src/flow/definition.js";
import { StepResult } from "../../../src/flow/engine/step-result.js";
import { SourceWorkerEffect, SourceStepFacts, SourceStepSelection, ImplementationTaskFrontier } from "../../../src/flow/lib/source-effect-values.js";
import { SourceMutationBaseline, SourceMutationManifest, SourceHandoffSettlement } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { TaskReviewEpisodeBinding } from "../../../src/flow/lib/task-review-stage-binding.js";
import { TaskReviewStageFacts } from "../../../src/flow/lib/task-review-stage-transition.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => value?.toJSON?.() ?? value;
function exact(value, fields) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), "source publication capture schema changed");
}

/** Original private candidate identity for READ authentication only; has no admission or save operation. */
class CapturedSourcePublicationIdentity {
  #document;
  constructor(value, bytes) {
    exact(value, ["facts", "artifactWrites", "taskFrontier", "filter", "sourceStageBinding"]);
    this.facts = new TaskReviewStageFacts(value.facts);
    this.frontier = ImplementationTaskFrontier.fromJSON(value.taskFrontier);
    assert.equal(value.filter, null);
    this.binding = new TaskReviewEpisodeBinding(value.sourceStageBinding);
    assert.equal(value.artifactWrites.length, bytes.length);
    for (const [index, write] of value.artifactWrites.entries()) {
      const content = Buffer.from(bytes[index], "base64");
      assert.equal(content.length, write.byteLength);
      assert.equal(hash(content), write.digest, "captured original candidate bytes changed");
    }
    this.#document = JSON.stringify(value);
    Object.freeze(this);
  }
  toJSON() { return JSON.parse(this.#document); }
}

/** Pure original binding identity; deliberately cannot validate or start an Attempt. */
class CapturedSourceBinding {
  constructor(value) {
    exact(value, ["runId", "specId", "stepId", "nodeId", "attempt"]);
    for (const field of ["runId", "specId", "stepId", "nodeId"]) {
      assert.ok(typeof value[field] === "string" && value[field] !== "");
      this[field] = value[field];
    }
    this.attempt = CurrentAttemptIdentity.from(value.attempt);
    assert.equal(this.attempt.nodeId, this.nodeId);
    Object.freeze(this);
  }
}

/** Durable original child input, captured before the real public save is called. */
export class SourcePublicationCaptureFile {
  constructor({ filePath, nonce }) {
    assert.ok(typeof nonce === "string" && nonce !== "");
    this.filePath = path.resolve(filePath);
    this.nonce = nonce;
    this.file = new AtomicJsonFile(this.filePath);
    Object.freeze(this);
  }
  write({ operation, input, beforeState, priorActivities }) {
    assert.equal(operation, "FlowManager.commitSpecStepResult");
    assert.ok(input.effect instanceof SourceWorkerEffect && input.stepResult instanceof StepResult);
    assert.equal(input.stepResult.stepId, "task-repair", "child capture is bounded to original Source Task repair");
    assert.equal(input.planGateRepairOutcome, null);
    assert.equal(input.upgradeResult, undefined);
    assert.equal(input.commandResult, undefined);
    const executionRoot = input.sourceMutationBaseline.snapshot.root;
    const relative = path.relative(executionRoot, this.filePath);
    assert.ok(relative.startsWith(".." + path.sep) || path.isAbsolute(relative),
      "publication capture must be outside execution, canonical and handoff authority");
    const document = { version: 1, nonce: this.nonce, processId: process.pid, executionRoot, operation,
      beforeState: beforeState.toJSON(), priorActivities: priorActivities.map((entry) => entry.toJSON()),
      input: { binding: { runId: input.binding.runId, specId: input.binding.specId,
        stepId: input.binding.stepId, nodeId: input.binding.nodeId,
        attempt: input.binding.attempt.toJSON() },
      stepResult: input.stepResult.toJSON(), settlement: input.settlement.toJSON(),
      effect: input.effect.toJSON(), mutationManifest: input.mutationManifest.toJSON(),
      sourceMutationBaseline: input.sourceMutationBaseline.toJSON(), handoffDigest: input.handoffDigest,
      sourceHandoffSettlement: input.sourceHandoffSettlement.toJSON(), taskStageBinding: json(input.taskStageBinding),
      result: json(input.result), sourceTaskReviewStage: input.sourceTaskReviewStage.toJSON(),
      candidateBytes: input.sourceTaskReviewStage.artifactWrites.map((write) => write.bytes.toString("base64")) } };
    this.file.write({ ...document, digest: hash(JSON.stringify(document)) });
  }
  read({ processId, executionRoot }) {
    const stored = this.file.read(null);
    exact(stored, ["version", "nonce", "processId", "executionRoot", "operation", "beforeState", "priorActivities", "input", "digest"]);
    const { digest, ...document } = stored;
    assert.equal(digest, hash(JSON.stringify(document)), "original child publication capture digest changed");
    assert.equal(document.version, 1);
    assert.equal(document.nonce, this.nonce);
    assert.equal(document.processId, processId);
    assert.notEqual(processId, process.pid, "import must observe a distinct actual child producer");
    assert.equal(document.executionRoot, path.resolve(executionRoot));
    assert.equal(document.operation, "FlowManager.commitSpecStepResult");
    exact(document.input, ["binding", "stepResult", "settlement", "effect", "mutationManifest", "sourceMutationBaseline",
      "handoffDigest", "sourceHandoffSettlement", "taskStageBinding", "result", "sourceTaskReviewStage", "candidateBytes"]);
    const value = document.input;
    const binding = new CapturedSourceBinding(value.binding);
    const stepResult = StepResult.fromStored(binding.stepId, value.stepResult);
    const settlement = binding.stepId.startsWith("task-") ? settleTaskStepResult(binding.stepId, stepResult)
      : settleImplStepResult(binding.stepId, stepResult);
    assert.deepEqual(settlement.toJSON(), value.settlement, "captured original Result must select its original settlement");
    const effect = SourceWorkerEffect.fromDocument(value.effect, binding.stepId);
    const mutationManifest = SourceMutationManifest.fromStored(value.mutationManifest);
    const sourceMutationBaseline = SourceMutationBaseline.fromStored(value.sourceMutationBaseline, { root: executionRoot });
    mutationManifest.assertBinding(sourceMutationBaseline);
    const sourceTaskReviewStage = new CapturedSourcePublicationIdentity(value.sourceTaskReviewStage, value.candidateBytes);
    assert.deepEqual(sourceTaskReviewStage.facts.toJSON(), stepResult.evidence.taskStageFacts.toJSON());
    const input = { binding, stepResult, settlement, specId: binding.specId, effect, mutationManifest,
      sourceMutationBaseline, handoffDigest: value.handoffDigest,
      sourceHandoffSettlement: SourceHandoffSettlement.fromStored(value.sourceHandoffSettlement),
      taskStageBinding: new TaskReviewEpisodeBinding(value.taskStageBinding), result: new NodeResult(value.result),
      sourceTaskReviewStage, planGateRepairOutcome: null,
      sourceSelection: new SourceStepSelection({ facts: new SourceStepFacts({ stepId: binding.stepId,
        effect, evidence: stepResult.evidence }), result: stepResult }) };
    const beforeState = new CurrentFlowState(document.beforeState, { definition: buildCurrentFlowDefinition() });
    const priorActivities = Object.freeze(document.priorActivities.map((entry) => FlowActivity.fromSerialized(entry)));
    assert.equal(beforeState.runId, binding.runId);
    assert.equal(beforeState.specId, binding.specId);
    assert.ok(binding.attempt.matches(beforeState));
    assert.equal(priorActivities.length, beforeState.confirmationOrder);
    return Object.freeze({ operation: document.operation, input, beforeState, priorActivities,
      producer: Object.freeze({ processId, nonce: this.nonce }), digest });
  }
}
