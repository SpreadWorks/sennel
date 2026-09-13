import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildStateRetryRecoveryView,
  resolveRecoveryMaxAttempts,
} from "../../../src/flow/lib/retry-recovery.js";
import { RetryRecoveryBasis, RetryRecoveryPlan } from "../../../src/flow/definition.js";

const canonicalState = Object.freeze({ schemaRevision: 3, specId: "001-retry" });

describe("Version-1 retry recovery view", () => {
  it("does not offer a recovery command while the definition still owns retry budget", () => {
    const view = buildStateRetryRecoveryView({
      flowState: canonicalState,
      kind: "gate",
      phase: "spec",
      attempts: 1,
      max: 2,
    });
    assert.equal(view, null);
  });

  it("projects exhausted retry state as a fail-closed definition decision", () => {
    const view = buildStateRetryRecoveryView({
      flowState: canonicalState,
      kind: "review",
      phase: "impl",
      attempts: 2,
      max: 2,
    });
    assert.deepEqual(view, {
      kind: "review",
      phase: "impl",
      canonicalPhase: "impl",
      attempts: 2,
      max: 2,
      recoveryPossible: false,
      recoveryReason: "definition-owned-retry-budget-exhausted",
      observation: null,
      recoveryCommand: null,
    });
  });

  it("projects unchanged confirmed-timeout evidence through the definition-owned recovery view", () => {
    const view = buildStateRetryRecoveryView({
      flowState: canonicalState,
      kind: "review",
      phase: "test",
      attempts: 2,
      max: 2,
      recoveryPlan: RetryRecoveryPlan.available(
        RetryRecoveryBasis.confirmedTimeout(),
        "Confirmed provider timeout stopped before publishing a Review artifact.",
      ),
    });

    assert.equal(view.recoveryPossible, true);
    assert.equal(view.observation, null);
    assert.match(view.recoveryCommand, /set retry reset review test/);
  });

  it("rejects legacy state replay instead of inspecting a root-side evidence map", () => {
    assert.throws(
      () => buildStateRetryRecoveryView({
        flowState: { specId: "001-retry", reviewRecoveryBaselines: [] },
        kind: "gate",
        phase: "integration",
        attempts: 5,
        max: 5,
      }),
      /Version-1 Flow/,
    );
    assert.equal(resolveRecoveryMaxAttempts({ resolvedMax: 3 }), 3);
    assert.throws(() => resolveRecoveryMaxAttempts({}), /resolved retry maximum/);
  });
});
