import { runGit } from "../../../lib/git-helpers.js";
import { isDeepStrictEqual } from "node:util";
import { StepRegistration } from "./step-registration.js";
import { StepExecutionContract } from "./step-execution-contract.js";
import { ImplStepBinding } from "../connectors/impl/impl-step-binding.js";
import { NonGateTargetBinding } from "../../lib/non-gate-transition.js";
import { FinalizationExecutionIdentity } from "../../lib/finalization-execution-identity.js";
import { finalizationOutboxIdentity, FlowOutboxStore } from "../../lib/flow-outbox.js";
import { FinalizeFlowStateOwner } from "../../lib/finalize-flow-state-owner.js";
import { AcceptanceReceiptReplay } from "../../lib/acceptance-receipt-replay.js";
import { StepAdmissionRefusal, isStepAdmissionRefusal } from "../../lib/step-admission-refusal.js";
import { FlowDispatchAuthorization, ExplicitFlowDispatchAuthorization } from "../../lib/dispatch-invocation.js";
import { FinalizationRecoveryDecision } from "../../definition.js";
import { BlockedDirective } from "../../lib/next-action-directive.js";
import { CurrentFlowStateConflictError } from "../../lib/current-flow-state-conflict-error.js";
import { FinalizationSettlementWriter } from "../../services/finalization-settlement-writer.js";
import { FinalizeCommitStep } from "../../steps/finalize/finalize-commit.js";
import { FinalizeMergeStep } from "../../steps/finalize/finalize-merge.js";
import { FinalizeSyncStep } from "../../steps/finalize/finalize-sync.js";
import { FinalizeCleanupStep } from "../../steps/finalize/finalize-cleanup.js";
import { FinalizeCommitService } from "../../services/finalize-commit-service.js";
import { FinalizeMergeService } from "../../services/finalize-merge-service.js";
import { FinalizeSyncService } from "../../services/finalize-sync-service.js";
import { FinalizeCleanupService } from "../../services/finalize-cleanup-service.js";
import { FinalizeCommitInput } from "../../services/finalize-commit-input.js";
import { FinalizeMergeInput } from "../../services/finalize-merge-input.js";
import { FinalizeSyncInput } from "../../services/finalize-sync-input.js";
import { FinalizeCleanupInput } from "../../services/finalize-cleanup-input.js";
import { FinalizeCommitResultEvidence, FinalizeMergeResultEvidence,
  FinalizeSyncResultEvidence, FinalizeCleanupResultEvidence } from "../../steps/finalize/finalization-values.js";

export class FinalizationPreparation {
  constructor({ binding, observed, evidence, commandResult, finalizationPublication, operationOwnerToken = null }) {
    if (!(binding instanceof ImplStepBinding) || observed.stepId !== binding.stepId) {
      throw new TypeError("Finalization preparation requires its acquired source input");
    }
    Object.assign(this, { binding, observed, evidence, commandResult, finalizationPublication, operationOwnerToken });
    Object.freeze(this);
  }
}

function expectedRef(root, branch) {
  if (!branch) return null;
  const result = runGit(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: root });
  if (!result.ok) throw new StepAdmissionRefusal(`Unable to acquire finalization Git ref ${branch}`);
  return result.stdout.trim();
}

function acquiredAuthorization(ctx, state, stepId) {
  const authorization = ctx.finalizationAuthorization;
  if (authorization === undefined || authorization === null) {
    return { approval: null, authorization: state.nextAction() };
  }
  if (!(authorization instanceof FlowDispatchAuthorization)
    || authorization.action.target.runId !== state.runId
    || authorization.action.target.specId !== null && authorization.action.target.specId !== state.specId
    || authorization.action.nextAction.step !== stepId
    || !authorization.isGrantedBy(ctx.flowManager.loadReadOnly(state.specId))) {
    throw new StepAdmissionRefusal("Finalization dispatch authorization differs from its selected canonical action");
  }
  return {
    approval: authorization instanceof ExplicitFlowDispatchAuthorization
      ? authorization.toReceiptJSON() : authorization.approved ? authorization.toJSON() : null,
    authorization: { ...authorization.toJSON(), action: authorization.action.toJSON() },
  };
}

