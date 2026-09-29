import { StepExecutionContract } from "../engine/composition/step-execution-contract.js";
import { deriveNextAction, resolveDraftWorkerCorrection, resolveDraftWorkerRecovery,
  DraftWorkerRecoveryRefusal, SpecGateRepairExecutionStop } from "../definition.js";
import { selectSpecGateRepairExecution } from "./spec-gate-repair-execution.js";
import { DraftLifecycle } from "./draft-lifecycle.js";
import { isConditionalDraftWorkerStep } from "./draft-conditional-worker.js";
import { NextActionPlanError } from "./next-action-plan-error.js";
import { NextActionDirectiveResolver, ExecuteStepDirective, ExecuteCommandDirective,
  BlockedDirective, AwaitDraftQuestionDirective } from "./next-action-directive.js";
import { guardedCommand } from "./guarded-command.js";
import { WorkerArtifactHandoffError } from "./worker-artifact-handoff-error.js";

class WorkerExecutionAdmissionSelection {
  constructor({ state, flowState, descriptor, action, conditionalDisposition, repair, correction, recovery }) {
    this.state = state;
    this.flowState = flowState;
    this.descriptor = descriptor;
    this.action = action;
    this.conditionalDisposition = conditionalDisposition;
    this.repair = repair;
    this.correction = correction;
    this.recovery = recovery;
    Object.freeze(this);
  }
}

/** Canonical reads and Definition decisions shared by display and worker launch. */
export function selectWorkerExecutionAdmission({ ctx, stepId }) {
  const state = ctx.flowManager.canonicalState(ctx.specId ?? ctx.flowState.specId);
  const flowState = ctx.flowManager.loadReadOnly(state.specId);
  const descriptor = state.nextAction();
  if (descriptor === null || descriptor.nodeId !== stepId) {
    throw new NextActionPlanError("NEXT_ACTION_TARGET_MISMATCH", `worker admission requires selected ${stepId}`);
  }
  const conditionalDisposition = stepId === "draft-refine"
    && state.attempt?.nodeId === stepId
    && ["start", "recover", "resume", "retry"].includes(descriptor.operation)
    ? persistedDraftRefineDisposition({ flowManager: ctx.flowManager, typedState: state }) : null;
  const activities = ctx.flowManager.activityLedger(state.specId);
  const correction = resolveDraftWorkerCorrection({ state, activities });
  let recovery = null;
  if (isConditionalDraftWorkerStep(stepId)) {
    try { recovery = resolveDraftWorkerRecovery({ state, activities }); }
    catch (error) { if (!(error instanceof DraftWorkerRecoveryRefusal)) throw error; }
  }
  const repair = stepId === "spec-gate-repair" && state.attempt?.nodeId === stepId
    && ["start", "recover", "resume", "retry"].includes(descriptor.operation)
    ? selectSpecGateRepairExecution({ ctx, state }) : null;
  const derived = deriveNextAction({ scope: "flow", stepId, context: flowState });
  return new WorkerExecutionAdmissionSelection({ state, flowState, descriptor,
    action: derived.action, conditionalDisposition, repair, correction, recovery });
}

export function projectWorkerExecutionAdmission(selection, { binding = null,
  recoveryCommand = null, retryRecoveryPlan = null, missingProducerArtifactRoute = null } = {}) {
  if (!(selection instanceof WorkerExecutionAdmissionSelection)) throw new TypeError("worker projection requires its selection");
  const state = selection.flowState;
  const { correction, recovery } = selection;
  if (correction.exhausted) return new BlockedDirective({
    code: "FLOW_DRAFT_WORKER_CORRECTION_EXHAUSTED",
    reason: `Draft producer correction exhausted after ${correction.used} rejected submissions. Latest diagnostic: ${correction.feedback.code}.`,
    resumeInstruction: "Correct the artifact producer using the retained diagnostics before starting a new authorized Attempt. Do not reset the checkpoint or bypass validation.",
  });
  if (recovery !== null) return new ExecuteCommandDirective({
    actionId: "RECOVER_DRAFT_EXECUTION",
    nextAction: guardedCommand("sennel flow run recover-draft-execution", state, binding),
    instruction: `Verify inputs and recover the retained legacy ${recovery.stepId} checkpoint before resuming dispatch.`,
    reason: "Definition selected the retained unpublished worker claim and its checkpoint on this Attempt.",
  });
  if (selection.repair?.decision instanceof SpecGateRepairExecutionStop) {
    return new BlockedDirective({ code: selection.repair.decision.code,
      reason: selection.repair.decision.reason,
      resumeInstruction: "Restore the exact sealed response for the retained claim before resuming. Do not start a new worker or reset its budget." });
  }
  return draftQuestionDirective(selection.conditionalDisposition)
    ?? conditionalWorkerDirective(selection.conditionalDisposition, { state, binding })
    ?? new NextActionDirectiveResolver({ state, binding, action: selection.action,
      descriptor: selection.descriptor.withConditionalWorkerDisposition(selection.conditionalDisposition),
      recoveryCommand, retryRecoveryPlan, missingProducerArtifactRoute }).resolve();
}

