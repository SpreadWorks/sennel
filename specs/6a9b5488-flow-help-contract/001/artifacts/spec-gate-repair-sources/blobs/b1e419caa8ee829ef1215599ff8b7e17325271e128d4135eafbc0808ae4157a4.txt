import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { FlowCommand } from "./base-command.js";
import { settleDefinitionReviewTransition } from "./review-transition-persistence.js";

/**
 * Materialize a Review disposition which definition.js already selected from
 * persisted facts. This command has no route/result arguments and cannot
 * execute a review or choose a retry policy.
 */
export default class RunSettleReviewTransitionCommand extends FlowCommand {
  constructor() {
    super({ explicitTargetResolution: true });
  }

  execute(ctx) {
    if (ctx.flowState?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || typeof ctx.flowManager?.canonicalState !== "function") {
      return Envelope.fail("run", "settle-review-transition", "CANONICAL_FLOW_REQUIRED", "settling a Review transition requires a Version-1 Flow");
    }
    try {
      const settled = settleDefinitionReviewTransition(ctx);
      if (settled === null) {
        return Envelope.fail(
          "run",
          "settle-review-transition",
          "REVIEW_TRANSITION_SETTLEMENT_UNAVAILABLE",
          "the active review has no definition-selected transition to settle",
        );
      }
      return Envelope.ok("run", "settle-review-transition", settled);
    } catch (error) {
      return Envelope.fail(
        "run",
        "settle-review-transition",
        error.code || "REVIEW_TRANSITION_SETTLEMENT_FAILED",
        error.message,
      );
    }
  }
}
