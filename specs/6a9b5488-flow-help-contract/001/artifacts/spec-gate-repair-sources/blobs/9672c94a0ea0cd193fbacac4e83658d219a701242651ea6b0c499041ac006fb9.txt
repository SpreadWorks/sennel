/**
 * src/lib/constants.js
 *
 * Single source of truth for all enum constants used across the codebase.
 */

// ---------------------------------------------------------------------------
// Flow phases (used by metrics, guardrails, review routing)
// ---------------------------------------------------------------------------

export const VALID_PHASES = Object.freeze([
  "draft",
  "spec",
  "gate",
  "impl",
  "task-spec",
  "task-impl",
  "integration",
  "test",
  "lint",
  "review",
]);

// ---------------------------------------------------------------------------
// Flow step statuses
// ---------------------------------------------------------------------------

export const VALID_STEP_STATUSES = Object.freeze([
  "pending",
  "in_progress",
  "done",
  "skipped",
]);

// ---------------------------------------------------------------------------
// Gate phases (subset used by run-gate)
// ---------------------------------------------------------------------------

export const VALID_GATE_PHASES = Object.freeze([
  "draft",
  "spec",
  "task-spec",
  "task-impl",
  "integration",
]);

// ---------------------------------------------------------------------------
// Gate levels (report.level field; issue #184)
// ---------------------------------------------------------------------------

export const VALID_GATE_LEVELS = Object.freeze([
  "parent",
  "task",
  "integration",
]);

// Allowed (level, phase) combinations — other combinations are rejected.
export const VALID_LEVEL_PHASE_COMBINATIONS = Object.freeze([
  Object.freeze({ level: "parent", phase: "draft" }),
  Object.freeze({ level: "parent", phase: "spec" }),
  Object.freeze({ level: "task", phase: "task-spec" }),
  Object.freeze({ level: "task", phase: "task-impl" }),
  Object.freeze({ level: "integration", phase: "integration" }),
]);

// ---------------------------------------------------------------------------
// Guardrail metadata enums (issue #184)
// ---------------------------------------------------------------------------

export const VALID_GUARDRAIL_CATEGORIES = Object.freeze([
  "requirements",
  "code-quality",
  "testing",
  "security",
  "process",
]);

// meta.phase values permitted inside guardrail.json.
// Superset of VALID_GATE_PHASES (gate phases + lint).
export const VALID_GUARDRAIL_PHASES = Object.freeze([
  "draft",
  "spec",
  "task-spec",
  "task-impl",
  "integration",
  "test",
  "lint",
  "review",
]);

// ---------------------------------------------------------------------------
// Metric counters
// ---------------------------------------------------------------------------

export const VALID_METRIC_COUNTERS = Object.freeze([
  "question",
  "docsRead",
  "srcRead",
  "gateRetry",
  "reviewRetry",
]);

// ---------------------------------------------------------------------------
// Check targets
// ---------------------------------------------------------------------------

export const VALID_CHECK_TARGETS = Object.freeze([
  "impl",
  "finalize",
  "dirty",
  "gh",
]);

// ---------------------------------------------------------------------------
// Review phases
// ---------------------------------------------------------------------------

export const VALID_REVIEW_PHASES = Object.freeze([
  "test",
  "spec",
  "draft",
  "impl",
]);

// ---------------------------------------------------------------------------
// Bounded flow audit output
// ---------------------------------------------------------------------------

export const BROAD_MODE_HISTORY_MAX_ENTRIES = 50;

// ---------------------------------------------------------------------------
// Auto-approve values
// ---------------------------------------------------------------------------

export const VALID_AUTO_VALUES = Object.freeze([
  "on",
  "off",
]);

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const EXIT_SUCCESS = 0;
export const EXIT_ERROR = 1;