export function assertWorkerExecutionAdmission(selection) {
  if (!(selection instanceof WorkerExecutionAdmissionSelection)) throw new TypeError("worker execution requires its registered selection");
  const directive = projectWorkerExecutionAdmission(selection);
  if (!(directive instanceof ExecuteStepDirective) || selection.state.attempt === null
    || selection.descriptor.operation !== "resume") {
    throw new WorkerArtifactHandoffError("recovery-required", directive.code ?? "FLOW_WORKER_EXECUTION_NOT_ADMITTED",
      directive.reason ?? "worker requires the current Definition-selected active Attempt",
      { retryable: false, recoveryPossible: false });
  }
  return selection;
}

export function assertCurrentWorkerExecutionSelection(selection, current) {
  assertWorkerExecutionAdmission(selection);
  assertWorkerExecutionAdmission(current);
  if (selection.state.runId !== current.state.runId
    || selection.state.specId !== current.state.specId
    || selection.state.attempt.id !== current.state.attempt.id
    || selection.state.attempt.sequence !== current.state.attempt.sequence
    || selection.descriptor.nodeId !== current.descriptor.nodeId
    || selection.action.action !== current.action.action) {
    throw new WorkerArtifactHandoffError("recovery-required", "FLOW_WORKER_EXECUTION_SELECTION_CHANGED",
      "worker execution selection changed before use", { retryable: false, recoveryPossible: false });
  }
  return current;
}

export function executeWorkerExecutionAdmission(selection, input) {
  return input.command.executeSelectedWorker(selection, input);
}

export const workerStepExecutionContract = new StepExecutionContract({
  select: selectWorkerExecutionAdmission,
  project: projectWorkerExecutionAdmission,
  execute: executeWorkerExecutionAdmission,
});
function draftQuestionDirective(disposition) {
  if (disposition?.operation !== "await-user-answer") return null;
  return new AwaitDraftQuestionDirective({
    questionId: disposition.questionId,
    question: disposition.question,
    questionRevision: disposition.questionRevision,
  });
}

function persistedDraftRefineDisposition({ flowManager, typedState }) {
  // A pending Draft Step has no Result or Settlement to project yet. Its
  // ordinary claim must create the Attempt before the Step selects either an
  // execution or Await receipt.
  if (typedState.attempt === null) return null;
  const binding = {
    runId: typedState.runId,
    specId: typedState.specId,
    stepId: "draft-refine",
    attempt: typedState.attempt,
  };
  const projected = flowManager.draftRefineStepState({ binding });
  if (projected.requiresStepSelection) return null;
  const identity = projected.awaitQuestionIdentity();
  if (identity === null) return projected.dispositionForQuestion();
  const source = flowManager.readArtifact({
    specId: typedState.specId,
    logicalKey: "draft",
    consumerNodeId: "draft-refine",
  });
  if (source.descriptor.hash !== identity.sourceDigest
    || source.descriptor.size !== identity.sourceByteLength) {
    throw new NextActionPlanError(
      "DRAFT_AWAIT_RECEIPT_STALE",
      "persisted Draft Await receipt does not bind the canonical Draft revision",
    );
  }
  let draft;
  try {
    draft = new DraftLifecycle(JSON.parse(source.bytes.toString("utf8")));
  } catch (cause) {
    throw new NextActionPlanError("DRAFT_SCHEMA_INVALID", `canonical Draft is invalid: ${cause.message}`);
  }
  const question = draft.questionLedger.nextAwaiting();
  if (question?.id !== identity.questionId || question.revision !== identity.questionRevision) {
    throw new NextActionPlanError(
      "DRAFT_AWAIT_RECEIPT_STALE",
      "persisted Draft Await receipt does not select the canonical pending question",
    );
  }
  return projected.dispositionForQuestion(question);
}

function conditionalWorkerDirective(disposition, { state, binding }) {
  if (disposition === null || disposition.operation === "execute-worker" || disposition.operation === "await-user-answer") return null;
  if (disposition.operation === "blocked") {
    return new BlockedDirective({
      code: "CONDITIONAL_WORKER_NOT_ADMITTED",
      reason: `Definition did not find the canonical input required by ${disposition.stepId}.`,
      resumeInstruction: "Restore the canonical conditional-worker input before retrying this action.",
    });
  }
  return new ExecuteCommandDirective({
    actionId: disposition.operation === "skip-worker"
      ? "SKIP_CONDITIONAL_WORKER"
      : "COMPLETE_CONDITIONAL_WORKER",
    nextAction: guardedCommand("sennel flow run claim-next-action", state, binding),
    instruction: disposition.operation === "skip-worker"
      ? `Settle ${disposition.stepId} as skipped without starting its worker.`
      : `Settle ${disposition.stepId} from its canonical completed input.`,
    reason: "Definition selected the conditional worker lifecycle from canonical persisted facts.",
  });
}
