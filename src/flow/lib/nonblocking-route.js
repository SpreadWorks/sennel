/**
 * Acceptance-backed continuation routes.
 *
 * A route exists only for a checkpoint that persists a bounded result
 * artifact.  Lifecycle/integrity failures without such evidence remain strict:
 * they cannot be represented honestly at acceptance.
 */

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireStringList(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return Object.freeze(value.map((entry) => requireString(entry, field)));
}

export class NonBlockingRoute {
  constructor({ sourceStep, artifact, kind, phase = null, targetStep = null, skippedSteps = [], taskScoped = false }) {
    this.sourceStep = requireString(sourceStep, "sourceStep");
    this.artifact = requireString(artifact, "artifact");
    this.kind = requireString(kind, "kind");
    if (!new Set(["review", "gate", "verification", "acceptance", "regression"]).has(this.kind)) {
      throw new Error("nonblocking route kind is invalid");
    }
    this.phase = phase == null ? null : requireString(phase, "phase");
    this.targetStep = targetStep == null ? null : requireString(targetStep, "targetStep");
    this.skippedSteps = requireStringList(skippedSteps, "skippedSteps");
    if (typeof taskScoped !== "boolean") throw new Error("taskScoped must be a boolean");
    this.taskScoped = taskScoped;
    if (this.taskScoped !== (this.sourceStep === "task-review" || this.sourceStep === "task-gate")) {
      throw new Error("taskScoped is reserved for task review and task gate");
    }
    Object.freeze(this);
  }

  get continueAction() {
    return this.targetStep == null ? "refresh-next-action" : `run-${this.targetStep}`;
  }
}

const ROUTES = [
  new NonBlockingRoute({
    sourceStep: "draft-questions-review",
    artifact: "draft-review-questions.json",
    kind: "review",
    phase: "draft-questions",
    targetStep: "draft-refine",
    skippedSteps: ["draft-questions-triage", "draft-questions-repair"],
  }),
  new NonBlockingRoute({
    sourceStep: "draft-coverage-review",
    artifact: "draft-review-coverage.json",
    kind: "review",
    phase: "draft-coverage",
    targetStep: "draft-gate",
    skippedSteps: ["draft-coverage-triage", "draft-coverage-repair"],
  }),
  new NonBlockingRoute({ sourceStep: "draft-gate", artifact: "draft-gate-result.json", kind: "gate", phase: "draft", targetStep: "spec" }),
  new NonBlockingRoute({ sourceStep: "spec-gate", artifact: "spec-gate-result.json", kind: "gate", phase: "spec", targetStep: "approval" }),
  new NonBlockingRoute({ sourceStep: "test-result-review", artifact: "test-result-review.json", kind: "verification", targetStep: "impl-review" }),
  new NonBlockingRoute({
    sourceStep: "task-review",
    artifact: "impl-review.json",
    kind: "review",
    phase: "impl",
    targetStep: "task-gate",
    skippedSteps: ["task-triage", "task-repair"],
    taskScoped: true,
  }),
  new NonBlockingRoute({ sourceStep: "task-gate", artifact: "task-impl-gate-result.json", kind: "gate", phase: "task-impl", taskScoped: true }),
  new NonBlockingRoute({ sourceStep: "impl-review", artifact: "impl-review.json", kind: "review", phase: "impl", targetStep: "impl-gate", skippedSteps: ["impl-triage", "impl-repair"] }),
  new NonBlockingRoute({ sourceStep: "impl-gate", artifact: "impl-gate-result.json", kind: "gate", phase: "integration", targetStep: "retro" }),
  new NonBlockingRoute({ sourceStep: "retro", artifact: "retro.json", kind: "verification", targetStep: "acceptance-review" }),
  // A durable nonblocking decision is the acceptance disposition for this
  // route. Leaving the explicit user-decision leaf pending would let the
  // generic next-action promoter resurrect it after report/finalization.
  new NonBlockingRoute({
    sourceStep: "acceptance-review",
    artifact: "acceptance-review.json",
    kind: "acceptance",
    targetStep: "final-regression",
    skippedSteps: ["acceptance-decision"],
  }),
  new NonBlockingRoute({ sourceStep: "final-regression", artifact: "final-regression-result.json", kind: "regression", targetStep: "report" }),
];

const byStep = new Map(ROUTES.map((route) => [route.sourceStep, route]));
if (byStep.size !== ROUTES.length) throw new Error("nonblocking routes must have unique source steps");

export const NONBLOCKING_ROUTES = Object.freeze(ROUTES);
export const NONBLOCKING_SOURCE_STEPS = Object.freeze(NONBLOCKING_ROUTES.map((route) => route.sourceStep));

export function nonblockingRouteFor(step) {
  return byStep.get(step) || null;
}
