import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { emptySpecStub } from "../../../src/lib/spec-json.js";
import { CanonicalFlowCreateRequest } from "../../../src/flow/lib/canonical-flow-manager-store.js";
import { CurrentFlowSpecRecord } from "../../../src/flow/lib/current-flow-state.js";
import { ReviewRecoveryIdentity } from "../../../src/flow/lib/review-convergence.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { workerStepExecutionRegistration } from "../../../src/flow/engine/composition/registered-step-execution.js";
import { flattenSteps } from "../../../src/flow/lib/step-tree.js";
import { canonicalFixtureProducerResult } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const roots = [];

function root() {
  const value = createTmpDir("canonical-retry-recovery-");
  roots.push(value);
  return value;
}

function createFlow(specId) {
  const repository = root();
  const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
  const created = manager.createFresh(new CanonicalFlowCreateRequest({
    specId,
    runId: `run-${specId}`,
    request: "Exercise canonical Attempt retry and recovery semantics.",
    execution: { mode: "direct" },
    policy: { autoApprove: false, nonblocking: null },
    flowId: `flow-${specId}`,
    flowVersionId: `flow-${specId}-v1`,
    specRecord: new CurrentFlowSpecRecord({ ...emptySpecStub(), tasks: [] }, { specId }),
  }));
  manager.addActiveFlow(created.specId, "direct");
  return Object.freeze({ repository, manager, created });
}

function advanceTo(fixture, nodeId) {
  const ordered = flattenSteps(fixture.manager.load(fixture.created.specId).steps);
  const target = ordered.findIndex((step) => step.id === nodeId);
  assert.ok(target >= 0, `canonical definition includes ${nodeId}`);
  for (const step of ordered.slice(0, target)) {
    const canonicalCommandResult = canonicalFixtureProducerResult(
      fixture.manager.loadReadOnly(fixture.created.specId),
      step.id,
      { flowManager: fixture.manager, specId: fixture.created.specId },
    );
    fixture.manager.updateStepStatus(
      { stepId: step.id, requestedStatus: "done" },
      {
        specId: fixture.created.specId,
        ...(canonicalCommandResult === null ? {} : { canonicalCommandResult }),
      },
    );
  }
  fixture.manager.updateStepStatus({ stepId: nodeId, requestedStatus: "in_progress" }, { specId: fixture.created.specId });
}

function retryableFailure(kind) {
  return {
    category: kind === "semantic" ? "semantic" : "provider",
    code: kind === "semantic" ? "REVIEW_REJECTED" : "REVIEW_PROVIDER_UNAVAILABLE",
    message: kind === "semantic" ? "Review reported a repairable finding." : "Review provider was temporarily unavailable.",
    retryable: true,
    retryKind: kind,
  };
}

function failForRetry(fixture, nodeId, kind) {
  advanceTo(fixture, nodeId);
  fixture.manager.failCurrentAttempt({ specId: fixture.created.specId, failure: retryableFailure(kind) });
  return fixture.manager.canonicalState(fixture.created.specId);
}

function ledgerOperations(fixture) {
  return fixture.manager.activityLedger(fixture.created.specId).map((entry) => entry.transition.operation);
}

