import { Step } from "../../engine/step.js";
import { TaskGateExecutionRequiredResult, TaskGatePassedResult, TaskGateRepairRequiredResult,
  TaskGateRetryRequiredResult, TaskGateDeferredResult, TaskGateAwaitingDecisionResult,
  StepErrorResult } from "../../engine/step-result.js";
import { TaskGateService } from "../../services/task-gate-service.js";
import { GateStepObservation } from "../../lib/gate-observation-values.js";

export function taskGateResult(observation) {
  if (!(observation instanceof GateStepObservation) || observation.evidence.stepId !== "task-gate") {
    throw new TypeError("Task Gate Result requires its acquired Task source observation");
  }
  const evidence = observation.evidence;
  const meaning = evidence.meaning;
  const Result = { "task-gate-execution-required": TaskGateExecutionRequiredResult,
    "task-gate-passed": TaskGatePassedResult, "task-gate-repair-required": TaskGateRepairRequiredResult,
    "task-gate-retry-required": TaskGateRetryRequiredResult, "task-gate-deferred": TaskGateDeferredResult,
    "task-gate-awaiting-decision": TaskGateAwaitingDecisionResult }[evidence.resultKind];
  if (Result !== undefined) return new Result({ evidence });
  const error = new Error("Task Gate evidence cannot continue");
  error.code = meaning.reason ?? "TASK_GATE_INVALID_EVIDENCE";
  error.data = { evidence: evidence.toJSON() };
  return new StepErrorResult("task-gate", error);
}

export class TaskGateStep extends Step {
  static synchronous = true;
  static dependencies = [TaskGateService];
  #service;
  constructor(service) {
    super();
    if (!(service instanceof TaskGateService)) throw new TypeError("TaskGateService is required");
    this.#service = service;
  }
  _execute() {
    const result = taskGateResult(this.#service.inspectGateObservation());
    result.persist(this.#service);
    return result;
  }
}
