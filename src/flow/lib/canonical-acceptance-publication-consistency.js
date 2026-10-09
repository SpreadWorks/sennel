import { isDeepStrictEqual } from "node:util";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { AcceptanceRepairFindingSet, validateAcceptanceReviewArtifact } from "./acceptance-review-artifacts.js";
import { FinalRegressionStepFacts } from "./final-regression-transition.js";
import { CurrentFlowStateConflictError } from "./current-flow-state-conflict-error.js";

const conflict = (message) => { throw new CurrentFlowStateConflictError(message); };

/** Validate adopted meaning against the acquired bytes, without selecting a disposition. */
export function assertAcceptancePublicationConsistency({ candidate, descriptor, evidence }) {
  const document = JSON.parse(candidate.readCatalogedArtifact(descriptor).toString("utf8"));
  const history = ["acceptance-review", "acceptance-decision", "final-regression"].includes(candidate.binding.stepId)
    ? CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: descriptor.logicalKey,
      bytes: candidate.readCatalogedArtifact(descriptor) }) : null;
  const payload = history === null ? document : history.current.payload;
  const attempt = candidate.settlementAttempt ?? candidate.binding.attempt;
  if (history !== null && history.current.attempt !== attempt.sequence) conflict("Acceptance publication has another Attempt ordinal");
  if (evidence.identity?.runId !== candidate.binding.runId || evidence.identity?.specId !== candidate.binding.specId
    || evidence.identity?.stepId !== candidate.binding.stepId || evidence.identity?.attempt?.id !== attempt.id
    || evidence.identity?.attempt?.sequence !== attempt.sequence) conflict("Acceptance meaning belongs to another producer identity");
  if (candidate.binding.stepId === "retro") {
    if (payload.repairFingerprint !== evidence.fingerprint || payload.summary?.not_done !== evidence.notDone
      || evidence.nonblocking !== (candidate.state.policy.nonblocking?.enabled === true)) {
      conflict("Retro Result differs from its acquired aggregate");
    }
  } else if (candidate.binding.stepId === "acceptance-review") {
    validateAcceptanceReviewArtifact(payload, { requirementIds: evidence.requirementIds });
    const frontier = candidate.state.findNode("acceptance-decision");
    if (payload.verdict !== evidence.verdict || payload.repairFingerprint !== evidence.fingerprint
      || evidence.reviewAttempt !== history.current.attempt || evidence.reviewDigest !== descriptor.hash
      || evidence.decisionAttemptSequence !== frontier.attemptSequence || evidence.decisionStatus !== frontier.status
      || !isDeepStrictEqual(new AcceptanceRepairFindingSet(payload).toJSON(), [...evidence.findingIds])) {
      conflict("Acceptance Review Result changed its published verdict, findings or frontier");
    }
  } else if (candidate.binding.stepId === "acceptance-decision") {
    const source = evidence.sourcePublication;
    const sourceDescriptor = candidate.catalog.artifacts.find((entry) => entry.relativePath === source.artifactId);
    const producer = candidate.activities.find((entry) => entry.id === source.producerActivityId);
    if (sourceDescriptor?.hash !== source.fingerprint || sourceDescriptor?.activityId !== source.producerActivityId
      || producer?.nodeId !== "acceptance-review" || producer?.attemptId !== source.attempt.id
      || producer?.sequence !== source.attempt.sequence) conflict("Acceptance choice source publication is stale");
    const review = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: "acceptance.review",
      bytes: candidate.readCatalogedArtifact(sourceDescriptor) }).current;
    if (payload.choice !== evidence.choice || payload.acceptanceReviewDigest !== source.fingerprint
      || payload.acceptanceReviewAttempt !== evidence.reviewAttempt || review.attempt !== evidence.reviewAttempt
      || payload.repairFingerprint !== evidence.repairFingerprint || review.payload.repairFingerprint !== evidence.repairFingerprint
      || review.payload.verdict !== "user_decision_required") conflict("Acceptance choice changed its Review lineage or explicit decision");
  } else if (candidate.binding.stepId === "final-regression") {
    const observed = evidence.observation;
    if (candidate.settlementAttempt !== null) {
      const original = history.attempts.find((entry) => entry.attempt === candidate.binding.attempt.sequence);
      const source = candidate.activities.findLast((entry) => entry.nodeId === "final-regression"
        && entry.attemptId === candidate.binding.attempt.id && entry.sequence === candidate.binding.attempt.sequence
        && entry.result?.stepResult?.kind === "final-regression-failed");
      if (source?.result?.draftSettlementReceipt == null || original?.payload?.result !== "fail"
        || ["executionBinding", "rawOutputPath", "changedFileSnapshotDigest", "failureKind", "command", "result"]
          .some((field) => !isDeepStrictEqual(original.payload[field], payload[field]))) {
        conflict("Accepted regression changed the original failed producer or raw execution evidence");
      }
    }
    const currentAttempt = candidate.settlementAttempt ?? candidate.state.attempt;
    const expected = FinalRegressionStepFacts.fromCanonicalArtifact({ artifact: payload, artifactDigest: descriptor.hash,
      retry: { used: currentAttempt.consumption.semantic,
        maximum: candidate.state.definition.contractFor("final-regression", candidate.state.root).semanticRetryLimit },
      changedFileSnapshot: { digest: payload.changedFileSnapshotDigest, current: observed.changedFileSnapshot.current },
      nonblocking: candidate.state.policy.nonblocking?.enabled === true, failureRecorded: currentAttempt.failure !== null });
    if (!isDeepStrictEqual(expected.toJSON(), observed.toJSON())
      || (evidence.retry.used !== expected.retryHistory.used || evidence.retry.maximum !== expected.retryHistory.maximum)) {
      conflict("Final regression Result changed its acquired failure, budget or execution evidence");
    }
  } else if (candidate.binding.stepId === "report") {
    if (payload.data?.delivery?.status !== evidence.delivery
      || (evidence.delivery === "not_required" ? candidate.state.issue !== null
        : (payload.data.delivery.idempotencyKey ?? null) !== (evidence.outboxIdentity?.idempotencyKey ?? null))) {
      conflict("Report Result differs from its acquired delivery and outbox evidence");
    }
  }
}
