import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import RunReportCommand from "../../../src/flow/lib/run-report.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { describe, it } from "node:test";

import {
  BeginOutboxEffect,
  CompleteOutboxEffect,
  FailOutboxEffect,
  SetStepStatus,
  buildInitialNestedSteps,
  resolveLifecycle,
} from "../../../src/flow/definition.js";
import {
  FlowOutbox,
  FlowOutboxEntry,
  FlowOutboxIdentity,
  FlowOutboxStore,
} from "../../../src/flow/lib/flow-outbox.js";
import * as flowOutboxModule from "../../../src/flow/lib/flow-outbox.js";
import { flattenSteps } from "../../../src/flow/lib/step-tree.js";
import { Command } from "../../../src/lib/command.js";
import { dispatch } from "../../../src/lib/dispatcher.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { CanonicalFlowFixture, FlowAtStepFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";

function finalizationIdentity(stepId) {
  return new FlowOutboxIdentity({
    runId: "run-421",
    taskId: null,
    stepId,
    operation: stepId,
  });
}

function failedAttemptTwo(stepId = "report", failure = "issue comment idempotencyKey is required") {
  const identity = finalizationIdentity(stepId);
  const outbox = new FlowOutbox();
  outbox.begin(identity, "2026-07-17T00:00:00.000Z");
  outbox.fail(identity, new Error("first failure"), "2026-07-17T00:00:01.000Z");
  outbox.begin(identity, "2026-07-17T00:00:02.000Z");
  outbox.fail(identity, new Error(failure), "2026-07-17T00:00:03.000Z");
  return { identity, outbox, failure };
}

function recoveryClaim(identity, attempt, failure) {
  return new flowOutboxModule.FlowOutboxRecoveryClaim({ identity, attempt, failure });
}

