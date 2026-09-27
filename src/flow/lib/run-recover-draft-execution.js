import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { FlowCommand } from "./base-command.js";
import { DraftWorkerRecoveryRefusal } from "../definition.js";
import { CurrentFlowStateConflictError } from "./current-flow-state.js";
import { FlowDispatchTarget } from "./dispatch-invocation.js";
import { WorkerArtifactHandoffError } from "./worker-artifact-handoff.js";

/** Explicitly reconcile one proven legacy conditional Draft checkpoint. */
export default class RunRecoverDraftExecutionCommand extends FlowCommand {
  constructor() { super({ requiresFlow: true, explicitTargetResolution: true }); }

  execute(ctx) {
    if (ctx.flowState?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION
      || typeof ctx.flowManager?.recoverLegacyDraftWorkerExecution !== "function") {
      return Envelope.fail("run", "recover-draft-execution", "CANONICAL_FLOW_REQUIRED",
        "Draft execution recovery requires a canonical Flow");
    }
    try {
      const target = FlowDispatchTarget.captureContext(ctx);
      const recovered = ctx.flowManager.recoverLegacyDraftWorkerExecution({
        specId: ctx.specId,
        executionRoot: ctx.executionRoot || ctx.root,
        targetDigest: target.digest,
      });
      const state = recovered.state;
      return Envelope.ok("run", "recover-draft-execution", {
        step: state.current?.at(-1) ?? null,
        attemptId: state.attempt?.id ?? null,
        attempt: state.attempt?.sequence ?? null,
        executionGeneration: recovered.receipt.executionLifecycle.executionGeneration,
      });
    } catch (error) {
      if (!(error instanceof DraftWorkerRecoveryRefusal)
        && !(error instanceof CurrentFlowStateConflictError)
        && !(error instanceof WorkerArtifactHandoffError)) throw error;
      return Envelope.fail("run", "recover-draft-execution",
        error.code || "CANONICAL_DRAFT_EXECUTION_RECOVERY_FAILED", error.message);
    }
  }
}
