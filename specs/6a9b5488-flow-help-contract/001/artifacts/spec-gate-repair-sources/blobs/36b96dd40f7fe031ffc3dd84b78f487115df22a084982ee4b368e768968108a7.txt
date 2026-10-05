import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
import { FlowCommand } from "./base-command.js";
import { CanonicalAcceptanceDecision } from "./canonical-acceptance-artifacts.js";
import {
  attachedCanonicalCommandResultArtifact,
  CanonicalCommandAttemptArtifactHistory,
} from "./canonical-command-result.js";
import { resolveDefinitionRoute } from "../definition.js";
import { acceptanceDecisionRouteFacts } from "./definition-route-facts.js";

export default class SetAcceptanceDecisionCommand extends FlowCommand {
  execute(ctx) {
    const choice = ctx.choice;
    if (!choice) throw new Error("usage: flow set acceptance-decision --choice <choice>");
    const state = ctx.flowManager.load();
    if (state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION) {
      throw new Error("acceptance decision requires a Version-1 Flow");
    }
    const result = new CanonicalAcceptanceDecision({
      flowManager: ctx.flowManager,
      state,
      choice,
    }).resolve();
    const typedState = ctx.flowManager.canonicalState(state.specId);
    const review = ctx.flowManager.readArtifact({
      specId: state.specId,
      logicalKey: "acceptance.review",
      consumerNodeId: "acceptance-decision",
    });
    const spec = ctx.flowManager.readArtifact({
      specId: state.specId,
      logicalKey: "spec.record",
      consumerNodeId: "acceptance-decision",
    });
    const decision = attachedCanonicalCommandResultArtifact(result)?.payload;
    const reviewHistory = CanonicalCommandAttemptArtifactHistory.fromBytes({
      logicalKey: "acceptance.review",
      bytes: review.bytes,
    });
    const plan = resolveDefinitionRoute(acceptanceDecisionRouteFacts({
      state: typedState,
      review: reviewHistory.current.payload,
      reviewDescriptor: review.descriptor,
      spec: JSON.parse(spec.bytes.toString("utf8")),
      choice,
      decisionRecord: {
        choice: decision.choice,
        reviewArtifactDigest: decision.acceptanceReviewDigest,
      },
    }));
    plan.apply({
      advanceFinalRegression() {
        ctx.flowManager.updateStepStatus({ stepId: "acceptance-decision", requestedStatus: "done" }, {
          specId: state.specId, canonicalCommandResult: result,
        });
        ctx.flowManager.updateStepStatus({ stepId: "final-regression", requestedStatus: "in_progress" }, { specId: state.specId });
      },
      park() {
        ctx.flowManager.updateStepStatus({ stepId: "acceptance-decision", requestedStatus: "done" }, {
          specId: state.specId, canonicalCommandResult: result,
        });
        ctx.flowManager.parkFlow(state.specId);
      },
    });
    return result;
  }
}
