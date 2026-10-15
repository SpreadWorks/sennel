import crypto from "node:crypto";
import { FlowExecutionContractValue } from "./flow-execution-contract-value.js";
import { FlowExecutionInputBaseline } from "./flow-execution-input-baseline.js";
import { workerArtifactStableStringify } from "./worker-artifact-input-format.js";
export { FlowExecutionInputBaseline } from "./flow-execution-input-baseline.js";
import { isDeepStrictEqual } from "node:util";
import { currentRuntimePackage } from "../../lib/runtime-package.js";
import { PromptExecutionLimit } from "../../lib/prompt-batching.js";
import { StepAdmissionRefusal } from "./step-admission-refusal.js";

export function executionValueDigest(value) {
  return crypto.createHash("sha256").update(workerArtifactStableStringify(JSON.parse(JSON.stringify(value)))).digest("hex");
}

export class FlowExecutionContractRefusal extends StepAdmissionRefusal {
  constructor(message) { super(message); this.code = "FLOW_EXECUTION_CONTRACT_MISMATCH"; }
}

/** Immutable, independent identities of one unfinished execution generation. */
export class FlowExecutionContract extends FlowExecutionContractValue {
  constructor({ runId, specId, stepId, nodeId = stepId, taskId = null, attemptId,
    attemptSequence, generation, inputRevision, runtimeRevision, promptDigest,
    schemaDigest, budgetOwner = null, executionLimit = null, executionMode = null, inputBaselines = [] }) {
    super();
    budgetOwner ??= FlowExecutionContract.parametersForBinding({ binding: { runId, specId, nodeId,
      attempt: { id: attemptId, sequence: attemptSequence } }, generation }).episodeId;
    for (const [key, value] of Object.entries({ runId, specId, stepId, nodeId, attemptId,
      inputRevision, runtimeRevision, promptDigest, schemaDigest, budgetOwner })) {
      if (typeof value !== "string" || !value.trim()) throw new TypeError(`Execution contract ${key} is required`);
    }
    if (!Number.isSafeInteger(attemptSequence) || attemptSequence < 1
      || !Number.isSafeInteger(generation) || generation < 0
      || taskId !== null && (typeof taskId !== "string" || !taskId)) {
      throw new TypeError("Execution contract Attempt, generation or Task is invalid");
    }
    if (!Array.isArray(inputBaselines) || inputBaselines.some((baseline) => !(baseline instanceof FlowExecutionInputBaseline))) {
      throw new TypeError("Execution contract input baselines must be typed");
    }
    const paths = inputBaselines.map((baseline) => baseline.baseline.artifact.relativePath);
    if (new Set(paths).size !== paths.length) throw new TypeError("Execution input baselines must not repeat an artifact");
    this.inputBaselines = Object.freeze([...inputBaselines].sort((left, right) => left.baseline.artifact.relativePath.localeCompare(right.baseline.artifact.relativePath)));
    Object.assign(this, { runId, specId, stepId, nodeId, taskId, attemptId,
      attemptSequence, generation, inputRevision, runtimeRevision, promptDigest, schemaDigest, budgetOwner,
      executionLimit: executionLimit === null ? null : Object.freeze({ ...new PromptExecutionLimit(executionLimit) }), executionMode });
    Object.freeze(this);
  }
  static fromBinding({ binding, generation, inputRevision, promptDigest, schemaDigest, budgetOwner, executionLimit, executionMode, inputBaselines }) {
    return new FlowExecutionContract({ runId: binding.runId, specId: binding.specId,
      stepId: binding.stepId, nodeId: binding.nodeId ?? binding.stepId,
      taskId: binding.taskId ?? null, attemptId: binding.attempt.id,
      attemptSequence: binding.attempt.sequence, generation, inputRevision,
      runtimeRevision: currentRuntimePackage().revision, promptDigest, schemaDigest, budgetOwner, executionLimit, executionMode, inputBaselines });
  }
  toJSON() { return { runId: this.runId, specId: this.specId, stepId: this.stepId,
    nodeId: this.nodeId, taskId: this.taskId, attemptId: this.attemptId,
    attemptSequence: this.attemptSequence, generation: this.generation,
    inputRevision: this.inputRevision, runtimeRevision: this.runtimeRevision,
    promptDigest: this.promptDigest, schemaDigest: this.schemaDigest, budgetOwner: this.budgetOwner,
    executionLimit: this.executionLimit, executionMode: this.executionMode, inputBaselines: this.inputBaselines.map((baseline) => baseline.toJSON()) }; }
  get id() { return executionValueDigest(this.toJSON()); }
  static parametersForBinding({ binding, generation }) {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new TypeError("Execution contract location requires its generation");
    return { episodeId: executionValueDigest([binding.runId, binding.specId, binding.nodeId ?? binding.stepId,
      binding.attempt.id, binding.attempt.sequence]), generation: String(generation) };
  }
  get episodeId() { return this.parameters.episodeId; }
  get budgetId() { return executionValueDigest([this.episodeId, this.budgetOwner]); }
  get parameters() { return FlowExecutionContract.parametersForBinding({ binding: { runId: this.runId,
    specId: this.specId, nodeId: this.nodeId, attempt: { id: this.attemptId, sequence: this.attemptSequence } }, generation: this.generation }); }
  assertMatches(other) {
    if (!(other instanceof FlowExecutionContract) || !isDeepStrictEqual(this.toJSON(), other.toJSON())) {
      const fields = other instanceof FlowExecutionContract ? Object.keys(this.toJSON())
        .filter((field) => !isDeepStrictEqual(this.toJSON()[field], other.toJSON()[field])) : ["contract"];
      const error = new FlowExecutionContractRefusal(`Saved execution contract differs from the current execution: ${fields.join(", ")}`);
      error.mismatchedFields = Object.freeze(fields);
      throw error;
    }
  }
  assertExecutionBinding(binding, executionBinding) {
    const inputRevision = executionBinding.inputRevision;
    if (binding.runId !== this.runId || binding.specId !== this.specId
      || binding.stepId !== this.stepId || (binding.nodeId ?? binding.stepId) !== this.nodeId
      || binding.attempt.id !== this.attemptId || binding.attempt.sequence !== this.attemptSequence
      || executionBinding.executionGeneration !== this.generation || inputRevision !== this.inputRevision) {
      throw new FlowExecutionContractRefusal("Execution contract differs from its generation claim");
    }
  }
  assertCurrent(state) {
    if (state.runId !== this.runId || state.specId !== this.specId
      || state.current?.at(-1) !== this.nodeId || state.attempt?.nodeId !== this.nodeId
      || state.attempt.id !== this.attemptId || state.attempt.sequence !== this.attemptSequence
      || state.attempt.failure !== null || currentRuntimePackage().revision !== this.runtimeRevision) {
      throw new FlowExecutionContractRefusal("Execution contract no longer owns the current runtime and Attempt");
    }
  }
  static fromJSON(value) {
    const contract = new FlowExecutionContract({ ...value, inputBaselines: value.inputBaselines?.map((baseline) => FlowExecutionInputBaseline.fromJSON(baseline)) });
    if (!isDeepStrictEqual(contract.toJSON(), value)) throw new FlowExecutionContractRefusal("Saved execution contract has unknown or missing fields");
    return contract;
  }
}
