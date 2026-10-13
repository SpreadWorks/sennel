/** Pure durable publication identities shared by canonical writers and readers. */
import crypto from "node:crypto";
import { DraftStepSettlementPublication, StepErrorDecision } from "../definition.js";
import { CanonicalFlowArtifactWrite, CanonicalFlowArtifactBaseline,
  CanonicalFlowArtifactRemoval, CanonicalFlowTestSourceBaseline,
  CurrentFlowStateInvariantError } from "./current-flow-state.js";
import { attachedCanonicalCommandResultArtifact,
  attachedCanonicalCommandResultPublications } from "./canonical-command-result.js";
import { attemptHistoryTargetForNode } from "./producer-artifact-readiness.js";
import { DraftCompletionSettlementApplication } from "./draft-completion-connector.js";

export function canonicalArtifactWriteIdentity(value) {
  const write = CanonicalFlowArtifactWrite.from(value);
  return {
    logicalKey: write.artifact.logicalKey,
    relativePath: write.artifact.relativePath,
    mediaType: write.mediaType,
    digest: crypto.createHash("sha256").update(write.bytes).digest("hex"),
    byteLength: write.bytes.length,
  };
}

export function commandResultPayload(value, nodeId, artifactLogicalKey) {
  const fallback = Object.freeze({ nodeId, outcome: "completed" });
  if (value == null) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({ nodeId, outcome: "completed", value: String(value) });
  }
  // Flow command envelopes are JSON values.  A clone through JSON prevents a
  // command-local class instance, function, or undefined field from leaking
  // into the permanent artifact contract.
  let result;
  try {
    result = JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new CurrentFlowStateInvariantError(`canonical command result must be JSON-serializable: ${error.message}`);
  }
  const attached = attachedCanonicalCommandResultArtifact(value);
  if (attached !== null && attached.logicalKey !== artifactLogicalKey) {
    throw new CurrentFlowStateInvariantError(
      `canonical command result artifact does not belong to ${artifactLogicalKey}: ${attached.logicalKey}`,
    );
  }
  return Object.freeze({
    nodeId,
    outcome: "completed",
    result,
    ...(attached !== null && { artifact: attached.toJSON() }),
  });
}

export function canonicalStepSettlementPublicationIdentity({
  binding,
  settlement,
  draftCompletionApplication,
  artifactWrites,
  artifactRemovals,
  artifactBaselines,
  testSourceBaseline,
  commandResult,
  gatePublication,
  lifecycleResult,
  references,
  specRecord,
  planGateRepairOutcome,
  preparation,
}) {
  const removalIdentity = (value) => {
    const removal = CanonicalFlowArtifactRemoval.from(value);
    return {
      logicalKey: removal.artifact.logicalKey,
      relativePath: removal.artifact.relativePath,
    };
  };
  const baselineIdentity = (value) => {
    const baseline = CanonicalFlowArtifactBaseline.from(value);
    return {
      logicalKey: baseline.artifact.logicalKey,
      relativePath: baseline.artifact.relativePath,
      digest: baseline.digest,
      byteLength: baseline.byteLength,
    };
  };
  const commandIdentity = (() => {
    if (commandResult === undefined) return null;
    const target = attemptHistoryTargetForNode(binding.stepId);
    return {
      attemptHistory: target === null ? null : {
        logicalKey: target.logicalKey,
        parameters: target.parameters,
        payload: commandResultPayload(commandResult, binding.stepId, target.logicalKey),
      },
      ...(["branch", "prepare-spec"].includes(binding.stepId)
        ? { preparationCommand: commandResult } : {}),
      publications: attachedCanonicalCommandResultPublications(commandResult)
        .map((publication) => publication.toJSON()),
    };
  })();
  const testSource = testSourceBaseline === undefined
    ? null
    : CanonicalFlowTestSourceBaseline.from(testSourceBaseline).entries.map((entry) => ({ ...entry }));
  const jsonIdentity = (value, field) => {
    if (value === undefined || value === null) return null;
    try {
      return JSON.parse(JSON.stringify(value.toJSON?.() ?? value));
    } catch (error) {
      throw new CurrentFlowStateInvariantError(`Step settlement ${field} must be JSON-serializable: ${error.message}`);
    }
  };
  const planGateRepair = planGateRepairOutcome === null ? null : {
    disposition: planGateRepairOutcome.disposition,
    repair: jsonIdentity(planGateRepairOutcome.repair, "plan-Gate repair"),
    report: jsonIdentity(planGateRepairOutcome.report, "plan-Gate repair report"),
  };
  return new DraftStepSettlementPublication({
    // Error settlements delegate their only publication to failCurrentAttempt,
    // so raw artifact arguments cannot affect that durable transaction.
    artifactWrites: settlement instanceof StepErrorDecision
      ? [] : artifactWrites.map(canonicalArtifactWriteIdentity),
    artifactRemovals: settlement instanceof StepErrorDecision
      ? [] : (artifactRemovals ?? []).map(removalIdentity),
    artifactBaselines: settlement instanceof StepErrorDecision
      ? [] : (artifactBaselines ?? []).map(baselineIdentity),
    testSourceBaseline: settlement instanceof StepErrorDecision ? null : testSource,
    command: commandIdentity,
    gatePublication: settlement instanceof StepErrorDecision && binding.stepId !== "spec-gate"
      ? null : jsonIdentity(gatePublication, "Gate publication"),
    draftCompletionApplication: draftCompletionApplication instanceof DraftCompletionSettlementApplication
      ? jsonIdentity(draftCompletionApplication, "Draft completion application")
      : null,
    lifecycleResult: jsonIdentity(lifecycleResult, "lifecycle result"),
    references: settlement instanceof StepErrorDecision ? null : jsonIdentity(references, "references"),
    specRecord: settlement instanceof StepErrorDecision ? null : jsonIdentity(specRecord, "Spec record"),
    planGateRepairOutcome: settlement instanceof StepErrorDecision ? null : planGateRepair,
    ...(preparation === null ? {} : { preparation: preparation.toJSON() }),
  });
}