function isFinalizationAdmissionError(error) {
  return isStepAdmissionRefusal(error) || [
    "REPOSITORY_FLOW_OPERATION_BUSY", "REPOSITORY_MAINTENANCE_BUSY", "FINALIZE_PREFLIGHT_FAILED",
    "FINALIZE_MERGE_EXTERNAL_DIRTY",
  ].includes(error?.code);
}

class FinalizationProjectionPreparation {
  constructor(saved) {
    this.saved = saved;
    Object.freeze(this);
  }
  get directive() {
    if (this.saved.settlement.kind !== "await") return null;
    return new BlockedDirective({ code: "FINALIZATION_PR_AWAIT_MERGE",
      reason: "The recorded pull request awaits merge before finalization can continue.",
      resumeInstruction: "Wait for the pull request to merge, then resume through the authorized post-merge workflow." });
  }
}

/** Acquire external state before constructing a Step or its private Service. */
export function prepareFinalizationExecution({ ctx, stepId, commandResult = null, failure = null, execution = null, recovery = null }) {
  const flowManager = ctx.flowManager;
  const state = flowManager.canonicalState(ctx.specId ?? ctx.flowState.specId);
  const outboxIdentity = finalizationOutboxIdentity(state, stepId);
  const entry = new FlowOutboxStore(flowManager, { specId: state.specId,
    operationOwnerToken: ctx.repositoryOperationOwnerToken ?? null }).status(outboxIdentity);
  const owner = FinalizeFlowStateOwner.fromContext(ctx);
  const root = ctx.executionRoot ?? ctx.root;
  if (recovery !== null && (!(recovery instanceof FinalizationRecoveryDecision)
    || recovery.operation !== "exact-outbox-recovery" || recovery.facts.target.stepId !== stepId
    || recovery.facts.outbox.idempotencyKey !== outboxIdentity.idempotencyKey
    || entry?.status !== "pending" || entry.exactRecoveryReceipt === null
    || entry.exactRecoveryReceipt.attempt !== recovery.facts.outbox.attempt)) {
    throw new StepAdmissionRefusal("Finalization recovery preparation requires the Definition-selected reopened exact outbox");
  }
  const binding = new ImplStepBinding({ flowManager, specId: state.specId, stepId,
    allowFailed: failure !== null || recovery !== null });
  const identity = new NonGateTargetBinding({ runId: state.runId, specId: state.specId, stepId, attempt: binding.attempt });
  if (execution === null && recovery === null && failure === null && commandResult === null) {
    const saved = flowManager.readCurrentStepSettlement({ specId: state.specId, stepId });
    if (saved?.result.execution instanceof FinalizationExecutionIdentity
      && isDeepStrictEqual(saved.result.execution.identity.toJSON(), identity.toJSON())) execution = saved.result.execution;
  }
  if (execution === null && stepId === "finalize-cleanup" && ctx.finalizationEffectPreparation?.resumed === true) {
    execution = ctx.finalizationEffectPreparation.executionForBinding(binding);
  }
  if (execution !== null) {
    if (!(execution instanceof FinalizationExecutionIdentity)
      || !isDeepStrictEqual(execution.identity.toJSON(), identity.toJSON())
      || !execution.outboxIdentity?.equals(outboxIdentity)
      || execution.claim?.attempt !== entry?.attempt || execution.claim?.idempotencyKey !== entry?.idempotencyKey) {
      throw new StepAdmissionRefusal("Finalization completed observation differs from its original execution claim");
    }
    execution = new FinalizationExecutionIdentity({ ...execution.toJSON(), identity,
      mainAuthority: { mainRoot: owner.mainRepoPath, authorityRoot: owner.authorityRoot },
      journal: ctx.finalizationJournal ?? execution.journal });
  } else {
    const authority = acquiredAuthorization(ctx, state, stepId);
    execution = new FinalizationExecutionIdentity({ identity, outboxIdentity, ...authority,
      expectedBaseSha: expectedRef(owner.mainRepoPath, state.execution.baseBranch),
      expectedFeatureSha: expectedRef(root, state.execution.featureBranch),
      mainAuthority: { mainRoot: owner.mainRepoPath, authorityRoot: owner.authorityRoot },
      journal: ctx.finalizationJournal ?? null,
      claim: entry === null ? null : { attempt: entry.attempt, idempotencyKey: entry.idempotencyKey },
      publication: flowManager.readCurrentStepSettlement({ specId: state.specId, stepId: "report", completed: true })?.receipt.toJSON() ?? null });
  }
  const observation = { identity, execution, commandResult };
  let evidence;
  let observed;
  if (stepId === "finalize-commit") {
    evidence = new FinalizeCommitResultEvidence(observation);
    observed = new FinalizeCommitInput({ evidence: failure === null ? evidence : null, failure });
  } else if (stepId === "finalize-merge") {
    evidence = new FinalizeMergeResultEvidence(observation);
    observed = new FinalizeMergeInput({ evidence: failure === null ? evidence : null, failure });
  } else if (stepId === "finalize-sync") {
    evidence = new FinalizeSyncResultEvidence(observation);
    observed = new FinalizeSyncInput({ evidence: failure === null ? evidence : null, failure });
  } else if (stepId === "finalize-cleanup") {
    evidence = new FinalizeCleanupResultEvidence(observation);
    observed = new FinalizeCleanupInput({ evidence: failure === null ? evidence : null, failure });
  } else throw new TypeError("Finalization preparation requires a registered leaf");
  const finalizationPublication = flowManager.prepareFinalizationCommandPublication({ binding, evidence, commandResult });
  return new FinalizationPreparation({ binding, observed, evidence, commandResult, finalizationPublication,
    operationOwnerToken: ctx.repositoryOperationOwnerToken ?? null });
}

