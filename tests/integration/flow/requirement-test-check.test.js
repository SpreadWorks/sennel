import assert from "node:assert/strict";
import { test } from "node:test";
import {
  observeRequirementTest,
  RequirementTestCheck,
} from "../../../src/flow/lib/requirement-test-check.js";

const processResult = (exitCode, extras = {}) => ({
  started: true,
  exitCode,
  signal: null,
  timedOut: false,
  spawnError: null,
  ...extras,
});

test("assigned named test assertion failure is observed as a raw fact", () => {
  const result = observeRequirementTest({
    requirementId: "R1",
    testName: "R1: missing behavior",
    process: processResult(1),
    rawText: "not ok 1 - R1: missing behavior\n  error: AssertionError",
  });
  assert.equal(result.kind, "assertion_failed");
  assert.equal(result.requirementId, "R1");
  assert.equal(result.testName, "R1: missing behavior");
  assert.equal(Object.hasOwn(result, "accepted"), false);
});

test("assigned named test pass is observed as a raw fact", () => {
  const result = new RequirementTestCheck({ requirementId: "R2", testName: "R2: implemented behavior" }).observe({
    process: processResult(0),
    rawText: "ok 1 - R2: implemented behavior",
  });
  assert.equal(result.kind, "assertion_passed");
});

test("nonzero runner output without the assigned named assertion is tooling failure", () => {
  const result = observeRequirementTest({
    requirementId: "R3",
    testName: "R3: behavior",
    process: processResult(1),
    rawText: "not ok 1 - unrelated runner failure\nrunner aborted",
  });
  assert.equal(result.kind, "tooling_failure");
});

test("invalid, skipped, and missing execution evidence remain distinct", () => {
  const check = new RequirementTestCheck({ requirementId: "R4", testName: "R4: behavior" });
  assert.equal(check.observe({ process: processResult(1), rawText: "SyntaxError: invalid test source" }).kind, "invalid_test");
  assert.equal(check.observe({ skipped: true }).kind, "skipped");
  assert.equal(check.observe({ missing: true }).kind, "missing");
});

test("a different test identity does not satisfy the assigned requirement", () => {
  const result = observeRequirementTest({
    requirementId: "R5",
    testName: "R5: assigned behavior",
    process: processResult(0),
    rawText: "ok 1 - R5: other behavior",
  });
  assert.equal(result.kind, "tooling_failure");
});
