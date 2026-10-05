/**
 * Requirement-level test execution observations.
 *
 * This module reports only facts from the runner and the assigned named test.
 * Expectation compatibility, acceptance, retry, and defer decisions belong to
 * the Definition layer.
 */

const ASSERTION_FAILURE_PATTERN = /(?:\bcode:\s*['"]ERR_ASSERTION['"]|\bname:\s*['"]AssertionError['"]|\bAssertionError\b)/i;
const INVALID_TEST_PATTERN = /SyntaxError|ERR_(?:MODULE|TEST_FAILURE)|Cannot find module|ReferenceError|TypeError|RangeError|bootstrap|module loader|hook/i;

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

    if (!process || process.started !== true || process.spawnError || process.signal || process.timedOut) {
      return new RequirementTestObservation({ ...common, kind: "tooling_failure", reason: "test runner transport did not provide a usable result" });
    }

    const text = String(rawText || "");
    const status = namedTestStatus(text, this.testName);
    if (status === null && INVALID_TEST_PATTERN.test(text)) {
      return new RequirementTestObservation({ ...common, kind: "invalid_test", reason: "test source or bootstrap failed before the named test ran" });
    }
    if (status === "not ok" && process.exitCode !== 0) {
      return ASSERTION_FAILURE_PATTERN.test(text)
        ? new RequirementTestObservation({ ...common, kind: "assertion_failed", reason: "assigned named test reported an assertion failure" })
        : new RequirementTestObservation({ ...common, kind: "invalid_test", reason: "assigned named test failed without assertion evidence" });
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