describe("retry recovery authority convergence", () => {
  afterEach(() => {
    while (roots.length > 0) removeTmpDir(roots.pop());
  });

  for (const nodeId of ["draft-questions-review", "draft-coverage-review", "spec-review", "test-review", "impl-review"]) {
    it(`starts ${nodeId} through the definition-owned canonical lifecycle`, () => {
      const fixture = createFlow(`001-route-${nodeId}`);
      advanceTo(fixture, nodeId);
      const state = fixture.manager.canonicalState(fixture.created.specId);
      assert.equal(state.current.at(-1), nodeId);
      assert.equal(state.attempt.nodeId, nodeId);
      assert.equal(Object.hasOwn(fixture.manager.load(fixture.created.specId), "stepAttempts"), false);
      assert.equal(ledgerOperations(fixture).at(-1), "start_attempt");
    });
  }

  it("retries a rejected review through one typed semantic Attempt transition", () => {
    const fixture = createFlow("001-semantic-retry");
    const failed = failForRetry(fixture, "spec-review", "semantic");
    const before = fixture.manager.activityLedger(fixture.created.specId).length;
    fixture.manager.retryCurrentAttempt({ specId: fixture.created.specId });
    const retried = fixture.manager.canonicalState(fixture.created.specId);
    assert.equal(failed.attempt.failure.retryKind, "semantic");
    assert.equal(retried.attempt.sequence, 2);
    assert.equal(retried.attempt.consumption.semantic, 1);
    assert.equal(retried.attempt.consumption.tooling, 0);
    assert.equal(fixture.manager.activityLedger(fixture.created.specId).length, before + 1);
    assert.equal(ledgerOperations(fixture).at(-1), "retry_attempt");
  });

  it("retries a transient review provider failure through one typed tooling Attempt transition", () => {
    const fixture = createFlow("001-tooling-retry");
    failForRetry(fixture, "spec-review", "tooling");
    fixture.manager.retryCurrentAttempt({ specId: fixture.created.specId });
    const retried = fixture.manager.canonicalState(fixture.created.specId);
    assert.equal(retried.attempt.sequence, 2);
    assert.equal(retried.attempt.consumption.semantic, 0);
    assert.equal(retried.attempt.consumption.tooling, 1);
    assert.equal(retried.attempt.failure, null);
  });

  it("rejects a second retry until the active replacement Attempt has failed", () => {
    const fixture = createFlow("001-idempotent-retry");
    failForRetry(fixture, "spec-review", "semantic");
    fixture.manager.retryCurrentAttempt({ specId: fixture.created.specId });
    const before = fixture.manager.activityLedger(fixture.created.specId);
    assert.throws(
      () => fixture.manager.retryCurrentAttempt({ specId: fixture.created.specId }),
      /failed active Attempt/,
    );
    assert.deepEqual(fixture.manager.activityLedger(fixture.created.specId), before);
  });

  it("does not make a non-retryable review failure recoverable", () => {
    const fixture = createFlow("001-terminal-review");
    advanceTo(fixture, "spec-review");
    fixture.manager.failCurrentAttempt({
      specId: fixture.created.specId,
      failure: {
        category: "semantic",
        code: "REVIEW_BLOCKED",
        message: "The review finding is terminal until an explicit repair route is selected.",
        retryable: false,
        retryKind: null,
      },
    });
    assert.throws(
      () => fixture.manager.retryCurrentAttempt({ specId: fixture.created.specId }),
      /retryable Attempt failure kind/,
    );
    assert.equal(fixture.manager.canonicalState(fixture.created.specId).attempt.failure.retryable, false);
  });

  it("preserves the active Attempt node and operation claims across a retry", () => {
    const fixture = createFlow("001-retry-claims");
    const failed = failForRetry(fixture, "spec-review", "semantic");
    fixture.manager.retryCurrentAttempt({ specId: fixture.created.specId });
    const retried = fixture.manager.canonicalState(fixture.created.specId);
    assert.equal(retried.attempt.nodeId, failed.attempt.nodeId);
    assert.deepEqual(retried.attempt.operationClaims, failed.attempt.operationClaims);
  });

  it("refuses a worker selection from a different admitted run before effects", async () => {
    const original = createFlow("001-original-worker-selection");
    const current = createFlow("001-current-worker-selection");
    advanceTo(original, "draft");
    advanceTo(current, "draft");
    const originalCtx = {
      root: original.repository, mainRoot: original.repository,
      executionRoot: original.repository, specId: original.created.specId,
      flowManager: original.manager,
      flowState: original.manager.loadReadOnly(original.created.specId),
    };
    const contract = workerStepExecutionRegistration("draft").executionContract;
    const selected = contract.select({ ctx: originalCtx, stepId: "draft" });
    const currentCtx = {
      root: current.repository, mainRoot: current.repository,
      executionRoot: current.repository, specId: current.created.specId,
      flowManager: current.manager,
      flowState: current.manager.loadReadOnly(current.created.specId),
    };
    assert.equal(contract.project(selected).kind, "execute_step");
    assert.equal(contract.project(contract.select({ ctx: currentCtx, stepId: "draft" })).kind,
      "execute_step");
    const before = {
      state: current.manager.canonicalState(current.created.specId).toJSON(),
      activities: current.manager.activityLedger(current.created.specId),
      catalog: current.manager.artifactCatalog(current.created.specId).toJSON(),
    };
    let providerCalls = 0;
    const dispatcher = new RunDispatchCommand({ agent: { async call() { providerCalls += 1; } } });
    await assert.rejects(() => dispatcher.executeSelectedWorker(selected, {
      ctx: currentCtx, invocation: { action: { nextAction: { step: "draft" } } },
    }), { code: "FLOW_WORKER_EXECUTION_SELECTION_CHANGED" });
    assert.equal(providerCalls, 0);
    assert.deepEqual(current.manager.canonicalState(current.created.specId).toJSON(), before.state);
    assert.deepEqual(current.manager.activityLedger(current.created.specId), before.activities);
    assert.deepEqual(current.manager.artifactCatalog(current.created.specId).toJSON(), before.catalog);
  });

  it("does not persist legacy mutable retry or review-convergence fields", () => {
    const fixture = createFlow("001-no-legacy-retry");
    failForRetry(fixture, "spec-review", "semantic");
    fixture.manager.retryCurrentAttempt({ specId: fixture.created.specId });
    const projected = fixture.manager.load(fixture.created.specId);
    assert.equal(Object.hasOwn(projected, "retryRecovery"), false);
    assert.equal(Object.hasOwn(projected, "reviewRecoveryBaselines"), false);
    assert.equal(Object.hasOwn(projected, "reviewConvergence"), false);
    assert.equal(Object.hasOwn(projected, "stepAttempts"), false);
  });

  it("keeps dispatch invocation identifiers out of review target identity comparison", () => {
    const identity = {
      treeSha: "9".repeat(40),
      targetStateDigest: "a".repeat(64),
      targetBindingDigest: "b".repeat(64),
    };
    assert.equal(
      new ReviewRecoveryIdentity({ ...identity, dispatchInvocationId: "next-dispatch" }).changedFrom(
        new ReviewRecoveryIdentity({ ...identity, dispatchInvocationId: "previous-dispatch" }),
      ),
      false,
    );
  });

  for (const [label, next, expected] of [
    ["tree", { treeSha: "c".repeat(40) }, true],
    ["target state", { targetStateDigest: "d".repeat(64) }, true],
    ["target binding", { targetBindingDigest: "e".repeat(64) }, true],
    ["phase", { phase: "impl" }, true],
    ["identical durable target", {}, false],
  ]) {
    it(`compares ${label} as a durable review recovery identity fact`, () => {
      const baseline = {
        runId: "review-identity-run",
        hasIssue: false,
        specId: "001-identity",
        phase: "spec",
        treeSha: "1".repeat(40),
        targetStateDigest: "2".repeat(64),
        targetBindingDigest: "3".repeat(64),
      };
      assert.equal(
        new ReviewRecoveryIdentity({ ...baseline, ...next }).changedFrom(new ReviewRecoveryIdentity(baseline)),
        expected,
      );
    });
  }

  it("rejects an identity that claims both no Issue and an Issue number", () => {
    assert.throws(
      () => new ReviewRecoveryIdentity({
        hasIssue: false,
        issue: 1,
        treeSha: "1".repeat(40),
      }),
      /no-Issue review recovery identity/,
    );
  });

  it("rejects an identity with a malformed durable target digest", () => {
    assert.throws(
      () => new ReviewRecoveryIdentity({ treeSha: "1".repeat(40), targetStateDigest: "not-a-digest" }),
      /SHA-256 string/,
    );
  });

  it("rejects an Issue-bearing identity that omits its durable Issue number", () => {
    assert.throws(
      () => new ReviewRecoveryIdentity({
        hasIssue: true,
        treeSha: "1".repeat(40),
      }),
      /requires issue/,
    );
  });
});
