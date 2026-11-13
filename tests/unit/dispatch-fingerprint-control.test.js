import assert from "node:assert/strict";
import { test } from "node:test";
import RunDispatchCommand, { FlowDispatchRepositoryFingerprintError } from "../../src/flow/lib/run-dispatch.js";
import { FlowDispatchActionIdentity, FlowDispatchSession, FlowDispatchTarget } from "../../src/flow/lib/dispatch-invocation.js";
import { ExecuteStepDirective } from "../../src/flow/lib/next-action-directive.js";
import { FlowTargetExpectation } from "../../src/lib/flow-target-guard.js";
import { ProcessExecutionControlFailure } from "../../src/lib/process-execution-values.js";

function inputs() {
  const target = new FlowDispatchTarget({ expectation: new FlowTargetExpectation({
    expectRunId: "a1111111-1111-4111-8111-111111111111", expectSpec: "803-control-failure", expectNoIssue: true,
  }) });
  return {
    session: new FlowDispatchSession({ id: "b2222222-2222-4222-8222-222222222222", target }),
    nextAction: { step: "spec", action: "worker", directive: new ExecuteStepDirective({ action: "spec" }).toJSON() },
  };
}

for (const phase of ["action-capture", "pre-handoff-validation", "post-handoff-progress"]) {
  for (const reason of ["observation-unknown", "record-invalid"]) {
    test(`fingerprint ${phase} retains exact typed ${reason} evidence`, () => {
      const { session, nextAction } = inputs();
      const failure = new ProcessExecutionControlFailure(reason, "Repository observation failed before action capture", {
        executionId: "c3333333-3333-4333-8333-333333333333", callId: "d4444444-4444-4444-8444-444444444444",
      });
      const command = new RunDispatchCommand({ repositoryFingerprint() { throw failure; } });
      let observed;
      assert.throws(() => command.captureAction({}, session, nextAction, 3, phase), error => {
        observed = error;
        return error === failure;
      });
      const wire = JSON.parse(JSON.stringify(observed.toJSON()));
      assert.deepEqual(ProcessExecutionControlFailure.fromStored(wire).toJSON(), failure.toJSON());
    });
  }
}

test("an ordinary fingerprint refusal retains its phase and original cause", () => {
  const { session, nextAction } = inputs();
  const cause = new Error("Repository contents changed");
  const command = new RunDispatchCommand({ repositoryFingerprint() { throw cause; } });
  assert.throws(() => command.captureAction({}, session, nextAction, 3, "pre-handoff-validation"), error =>
    error instanceof FlowDispatchRepositoryFingerprintError && error.cause === cause
      && error.phase === "pre-handoff-validation" && error.dispatchCount === 3 && error.nextAction === nextAction);
});

test("the same real session and directive capture a successful repository observation", () => {
  const { session, nextAction } = inputs();
  const fingerprint = "a".repeat(64);
  const command = new RunDispatchCommand({ repositoryFingerprint: () => fingerprint });
  const action = command.captureAction({}, session, nextAction, 0, "action-capture");
  assert.ok(action instanceof FlowDispatchActionIdentity);
  assert.equal(action.session, session);
  assert.equal(action.nextAction, nextAction);
  assert.equal(action.repositoryFingerprint, fingerprint);
});
