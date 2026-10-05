/**
 * Read-only fact constructors for Definition-owned approval and acceptance
 * routes.  They intentionally carry evidence identities, not route labels;
 * `definition.js` is the only policy interpreter.
 */
import crypto from "node:crypto";

import {
  AcceptanceDecisionRouteFacts,
  AcceptanceReviewRouteFacts,
  ApprovalRouteFacts,
  DefinitionRouteTarget,
} from "../definition.js";

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function target(state, stepId) {
  const attempt = state?.attempt;
  const currentNodeId = state?.currentNodeId ?? state?.current?.at(-1) ?? null;
  if (currentNodeId !== stepId || !attempt?.id || !Number.isSafeInteger(attempt.sequence)) {
    throw new Error(`Definition route facts require the active ${stepId} Attempt`);
  }
  return new DefinitionRouteTarget({
    runId: state.runId,
    specId: state.specId,
    stepId,
    attemptId: attempt.id,
    sequence: attempt.sequence,
  });
}

function requirementIds(spec) {
  const ids = (spec?.requirements ?? []).map((entry) => entry?.id);
  if (ids.some((id) => typeof id !== "string" || id === "")) throw new Error("canonical Spec has invalid requirement IDs");
  return ids;
}

function findingDispositions(review) {
  return (review?.deferredFindings ?? []).map((entry) => `${entry.findingId}:${entry.finalDisposition}`);
}

export function approvalRouteFacts({ state, specDescriptor, spec, requestedApproval = false, targetBinding = null } = {}) {
  return new ApprovalRouteFacts({
    target: targetBinding ?? target(state, "approval"),
    specPublicationDigest: specDescriptor?.hash,
    approvalRecord: spec?.user_approval ?? null,
    requestedApproval,
    autoApprove: state.policy?.autoApprove === true,
  });
}

export function acceptanceReviewRouteFacts({ state, artifact, completed = true } = {}) {
  return new AcceptanceReviewRouteFacts({
    target: target(state, "acceptance-review"),
    reviewArtifactDigest: digest(artifact),
    requirementIds: artifact?.requirementJudgments?.map((entry) => entry.requirementId) ?? [],
    findingDispositions: findingDispositions(artifact),
    verdict: artifact?.verdict,
    completed,
  });
}

export function acceptanceDecisionRouteFacts({ state, review, reviewDescriptor, spec, choice = null, decisionRecord = null } = {}) {
  return new AcceptanceDecisionRouteFacts({
    target: target(state, "acceptance-decision"),
    reviewArtifactDigest: reviewDescriptor?.hash,
    requirementIds: requirementIds(spec),
    findingDispositions: findingDispositions(review),
    choice,
    decisionRecord,
  });
}
