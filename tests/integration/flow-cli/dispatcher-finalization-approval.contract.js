import assert from "node:assert/strict";
import { test } from "node:test";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunFinalizeCommitCommand from "../../../src/flow/lib/run-finalize-commit.js";
import SetAutoCommand from "../../../src/flow/lib/set-auto.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { ExplicitFlowDispatchAuthorization, FlowDispatchSession, FlowDispatchTarget } from "../../../src/flow/lib/dispatch-invocation.js";
import { dispatchContainer } from "../../support/infrastructure/flow-dispatch-scenario.js";

async function interruptedCommit(flow) {
  await flow.advanceTo("finalize-commit");
  if (flow.manager.loadReadOnly(flow.specId).autoApprove === true) {
    const disabled = await new SetAutoCommand().execute({ ...flow.context(), value: "off" });
    assert.equal(disabled.autoApprove, false, JSON.stringify(disabled));
    flow.reload();
  }
  assert.equal(flow.manager.loadReadOnly(flow.specId).autoApprove, false);
  const ctx = flow.context();
  await FLOW_COMMANDS.run["finalize-commit"].pre(ctx);
  const result = await new RunFinalizeCommitCommand().execute(ctx);
  assert.equal(result.status, "done", JSON.stringify(result));
  const head = flow.git(["rev-parse", "HEAD"]);
  const claimed = flow.outbox("finalize-commit");
  assert.equal(claimed.status, "pending");
  // The external caller loses acknowledgement after Git committed. Feed that
  // failure to the registered producer, which owns the failed exact outbox.
  await FLOW_COMMANDS.run["finalize-commit"].onError(ctx,
    new Error("The external caller lost the completed Git commit acknowledgement before post."));
  flow.reload();
  const failed = flow.outbox("finalize-commit");
  assert.equal(failed.status, "failed");
  assert.equal(failed.idempotencyKey, claimed.idempotencyKey);
  assert.equal(flow.git(["rev-parse", "HEAD"]), head);
  const selected = await flow.next();
  assert.equal(selected.directive.actionId, "RECOVER_FINALIZE_COMMIT_OUTBOX", JSON.stringify(selected.directive));
  assert.equal(selected.requires_approval, true);
  return head;
}

function dispatcher(flow, nextAction = undefined) {
  let workerCalls = 0;
  const agent = { async call() { workerCalls += 1; throw new Error("exact commit recovery must not start a worker"); } };
  const command = new RunDispatchCommand({ agent, maxDispatches: 1, ...(nextAction ? { nextAction } : {}) });
  command.container = dispatchContainer({ root: flow.root, flowManager: flow.manager, agent, config: flow.options.config });
  const execute = (values = {}) => command.execute({ ...flow.context(),
    expectBinding: FlowTargetBinding.captureContext(flow.context()).serialize(),
    _envelopeType: "run", _envelopeKey: "dispatch", ...values });
  return { command, execute, workerCalls: () => workerCalls };
}

function recoveredExecution(flow, approvalToken, head) {
  flow.reload();
  assert.equal(flow.outbox("finalize-commit").status, "pending");
  assert.notEqual(flow.outbox("finalize-commit").exactRecoveryReceipt, null);
  assert.notEqual(flow.state().findNode("finalize-commit").status, "done",
    "an Execution receipt cannot stand in for the effect's Completion");
  const saved = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "finalize-commit" });
  assert.equal(saved.receipt.settlementKind, "execution");
  assert.equal(saved.result.type, "loop-required");
  assert.equal(saved.result.execution.approval.approvalToken, approvalToken);
  assert.equal(flow.git(["rev-parse", "HEAD"]), head, "recovery cannot repeat the commit effect");
  return saved.result.execution.toJSON();
}

async function completeRecoveredCommit(flow, execution, head) {
  const boundary = await dispatcher(flow).execute();
  assert.equal(boundary.dispatch.boundary, "approval_required", JSON.stringify(boundary));
  assert.equal(boundary.nextAction.directive.kind, "execute_step");
  const completion = dispatcher(flow);
  const result = await completion.execute({ approve: boundary.dispatch.approvalToken });
  assert.equal(result.data?.dispatch?.dispatchCount, 1, JSON.stringify(result));
  assert.equal(completion.workerCalls(), 0);
  flow.reload();
  assert.equal(flow.outbox("finalize-commit").status, "done");
  assert.equal(flow.state().findNode("finalize-commit").status, "done");
  const saved = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "finalize-commit", completed: true });
  assert.deepEqual(saved.receipt.finalization.evidence.execution, execution,
    "ordinary resumed completion retains the original Execution authorization");
  assert.equal(flow.git(["rev-parse", "HEAD"]), head);
  flow.assertResults(["finalize-commit"], { expectedKinds: { "finalize-commit": "finalize-commit-created" } });
}

