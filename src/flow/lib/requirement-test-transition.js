import { RequirementTestCandidateBundle } from "./requirement-test-artifacts.js";
import {
  RequirementTestPlan,
  RequirementTestWorkItem,
} from "./requirement-test-lifecycle.js";

export const REQUIREMENT_TEST_LEAF_IDS = Object.freeze([
  "test-generate",
  "test-review",
  "test-repair",
  "test-gate",
]);

const TARGETS = new Set([...REQUIREMENT_TEST_LEAF_IDS, "implement"]);
const DISPOSITIONS = new Set(["advance", "semantic_retry", "tooling_retry", "promote", "defer"]);
const STATUSES = new Set(["in_progress", "candidate_saved", "reviewed", "promoted", "deferred"]);
const BUDGET_KINDS = new Set(["autoSemantic", "manualSemantic", "tooling"]);

function exactDecision(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Requirement test lifecycle decision must be an object");
  }
  const expected = [
    "disposition", "target", "nextStatus", "budgetIncrement", "requirementId",
    "nextRequirementId", "repairRequired", "acceptanceHandoff", "candidateBundle",
  ].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Requirement test lifecycle decision has an invalid schema");
  }
}

/** Definition-selected connector instruction; applying it does not re-run policy. */
export class RequirementTestLifecycleDecision {
  constructor({
    disposition,
    target,
    nextStatus,
    budgetIncrement = null,
    requirementId,
    nextRequirementId = null,
    repairRequired = null,
    acceptanceHandoff = false,
    candidateBundle = null,
    facts = null,
  } = {}) {
    if (!DISPOSITIONS.has(disposition)) throw new Error("Requirement test lifecycle disposition is invalid");
    if (!TARGETS.has(target)) throw new Error("Requirement test lifecycle target is invalid");
    if (!STATUSES.has(nextStatus)) throw new Error("Requirement test lifecycle next status is invalid");
    if (budgetIncrement !== null && !BUDGET_KINDS.has(budgetIncrement)) {
      throw new Error("Requirement test lifecycle budget increment is invalid");
    }
    if (typeof requirementId !== "string" || requirementId === "") {
      throw new Error("Requirement test lifecycle requirementId is required");
    }
    if (nextRequirementId !== null && (typeof nextRequirementId !== "string" || nextRequirementId === "")) {
      throw new Error("Requirement test lifecycle nextRequirementId is invalid");
    }
    const repairModeValid = target === "test-repair"
      ? repairRequired === true
      : target === "test-gate" && disposition === "advance" && nextStatus === "reviewed"
        ? repairRequired === false
        : repairRequired === null;
    if (!repairModeValid) {
      throw new Error("Requirement test lifecycle repair mode does not match target");
    }
    if (typeof acceptanceHandoff !== "boolean" || acceptanceHandoff !== (disposition === "defer")) {
      throw new Error("Requirement test lifecycle acceptance handoff does not match disposition");
    }
    if ((candidateBundle !== null && !(candidateBundle instanceof RequirementTestCandidateBundle))
      || ((disposition === "advance" && nextStatus === "candidate_saved") !== (candidateBundle !== null))) {
      throw new Error("Requirement test lifecycle candidate bundle does not match decision");
    }
    this.disposition = disposition;
    this.target = target;
    this.nextStatus = nextStatus;
    this.budgetIncrement = budgetIncrement;
    this.requirementId = requirementId;
    this.nextRequirementId = nextRequirementId;
    this.repairRequired = repairRequired;
    this.acceptanceHandoff = acceptanceHandoff;
    this.candidateBundle = candidateBundle;
    this.facts = facts;
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactDecision(value);
    return new RequirementTestLifecycleDecision({
      ...value,
      candidateBundle: value.candidateBundle === null
        ? null
        : RequirementTestCandidateBundle.fromJSON(value.candidateBundle),
    });
  }

  apply(plan) {
    if (!(plan instanceof RequirementTestPlan)) {
      throw new Error("Requirement test lifecycle decision requires a typed plan");
    }
    const current = plan.workItem(this.requirementId);
    if (!(current instanceof RequirementTestWorkItem) || plan.activeWorkItem()?.requirementId !== this.requirementId) {
      throw new Error("Requirement test lifecycle decision does not match the active work item");
    }
    const budget = this.budgetIncrement === null
      ? current.budget
      : current.budget.increment(this.budgetIncrement);
    let next = plan.withWorkItem(current.withState({
      status: this.nextStatus,
      bundleRevision: this.candidateBundle?.bundle ?? current.bundleRevision,
      budget,
    }));
    if (this.nextRequirementId !== null) {
      const pending = next.workItem(this.nextRequirementId);
      if (!(pending instanceof RequirementTestWorkItem) || pending.status !== "pending") {
        throw new Error("Requirement test lifecycle next Requirement is not pending");
      }
      next = next.withWorkItem(pending.withState({ status: "in_progress" }));
    }
    return next;
  }

  toJSON() {
    return {
      disposition: this.disposition,
      target: this.target,
      nextStatus: this.nextStatus,
      budgetIncrement: this.budgetIncrement,
      requirementId: this.requirementId,
      nextRequirementId: this.nextRequirementId,
      repairRequired: this.repairRequired,
      acceptanceHandoff: this.acceptanceHandoff,
      candidateBundle: this.candidateBundle?.toJSON() ?? null,
    };
  }
}

export function sameRequirementTestLifecycleDecision(left, right) {
  if (!(left instanceof RequirementTestLifecycleDecision)
    || !(right instanceof RequirementTestLifecycleDecision)) return false;
  return JSON.stringify(left.toJSON()) === JSON.stringify(right.toJSON());
}

/** Typed initial route selected by Definition from the approved Spec. */
export class RequirementTestInitializationEffect {
  constructor({ target, skippedLeafIds = [] } = {}) {
    if (!new Set(["test-generate", "implement"]).has(target)) {
      throw new Error("Requirement test initialization target is invalid");
    }
    const expectedSkipped = target === "implement" ? [...REQUIREMENT_TEST_LEAF_IDS] : [];
    if (!Array.isArray(skippedLeafIds)
      || JSON.stringify(skippedLeafIds) !== JSON.stringify(expectedSkipped)) {
      throw new Error("Requirement test initialization skipped leaves do not match its target");
    }
    this.target = target;
    this.skippedLeafIds = Object.freeze([...skippedLeafIds]);
    Object.freeze(this);
  }

  static fromJSON(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "skippedLeafIds,target") {
      throw new Error("Requirement test initialization effect has an invalid schema");
    }
    return new RequirementTestInitializationEffect(value);
  }

  toJSON() {
    return { target: this.target, skippedLeafIds: [...this.skippedLeafIds] };
  }
}

export class RequirementTestInitializationDecision {
  constructor({ plan, target, skippedLeafIds = [] } = {}) {
    if (!(plan instanceof RequirementTestPlan)) throw new Error("Requirement test initialization requires a typed plan");
    this.effect = new RequirementTestInitializationEffect({ target, skippedLeafIds });
    if ((this.effect.target === "implement") !== plan.settled) {
      throw new Error("Requirement test initialization target does not match plan settlement");
    }
    this.plan = plan;
    this.target = this.effect.target;
    this.skippedLeafIds = this.effect.skippedLeafIds;
    Object.freeze(this);
  }

  toJSON() { return this.effect.toJSON(); }
}
