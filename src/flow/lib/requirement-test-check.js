/**
 * Requirement-level test execution observations.
 *
 * This module reports only facts from the runner and the assigned named test.
 * Expectation compatibility, acceptance, retry, and defer decisions belong to
 * the Definition layer.
 */

const INVALID_TEST_PATTERN = /SyntaxError|ERR_MODULE|Cannot find module|ReferenceError|bootstrap|module loader/i;

function requiredText(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namedTestStatus(rawText, testName) {
  const pattern = new RegExp(`(?:^|\\n)\\s*(ok|not ok)\\b[^\\n]*?[-:]\\s*${escapeRegExp(testName)}(?:\\s|$)`);
  return String(rawText || "").match(pattern)?.[1] || null;
}

export class RequirementTestObservation {
  constructor({ requirementId, testName, kind, reason }) {
    this.requirementId = requiredText(requirementId, "requirement test observation requirementId");
    this.testName = requiredText(testName, "requirement test observation testName");
    if (!["assertion_failed", "assertion_passed", "invalid_test", "tooling_failure", "skipped", "missing"].includes(kind)) {
      throw new Error(`invalid requirement test observation kind: ${kind}`);
    }
    this.kind = kind;
    this.reason = requiredText(reason, "requirement test observation reason");
    Object.freeze(this);
  }

  toJSON() {
    return {
      requirementId: this.requirementId,
      testName: this.testName,
      kind: this.kind,
      reason: this.reason,
    };
  }
}

export class RequirementTestCheck {
  constructor({ requirementId, testName }) {
    this.requirementId = requiredText(requirementId, "requirement test check requirementId");
    this.testName = requiredText(testName, "requirement test check testName");
    Object.freeze(this);
  }

  observe({ process, rawText = "", skipped = false, missing = false } = {}) {
    const common = { requirementId: this.requirementId, testName: this.testName };
    if (missing) return new RequirementTestObservation({ ...common, kind: "missing", reason: "assigned named requirement test was not found" });
    if (skipped) return new RequirementTestObservation({ ...common, kind: "skipped", reason: "assigned named requirement test was skipped" });

    const text = String(rawText || "");
    const status = namedTestStatus(text, this.testName);
    if (INVALID_TEST_PATTERN.test(text) && status === null) {
      return new RequirementTestObservation({ ...common, kind: "invalid_test", reason: "test source or bootstrap failed before the named test ran" });
    }
    if (!process || process.started !== true || process.spawnError || process.signal || process.timedOut) {
      return new RequirementTestObservation({ ...common, kind: "tooling_failure", reason: "test runner transport did not provide a usable result" });
    }
    if (status === "not ok" && process.exitCode !== 0) {
      return new RequirementTestObservation({ ...common, kind: "assertion_failed", reason: "assigned named test reported an assertion failure" });
    }
    if (status === "ok" && process.exitCode === 0) {
      return new RequirementTestObservation({ ...common, kind: "assertion_passed", reason: "assigned named test reported a passing assertion" });
    }
    return new RequirementTestObservation({ ...common, kind: "tooling_failure", reason: "assigned named test execution evidence is missing or inconsistent" });
  }
}

export function observeRequirementTest({ requirementId, testName, ...evidence }) {
  return new RequirementTestCheck({ requirementId, testName }).observe(evidence);
}