export function registerDispatcherFinalizationApprovalContracts(scenario) {
  test("F06 dispatcher explicit approval survives exact commit recovery revalidation", async (t) => {
    const flow = scenario(t);
    const head = await interruptedCommit(flow);
    const beforeApprovals = flow.manager.loadReadOnly(flow.specId).flowDispatchApprovals?.length ?? 0;
    const boundary = await dispatcher(flow).execute();
    assert.equal(boundary.dispatch.boundary, "approval_required", JSON.stringify(boundary));
    assert.equal(boundary.nextAction.directive.command.subcommand, "recover-finalization");
    const recovery = dispatcher(flow);
    const result = await recovery.execute({ approve: boundary.dispatch.approvalToken });
    assert.equal(result.data?.dispatch?.dispatchCount, 1, JSON.stringify(result));
    assert.equal(recovery.workerCalls(), 0);
    const execution = recoveredExecution(flow, boundary.dispatch.approvalToken, head);
    const approvals = flow.manager.loadReadOnly(flow.specId).flowDispatchApprovals;
    assert.equal(approvals.length, beforeApprovals + 1);
    assert.equal(approvals.at(-1).approvalToken, boundary.dispatch.approvalToken);
    await completeRecoveredCommit(flow, execution, head);
  });

  test("F06 dispatcher approval recovery refuses an unrelated canonical write at the lower boundary", async (t) => {
    const flow = scenario(t);
    const head = await interruptedCommit(flow);
    const boundary = await dispatcher(flow).execute();
    assert.equal(boundary.dispatch.boundary, "approval_required", JSON.stringify(boundary));
    const reader = new GetNextActionCommand();
    let reads = 0;
    let afterConcurrentWrite = null;
    const recovery = dispatcher(flow, {
      async run(container, input) {
        const selected = await reader.run(container, input);
        // Delegate every canonical decision to the real reader. The third
        // observation is the recovery boundary after the upper approval check.
        if (++reads === 3) {
          flow.manager.addNote("A concurrent writer advanced canonical state after approval validation.", { specId: flow.specId });
          afterConcurrentWrite = flow.snapshot();
        }
        return selected;
      },
    });
    const result = await recovery.execute({ approve: boundary.dispatch.approvalToken });
    assert.equal(result.errors[0].code, "FLOW_DISPATCH_AUTHORIZATION_STALE", JSON.stringify(result));
    assert.equal(reads, 3);
    assert.notEqual(afterConcurrentWrite, null);
    assert.equal(recovery.workerCalls(), 0);
    flow.reload();
    assert.deepEqual(flow.snapshot(), afterConcurrentWrite, "refusal leaves no additional canonical effects");
    assert.equal(flow.outbox("finalize-commit").status, "failed");
    assert.notEqual(flow.state().findNode("finalize-commit").status, "done");
    assert.equal(flow.git(["rev-parse", "HEAD"]), head);
  });

  for (const concurrentNote of [false, true]) {
    test(`F06 dispatcher stored approval ${concurrentNote ? "refuses changed canonical evidence" : "survives restart before recovery"}`, async (t) => {
      const flow = scenario(t);
      const head = await interruptedCommit(flow);
      const recorder = dispatcher(flow);
      const boundary = await recorder.execute();
      assert.equal(boundary.dispatch.boundary, "approval_required", JSON.stringify(boundary));
      const target = FlowDispatchTarget.captureContext({ ...flow.context(), expectBinding: boundary.dispatch.binding });
      const selected = target.assertNextActionBinding(await new GetNextActionCommand().run(recorder.command.container, target.guardInput()));
      const action = recorder.command.captureAction(flow.context(), new FlowDispatchSession({ target }), selected, 0, "action-capture");
      const authorization = new ExplicitFlowDispatchAuthorization({ action, runId: target.runId,
        approvalToken: boundary.dispatch.approvalToken });
      const snapshot = flow.manager.readCanonicalTransitionSnapshot(flow.specId);
      flow.manager.recordDispatchApproval({ specId: flow.specId, receipt: authorization.toReceiptJSON() });
      const approved = flow.manager.readCanonicalTransitionSnapshot(flow.specId);
      assert.deepEqual(approved.state.withConfirmationOrder(snapshot.state.confirmationOrder).toJSON(), snapshot.state.toJSON(),
        "the existing typed approval producer changes only canonical confirmation order");
      assert.notEqual(approved.revision, snapshot.revision, "the generic canonical byte revision retains the receipt write");
      flow.reload();
      if (concurrentNote) flow.manager.addNote("Changed canonical evidence after the persisted user approval.", { specId: flow.specId });
      const before = flow.snapshot();
      const resumed = dispatcher(flow);
      const result = await resumed.execute();
      assert.equal(resumed.workerCalls(), 0);
      flow.reload();
      if (concurrentNote) {
        assert.equal(result.dispatch.boundary, "approval_required", JSON.stringify(result));
        assert.notEqual(result.dispatch.approvalToken, boundary.dispatch.approvalToken);
        assert.deepEqual(flow.snapshot(), before);
        assert.equal(flow.outbox("finalize-commit").status, "failed");
      } else {
        assert.equal(result.data?.dispatch?.dispatchCount, 1, JSON.stringify(result));
        const execution = recoveredExecution(flow, boundary.dispatch.approvalToken, head);
        assert.equal(flow.manager.loadReadOnly(flow.specId).flowDispatchApprovals.length, 1,
          "restart reuses the exact stored receipt instead of recording a second approval");
        await completeRecoveredCommit(flow, execution, head);
      }
      assert.equal(flow.git(["rev-parse", "HEAD"]), head);
    });
  }
}
