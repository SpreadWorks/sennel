import { Envelope } from "../../lib/flow-envelope.js";
import { missingExactTargetGuardNames } from "../../lib/flow-target-guard.js";
import { FlowCommand } from "./base-command.js";
import { isCanonicalFlowState } from "./canonical-test-artifacts.js";

/**
 * Version-1 review results publish the producer Attempt and immutable
 * evidence in the same Store transaction. The retired root projection
 * repair protocol therefore has no authoritative state to replay.
 */
export function inspectCanonicalReviewPassRecovery({ state } = {}) {
  void state;
  return null;
}

function guardFailure(ctx) {
  const missing = missingExactTargetGuardNames(ctx, ctx.flowState);
  return missing.length === 0
    ? null
    : Envelope.fail(
      "run",
      "recover-review-pass",
      "REVIEW_PASS_RECOVERY_GUARDS_REQUIRED",
      `canonical review PASS recovery requires ${missing.join(", ")}`,
    );
}

export default class RunRecoverReviewPassCommand extends FlowCommand {
  execute(ctx) {
    const guarded = guardFailure(ctx);
    if (guarded) return guarded;
    if (!isCanonicalFlowState(ctx.flowState)) {
      return Envelope.fail(
        "run",
        "recover-review-pass",
        "CANONICAL_REVIEW_REQUIRED",
        "review PASS recovery requires a Version-1 Flow.",
      );
    }
    return Envelope.fail(
      "run",
      "recover-review-pass",
      "REVIEW_PASS_RECOVERY_NOT_ELIGIBLE",
      "Version-1 review results are atomic catalog publications and do not require PASS projection recovery.",
    );
  }
}