export function prepareFinalizeCommitServiceArguments(input) {
  const acquired = input.preparation;
  return [new FinalizeCommitInput(acquired.observed), new FinalizationSettlementWriter({
    flowManager: input.flowManager ?? input.ctx.flowManager, ...acquired })];
}
export function prepareFinalizeMergeServiceArguments(input) {
  const acquired = input.preparation;
  return [new FinalizeMergeInput(acquired.observed), new FinalizationSettlementWriter({
    flowManager: input.flowManager ?? input.ctx.flowManager, ...acquired })];
}
export function prepareFinalizeSyncServiceArguments(input) {
  const acquired = input.preparation;
  return [new FinalizeSyncInput(acquired.observed), new FinalizationSettlementWriter({
    flowManager: input.flowManager ?? input.ctx.flowManager, ...acquired })];
}
export function prepareFinalizeCleanupServiceArguments(input) {
  const acquired = input.preparation;
  return [new FinalizeCleanupInput(acquired.observed), new FinalizationSettlementWriter({
    flowManager: input.flowManager ?? input.ctx.flowManager, ...acquired })];
}

export class FinalizationExecutionSelection {
  constructor({ state, stepId, registration, binding, preparation, receipt }) {
    if (registration?.stepId !== stepId || registration.executionContract !== finalizationStepExecutionContract) {
      throw new StepAdmissionRefusal("Finalization selection requires its exact registration");
    }
    this.runId = state.runId;
    this.specId = state.specId;
    this.stepId = stepId;
    this.registration = registration;
    this.binding = binding;
    this.preparation = preparation;
    this.receipt = receipt;
    Object.freeze(this);
  }
  get directive() { return this.preparation instanceof FinalizationProjectionPreparation ? this.preparation.directive : null; }
}

