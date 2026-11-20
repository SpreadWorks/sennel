import assert from "node:assert/strict";
import { test } from "node:test";
import { auditOsIndependenceAt } from "../support/structure/os-audit.js";

test("the standard structure gate accepts only a complete whole-source OS audit", () => {
  const report = auditOsIndependenceAt(process.cwd());
  assert.equal(report.ok, true, JSON.stringify(report.toJSON(), null, 2));
  assert.equal(report.complete, true);
  assert.equal(report.exitCode, 0);
});
