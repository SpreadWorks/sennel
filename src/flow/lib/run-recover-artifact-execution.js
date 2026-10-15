import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { FlowHandoffAuthorityLease } from "../../lib/flow-handoff-authority-lease.js";
import { WorkerArtifactHandoffCoordinator } from "./worker-artifact-handoff.js";
import { isStepAdmissionRefusal } from "./step-admission-refusal.js";
import { ProcessExecutionControlFailure } from "../../lib/process-execution-values.js";
import { PromptBatchingError } from "../../lib/prompt-batching.js";
import { dispatchRepositoryFingerprint, workerFacingNextAction } from "./run-dispatch.js";
import { FlowDispatchTarget, FlowDispatchSession, FlowDispatchInvocation, UnapprovedFlowDispatchAuthorization } from "./dispatch-invocation.js";
import { OriginalArtifactWorkerAuthorization } from "./original-artifact-worker-authorization.js";
import { ArtifactWorkerResponseAvailable } from "./artifact-worker-execution-recovery.js";
import { selectWorkerExecutionAdmission } from "./worker-execution-admission.js";
import { ArtifactWorkerSealedReplay } from "./artifact-worker-execution-continuation.js";

/** Apply the Definition-selected recovery without invoking a provider. */
export default class RunRecoverArtifactExecutionCommand extends FlowCommand {
  constructor() { super({ requiresFlow: true, explicitTargetResolution: true }); }
  async execute(ctx) {
    const lease = new FlowHandoffAuthorityLease({ mainRoot: ctx.mainRoot || ctx.root,
      executionRoot: ctx.executionRoot || ctx.root });
    lease.acquire();
    try {
      const receipt = await new WorkerArtifactHandoffCoordinator().recoverArtifactExecution({ ctx,
        createRecoveryInvocation(request, id) {
          const session = new FlowDispatchSession({ id, target: FlowDispatchTarget.captureContext(ctx) });
          const action = session.captureAction(workerFacingNextAction(request.invocation.action.nextAction), dispatchRepositoryFingerprint(ctx));
          return new FlowDispatchInvocation({ session, action, authorization: new UnapprovedFlowDispatchAuthorization(action) });
        } });
      if (receipt instanceof OriginalArtifactWorkerAuthorization) return Envelope.ok("run", "recover-artifact-execution", {
        authorizationId: receipt.id, step: receipt.executionContract.stepId,
        executionContractId: receipt.executionContract.id, executionGeneration: receipt.executionContract.generation,
        runtimeMigration: false,
      });
      return Envelope.ok("run", "recover-artifact-execution", {
        recoveryReceiptId: receipt.id, step: receipt.targetContract.stepId,
        sourceContractId: receipt.sourceContractId, targetContractId: receipt.targetContractId,
        executionGeneration: receipt.targetGeneration,
        runtimeMigration: receipt.evidence.migratesRuntime,
      });
    } catch (error) {
      if (error instanceof ArtifactWorkerResponseAvailable) {
        const state = ctx.flowManager.canonicalState(ctx.specId ?? ctx.flowState.specId);
        const selection = selectWorkerExecutionAdmission({ ctx, stepId: state.attempt.nodeId });
        if (selection.artifactContinuation instanceof ArtifactWorkerSealedReplay) {
          return Envelope.ok("run", "recover-artifact-execution", { replaySelected: true,
            executionContractId: selection.artifactContinuation.contractId });
        }
      }
      if (!isStepAdmissionRefusal(error) && !(error instanceof ProcessExecutionControlFailure)
        && !(error instanceof PromptBatchingError)) throw error;
      return Envelope.fail("run", "recover-artifact-execution", error.code, error.message,
        { retryable: false, recoveryPossible: false, missingConditions: ["authenticated-recovery-admission"] });
    } finally { lease.release(); }
  }
}