export function selectFinalizationExecution(input) {
  const flowManager = input.flowManager ?? input.ctx.flowManager;
  const specId = input.specId ?? input.ctx?.specId ?? input.ctx?.flowState?.specId;
  const state = flowManager.canonicalState(specId);
  const suppliedReceipt = input.receipt instanceof AcceptanceReceiptReplay ? input.receipt.receipt : input.receipt;
  const receipt = suppliedReceipt == null ? null : new AcceptanceReceiptReplay({ flowManager, specId,
    stepId: input.stepId, receipt: suppliedReceipt, completed: suppliedReceipt.settlementKind !== "execution" });
  let preparation = input.preparation ?? null;
  const binding = input.binding ?? preparation?.binding ?? null;
  if (preparation === null && receipt === null && input.command === undefined) {
    const saved = flowManager.readCurrentStepSettlement({ specId, stepId: input.stepId });
    if (saved?.settlement.kind === "await") preparation = new FinalizationProjectionPreparation(saved);
  }
  if (preparation !== null && !(preparation instanceof FinalizationProjectionPreparation)) {
    preparation.binding.assertCurrent();
    if (preparation.binding.stepId !== input.stepId) throw new StepAdmissionRefusal("Finalization preparation belongs to another leaf");
  } else if (receipt === null && input.command !== undefined) {
    const saved = flowManager.readCurrentStepSettlement({ specId, stepId: input.stepId });
    if (saved?.settlement.kind === "await") throw new StepAdmissionRefusal("The saved finalization Result awaits pull-request merge");
    const action = state.nextAction();
    if (state.lifecycle.state !== "active" || state.current?.at(-1) !== input.stepId && action?.nodeId !== input.stepId) {
      throw new StepAdmissionRefusal("Finalization direct execution differs from the selected Action");
    }
  }
  return new FinalizationExecutionSelection({ state, stepId: input.stepId, registration: input.registration,
    binding, preparation, receipt });
}

export function projectFinalizationExecution(selection) { return selection; }

export async function executeFinalizationSelection(selection, input) {
  if (!(selection instanceof FinalizationExecutionSelection) || selection.registration !== input.registration
    || selection.stepId !== input.registration.stepId) {
    throw new StepAdmissionRefusal("Finalization execution requires its exact selected registration");
  }
  if (selection.receipt !== null) { selection.receipt.assertCurrent(); return selection.receipt.receipt; }
  if (selection.binding === null || selection.preparation === null) {
    throw new StepAdmissionRefusal("Finalization settlement requires its bound preparation");
  }
  selection.binding.assertCurrent();
  const prepared = await input.registration.create({
    flowManager: input.flowManager, binding: selection.binding,
    preparation: selection.preparation, commandResult: input.commandResult,
  });
  await prepared.step.execute();
  return prepared.dependency(input.registration.ServiceClass).settlementOutcome;
}

