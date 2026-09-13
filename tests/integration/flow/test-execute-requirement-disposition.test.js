import assert from "node:assert/strict";
import { test } from "node:test";

import { validateTestExecuteResultV2 } from "../../../src/flow/lib/test-artifacts.js";

function artifact() {
  return {
    version: "2",
    repairFingerprint: "a".repeat(64),
    testSourceRevision: "b".repeat(64),
    rawEvidenceFingerprint: "c".repeat(64),
    process: { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null },
    raw_output_path: "steps/test-execute/output.log",
    summary: [{
      id: "R1",
      execution: "executed",
      result: "pass",
      evidence: {
        test_file: "specs/example/001/artifacts/tests/r1.test.js",
        test_name: "R1: behavior",
        command: "node --test specs/example/001/artifacts/tests/r1.test.js",
        raw_output_lines: { start_line: 1, end_line: 1 },
      },
    }],
    regression: {
      required: false,
      result: "skipped",
      mode: "none",
      category: "spec-artifact-only",
      reason: "no implementation changes",
      classified_paths: [],
      changed_files: [],
      trigger_relevant_changed_files: [],
    },
  };
}

test("test-execute distinguishes an executed Requirement from a deferred Requirement", () => {
  const value = artifact();
  assert.equal(validateTestExecuteResultV2(value), value);

  value.summary[0].execution = "deferred_no_active_test";
  assert.throws(
    () => validateTestExecuteResultV2(value),
    /execution must be executed for active result/,
  );
});

test("test-execute rejects a summary that omits the Requirement execution disposition", () => {
  const value = artifact();
  delete value.summary[0].execution;
  assert.throws(
    () => validateTestExecuteResultV2(value),
    /summary.*execution|required property 'execution'/i,
  );
});
