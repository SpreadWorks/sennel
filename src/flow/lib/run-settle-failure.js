import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { FlowCommand } from "./base-command.js";

/**
 * Execute the definition-owned terminal continuation for a failed Attempt.
 * Record and rewind share this command because their route is selected only
 * from CurrentFailureDisposition; gate-specific repairs remain evidence
 * commands and are never inferred here.
 */
export default class RunSettleFailureCommand extends FlowCommand {
  constructor() {
    super({ explicitTargetResolution: true });
  }

  execute(ctx) {
    const projectedState = ctx.flowState;
    if (projectedState?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || typeof ctx.flowManager?.canonicalState !== "function") {
      return Envelope.fail(
        "run",
        "settle-failure",
        "CANONICAL_FLOW_REQUIRED",
        "settling a failed Attempt requires a Version-1 Flow",
      );
    }
    const state = ctx.flowManager.canonicalState(ctx.specId ?? projectedState.specId);
    const missingProducerArtifactRoute = typeof ctx.flowManager.missingProducerArtifactRoute === "function"
      ? ctx.flowManager.missingProducerArtifactRoute({ specId: state?.specId })
      : null;
    if (missingProducerArtifactRoute !== null) {
      const historical = missingProducerArtifactRoute.kind === "historical-consumer";
      return Envelope.fail(
        "run",
        "settle-failure",
        "CANONICAL_PRODUCER_ARTIFACT_NOT_READY",
        historical
          ? "a historical consumer claim lacks its required producer artifact; use the typed recovery command instead of settlement"
          : "the failed producer Attempt lacks its required consumer artifact; settlement is blocked until explicit evidence-based recovery is available",
        {
          producerNodeId: missingProducerArtifactRoute.producerNodeId,
          consumerNodeId: missingProducerArtifactRoute.consumerNodeId,
          ...(historical && { recoveryCommand: "sennel flow run recover-missing-producer-artifact" }),
        },
      );
    }
    const descriptor = state?.nextAction() ?? null;
    if (descriptor === null || !["record", "rewind"].includes(descriptor.operation)) {
      return Envelope.fail(
        "run",
        "settle-failure",
        "CANONICAL_FAILURE_SETTLEMENT_UNAVAILABLE",
        "the current Flow has no definition-owned failed Attempt settlement",
      );
    }
    try {
      const settled = ctx.flowManager.settleCurrentFailure({ specId: state.specId });
      if (settled === null) {
        throw new Error("canonical failed Attempt changed before settlement");
      }
      return Envelope.ok("run", "settle-failure", {
        operation: descriptor.operation,
        previousStep: state.current.at(-1),
        nextStep: descriptor.failureDisposition.targetPath?.at(-1) ?? null,
      });
    } catch (error) {
      return Envelope.fail(
        "run",
        "settle-failure",
        error.code || "CANONICAL_FAILURE_SETTLEMENT_FAILED",
        error.message,
      );
    }
  }
}
