import assert from "node:assert/strict";
import { test } from "node:test";
import { PrepareArtifactScenario } from "../../support/prepare-artifact-scenario.js";
import { dispatchContainer } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { RepositoryFlowOperationLock } from "../../../src/lib/repository-maintenance-lock.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { FlowCommand } from "../../../src/flow/lib/base-command.js";

class ObserveFlowContext extends FlowCommand {
  execute(ctx) { return ctx; }
}

test("a guarded worktree command reuses only its exact pre-acquired repository operation token during context resolution", async (t) => {
  const flow = PrepareArtifactScenario.create(t, { mode: "worktree", request: "Observe exact operation ownership at the public command context boundary." });
  await flow.initialize();
  assert.equal((await flow.prepare()).result, "ok");
  flow.reload();
  const context = flow.context();
  const before = context.flowManager.canonicalState(flow.specId).toJSON();
  const container = dispatchContainer({ root: flow.executionRoot, mainRoot: flow.root, inWorktree: true,
    config: flow.config, flowManager: flow.flowManager });
  const expectBinding = FlowTargetBinding.capture({ flowState: context.flowState,
    mainRoot: flow.root, authorityRoot: flow.executionRoot }).serialize();
  const owner = new RepositoryFlowOperationLock({ mainRoot: flow.root });
  const token = owner.acquire();
  try {
    const observed = await new ObserveFlowContext().run(container, { expectBinding,
      repositoryOperationOwnerToken: token });
    assert.equal(observed.executionRoot, flow.executionRoot);
    assert.equal(observed.flowState.runId, flow.runId);
    assert.equal(observed.repositoryOperationOwnerToken, token);
    owner.assertOwned();
    for (const repositoryOperationOwnerToken of [undefined, "wrong-owner-token"]) {
      await assert.rejects(new ObserveFlowContext().run(container, { expectBinding, repositoryOperationOwnerToken }),
        (error) => error.code === "REPOSITORY_FLOW_OPERATION_BUSY");
      owner.assertOwned();
    }
    assert.deepEqual(context.flowManager.canonicalState(flow.specId).toJSON(), before);
  } finally { owner.release(); }
});
