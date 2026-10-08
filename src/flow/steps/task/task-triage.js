import { Step } from "../../engine/step.js";
import { TaskTriageFilterRequiredResult, TaskTriageRepairRequiredResult, TaskTriageGateRequiredResult, TaskTriageNoChangeCompletedResult,
  TaskTriageCorrectionRequiredResult, TaskTriageUnreviewedGateResult, StepErrorResult } from "../../engine/step-result.js";
import { TaskHostFilterService } from "../../services/task-host-filter-service.js";
import { TaskReviewStageFacts } from "../../lib/task-review-stage-transition.js";
import { TaskHostFilterAuthority } from "../../lib/task-review-host-filter-values.js";
import { TaskStageResultEvidence } from "../../lib/task-stage-result-values.js";

export function taskTriageResult(facts, frontier) {
  if (facts instanceof TaskHostFilterAuthority) return new TaskTriageFilterRequiredResult({ evidence: facts });
  if (!(facts instanceof TaskReviewStageFacts) || facts.binding.stage !== "triage") {
    throw new TypeError("Task Triage Result requires acquired canonical host filter facts");
  }
  const evidence = new TaskStageResultEvidence({ facts, frontier });
  if (evidence.resultKind === "task-triage-repair-required") return new TaskTriageRepairRequiredResult({ evidence });
  if (evidence.resultKind === "task-triage-gate-required") return new TaskTriageGateRequiredResult({ evidence });
  if (evidence.resultKind === "task-triage-no-change-completed") return new TaskTriageNoChangeCompletedResult({ evidence });
  if (evidence.resultKind === "task-triage-correction-required") return new TaskTriageCorrectionRequiredResult({ evidence });
  if (evidence.resultKind === "task-triage-unreviewed-gate") return new TaskTriageUnreviewedGateResult({ evidence });
  throw new TypeError("Task Triage selected an unsupported stage operation");
}

export class TaskTriageStep extends Step {
  static synchronous = true;
  static dependencies = [TaskHostFilterService];
  #service;
  constructor(service) {
    super();
    if (!(service instanceof TaskHostFilterService)) throw new TypeError("TaskHostFilterService is required");
    this.#service = service;
  }
  _execute() {
    let result;
    try { result = taskTriageResult(this.#service.inspectFacts(), this.#service.frontier); }
    catch (error) { result = new StepErrorResult("task-triage", error); }
    result.persist(this.#service);
    return result;
  }
}