describe("resumable finalization outbox", () => {
  it("places report between final-regression and finalize-commit", () => {
    const ids = flattenSteps(buildInitialNestedSteps()).map((step) => step.id);
    assert.deepEqual(
      ids.slice(ids.indexOf("final-regression"), ids.indexOf("finalize-commit") + 1),
      ["final-regression", "report", "finalize-commit"],
    );
  });

  it("retains one stable identity across pending, failed, retry, and done", () => {
    const identity = finalizationIdentity("finalize-commit");
    const outbox = new FlowOutbox();

    const pending = outbox.begin(identity, "2026-07-17T00:00:00.000Z");
    assert.ok(pending instanceof FlowOutboxEntry);
    assert.equal(pending.status, "pending");

    outbox.fail(identity, new Error("process killed"), "2026-07-17T00:00:01.000Z");
    const retried = outbox.begin(identity, "2026-07-17T00:00:02.000Z");
    assert.equal(retried.idempotencyKey, pending.idempotencyKey);
    assert.equal(retried.attempt, 2);

    outbox.complete(identity, { status: "done" }, "2026-07-17T00:00:03.000Z");
    const resumed = outbox.begin(identity, "2026-07-17T00:00:04.000Z");
    assert.equal(resumed.status, "done");
    assert.equal(resumed.attempt, 2);
    assert.equal(outbox.entries.length, 1);
  });

  it("reopens an exactly bound failed entry without changing its key or attempt", () => {
    const { identity, outbox, failure } = failedAttemptTwo();
    const reopened = outbox.reopenFailedExact(
      recoveryClaim(identity, 2, failure),
      "2026-07-17T00:00:04.000Z",
    );

    assert.equal(reopened.status, "pending");
    assert.equal(reopened.attempt, 2);
    assert.equal(reopened.idempotencyKey, identity.idempotencyKey);
    assert.equal(reopened.failure, null);
  });

  it("rejects a second use of the same exact recovery claim", () => {
    const { identity, outbox, failure } = failedAttemptTwo();
    const claim = recoveryClaim(identity, 2, failure);
    outbox.reopenFailedExact(claim, "2026-07-17T00:00:04.000Z");
    const once = outbox.toJSON();

    assert.throws(
      () => outbox.reopenFailedExact(claim, "2026-07-17T00:00:05.000Z"),
      /exact recovery requires a failed outbox entry/,
    );
    assert.deepEqual(outbox.toJSON(), once);
  });

  it("rejects ABA claim reuse after the reopened entry fails with the same binding", () => {
    const { identity, outbox, failure } = failedAttemptTwo();
    const claim = recoveryClaim(identity, 2, failure);
    outbox.reopenFailedExact(claim, "2026-07-17T00:00:04.000Z");
    outbox.fail(identity, new Error(failure), "2026-07-17T00:00:05.000Z");
    const failedAgain = outbox.toJSON();
    assert.deepEqual(failedAgain[0].exactRecoveryReceipt, {
      idempotencyKey: identity.idempotencyKey,
      attempt: 2,
      failure,
    });

    assert.throws(
      () => outbox.reopenFailedExact(claim, "2026-07-17T00:00:06.000Z"),
      /exact recovery was already consumed/,
    );
    assert.deepEqual(outbox.toJSON(), failedAgain);
  });

  it("rejects foreign key, attempt, and failure mismatches without changing any entry", () => {
    const { identity, outbox, failure } = failedAttemptTwo();
    const foreignIdentity = finalizationIdentity("finalize-commit");
    outbox.begin(foreignIdentity, "2026-07-17T00:00:04.000Z");
    const before = outbox.toJSON();
    const claims = [
      recoveryClaim(finalizationIdentity("finalize-sync"), 2, failure),
      recoveryClaim(identity, 1, failure),
      recoveryClaim(identity, 2, "different failure"),
    ];

    for (const claim of claims) {
      assert.throws(() => outbox.reopenFailedExact(claim), /exact recovery/);
      assert.deepEqual(outbox.toJSON(), before);
    }
  });

  it("preserves the old durable state when exact recovery atomic write fails", () => {
    const root = createTmpDir("flow-outbox-exact-recovery-");
    try {
      let injectFailure = false;
      const flowManager = makeFlowManager(root, {
        versionStoreFaultInjector({ phase }) {
          if (injectFailure && phase === "before-current-flow-state-temp-write") {
            throw new Error("injected exact recovery write failure");
          }
        },
      });
      const fixture = new CanonicalFlowFixture({ flowManager }).create().registerActive();
      const state = fixture.state();
      const identity = finalizationIdentity("report");
      const store = new FlowOutboxStore(flowManager);
      store.begin(identity);
      store.fail(identity, new Error("first failure"));
      store.begin(identity);
      const failure = "issue comment idempotencyKey is required";
      store.fail(identity, new Error(failure));
      const flowPath = fixture.location().flowStateFile;
      const before = fs.readFileSync(flowPath);
      injectFailure = true;
      assert.throws(
        () => store.reopenFailedExact(recoveryClaim(identity, 2, failure)),
        /injected exact recovery write failure/,
      );
      assert.deepEqual(fs.readFileSync(flowPath), before);
    } finally {
      removeTmpDir(root);
    }
  });

  it("resumes a done outbox entry without executing the side effect twice", async () => {
    let executions = 0;
    let postHooks = 0;
    class SideEffectCommand extends Command {
      static outputMode = "envelope";

      execute() {
        executions += 1;
        return { status: "done" };
      }
    }
    const identity = finalizationIdentity("finalize-sync");
    const outbox = new FlowOutbox();
    outbox.begin(identity, "2026-07-17T00:00:00.000Z");
    const done = outbox.complete(identity, { status: "done" }, "2026-07-17T00:00:01.000Z");

    let output = "";
    await dispatch({
      container: { has: () => false, get: () => null },
      entry: {
        args: {},
        requiresFlow: false,
        command: async () => ({ default: SideEffectCommand }),
        pre(ctx) { ctx.flowOutboxEntry = done; },
        post() { postHooks += 1; },
      },
      argv: [],
      envelopeType: "run",
      envelopeKey: "finalize-sync",
      stdout(text) { output += text; },
      stderr() {},
      setExitCode() {},
    });

    assert.equal(JSON.parse(output).ok, true);
    assert.equal(executions, 0);
    assert.equal(postHooks, 1);
  });

  it("confirms Report completion and its outbox in one canonical publication", async () => {
    const root = createTmpDir("report-atomic-outbox-");
    try {
      initGitRepo(root);
      fs.writeFileSync(path.join(root, "README.md"), "report outbox fixture\n");
      commitAll(root, "fixture source");
      const specId = "001-atomic-report";
      const flowManager = makeFlowManager(root);
      await new FlowAtStepFixture({ flowManager, specId, runId: "run-atomic-report",
        execution: { mode: "direct", baseBranch: "main" },
        specRecord: { requirements: [{ id: "R1", desc: "Complete Report and its outbox atomically.", task_ids: ["T1"], testable: false }] },
        taskDocuments: [{ id: "T1", title: "Fixture Task", goal: "Complete Report and its outbox atomically.",
          origin: "plan", added_round: 0, status: "pending" }], targetStep: "report",
      }).createWithProducers();
      const state = flowManager.loadReadOnly(specId);
      const identity = new FlowOutboxIdentity({ runId: state.runId, stepId: "report", operation: "report" });
      const outbox = new FlowOutboxStore(flowManager, { specId });
      const entry = outbox.begin(identity);
      const ctx = { root, mainRoot: root, executionRoot: root, specId, flowManager,
        flowState: state, flowOutboxEntry: entry };
      const result = await new RunReportCommand().execute(ctx);
      const before = flowManager.activityLedger(specId).length;
      assert.equal(outbox.status(identity).status, "pending");
      assert.equal(flowManager.canonicalState(specId).findNode("report").status, "in_progress");
      await FLOW_COMMANDS.run.report.post(ctx, result);
      const reloaded = makeFlowManager(root);
      assert.equal(reloaded.canonicalState(specId).findNode("report").status, "done");
      assert.equal(new FlowOutboxStore(reloaded, { specId }).status(identity).status, "done");
      const completed = reloaded.activityLedger(specId).slice(before);
      assert.equal(completed.length, 1);
      assert.equal(completed[0].result.stepResult.kind, "report-generated");
      assert.equal(completed[0].transition.outbox.id, identity.idempotencyKey);
      assert.equal(completed[0].transition.outbox.result.result, "ok");
      assert.deepEqual(resolveLifecycle({ event: "report:post", command: "report", result: { result: "ok" } }), []);
    } finally { removeTmpDir(root); }
  });

  it("rejects raw Gate post results without a Definition Decision", () => {
    assert.throws(() => resolveLifecycle({
      event: "gate:post",
      currentStepId: "impl-gate",
      phase: "integration",
      result: { result: "pass", artifacts: { phase: "integration" } },
    }), /requires a Definition-selected GateTransitionDecision/);
  });

  for (const command of ["finalize-commit", "finalize-merge", "finalize-sync", "finalize-cleanup"]) {
    it(`${command} confirms its outbox before marking the step done`, () => {
      const actions = resolveLifecycle({
        event: "finalize:post",
        command,
        currentStepId: command,
        result: { status: "done" },
      });
      const completeIndex = actions.findIndex((action) => action instanceof CompleteOutboxEffect);
      const doneIndex = actions.findIndex((action) => (
        action instanceof SetStepStatus && action.step === command && action.status === "done"
      ));
      assert.equal(
        actions.some((action) => action instanceof BeginOutboxEffect),
        command === "finalize-merge",
      );
      assert.ok(completeIndex >= 0);
      assert.ok(completeIndex > doneIndex);
    });
  }

  it("settles a failed finalize-sync as skipped after recording its failed outbox", () => {
    const actions = resolveLifecycle({
      event: "finalize:onError",
      command: "finalize-sync",
      currentStepId: "finalize-sync",
    });
    const failureIndex = actions.findIndex((action) => action instanceof FailOutboxEffect);
    const skippedIndex = actions.findIndex((action) => (
      action instanceof SetStepStatus
      && action.step === "finalize-sync"
      && action.status === "skipped"
    ));
    assert.ok(failureIndex >= 0);
    assert.ok(skippedIndex > failureIndex);
  });

  it("recognizes an envelope-wrapped cleanup result as successful", () => {
    const actions = resolveLifecycle({
      event: "finalize:post",
      command: "finalize-cleanup",
      currentStepId: "finalize-cleanup",
      result: { data: { status: "done" } },
    });
    assert.ok(actions.some((action) => action instanceof CompleteOutboxEffect));
    assert.ok(actions.some((action) => (
      action instanceof SetStepStatus && action.step === "finalize-cleanup" && action.status === "done"
    )));
  });
});
