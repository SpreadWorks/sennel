import { NonGateTargetBinding } from "../../lib/non-gate-transition.js";
import { FinalizationExecutionIdentity } from "../../lib/finalization-execution-identity.js";
import { deepFreeze } from "../../lib/review-observation-values.js";
import { isDeepStrictEqual } from "node:util";
import { finalizationResultForEvidence } from "./finalization-result-factory.js";
import { StepErrorResult } from "../../engine/step-result.js";

/** Acquired observation of an operation, bound to its canonical Attempt. */
export class FinalizationResultEvidence {
  constructor(stepId, outcomes, { identity, execution, commandResult = null, outcome = commandResult === null ? "pending" : null }) {
    if (new.target === FinalizationResultEvidence) throw new TypeError("Finalization evidence requires a concrete operation");
    if (!(identity instanceof NonGateTargetBinding) || identity.stepId !== stepId
      || !(execution instanceof FinalizationExecutionIdentity) || execution.stepId !== stepId) {
      throw new TypeError("Finalization requires its acquired typed identity and execution facts");
    }
    if (execution.identity.runId !== identity.runId || execution.identity.specId !== identity.specId
      || !execution.identity.attempt.matches(identity.attempt)) {
      throw new TypeError("Finalization execution facts belong to another Attempt");
    }
    if (outcome !== null && !outcomes.includes(outcome)) throw new TypeError(`Invalid ${stepId} observation outcome`);
    if (outcome === null && commandResult === null) throw new TypeError("Finalization requires an acquired observation");
    this.identity = identity;
    this.execution = execution;
    this.outcome = outcome;
    this.commandResult = commandResult === null ? null : deepFreeze(structuredClone(commandResult));
    Object.freeze(this);
  }
  get stepId() { return this.identity.stepId; }
  assertResult(stepResult) {
    if (stepResult instanceof StepErrorResult) {
      if (stepResult.stepId !== this.stepId) throw new TypeError("Finalization Error Result belongs to another operation");
      return this;
    }
    const expected = finalizationResultForEvidence(this);
    if (!isDeepStrictEqual(stepResult.toJSON(), expected.toJSON())) {
      throw new TypeError("Finalization Result contradicts its acquired observation");
    }
    return this;
  }
  toJSON() {
    return { identity: this.identity.toJSON(), execution: this.execution.toJSON(),
      outcome: this.outcome, commandResult: structuredClone(this.commandResult) };
  }
  static fromJSON(value) {
    const Evidence = this === FinalizationResultEvidence ? evidenceClasses.get(value.identity.stepId) : this;
    if (Evidence === undefined) throw new TypeError("Stored finalization evidence requires a recognized operation");
    return new Evidence({ identity: new NonGateTargetBinding(value.identity),
      execution: FinalizationExecutionIdentity.fromJSON(value.execution),
      outcome: value.outcome, commandResult: value.commandResult });
  }
  static fromCommandResult({ identity, execution, commandResult }) {
    return new this({ identity, execution, commandResult });
  }
}

export class FinalizeCommitResultEvidence extends FinalizationResultEvidence {
  constructor(value) { super("finalize-commit", ["pending", "created", "unchanged"], value); }
}
export class FinalizeMergeResultEvidence extends FinalizationResultEvidence {
  constructor(value) { super("finalize-merge", ["pending", "squashed", "policy-skipped", "pr-opened"], value); }
}
export class FinalizeSyncResultEvidence extends FinalizationResultEvidence {
  constructor(value) { super("finalize-sync", ["pending", "built", "unchanged", "skipped-with-warning"], value); }
}
export class FinalizeCleanupResultEvidence extends FinalizationResultEvidence {
  constructor(value) { super("finalize-cleanup", ["pending", "completed", "completed-with-warning"], value); }
}

const evidenceClasses = new Map([
  ["finalize-commit", FinalizeCommitResultEvidence],
  ["finalize-merge", FinalizeMergeResultEvidence],
  ["finalize-sync", FinalizeSyncResultEvidence],
  ["finalize-cleanup", FinalizeCleanupResultEvidence],
]);
