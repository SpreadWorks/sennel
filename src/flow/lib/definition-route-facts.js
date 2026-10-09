/**
 * Read-only approval facts and canonical Acceptance decision request binding.
 */
import {
  ApprovalRouteFacts,
  DefinitionRouteTarget,
} from "../definition.js";
import { AcceptanceDecisionRequest } from "../steps/acceptance/acceptance-review-values.js";
import { validateAcceptanceReviewArtifact } from "./acceptance-review-artifacts.js";

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

export function approvalRouteFacts({ state, specDescriptor, spec, requestedApproval = false, targetBinding = null } = {}) {
  return new ApprovalRouteFacts({
    target: targetBinding ?? target(state, "approval"),
    specPublicationDigest: specDescriptor?.hash,
    approvalRecord: spec?.user_approval ?? null,
    requestedApproval,
    autoApprove: state.policy?.autoApprove === true,
  });
}

/** Validate a saved decision request; this boundary grants no route authority. */
export function acceptanceDecisionRouteFacts({ state, review, reviewDescriptor, spec, choice = null, decisionRecord = null } = {}) {
  target(state, "acceptance-decision");
  validateAcceptanceReviewArtifact(review, { requirementIds: requirementIds(spec) });
  return new AcceptanceDecisionRequest({
    reviewDigest: reviewDescriptor?.hash,
    choice,
    record: decisionRecord === null ? null : {
      reviewDigest: decisionRecord.reviewArtifactDigest,
      choice: decisionRecord.choice,
    },
  });
}
