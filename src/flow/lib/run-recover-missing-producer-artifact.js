import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { FlowCommand } from "./base-command.js";

/** Repair only the historical consumer-claim-before-producer-output defect. */
export default class RunRecoverMissingProducerArtifactCommand extends FlowCommand {
  constructor() {
    super({ explicitTargetResolution: true });
  }

  execute(ctx) {
    if (ctx.flowState?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || typeof ctx.flowManager?.recoverMissingProducerArtifact !== "function") {
      return Envelope.fail(
        "run",
        "recover-missing-producer-artifact",
        "CANONICAL_FLOW_REQUIRED",
        "missing producer artifact recovery requires a Version-1 Flow",
      );
    }
    try {
      const recovered = ctx.flowManager.recoverMissingProducerArtifact({ specId: ctx.specId });
      return Envelope.ok("run", "recover-missing-producer-artifact", {
        step: recovered.current?.at(-1) ?? null,
        attemptId: recovered.attempt?.id ?? null,
        attempt: recovered.attempt?.sequence ?? null,
      });
    } catch (error) {
      return Envelope.fail(
        "run",
        "recover-missing-producer-artifact",
        error.code || "CANONICAL_MISSING_PRODUCER_ARTIFACT_RECOVERY_FAILED",
        error.message,
      );
    }
  }
}
