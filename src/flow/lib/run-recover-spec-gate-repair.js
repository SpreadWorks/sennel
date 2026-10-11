import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { FlowDispatchTarget } from "./dispatch-invocation.js";
import { SpecGateRepairRecoveryRefusal } from "./spec-gate-repair-recovery.js";
import { CurrentFlowStateConflictError } from "./current-flow-state-conflict-error.js";
import { WorkerArtifactHandoffError } from "./worker-artifact-handoff.js";

export default class RunRecoverSpecGateRepairCommand extends FlowCommand {
  constructor() { super({ requiresFlow: true, explicitTargetResolution: true }); }
  execute(ctx) {
    try {
      if (ctx.preview === true ? ctx.previewDigest !== undefined
        : typeof ctx.previewDigest !== "string" || !/^[a-f0-9]{64}$/.test(ctx.previewDigest)) {
        throw new SpecGateRepairRecoveryRefusal("Choose --preview or supply exactly one --preview-digest SHA-256");
      }
      const target = FlowDispatchTarget.captureContext(ctx);
      const input = { specId: ctx.specId, executionRoot: ctx.executionRoot || ctx.root, targetDigest: target.digest };
      if (ctx.preview === true) {
        return Envelope.ok("run", "recover-spec-gate-repair", {
          preview: true, ...ctx.flowManager.previewSpecGateRepairRecovery(input).toJSON(), workerStarted: false,
        });
      }
      const recovered = ctx.flowManager.recoverSpecGateRepair({ ...input, previewDigest: ctx.previewDigest });
      return Envelope.ok("run", "recover-spec-gate-repair", { recovered: true, replayed: recovered.replayed,
        receipt: recovered.receipt.toJSON?.() ?? recovered.receipt, workerStarted: false,
        step: recovered.state.current.at(-1), attemptId: recovered.state.attempt.id });
    } catch (error) {
      if (!(error instanceof SpecGateRepairRecoveryRefusal) && !(error instanceof CurrentFlowStateConflictError)
        && !(error instanceof WorkerArtifactHandoffError)) throw error;
      return Envelope.fail("run", "recover-spec-gate-repair", error.code, error.message);
    }
  }
}
