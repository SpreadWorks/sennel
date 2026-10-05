import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { findActiveNode, resolveMaxAttempts } from "../definition.js";
import { ReviewEvidenceInput } from "./review-evidence-store.js";
import {
  ReviewConvergenceState,
  ReviewEvidenceReference,
  buildReviewHandoffFindings,
  resolveReviewPermittedOperation,
} from "./review-convergence.js";
import { ReviewTargetAuthority } from "./review-target-authority.js";
import { isCanonicalFlowState } from "./canonical-test-artifacts.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";

const PHASE_BY_REVIEW_STEP = Object.freeze({
  "draft-questions-review": "draft-questions",
  "draft-coverage-review": "draft-coverage",
  "spec-review": "spec",
  "test-review": "test",
  "impl-review": "impl",
  "task-review": "impl",
});

function currentReviewTarget(flowState, treeSha) {
  const active = findActiveNode(flowState);
  const phase = PHASE_BY_REVIEW_STEP[active?.stepId];
  if (!phase) {
    const error = new Error("review evidence can be registered only for the active review step");
    error.code = "REVIEW_TARGET_NOT_ACTIVE";
    throw error;
  }
  return {
    phase,
    taskId: active.scope === "task" ? active.taskId : null,
    treeSha,
    semanticMaxAttempts: resolveMaxAttempts({
      scope: active.scope,
      stepId: active.stepId,
      context: flowState,
    }),
  };
}

function canonicalReviewState({ evidence, target }) {
  const semanticAttempts = evidence.disposition.value === "REJECTED" ? 1 : 0;
  return new ReviewConvergenceState({
    phase: target.phase,
    taskId: target.taskId,
    treeSha: target.treeSha,
    semanticAttempts,
    semanticMaxAttempts: target.semanticMaxAttempts ?? 1,
    toolingAttempts: 0,
    toolingMaxAttempts: 1,
    evidence: new ReviewEvidenceReference({
      evidenceId: evidence.identity.evidenceDigest,
      disposition: evidence.disposition,
    }),
    finalizedEvidenceAvailable: true,
    handoffFindings: buildReviewHandoffFindings(evidence),
    blocker: null,
    toolingOutcome: null,
  });
}

function canonicalReviewNode(ctx, { phase, taskId }) {
  const activeNodeId = ctx.flowState.currentNodeId ?? null;
  const nodeId = taskId === null ? activeNodeId : "task-review";
  if (
    typeof nodeId !== "string"
    || PHASE_BY_REVIEW_STEP[nodeId] !== phase
    || (taskId === null ? nodeId === "task-review" : activeNodeId !== `${taskId}-review`)
  ) {
    const error = new Error("review evidence can be registered only for the active review step");
    error.code = "REVIEW_TARGET_NOT_ACTIVE";
    throw error;
  }
  return nodeId;
}

function assertCanonicalEvidenceIsNew(ctx, input) {
  const nodeId = canonicalReviewNode(ctx, input);
  const artifact = FLOW_ARTIFACT_CONTRACTS.reviewEvidence({
    ...(input.taskId === null ? { reviewStep: nodeId } : { taskId: input.taskId }),
    digest: input.evidence.identity.evidenceDigest,
  });
  const catalog = ctx.flowManager.artifactCatalog(ctx.flowState.specId);
  if (catalog.artifacts.some((entry) => entry.relativePath === artifact.relativePath)) {
    const error = new Error("review evidence is already registered for this target");
    error.code = "REVIEW_ALREADY_COMPLETED";
    throw error;
  }
}

function registerCanonicalReviewEvidence(ctx, { input, target }) {
  const evidence = input.toEvidence(target);
  const nodeId = canonicalReviewNode(ctx, target);
  const artifact = FLOW_ARTIFACT_CONTRACTS.reviewEvidence({
    ...(target.taskId === null ? { reviewStep: nodeId } : { taskId: target.taskId }),
    digest: evidence.identity.evidenceDigest,
  });
  ctx.flowManager.publishArtifacts({
    specId: ctx.flowState.specId,
    nodeId,
    artifactWrites: [{
      logicalKey: "review.evidence",
      ...(target.taskId === null ? { reviewStep: nodeId } : { taskId: target.taskId }),
      digest: evidence.identity.evidenceDigest,
      mediaType: "application/json",
      bytes: Buffer.from(`${evidence.canonicalText}\n`, "utf8"),
    }],
  });
  const convergenceState = canonicalReviewState({ evidence, target });
  return {
    providerInvoked: false,
    phase: target.phase,
    taskId: target.taskId,
    treeSha: target.treeSha,
    evidenceDigest: evidence.identity.evidenceDigest,
    artifactPath: artifact.relativePath,
    reviewAction: resolveReviewPermittedOperation(convergenceState).toJSON(),
  };
}

export default class SetReviewEvidenceCommand extends FlowCommand {
  execute(ctx) {
    if (typeof ctx.file !== "string" || ctx.file.trim() === "") {
      return Envelope.fail(
        "set",
        "review-evidence",
        "INVALID_USAGE",
        "usage: flow set review-evidence --file <path>",
      );
    }
    const canonical = isCanonicalFlowState(ctx.flowState);
    let input;
    let target;
    try {
      const authority = ReviewTargetAuthority.fromContext(ctx);
      input = ReviewEvidenceInput.fromFile({
        root: authority.executionRoot,
        // A Version directory is catalog-authoritative and cannot contain an
        // ad-hoc CLI source document.  The evidence file is read-only command
        // input, so V1 bounds it to the checked-out execution root instead.
        // The Store publishes only its normalized immutable bytes.
        specDir: authority.executionRoot,
        inputPath: ctx.file,
      });
      if (canonical) assertCanonicalEvidenceIsNew(ctx, input);
      target = currentReviewTarget(
        ctx.flowState,
        authority.resolveTreeSha(),
      );
      const fingerprint = authority.captureFingerprint();
      target.targetState = authority.captureTargetStateForPhase(target.phase, fingerprint);
      target.targetStateDigest = target.targetState.digest;
      input.validateTarget(target);
    } catch (error) {
      if (!error.code && /tree target mismatch/.test(error.message)) {
        error.code = "STALE_REVIEW_TARGET";
      } else if (!error.code) {
        error.code = "REVIEW_EVIDENCE_INVALID";
      }
      throw error;
    }

    if (!canonical) {
      throw new Error("review evidence registration requires a Version-1 Flow");
    }
    return registerCanonicalReviewEvidence(ctx, { input, target });
  }
}
