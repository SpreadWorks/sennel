import { responseContentDigest, PromptCompletionResponseContribution } from "../../lib/prompt-batching.js";
import { isDeepStrictEqual } from "node:util";
import { PromptResponseExecutionObservation } from "../../lib/prompt-execution-journal.js";
import { FlowExecutionContract, executionValueDigest } from "./flow-execution-contract.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";

function requiredDigest(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} must be a digest`);
  return value;
}

function assertReceiverContract(reference, contract) {
  const binding = reference.binding;
  if (binding.runId !== contract.runId || binding.specId !== contract.specId
    || binding.nodeId !== contract.nodeId || binding.taskId !== contract.taskId
    || binding.attemptId !== contract.attemptId || binding.attemptSequence !== contract.attemptSequence
    || binding.executionContractId !== contract.id || binding.executionGeneration !== contract.generation) {
    throw new TypeError("Selected Prompt response belongs to another execution contract");
  }
}

function selectedCompletion(reference, episode, state) {
  reference.binding.assertVersion(state);
  const scope = episode.scopes.find((snapshot) => isDeepStrictEqual(snapshot.scope.toJSON(), reference.scope.toJSON()));
  const batch = scope?.batches.find((entry) => entry.batchDigest === reference.batchDigest);
  const response = batch?.responses.find((entry) => entry.responseCallIndex === reference.responseCallIndex);
  if (response === undefined || batch.completion === null || scope.plan.digest !== reference.planDigest
    || !isDeepStrictEqual(response.executionObservation, reference.toJSON()) || response.rejection !== null) {
    throw new TypeError("Adopted Prompt response differs from its validated canonical receiver and completion");
  }
  reference.assertResponse({ scope: scope.scope, planDigest: scope.plan.digest, batchDigest: batch.batchDigest, response });
  return batch.completion;
}

/** Exact selected response input, acquired before a Step adopts worker outputs. */
export class CanonicalPromptResponseSelection {
  constructor({ executionContract, responseDigest, receivedResponses }) {
    this.executionContract = executionContract instanceof FlowExecutionContract ? executionContract : FlowExecutionContract.fromJSON(executionContract);
    this.responseDigest = requiredDigest(responseDigest, "Selected Prompt response digest");
    if (!Array.isArray(receivedResponses) || receivedResponses.length === 0) throw new TypeError("Selected Prompt response requires its exact receiver identities");
    this.receivedResponses = Object.freeze(receivedResponses.map((reference) => reference instanceof PromptResponseExecutionObservation
      ? reference : PromptResponseExecutionObservation.fromJSON(reference)));
    for (const reference of this.receivedResponses) assertReceiverContract(reference, this.executionContract);
    if (new Set(this.receivedResponses.map((reference) => executionValueDigest(reference.toJSON()))).size !== this.receivedResponses.length) {
      throw new TypeError("Selected Prompt response repeats a receiver identity");
    }
    Object.freeze(this);
  }
  static fromResponse(response, executionContract) {
    if (typeof response?.response !== "string" || response.executionContractId !== executionContract.id
      || response.generation !== executionContract.generation) throw new TypeError("Selected worker response differs from its request contract");
    return new this({ executionContract, responseDigest: responseContentDigest(response.response), receivedResponses: response.receivedResponses });
  }
  toJSON() { return { executionContract: this.executionContract.toJSON(), responseDigest: this.responseDigest,
    receivedResponses: this.receivedResponses.map((reference) => reference.toJSON()) }; }
  static fromJSON(value) {
    const selection = Object.hasOwn(value, "contributions") ? new CanonicalPromptResponseContributionSelection(value) : new this(value);
    if (!isDeepStrictEqual(selection.toJSON(), value)) throw new TypeError("Prompt response selection has unknown or missing fields");
    return selection;
  }
  assertEpisode(episode, state) {
    for (const reference of this.receivedResponses) {
      const completion = selectedCompletion(reference, episode, state);
      if (reference.responseDigest !== this.responseDigest || responseContentDigest(completion.response) !== this.responseDigest) {
        throw new TypeError("Adopted Prompt response differs from its validated canonical receiver and completion");
      }
    }
    return this;
  }
}

/** Explicit reducer-selected contributors to one transformed canonical publication. */
export class CanonicalPromptResponseContributionSelection {
  constructor({ executionContract, publicationLogicalKey, publicationDigest, contributions }) {
    this.executionContract = executionContract instanceof FlowExecutionContract ? executionContract : FlowExecutionContract.fromJSON(executionContract);
    if (publicationLogicalKey !== "acceptance.review" || this.executionContract.nodeId !== "acceptance-review") {
      throw new TypeError("Prompt contribution selection requires its Acceptance Review publication");
    }
    this.publicationLogicalKey = publicationLogicalKey;
    this.publicationDigest = requiredDigest(publicationDigest, "Selected Prompt publication digest");
    if (!Array.isArray(contributions) || contributions.length === 0) throw new TypeError("Prompt publication requires selected completion contributions");
    this.contributions = Object.freeze(contributions.map((entry) => entry instanceof PromptCompletionResponseContribution
      ? entry : PromptCompletionResponseContribution.fromJSON(entry)));
    if (new Set(this.contributions.map((entry) => executionValueDigest(entry.toJSON()))).size !== this.contributions.length) {
      throw new TypeError("Prompt publication repeats a completion contribution");
    }
    const receivers = new Map();
    for (const contribution of this.contributions) for (const reference of contribution.receivedResponses) {
      assertReceiverContract(reference, this.executionContract);
      receivers.set(executionValueDigest(reference.toJSON()), reference);
    }
    this.receivedResponses = Object.freeze([...receivers.values()]);
    Object.freeze(this);
  }
  toJSON() { return { executionContract: this.executionContract.toJSON(), publicationLogicalKey: this.publicationLogicalKey,
    publicationDigest: this.publicationDigest, contributions: this.contributions.map((entry) => entry.toJSON()),
    receivedResponses: this.receivedResponses.map((entry) => entry.toJSON()) }; }
  assertEpisode(episode, state) {
    for (const contribution of this.contributions) for (const reference of contribution.receivedResponses) {
      const completion = selectedCompletion(reference, episode, state);
      if (reference.batchDigest !== contribution.batchDigest || responseContentDigest(completion.response) !== contribution.completionDigest) {
        throw new TypeError("Adopted completion contribution differs from its retained Prompt completion");
      }
    }
    return this;
  }
  assertPublishedArtifact(bytes) {
    const record = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: this.publicationLogicalKey, bytes })
      .atAttempt(this.executionContract.attemptSequence);
    if (record === null || record.nodeId !== this.executionContract.nodeId || executionValueDigest(record.payload) !== this.publicationDigest) {
      throw new TypeError("Adopted Prompt contributions differ from the actual canonical publication payload");
    }
    return this;
  }
}

/** Publication provenance; the catalog descriptor identifies its actual Activity. */
export class CanonicalPromptResponseAdoption {
  constructor({ schemaRevision = 1, id = null, selection, requestDigest, handoffDigest, payloadDigest }) {
    if (schemaRevision !== 1) throw new TypeError("Prompt response adoption format is invalid");
    this.schemaRevision = schemaRevision;
    this.selection = selection instanceof CanonicalPromptResponseSelection || selection instanceof CanonicalPromptResponseContributionSelection
      ? selection : CanonicalPromptResponseSelection.fromJSON(selection);
    if (this.selection instanceof CanonicalPromptResponseSelection) {
      this.requestDigest = requiredDigest(requestDigest, "Adoption request digest");
      this.handoffDigest = requiredDigest(handoffDigest, "Adoption handoff digest");
      this.payloadDigest = requiredDigest(payloadDigest, "Adoption payload digest");
    }
    const { schemaRevision: revision, ...identity } = this.toJSON();
    this.id = executionValueDigest(identity);
    if (id !== null && id !== this.id) throw new TypeError("Prompt response adoption identity differs from its content");
    Object.freeze(this);
  }
  toJSON() { return { schemaRevision: this.schemaRevision, ...(this.id === undefined ? {} : { id: this.id }), selection: this.selection.toJSON(),
    ...(this.selection instanceof CanonicalPromptResponseSelection ? {
      requestDigest: this.requestDigest, handoffDigest: this.handoffDigest, payloadDigest: this.payloadDigest } : {}) }; }
  static fromJSON(value) {
    const adoption = new this(value);
    if (!isDeepStrictEqual(adoption.toJSON(), value)) throw new TypeError("Prompt response adoption has unknown or missing fields");
    return adoption;
  }
  assertPublication(view, activity) {
    const contract = this.selection.executionContract;
    const resultReferences = activity.result?.artifactRefs ?? [];
    const publicationReferenced = this.selection instanceof CanonicalPromptResponseContributionSelection
      ? resultReferences.some((reference) => reference.kind === "prompt-response-publication" && reference.id === this.id)
      : activity.result !== null
      ? resultReferences.some((reference) => reference.kind === "worker-handoff" && reference.id === this.handoffDigest)
        && resultReferences.some((reference) => reference.kind === "worker-handoff-request" && reference.id === this.requestDigest)
      : activity.transition.operation === "publish_artifacts"
        && activity.references.artifacts.some((reference) => reference.id === this.handoffDigest)
        && activity.references.artifacts.some((reference) => reference.id === this.requestDigest);
    if (activity.nodeId !== contract.nodeId || activity.attemptId !== contract.attemptId || activity.sequence !== contract.attemptSequence
      || !publicationReferenced) {
      throw new TypeError("Prompt response adoption does not bind its actual worker publication");
    }
    return this;
  }
  publicationReference() { return { kind: "prompt-response-publication", id: this.id }; }
  artifactWrite() { return { logicalKey: "execution.response.adoption", parameters: { adoptionId: this.id },
    mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(this.toJSON(), null, 2)}\n`) }; }
}

/** Nominal save admission without importing the canonical reader into value types. */
export class PromptResponseAdoptionAdmissionValue {
  constructor() {
    if (new.target === PromptResponseAdoptionAdmissionValue) throw new TypeError("Prompt adoption admissions are abstract");
  }
}
