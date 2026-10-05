/**
 * Canonical routing between retry recovery targets and Flow step ids.
 *
 * Retry grant validation and durable step-attempt invalidation must resolve
 * the same target. Keeping that relationship in one typed value prevents the
 * read and write paths from drifting independently.
 */

const VALID_KINDS = new Set(["gate", "review"]);
const VALID_SCOPES = new Set(["flow", "task"]);

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export class RetryTargetRoute {
  constructor({ kind, phase, stepId, scope = "flow" }) {
    this.kind = requireString(kind, "retry target kind");
    if (!VALID_KINDS.has(this.kind)) {
      throw new Error(`unsupported retry target kind: ${this.kind}`);
    }
    this.phase = requireString(phase, "retry target phase");
    this.stepId = requireString(stepId, "retry target stepId");
    this.scope = requireString(scope, "retry target scope");
    if (!VALID_SCOPES.has(this.scope)) {
      throw new Error(`unsupported retry target scope: ${this.scope}`);
    }
    this.counter = this.kind === "gate" ? "gateRetry" : "reviewRetry";
    Object.freeze(this);
  }

  static forStep(stepId) {
    return ROUTES.find((route) => route.stepId === stepId) || null;
  }

  static forRecovery(kind, phase, { currentTaskId = null } = {}) {
    const scope = (
      (kind === "gate" && phase === "task-impl")
      || (kind === "review" && phase === "impl" && currentTaskId != null)
    ) ? "task" : "flow";
    return ROUTES.find((route) => (
      route.kind === kind
      && route.phase === phase
      && route.scope === scope
    )) || null;
  }
}

const ROUTES = Object.freeze([
  new RetryTargetRoute({ kind: "gate", phase: "draft", stepId: "draft-gate" }),
  new RetryTargetRoute({ kind: "gate", phase: "spec", stepId: "spec-gate" }),
  new RetryTargetRoute({
    kind: "gate",
    phase: "task-impl",
    stepId: "task-gate",
    scope: "task",
  }),
  new RetryTargetRoute({ kind: "gate", phase: "integration", stepId: "impl-gate" }),
  new RetryTargetRoute({
    kind: "review",
    phase: "draft-questions",
    stepId: "draft-questions-review",
  }),
  new RetryTargetRoute({
    kind: "review",
    phase: "draft-coverage",
    stepId: "draft-coverage-review",
  }),
  new RetryTargetRoute({ kind: "review", phase: "spec", stepId: "spec-review" }),
  new RetryTargetRoute({ kind: "review", phase: "test", stepId: "test-review" }),
  new RetryTargetRoute({ kind: "review", phase: "impl", stepId: "impl-review" }),
  new RetryTargetRoute({
    kind: "review",
    phase: "impl",
    stepId: "task-review",
    scope: "task",
  }),
]);
