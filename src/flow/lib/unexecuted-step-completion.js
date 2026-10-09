import { AcceptedNonblockingDecision } from "./accepted-nonblocking-decision.js";
import { NonGateTargetBinding, NonGateAttemptIdentity } from "./non-gate-transition.js";
const text = (value, field) => {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} must be non-empty text`);
  return value.trim();
};

function authorityResultKinds(values, field) {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError(`${field} requires Result kinds`);
  const kinds = Object.freeze(values.map((kind) => text(kind, `${field} Result kind`)));
  if (new Set(kinds).size !== kinds.length) throw new TypeError(`${field} Result kinds must be unique`);
  return kinds;
}

export const UNEXECUTED_STEP_COMPLETION_REFERENCE_KIND = "source-step-settlement";

/** A Definition-selected explanation for a recipient that needs no execution. */
export class UnexecutedStepCompletion {
  constructor({ stepId, reason, attemptSequence } = {}) {
    this.stepId = text(stepId, "unexecuted completion Step");
    this.reason = text(reason, "unexecuted completion reason");
    if (!Number.isSafeInteger(attemptSequence) || attemptSequence < 0) throw new TypeError("unexecuted completion requires its existing recipient cursor");
    this.attemptSequence = attemptSequence;
    Object.freeze(this);
  }
  static fromJSON(value) {
    if (value instanceof UnexecutedStepCompletion) return value;
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 3 || !Object.hasOwn(value, "stepId") || !Object.hasOwn(value, "reason") || !Object.hasOwn(value, "attemptSequence")) {
      throw new TypeError("unexecuted completion requires its exact declared fields");
    }
    return new UnexecutedStepCompletion(value);
  }
  toJSON() { return { stepId: this.stepId, reason: this.reason, attemptSequence: this.attemptSequence }; }
}

/** The same uniqueness and disjointness contract for selected and stored effects. */
export class UnexecutedStepCompletionSet {
  constructor(entries = []) {
    if (!Array.isArray(entries)) throw new TypeError("unexecuted completions must be an array");
    this.entries = Object.freeze(entries.map(UnexecutedStepCompletion.fromJSON));
    if (new Set(this.entries.map((entry) => entry.stepId)).size !== this.entries.length) {
      throw new TypeError("unexecuted completion recipients must be unique");
    }
    Object.freeze(this);
  }
  assertDisjoint(stepIds) {
    if (this.entries.some((entry) => stepIds.includes(entry.stepId))) {
      throw new TypeError("unexecuted completions must be disjoint from other route effects");
    }
    return this;
  }
  toJSON() { return this.entries.map((entry) => entry.toJSON()); }
}

/** A narrow node contract; it grants no ordinary status-transition permission. */
export class UnexecutedStepCompletionAuthority {
  constructor({ sourceStepId, resultKinds } = {}) {
    this.sourceStepId = text(sourceStepId, "unexecuted completion authority source");
    this.resultKinds = authorityResultKinds(resultKinds, "unexecuted completion authority");
    Object.freeze(this);
  }
  permits(result) {
    return result?.stepId === this.sourceStepId && this.resultKinds.includes(result.kind)
      && (result.type === "completed" || result.kind === "impl-review-tooling"
        && result.evidence?.acceptedDecision instanceof AcceptedNonblockingDecision);
  }
}

/** A completed producer may remain behind the selected earlier recovery frontier. */
export class RetainedRouteSourceAuthority {
  constructor({ sourceStepId, resultKinds, targetStepId, resetStepIds } = {}) {
    this.sourceStepId = text(sourceStepId, "retained source Step");
    this.resultKinds = authorityResultKinds(resultKinds, "retained source");
    this.targetStepId = text(targetStepId, "retained source recovery target");
    this.resetStepIds = authorityResultKinds(resetStepIds, "retained source reset Steps");
    Object.freeze(this);
  }
  permits(result, receipt) {
    return result?.stepId === this.sourceStepId && result.type === "loop-required"
      && this.resultKinds.includes(result.kind) && receipt?.settlementKind === "target-connection"
      && receipt.targetStepId === this.targetStepId
      && receipt.effects?.skipStepIds.length === 0
      && receipt.effects.unexecutedStepCompletions.length === 0
      && JSON.stringify(receipt.effects.resetStepIds) === JSON.stringify(this.resetStepIds)
      && this.matchesBinding(result, receipt);
  }
  matchesBinding(result, receipt) {
    const evidence = result.evidence;
    const binding = receipt.binding;
    return evidence?.runId === binding.runId && evidence.specId === binding.specId
      && evidence.nodeId === binding.stepId && evidence.attemptId === binding.attemptId
      && evidence.attemptSequence === binding.attemptSequence;
  }
  preservesUnexecutedTail() { return false; }
  retainsInvalidatedSource() { return false; }
}

/** Non-Gate rewind keeps its untouched tail under the exact retained producer. */
export class NonGateRetainedRouteSourceAuthority extends RetainedRouteSourceAuthority {
  matchesBinding(result, receipt) {
    const identity = result.evidence?.identity;
    const binding = receipt.binding;
    return identity instanceof NonGateTargetBinding && identity.runId === binding.runId
      && identity.specId === binding.specId && identity.stepId === binding.stepId
      && identity.attempt.matches(new NonGateAttemptIdentity({ id: binding.attemptId, sequence: binding.attemptSequence }));
  }
  preservesUnexecutedTail() { return true; }
  retainsInvalidatedSource() { return true; }
}
