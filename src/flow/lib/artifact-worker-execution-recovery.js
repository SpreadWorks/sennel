import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { FlowExecutionContract, FlowExecutionContractRefusal, executionValueDigest } from "./flow-execution-contract.js";
import { ArtifactWorkerExecutionFrontier, ArtifactWorkerRecoveryReceipt, ArtifactWorkerRequestSnapshot } from "./artifact-worker-recovery-values.js";
import { readStoredExecutionContractFromView, readExecutionContractFromView,
  readStoredPromptExecutionEpisodeFromView, executionContractArtifact } from "./canonical-prompt-execution.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { StepResult } from "../engine/step-result.js";
import { settleArtifactWorkerRecoveryResult } from "../definition.js";
import { DraftWorkerRecoveryCheckpoint } from "./draft-worker-recovery-checkpoint.js";
import { LegacyArtifactPromptConsumptionPublication } from "./canonical-prompt-execution.js";
import { FlowProcessExecutionBinding } from "./flow-process-execution-binding.js";
import { FlowProcessStopEvidence, workerProcessStopIdentity } from "./process-runtime-evidence.js";

function refuse(message) { throw new FlowExecutionContractRefusal(message); }

export class ArtifactWorkerResponseAvailable extends FlowExecutionContractRefusal {
  constructor() {
    super("A response appeared before artifact recovery commit; reread and replay it");
    this.code = "FLOW_ARTIFACT_EXECUTION_RESPONSE_AVAILABLE";
  }
}

