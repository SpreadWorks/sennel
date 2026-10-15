import { isDeepStrictEqual } from "node:util";
import { FlowExecutionContract, FlowExecutionContractRefusal, executionValueDigest } from "./flow-execution-contract.js";
import { ArtifactWorkerInputContinuation } from "./artifact-worker-input-continuation.js";
import { ArtifactWorkerRecoverySelection } from "./artifact-worker-recovery-selection.js";
import { ArtifactWorkerRecoveryReceiptValue } from "./flow-execution-contract-value.js";
export { ArtifactWorkerExecutionFrontier } from "./artifact-worker-execution-frontier.js";

function refuse(message) { throw new FlowExecutionContractRefusal(message); }
function requireDigest(value, name) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${name} requires a digest`);
  return value;
}

/** Immutable identity of an explicitly selected replacement, never permission to spawn. */
export class ArtifactWorkerRecoveryEvidence {
  constructor({ sourceContract, targetContract, requestDigest, physicalEvidenceDigest, budget,
    sourceDispatchInvocationId, targetDispatchInvocationId, targetRequestDigest, inputContinuation = null }) {
    if (!(sourceContract instanceof FlowExecutionContract) || !(targetContract instanceof FlowExecutionContract)) {
      throw new TypeError("Artifact recovery requires its two typed execution contracts");
    }
    const previous = sourceContract.toJSON();
    const next = targetContract.toJSON();
    const { generation: oldGeneration, runtimeRevision: oldRuntime, ...oldPolicy } = previous;
    const { generation: newGeneration, runtimeRevision: newRuntime, ...newPolicy } = next;
    if (inputContinuation !== null) {
      if (!(inputContinuation instanceof ArtifactWorkerInputContinuation)) throw new TypeError("Artifact input continuation must be typed");
      inputContinuation.assertContracts(sourceContract, targetContract);
      delete oldPolicy.inputRevision;
      delete newPolicy.inputRevision;
    }
    if (newGeneration !== oldGeneration + 1 || !isDeepStrictEqual(oldPolicy, newPolicy)) {
      refuse("Artifact recovery cannot change its Attempt, inputs, prompt, schema, authority or execution limits");
    }
    if (![sourceDispatchInvocationId, targetDispatchInvocationId].every((value) => typeof value === "string" && value.trim())
      || sourceDispatchInvocationId === targetDispatchInvocationId) {
      throw new TypeError("Artifact recovery requires distinct saved source and target invocations");
    }
    if (budget === null || typeof budget !== "object" || Array.isArray(budget)
      || !Object.values(budget).every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new TypeError("Artifact recovery requires the acquired episode budget");
    }
    this.sourceContract = sourceContract;
    this.targetContract = targetContract;
    this.inputContinuation = inputContinuation;
    this.requestDigest = requireDigest(requestDigest, "Interrupted request");
    this.targetRequestDigest = requireDigest(targetRequestDigest, "Replacement request");
    this.physicalEvidenceDigest = requireDigest(physicalEvidenceDigest, "Recovery physical evidence");
    this.budget = Object.freeze({ ...budget });
    this.sourceDispatchInvocationId = sourceDispatchInvocationId;
    this.targetDispatchInvocationId = targetDispatchInvocationId;
    Object.freeze(this);
  }
  selection() {
    const policy = (contract) => {
      const { generation, runtimeRevision, ...value } = contract.toJSON();
      if (this.inputContinuation !== null) delete value.inputRevision;
      return executionValueDigest(value);
    };
    return new ArtifactWorkerRecoverySelection({ stepId: this.sourceContract.stepId,
      sourceContractId: this.sourceContractId, targetContractId: this.targetContractId,
      episodeId: this.episodeId, budgetId: this.budgetId,
      sourceGeneration: this.sourceContract.generation, targetGeneration: this.targetGeneration,
      sourceRuntimeRevision: this.sourceContract.runtimeRevision, targetRuntimeRevision: this.targetContract.runtimeRevision,
      sourcePolicyDigest: policy(this.sourceContract), targetPolicyDigest: policy(this.targetContract), previewDigest: this.previewDigest });
  }
  get sourceContractId() { return this.sourceContract.id; }
  get targetContractId() { return this.targetContract.id; }
  get targetGeneration() { return this.targetContract.generation; }
  get episodeId() { return this.sourceContract.episodeId; }
  get budgetId() { return this.sourceContract.budgetId; }
  get migratesRuntime() { return this.sourceContract.runtimeRevision !== this.targetContract.runtimeRevision; }
  get previewDigest() { return executionValueDigest(this.toJSON()); }
  toJSON() {
    return { sourceContract: this.sourceContract.toJSON(), targetContract: this.targetContract.toJSON(),
      requestDigest: this.requestDigest, targetRequestDigest: this.targetRequestDigest,
      physicalEvidenceDigest: this.physicalEvidenceDigest, budget: this.budget,
      sourceDispatchInvocationId: this.sourceDispatchInvocationId,
      targetDispatchInvocationId: this.targetDispatchInvocationId,
      inputContinuation: this.inputContinuation?.toJSON() ?? null };
  }
  static fromJSON(value) {
    const evidence = new this({ ...value, sourceContract: FlowExecutionContract.fromJSON(value.sourceContract),
      targetContract: FlowExecutionContract.fromJSON(value.targetContract),
      inputContinuation: value.inputContinuation == null ? null : ArtifactWorkerInputContinuation.fromJSON(value.inputContinuation) });
    if (!isDeepStrictEqual(evidence.toJSON(), value)) refuse("Saved artifact recovery evidence has unknown or missing fields");
    return evidence;
  }
}

/** The authorization is immutable; consumption is acquired from the existing Prompt journal. */
export class ArtifactWorkerRecoveryReceipt extends ArtifactWorkerRecoveryReceiptValue {
  constructor({ evidence, result, settlement }) {
    super();
    if (!(evidence instanceof ArtifactWorkerRecoveryEvidence) || result === null || typeof result !== "object"
      || settlement === null || typeof settlement !== "object") throw new TypeError("Artifact recovery receipt requires its selected Result and Settlement");
    this.evidence = evidence;
    this.result = Object.freeze(structuredClone(result));
    this.settlement = Object.freeze(structuredClone(settlement));
    Object.freeze(this);
  }
  get id() { return executionValueDigest(this.toJSON()); }
  get sourceContractId() { return this.evidence.sourceContractId; }
  get targetContractId() { return this.evidence.targetContractId; }
  get targetGeneration() { return this.evidence.targetGeneration; }
  get sourceContract() { return this.evidence.sourceContract; }
  get targetContract() { return this.evidence.targetContract; }
  toJSON() { return { evidence: this.evidence.toJSON(), result: this.result, settlement: this.settlement }; }
  static fromJSON(value) {
    const receipt = new this({ ...value, evidence: ArtifactWorkerRecoveryEvidence.fromJSON(value.evidence) });
    if (!isDeepStrictEqual(receipt.toJSON(), value)) refuse("Saved artifact recovery receipt has unknown or missing fields");
    return receipt;
  }
}

/** Exact request and action saved atomically with the generation claim. */
export class ArtifactWorkerDispatchIdentity {
  constructor({ repositoryFingerprint, canonicalRevision = null }) {
    if (typeof repositoryFingerprint !== "string" || !repositoryFingerprint
      || canonicalRevision !== null && (typeof canonicalRevision !== "string" || !canonicalRevision)) {
      throw new TypeError("Saved artifact dispatch identity requires its original action inputs");
    }
    this.repositoryFingerprint = repositoryFingerprint;
    this.canonicalRevision = canonicalRevision;
    Object.freeze(this);
  }
  toJSON() { return { repositoryFingerprint: this.repositoryFingerprint, canonicalRevision: this.canonicalRevision }; }
  static fromJSON(value) {
    const identity = new this(value);
    if (!isDeepStrictEqual(identity.toJSON(), value)) refuse("Saved artifact dispatch identity has unknown or missing fields");
    return identity;
  }
}

export class ArtifactWorkerRequestSnapshot {
  constructor({ executionContract, request, action, dispatchIdentity = null }) {
    if (dispatchIdentity !== null && !(dispatchIdentity instanceof ArtifactWorkerDispatchIdentity)) {
      throw new TypeError("Artifact request snapshot dispatch identity must be typed");
    }
    if (!(executionContract instanceof FlowExecutionContract) || request?.executionContractId !== executionContract.id
      || action?.step !== executionContract.stepId
      || request.runId !== executionContract.runId || request.specId !== executionContract.specId
      || request.stepId !== executionContract.stepId || request.inputRevision !== executionContract.inputRevision
      || !isDeepStrictEqual(request.executionContract, executionContract.toJSON())) {
      refuse("Artifact request snapshot does not match its execution contract");
    }
    this.executionContract = executionContract;
    this.request = JSON.parse(JSON.stringify(request));
    this.action = JSON.parse(JSON.stringify(action));
    this.dispatchIdentity = dispatchIdentity;
    const freeze = (value) => {
      if (value !== null && typeof value === "object") {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    freeze(this.request);
    freeze(this.action);
    Object.freeze(this);
  }
  get requestDigest() { return executionValueDigest(this.request); }
  get id() { return executionValueDigest(this.toJSON()); }
  toJSON() { return { executionContract: this.executionContract.toJSON(), request: this.request, action: this.action,
    dispatchIdentity: this.dispatchIdentity?.toJSON() ?? null }; }
  static fromJSON(value) {
    const snapshot = new this({ ...value, executionContract: FlowExecutionContract.fromJSON(value.executionContract),
      dispatchIdentity: value.dispatchIdentity === null ? null : ArtifactWorkerDispatchIdentity.fromJSON(value.dispatchIdentity) });
    if (!isDeepStrictEqual(snapshot.toJSON(), value)) refuse("Artifact request snapshot has unknown or missing fields");
    return snapshot;
  }
}
