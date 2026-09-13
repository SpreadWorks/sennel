import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseToolingOutcome } from "../../src/flow/lib/run-review.js";

describe("review tooling failure classification", () => {
  for (const stderr of [
    "no agent configured",
    "authentication failed: login required",
    "usage limit reached for this account",
  ]) {
    it(`preserves ${stderr} as an external Requirement review block`, () => {
      const outcome = parseToolingOutcome(stderr);
      assert.ok(outcome);
      assert.equal(outcome.permissionRelated, true);
    });
  }

  for (const stderr of [
    "rate limited by provider",
    "outcome=TOOLING_ERROR stage=communication toolingKind=invalid_payload",
  ]) {
    it(`keeps ${stderr} in bounded tooling handling`, () => {
      const outcome = parseToolingOutcome(stderr);
      assert.ok(outcome);
      assert.equal(outcome.permissionRelated, false);
    });
  }

  it("does not retry a timeout without process-stop evidence", () => {
    assert.equal(parseToolingOutcome("provider request timed out"), null);
  });
});
