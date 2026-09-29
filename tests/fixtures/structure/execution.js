import { StepExecutionContract } from "../../../src/flow/engine/composition/step-execution-contract.js";

function selectWorkerExecutionAdmission(input) { return input; }
function projectWorkerExecutionAdmission(selection) { return selection; }
function executeWorkerExecutionAdmission(selection) { return selection; }

export const workerStepExecutionContract = new StepExecutionContract({
  select: selectWorkerExecutionAdmission,
  project: projectWorkerExecutionAdmission,
  execute: executeWorkerExecutionAdmission,
});
