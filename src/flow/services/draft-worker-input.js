import { DraftTransitionFacts } from "../lib/draft-transition-facts.js";
import { DraftGateRepairBinding } from "../lib/draft-gate-repair-binding.js";
import { DraftWorkerExecutionBinding } from "../definition.js";
import { DraftCompletionFacts } from "../lib/draft-completion-connector.js";
import { DraftRepairInput } from "../steps/draft/draft-repair-candidate.js";
import { DraftGateRepairSelection } from "../steps/draft/draft-gate-repair-selection.js";

/** Values observed before a Draft Step is constructed. */
export class DraftWorkerInput {
  constructor({ stepId, executionBinding = null,
    draftTransitionFacts = null, autoApprove = null, planGateRepair = null,
    draftCompletionFacts = null, repairSelection = null, repairInput = null,
    prepared = false }) {
    if (typeof stepId !== "string" || !stepId.startsWith("draft")
      || executionBinding !== null && !(executionBinding instanceof DraftWorkerExecutionBinding)
      || draftTransitionFacts !== null && !(draftTransitionFacts instanceof DraftTransitionFacts)
      || planGateRepair !== null && !(planGateRepair instanceof DraftGateRepairBinding)
      || draftCompletionFacts !== null && !(draftCompletionFacts instanceof DraftCompletionFacts)
      || repairSelection !== null && !(repairSelection instanceof DraftGateRepairSelection)
      || repairInput !== null && !(repairInput instanceof DraftRepairInput)
      || typeof prepared !== "boolean"
      || draftTransitionFacts !== null && typeof autoApprove !== "boolean") {
      throw new TypeError("Draft worker input requires its typed Step observations");
    }
    this.stepId = stepId;
    this.executionBinding = executionBinding;
    this.draftTransitionFacts = draftTransitionFacts;
    this.autoApprove = autoApprove;
    this.planGateRepair = planGateRepair;
    this.draftCompletionFacts = draftCompletionFacts;
    this.repairSelection = repairSelection;
    this.repairInput = repairInput;
    this.prepared = prepared;
    Object.freeze(this);
  }
}
