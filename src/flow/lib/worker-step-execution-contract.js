import { StepExecutionContract } from "../engine/composition/step-execution-contract.js";
import { selectWorkerExecutionAdmission, projectWorkerExecutionAdmission,
  executeWorkerExecutionAdmission } from "./worker-execution-admission.js";

/** Initialize the shared contract independently of the admission reader's IO graph. */
export const workerStepExecutionContract = new StepExecutionContract({
  select: selectWorkerExecutionAdmission,
  project: projectWorkerExecutionAdmission,
  execute: executeWorkerExecutionAdmission,
});