export function artifactWorkerRequestSnapshotWrite(snapshot) {
  if (!(snapshot instanceof ArtifactWorkerRequestSnapshot)) throw new TypeError("Artifact request publication requires its typed snapshot");
  return { logicalKey: "execution.request", parameters: snapshot.executionContract.parameters,
    mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify({ id: snapshot.id, snapshot: snapshot.toJSON() }, null, 2)}\n`) };
}

export function readArtifactWorkerRequestSnapshotFromView(view, { executionContract, optional = false }) {
  readExecutionContractFromView(view, executionContract, { current: false });
  const target = FLOW_ARTIFACT_CONTRACTS.resolve("execution.request", executionContract.parameters);
  const descriptor = view.catalog.artifacts.find((entry) => entry.relativePath === target.relativePath);
  if (descriptor === undefined) {
    if (optional) return null;
    refuse("Artifact execution claim has no canonical request snapshot");
  }
  const value = JSON.parse(view.readCatalogedArtifact(descriptor).toString("utf8"));
  const snapshot = ArtifactWorkerRequestSnapshot.fromJSON(value.snapshot);
  executionContract.assertMatches(snapshot.executionContract);
  const producer = view.activities.find((activity) => activity.id === descriptor.activityId);
  if (value.id !== snapshot.id || producer?.nodeId !== executionContract.nodeId
    || producer.attemptId !== executionContract.attemptId || producer.sequence !== executionContract.attemptSequence) {
    refuse("Artifact execution request snapshot has no exact canonical producer");
  }
  return snapshot;
}
function readRecovery(view, descriptor) {
  const document = JSON.parse(view.readCatalogedArtifact(descriptor).toString("utf8"));
  const receipt = ArtifactWorkerRecoveryReceipt.fromJSON(document.receipt);
  if (document.id !== receipt.id) refuse("Artifact recovery receipt digest is invalid");
  const contract = receipt.targetContract;
  const result = StepResult.fromStored(contract.stepId, receipt.result);
  const settlement = settleArtifactWorkerRecoveryResult(contract.stepId, result);
  if (!isDeepStrictEqual(result.evidence.toJSON(), receipt.evidence.selection().toJSON())
    || !isDeepStrictEqual(settlement.toJSON(), receipt.settlement)) refuse("Artifact recovery receipt differs from its registered Result and Definition Settlement");
  const producer = view.activities.find((activity) => activity.id === descriptor.activityId);
  if (producer?.nodeId !== contract.nodeId || producer.attemptId !== contract.attemptId
    || producer.sequence !== contract.attemptSequence) refuse("Artifact recovery receipt has no exact canonical producer");
  return receipt;
}

export function readArtifactWorkerRecoveryReceiptsFromView(view) {
  return Object.freeze(view.catalog.artifacts.filter((entry) => entry.logicalKey === "execution.recovery")
    .map((entry) => readRecovery(view, entry)));
}

/** All generations are read from authenticated catalog rows, including saved old runtimes. */
export function readArtifactWorkerExecutionFrontierFromView(view, { binding, checkoutIdentity = null }) {
  const { episodeId } = FlowExecutionContract.parametersForBinding({ binding, generation: 0 });
  const prefix = `artifacts/executions/${episodeId}/`;
  const entries = view.catalog.artifacts.filter((entry) => entry.relativePath.startsWith(prefix));
  const contracts = entries.filter((entry) => entry.logicalKey === "execution.contract").map((entry) => {
    const document = JSON.parse(view.readCatalogedArtifact(entry).toString("utf8"));
    const contract = FlowExecutionContract.fromJSON(document.contract);
    if (contract.episodeId !== episodeId || contract.runId !== binding.runId || contract.specId !== binding.specId
      || contract.nodeId !== (binding.nodeId ?? binding.stepId) || contract.stepId !== binding.stepId
      || contract.attemptId !== binding.attempt.id || contract.attemptSequence !== binding.attempt.sequence
      || view.state.runId !== contract.runId || view.state.specId !== contract.specId) {
      refuse("Artifact worker execution frontier belongs to another binding");
    }
    return readExecutionContractFromView(view, contract, { current: false });
  });
  const recoveries = entries.filter((entry) => entry.logicalKey === "execution.recovery").map((entry) => readRecovery(view, entry));
  if (recoveries.length > 1) refuse("Artifact execution episode has more than one interrupted-worker recovery authorization");
  const recovery = recoveries[0] ?? null;
  let status = null;
  let reservationContinuation = null;
  const latest = [...contracts].sort((a, b) => a.generation - b.generation).at(-1) ?? null;
  if (recovery !== null) {
    const savedSource = contracts.find((contract) => contract.id === recovery.sourceContractId);
    const savedTarget = contracts.find((contract) => contract.id === recovery.targetContractId);
    if (savedSource === undefined || savedTarget === undefined) refuse("Artifact recovery receipt lost its source or target contract");
  }
  if (latest !== null) {
    const episode = readStoredPromptExecutionEpisodeFromView(view, latest, checkoutIdentity, { currentAttempt: false });
    const batches = episode.scopes.flatMap((scope) => scope.batches);
    if (episode.pendingReservationContinuations.length > 1) refuse("Artifact worker has multiple pending physical reservation continuations");
    reservationContinuation = episode.pendingReservationContinuations[0] ?? null;
    status = batches.some((batch) => batch.responses.length > 0 || batch.completion !== null) ? "accepted"
      : batches.some((batch) => batch.batchCalls > 0 || batch.claim !== null) ? "reserved" : "unconsumed";
  }
  return new ArtifactWorkerExecutionFrontier({ contracts, recovery, status, reservationContinuation });
}

export function assertArtifactWorkerRequestUnsealed(request, snapshot) {
  if (fs.existsSync(request.requestPath)) {
    const current = JSON.parse(fs.readFileSync(request.requestPath, "utf8"));
    if (executionValueDigest(current) !== request.requestDigest) refuse("Interrupted worker request changed before recovery commit");
  } else if (snapshot?.requestDigest !== request.requestDigest) {
    refuse("Interrupted worker has neither its exact capability nor its canonical request snapshot");
  }
  if (fs.existsSync(request.submissionPath)) throw new ArtifactWorkerResponseAvailable();
}

/** Admission validates a selected replacement; it never selects a fallback route. */
export class ArtifactWorkerRecoveryPublication {
  constructor({ receipt, sourceRequest, targetRequest, physicalEvidence, consumption,
    checkpoint = null, sourceExecutionReceiptId = null }) {
    if (!(receipt instanceof ArtifactWorkerRecoveryReceipt)) throw new TypeError("Artifact recovery publication requires its immutable receipt");
    if (!(consumption instanceof LegacyArtifactPromptConsumptionPublication)) throw new TypeError("Artifact recovery requires its authenticated episode accounting publication");
    if (checkpoint !== null && !(checkpoint instanceof DraftWorkerRecoveryCheckpoint)) throw new TypeError("Artifact recovery owner checkpoint must be typed");
    this.receipt = receipt;
    this.sourceRequest = sourceRequest;
    this.targetRequest = targetRequest;
    this.physicalEvidence = physicalEvidence;
    this.consumption = consumption;
    this.checkpoint = checkpoint;
    this.sourceExecutionReceiptId = sourceExecutionReceiptId;
    Object.freeze(this);
  }
  assert(view) {
    const { sourceContract: source, targetContract: target, evidence } = this.receipt;
    const result = StepResult.fromStored(source.stepId, this.receipt.result);
    if (!isDeepStrictEqual(result.evidence.toJSON(), evidence.selection().toJSON())
      || !isDeepStrictEqual(settleArtifactWorkerRecoveryResult(source.stepId, result).toJSON(), this.receipt.settlement)) {
      refuse("Artifact recovery publication does not match its Step Result and Definition Settlement");
    }
    this.physicalEvidence.assertCurrent();
    this.physicalEvidence.assertBinding(FlowProcessExecutionBinding.forEpisode(source));
    const sourcePhysical = this.physicalEvidence.forBinding(FlowProcessExecutionBinding.forContract(source));
    if (sourcePhysical.calls.length === 0 && sourcePhysical.nonExecution === null) refuse("Artifact recovery has no source execution stop or non-execution proof");
    for (const call of sourcePhysical.calls) new FlowProcessStopEvidence(call.receipt)
      .assertContract(source, workerProcessStopIdentity(this.sourceRequest)).assertCheckout(this.physicalEvidence.checkoutIdentity);
    if (this.physicalEvidence.digest !== evidence.physicalEvidenceDigest) refuse("Artifact recovery physical evidence changed");
    target.assertCurrent(view.state);
    readExecutionContractFromView(view, source, { current: false });
    for (const baseline of source.inputBaselines) baseline.assert(view);
    const frontier = readArtifactWorkerExecutionFrontierFromView(view, {
      binding: { runId: source.runId, specId: source.specId, stepId: source.stepId, nodeId: source.nodeId,
        attempt: { id: source.attemptId, nodeId: source.nodeId, sequence: source.attemptSequence } },
      checkoutIdentity: this.physicalEvidence.checkoutIdentity,
    });
    if (frontier.recovery !== null || frontier.executionContract?.id !== source.id) {
      refuse("Artifact recovery authorization or execution frontier changed before commit");
    }
    if (this.sourceRequest.requestDigest !== evidence.requestDigest
      || this.targetRequest.requestDigest !== evidence.targetRequestDigest
      || this.targetRequest.executionContract.id !== target.id
      || this.sourceRequest.executionContract.id !== source.id) refuse("Artifact recovery request binding changed");
    const snapshot = readArtifactWorkerRequestSnapshotFromView(view, { executionContract: source, optional: true });
    assertArtifactWorkerRequestUnsealed(this.sourceRequest, snapshot);
    if (evidence.inputContinuation !== null && (this.sourceRequest.recoveryInputContentDigest() !== evidence.inputContinuation.contentDigest
      || this.targetRequest.recoveryInputContentDigest() !== evidence.inputContinuation.contentDigest)) {
      refuse("Artifact recovery input provenance changed before commit");
    }
    this.consumption.assert(view);
    const episode = this.consumption.prepare(view).episode;
    const continuation = episode.continuationFor(target, { inputContinuation: evidence.inputContinuation });
    if (!isDeepStrictEqual(continuation.budget, evidence.budget)) refuse("Artifact recovery episode budget changed before commit");
  }
  assertInputCurrent({ flowManager, state }) {
    this.sourceRequest.assertInputCurrent(state, { flowManager });
    this.targetRequest.assertInputCurrent(state, { flowManager });
    this.sourceRequest.assertUnpublished({ flowManager, state });
    this.targetRequest.assertUnpublished({ flowManager, state });
    if (this.checkpoint !== null) {
      const execution = flowManager.draftStepExecutionState({ binding: this.checkpoint.binding });
      if (execution.receiptId !== this.sourceExecutionReceiptId) refuse("Conditional artifact execution changed before recovery commit");
    }
  }
  prepare(view) {
    this.assert(view);
    const receipt = this.receipt;
    const consumption = this.consumption.prepare(view);
    const snapshot = this.targetRequest.requestSnapshot();
    const sourceSnapshot = readArtifactWorkerRequestSnapshotFromView(view, { executionContract: receipt.sourceContract, optional: true });
    const preserved = sourceSnapshot === null ? [artifactWorkerRequestSnapshotWrite(this.sourceRequest.requestSnapshot())] : [];
    return { writes: [executionContractArtifact(receipt.targetContract), ...preserved, artifactWorkerRequestSnapshotWrite(snapshot), {
      logicalKey: "execution.recovery", parameters: receipt.targetContract.parameters,
      mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify({ id: receipt.id, receipt: receipt.toJSON() }, null, 2)}\n`),
    }, ...(consumption?.writes ?? [])] };
  }
  readAcknowledgement(view) {
    const target = FLOW_ARTIFACT_CONTRACTS.resolve("execution.recovery", this.receipt.targetContract.parameters);
    const descriptor = view.catalog.artifacts.find((entry) => entry.relativePath === target.relativePath);
    return descriptor !== undefined && readRecovery(view, descriptor).id === this.receipt.id;
  }
}
