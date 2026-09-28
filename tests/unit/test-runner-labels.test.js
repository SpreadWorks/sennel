/**
 * tests/unit/test-runner-labels.test.js
 *
 * The project test runner emits every suite label.
 * labels in its stdout summary. We test the shared helper that tests/run.js uses.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  categorizeTestFile,
  formatLabelSummary,
  parsePassCount,
} from "../runner/test-runner-labels.js";

describe("categorizeTestFile", () => {
  it("maps paths with /tests/unit/ to unit", () => {
    assert.equal(categorizeTestFile("/repo/tests/unit/foo.test.js"), "unit");
    assert.equal(
      categorizeTestFile("/repo/tests/presets/foo/tests/unit/bar.test.js"),
      "unit",
    );
  });

  it("maps paths with /tests/e2e/ to e2e", () => {
    assert.equal(categorizeTestFile("/repo/tests/e2e/foo.test.js"), "e2e");
    assert.equal(
      categorizeTestFile("/repo/tests/presets/foo/tests/e2e/bar.test.js"),
      "e2e",
    );
  });

  it("maps paths with /tests/acceptance/ to acceptance", () => {
    assert.equal(
      categorizeTestFile("/repo/tests/presets/foo/tests/acceptance/bar.test.js"),
      "acceptance",
    );
  });

  it("maps structure suite paths to structure", () => {
    assert.equal(categorizeTestFile("/repo/tests/structure/draft.test.js"), "structure");
  });

  it("returns null for paths that match no category", () => {
    assert.equal(categorizeTestFile("/repo/misc/foo.js"), null);
  });
});

describe("formatLabelSummary", () => {
  it("always emits all suite lines in canonical order", () => {
    const out = formatLabelSummary({ unit: 3, integration: 5, e2e: 1, acceptance: 2, agent: 4 });
    assert.equal(out, "unit: 3\nintegration: 5\ne2e: 1\nacceptance: 2\nstructure: 0\nagent: 4");
  });

  it("emits 0 explicitly for categories with no tests", () => {
    const out = formatLabelSummary({ unit: 1, integration: 0, acceptance: 0 });
    assert.equal(out, "unit: 1\nintegration: 0\ne2e: 0\nacceptance: 0\nstructure: 0\nagent: 0");
  });

  it("treats missing keys as 0 (never omits lines)", () => {
    const out = formatLabelSummary({ unit: 4 });
    assert.equal(out, "unit: 4\nintegration: 0\ne2e: 0\nacceptance: 0\nstructure: 0\nagent: 0");
  });
});

describe("parsePassCount", () => {
  it("reads the Node 18 TAP summary", () => {
    assert.equal(parsePassCount("# tests 12\n# pass 11\n# fail 1\n"), 11);
  });

  it("reads the Node 24 TAP summary", () => {
    assert.equal(parsePassCount("ℹ tests 12\nℹ pass 12\nℹ fail 0\n"), 12);
  });
});
