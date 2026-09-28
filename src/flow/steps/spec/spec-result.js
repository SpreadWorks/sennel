import {
  SpecCreatedResult,
  StepErrorResult,
  stepResultDigest,
} from "../../engine/step-result.js";
import { SpecWorkerCompletionFacts } from "../../lib/spec-step-connection.js";
import { CurrentFlowStateConflictError } from "../../lib/current-flow-state-conflict-error.js";

/** Select the meaning of one validated Spec worker candidate. */
export function specResult(facts) {
  if (facts instanceof Error) return new StepErrorResult("spec", facts);
  if (!(facts instanceof SpecWorkerCompletionFacts)) {
    throw new TypeError("Spec Result requires its typed completion facts");
  }
  return new SpecCreatedResult();
}

/** Step-owned Result sealed to the exact validated candidate it selected. */
export class SpecWorkerResultSelection {
  constructor(facts) {
    if (!(facts instanceof SpecWorkerCompletionFacts)) {
      throw new TypeError("Spec worker Result selection requires its typed candidate");
    }
    this.facts = facts;
    this.result = specResult(facts);
    this.resultDigest = stepResultDigest(this.result);
    Object.freeze(this);
  }

  assertResult(result) {
    if (result?.stepId !== "spec" || result?.kind !== this.result.kind
      || stepResultDigest(result) !== this.resultDigest) {
      throw new CurrentFlowStateConflictError("Spec Result differs from its selected worker candidate");
    }
  }

  assertCandidate({ result, application }) {
    this.assertResult(result);
    if ((application !== null && application !== undefined
        && application.baseline !== this.facts.baseline)) {
      throw new CurrentFlowStateConflictError("Spec publication differs from its selected worker candidate");
    }
    if (application !== null && application !== undefined) this.assertPublication(application.publication);
  }

  assertPublication(publication) {
    if (publication !== this.facts.publication) {
      throw new CurrentFlowStateConflictError("Spec publication differs from its selected worker candidate");
    }
  }
}
