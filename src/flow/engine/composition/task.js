import { implementationGateStepRegistration } from "./implementation-gate.js";
export { prepareTaskGateServiceArguments } from "./implementation-gate.js";
import { StepRegistration, PreparedStepReplay } from "./step-registration.js";
import { TaskStepBinding } from "../connectors/task/task-step-binding.js";
import { sourceStepRegistration } from "./source-step.js";
import { TaskReviewStep } from "../../steps/task/task-review.js";
import { TaskTriageStep } from "../../steps/task/task-triage.js";
import { TaskReviewService } from "../../services/task-review-service.js";
import { TaskHostFilterService } from "../../services/task-host-filter-service.js";
import { TaskReviewInput } from "../../services/task-review-input.js";
import { TaskHostFilterInput } from "../../services/task-host-filter-input.js";
import { TaskReviewSettlementWriter } from "../../services/task-review-settlement-writer.js";
import { TaskHostFilterSettlementWriter } from "../../services/task-host-filter-settlement-writer.js";
import { reviewStepExecutionContract,
  hostFilterStepExecutionContract, HostFilterReceiptReplay } from "../../lib/execution-admission.js";
import { TaskReviewOperations } from "../../lib/task-review-operations.js";
import { TaskReviewExecutionRequiredResult } from "../step-result.js";

export function prepareTaskReviewServiceArguments(input) {
  const flowManager = input.flowManager ?? input.ctx.flowManager;
  const specId = input.specId ?? input.ctx?.specId ?? input.ctx?.flowState?.specId;
  if (input.commandResult != null) {
    const replay = flowManager.readReviewPublicationReplay({ specId, commandResult: input.commandResult });
    if (replay !== null) return new PreparedStepReplay(replay);
  }
  const binding = input.binding ?? new TaskStepBinding({ flowManager, specId,
    definitionStepId: "task-review" });
  binding.assertCurrent();
  if (input.reviewFailurePublication != null) return [new TaskReviewInput({ failure: input.reviewFailurePublication.observation }),
    new TaskReviewSettlementWriter({ flowManager, binding, failurePublication: input.reviewFailurePublication })];
  const publication = input.manifest == null ? input.taskStagePublication
    ?? (input.publicationError != null
      ? flowManager.prepareTaskReviewPublicationUnavailable({ specId, commandResult: input.commandResult, error: input.publicationError })
      : input.checkpoint == null
        ? flowManager.prepareTaskReviewStagePublication({ specId: binding.specId, commandResult: input.commandResult })
        : flowManager.prepareTaskReviewUnavailablePublication({ specId: binding.specId, checkpoint: input.checkpoint, decision: input.decision })) : null;
  if (publication?.completed === true) return new PreparedStepReplay(publication);
  return [new TaskReviewInput({ facts: publication?.facts ?? null, frontier: publication?.taskFrontier ?? null, manifest: input.manifest ?? null }),
    new TaskReviewSettlementWriter({ flowManager, binding, publication,
      executionBinding: input.executionBinding ?? null, manifest: input.manifest ?? null })];
}

export function prepareTaskHostFilterServiceArguments(input) {
  const flowManager = input.flowManager ?? input.ctx.flowManager;
  const specId = input.specId ?? input.ctx?.specId ?? input.ctx?.flowState?.specId;
  const binding = input.binding ?? new TaskStepBinding({ flowManager, specId,
    definitionStepId: "task-triage" });
  binding.assertCurrent();
  const acquiredAuthority = input.authority ?? input.preparation?.authority ?? null;
  const acquiredPublication = input.taskStagePublication ?? input.preparation?.taskStagePublication ?? null;
  if (acquiredAuthority !== null && acquiredPublication === null) return [new TaskHostFilterInput({ authority: acquiredAuthority }),
    new TaskHostFilterSettlementWriter({ flowManager, binding })];
  const publication = acquiredPublication ?? flowManager.prepareTaskReviewHostFilterPublication({
    ...input, specId: binding.specId });
  return [new TaskHostFilterInput({ facts: publication.facts, filter: publication.filter, frontier: publication.taskFrontier }),
    new TaskHostFilterSettlementWriter({ flowManager, binding, publication })];
}


export const taskStepRegistrations = Object.freeze([
  sourceStepRegistration("task-impl"),
  new StepRegistration({ stepId: "task-review", StepClass: TaskReviewStep,
    ServiceClass: TaskReviewService, prepareServiceArguments: prepareTaskReviewServiceArguments,
    executionContract: reviewStepExecutionContract }),
  new StepRegistration({ stepId: "task-triage", StepClass: TaskTriageStep,
    ServiceClass: TaskHostFilterService, prepareServiceArguments: prepareTaskHostFilterServiceArguments,
    executionContract: hostFilterStepExecutionContract }),
  sourceStepRegistration("task-repair"),
  implementationGateStepRegistration("task-gate"),
]);

const byId = new Map(taskStepRegistrations.map((registration) => [registration.stepId, registration]));
export function taskStepRegistration(stepId) { return byId.get(stepId) ?? null; }

export async function claimTaskReviewExecution(input) {
  const claim = TaskReviewOperations.prepareExecutionClaim(input);
  if (claim.needsCheckpoint) {
    const prepared = await taskStepRegistration("task-review").create({
      flowManager: input.flowManager, binding: claim.binding,
      executionBinding: claim.executionBinding, manifest: input.manifest,
    });
    const result = await prepared.step.execute();
    if (!(result instanceof TaskReviewExecutionRequiredResult)) {
      throw new Error("Task Review Step did not select its execution Result");
    }
  }
  return TaskReviewOperations.commitExecutionClaim(claim);
}

export async function completeTaskReviewPublication(input) {
  const prepared = await taskStepRegistration("task-review").create(input);
  if (prepared.completed === true) return prepared;
  const result = await prepared.step.execute();
  return prepared.dependency(TaskReviewService).settlementOutcome ?? result;
}

export function consumeHostFilterExecution(input) {
  const registration = taskStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Host filter consumption requires a registered Task Step");
  const selection = input.selection;
  return registration.executionContract.execute(selection, { ...input, registration });
}

function replayHostFilterReceipt(receipt) {
  if (!(receipt instanceof HostFilterReceiptReplay)) throw new TypeError("Host filter replay requires its authenticated receipt");
  receipt.assertCurrent();
  return receipt.receipt;
}

export function recoverHostFilterExecution(input) {
  const registration = taskStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Host filter recovery requires a registered Task Step");
  const selection = input.selection;
  if (selection.registration !== registration) throw new TypeError("Host filter recovery requires its selected registration");
  if (selection.receipt !== null) return replayHostFilterReceipt(selection.receipt);
  return registration.executionContract.execute(selection, { ...input, registration });
}
