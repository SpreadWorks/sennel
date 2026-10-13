import { reviewStepExecutionRegistration } from "../engine/composition/registered-step-execution.js";
import { ImplStepBinding } from "../engine/connectors/impl/impl-step-binding.js";
import { TaskStepIdentity } from "./task-step-identity.js";
import { TaskStepBinding } from "../engine/connectors/task/task-step-binding.js";
import { TaskReviewExecutionRequiredResult } from "../engine/step-result.js";
import { prepareReviewExecutionClaim, commitReviewExecutionClaim } from "./spec-review-operations.js";
import { FlowExecutionContract } from "./flow-execution-contract.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
/** Task Review uses the same immutable Review execution protocol as Spec. */
export class TaskReviewOperations {
  static executionContractArtifact({ flowManager, state }) {
    const binding = new TaskStepBinding({ flowManager, specId: state.specId, definitionStepId: "task-review" });
    const execution = flowManager.draftStepExecutionState({ binding });
    return FLOW_ARTIFACT_CONTRACTS.resolve("execution.contract", FlowExecutionContract.parametersForBinding({
      binding, generation: execution.lifecycle?.executionGeneration ?? execution.nextGeneration,
    }));
  }

  static prepareExecutionClaim(input) {
    const binding = new TaskStepBinding({ flowManager: input.flowManager, specId: input.state.specId,
      definitionStepId: "task-review" });
    return prepareReviewExecutionClaim({ ...input, binding, ResultClass: TaskReviewExecutionRequiredResult });
  }
  static commitExecutionClaim(preparation) { return commitReviewExecutionClaim(preparation); }

  static authorizeExecutionObservation({ flowManager, state, manifest, observation }) {
    const binding = new TaskStepBinding({ flowManager, specId: state.specId,
      definitionStepId: "task-review" });
    return observation.withTaskReviewExecutionClaims({ flowManager, binding, manifest });
  }
}

/** Acquire the original classified failure, then execute its registered semantic Step. */
export async function completeReviewStepFailure({ flowManager, state, error, failure, checkpoint = null, workUnit = null }) {
  const identity = TaskStepIdentity.fromStateNode(state, state.current?.at(-1));
  const scope = identity === null ? "flow" : "task";
  const registration = reviewStepExecutionRegistration("impl", scope);
  const binding = identity === null
    ? new ImplStepBinding({ flowManager, specId: state.specId, stepId: registration.stepId })
    : new TaskStepBinding({ flowManager, specId: state.specId, definitionStepId: registration.stepId });
  const publication = flowManager.prepareReviewStepFailurePublication({ binding, error, failure, checkpoint, workUnit });
  const prepared = await registration.create({ flowManager, binding, reviewFailurePublication: publication });
  await prepared.step.execute();
  return prepared.dependency(registration.ServiceClass).settlementOutcome;
}