/** Effects run outside the typed Step/Service adoption boundary. */
export async function executeFinalizationCommand({ ctx, stepId, command, executeInput }) {
  if (stepId === "finalize-cleanup") {
    const owner = FinalizeFlowStateOwner.forMainContext(ctx);
    const completed = owner.flowManager.readCurrentStepSettlement({
      specId: owner.specId, stepId, completed: true,
    });
    if (completed?.settlement.kind === "completion") {
      const replayContext = owner.bindContext({ ...ctx, flowState: owner.loadReadOnly() });
      const receipt = await executeInput({
        ctx: replayContext, flowManager: owner.flowManager, stepId, receipt: completed.receipt,
      });
      return command.projectCompletedReceipt(replayContext, receipt);
    }
  }
  const effectPreparation = ctx.finalizationEffectPreparation ?? await command.prepareEffect?.(ctx);
  ctx.finalizationEffectPreparation = effectPreparation;
  const specId = ctx.specId ?? ctx.flowState.specId;
  const saved = ctx.flowManager.readCurrentStepSettlement({ specId, stepId });
  if (saved?.settlement.kind === "await") throw new StepAdmissionRefusal("The saved finalization Result awaits pull-request merge");
  let execution = saved?.result.execution ?? null;
  if (execution instanceof FinalizationExecutionIdentity) {
    const binding = new ImplStepBinding({ flowManager: ctx.flowManager, specId, stepId });
    binding.assertCurrent();
    const identity = new NonGateTargetBinding({ runId: binding.runId, specId, stepId, attempt: binding.attempt });
    if (!isDeepStrictEqual(execution.identity.toJSON(), identity.toJSON())
      || ctx.finalizationExecution != null && !isDeepStrictEqual(ctx.finalizationExecution.toJSON(), execution.toJSON())) {
      throw new StepAdmissionRefusal("Finalization execution checkpoint belongs to another source Attempt");
    }
  } else {
    const pending = prepareFinalizationExecution({ ctx, stepId });
    await executeInput({ ctx, flowManager: ctx.flowManager, stepId, preparation: pending });
    execution = pending.evidence.execution;
  }
  ctx.finalizationExecution = execution;
  const report = ctx.flowManager.readCurrentStepSettlement({ specId, stepId: "report", completed: true });
  if (report === null || !isDeepStrictEqual(report.receipt.toJSON(), execution.publication)) {
    throw new StepAdmissionRefusal("Finalization execution report publication changed after its original checkpoint");
  }
  if (ctx.finalizationAuthorization instanceof FlowDispatchAuthorization) acquiredAuthorization(ctx,
    ctx.flowManager.canonicalState(specId), stepId);
  if (effectPreparation?.resumed !== true) {
    const owner = FinalizeFlowStateOwner.fromContext(ctx);
    const state = ctx.flowManager.canonicalState(specId);
    if (expectedRef(owner.mainRepoPath, state.execution.baseBranch) !== execution.expectedBaseSha
      || expectedRef(ctx.executionRoot ?? ctx.root, state.execution.featureBranch) !== execution.expectedFeatureSha) {
      throw new StepAdmissionRefusal("Finalization Git refs changed after its original execution checkpoint");
    }
  }
  try { effectPreparation?.assertCurrent(ctx); }
  catch (error) {
    if (isStepAdmissionRefusal(error)) throw error;
    const refusal = new StepAdmissionRefusal(error.message, error);
    refusal.code = error.code;
    throw refusal;
  }
  try {
    return await command.executeEffect(ctx, effectPreparation);
  } catch (error) {
    if ((isFinalizationAdmissionError(error) || error instanceof CurrentFlowStateConflictError) && !isStepAdmissionRefusal(error)) {
      const refusal = new StepAdmissionRefusal(error.message, error);
      refusal.code = error.code;
      throw refusal;
    }
    throw error;
  }
}

export const finalizationStepExecutionContract = new StepExecutionContract({
  select: selectFinalizationExecution, project: projectFinalizationExecution, execute: executeFinalizationSelection,
});
export const finalizationStepRegistrations = Object.freeze([
  new StepRegistration({ stepId: "finalize-commit", StepClass: FinalizeCommitStep, ServiceClass: FinalizeCommitService,
    prepareServiceArguments: prepareFinalizeCommitServiceArguments, executionContract: finalizationStepExecutionContract }),
  new StepRegistration({ stepId: "finalize-merge", StepClass: FinalizeMergeStep, ServiceClass: FinalizeMergeService,
    prepareServiceArguments: prepareFinalizeMergeServiceArguments, executionContract: finalizationStepExecutionContract }),
  new StepRegistration({ stepId: "finalize-sync", StepClass: FinalizeSyncStep, ServiceClass: FinalizeSyncService,
    prepareServiceArguments: prepareFinalizeSyncServiceArguments, executionContract: finalizationStepExecutionContract }),
  new StepRegistration({ stepId: "finalize-cleanup", StepClass: FinalizeCleanupStep, ServiceClass: FinalizeCleanupService,
    prepareServiceArguments: prepareFinalizeCleanupServiceArguments, executionContract: finalizationStepExecutionContract }),
]);
const byId = new Map(finalizationStepRegistrations.map((registration) => [registration.stepId, registration]));
export function finalizationStepRegistration(stepId) { return byId.get(stepId) ?? null; }

export function consumeFinalizationExecution(input) {
  const registration = finalizationStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Finalization consumption requires its registered Step");
  const selection = input.selection;
  return registration.executionContract.execute(selection, { ...input, registration });
}
