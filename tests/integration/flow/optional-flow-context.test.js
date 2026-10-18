import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Container } from "../../../src/lib/container.js";
import { FlowCommand } from "../../../src/flow/lib/base-command.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function makeContainerWithAmbiguousActiveFlows(t) {
  const root = createTmpDir("optional-flow-context-");
  t.after(() => removeTmpDir(root));
  const container = new Container();
  const manager = makeFlowManager(root);
  new CanonicalFlowFixture({ flowManager: manager, specId: "002-demo", runId: "run-002" }).create();
  const selectedState = manager.loadReadOnly("002-demo");
  const flowManager = {
    load: () => null,
    loadReadOnly: (specId) => manager.loadReadOnly(specId),
    forRoot: () => flowManager,
    resolveExplicitFlowTarget: (expectation) => {
      if (expectation.runId === "run-002") {
        return { state: selectedState, specId: "002-demo", authorityRoot: root, preparing: false };
      }
      throw new Error("selected active Flow is absent");
    },
    resolveActiveFlow: (_flowState, opts = {}) => {
      if (opts.selectRunId === "run-002") {
        return { state: selectedState, specId: "002-demo", worktreePath: null };
      }
      throw new Error("multiple active flows: 001-demo (worktree), 002-demo (worktree)");
    },
  };
  container.register("paths", { root });
  container.register("mainRoot", root);
  container.register("config", {});
  container.register("flowManager", flowManager);
  container.register("inWorktree", false);
  return container;
}

describe("optional flow context resolution", () => {
  it("requiresFlow:false commands target a preparing runId before active-flow discovery", async () => {
    let captured;
    let loadCalled = false;
    let selectedRoot = null;
    const container = new Container();
    const flowManager = {
      loadPreparingFlow: (runId) => (runId === "preparing-run" ? { runId, issue: 431, specId: null } : null),
      forRoot: (root) => {
        selectedRoot = root;
        return flowManager;
      },
      load: () => {
        loadCalled = true;
        throw new Error("active flow discovery should not run");
      },
      resolveActiveFlow: () => {
        throw new Error("active flow resolution should not run");
      },
    };
    container.register("paths", { root: "/repo" });
    container.register("mainRoot", "/repo");
    container.register("config", {});
    container.register("flowManager", flowManager);
    container.register("inWorktree", false);

    class OptionalCommand extends FlowCommand {
      constructor() {
        super({ requiresFlow: false });
      }

      execute(ctx) {
        captured = ctx;
        return { ok: true };
      }
    }

    const cmd = new OptionalCommand();
    const result = await cmd.run(container, { runId: "preparing-run" });

    assert.deepEqual(result, { ok: true });
    assert.equal(captured.flowState, null);
    assert.deepEqual(captured.preparingFlowState, { runId: "preparing-run", issue: 431, specId: null });
    assert.equal(captured.root, "/repo");
    assert.equal(selectedRoot, "/repo");
    assert.equal(loadCalled, false);
  });

  it("isolates an explicit unknown preparing run from active-flow discovery", async () => {
    let loadCalled = false;
    const container = new Container();
    const flowManager = {
      loadPreparingFlow: () => null,
      forRoot: () => flowManager,
      load: () => {
        loadCalled = true;
        return { runId: "unrelated-run", issue: 999, specId: "999-unrelated" };
      },
    };
    container.register("paths", { root: "/repo" });
    container.register("mainRoot", "/repo");
    container.register("config", {});
    container.register("flowManager", flowManager);
    container.register("inWorktree", false);

    class OptionalCommand extends FlowCommand {
      constructor() {
        super({ requiresFlow: false });
      }
      execute(ctx) {
        return ctx;
      }
    }

    const result = await new OptionalCommand().run(container, {
      runId: "missing-run",
      expectRunId: "missing-run",
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "ACTIVE_FLOW_MISMATCH");
    assert.equal(loadCalled, false);
  });

  it("requiresFlow:false commands continue when active flow discovery is ambiguous", async (t) => {
    let captured;
    class OptionalCommand extends FlowCommand {
      constructor() {
        super({ requiresFlow: false });
      }

      execute(ctx) {
        captured = ctx;
        return { ok: true };
      }
    }

    const cmd = new OptionalCommand();
    const result = await cmd.run(makeContainerWithAmbiguousActiveFlows(t), { runId: "preparing-run" });

    assert.deepEqual(result, { ok: true });
    assert.equal(captured.flowState, null);
    assert.match(captured.flowResolutionError.message, /multiple active flows/);
    assert.equal(captured.runId, "preparing-run");
  });

  it("requiresFlow:true commands select the target when --expect-run-id is provided", async (t) => {
    let captured;
    class RequiredCommand extends FlowCommand {
      execute(ctx) {
        captured = ctx;
        return { ok: true };
      }
    }

    const cmd = new RequiredCommand();
    const commandContainer = makeContainerWithAmbiguousActiveFlows(t);
    const manager = commandContainer.get("flowManager");
    const before = manager.loadReadOnly("002-demo");
    const result = await cmd.run(commandContainer, { expectRunId: "run-002" });

    assert.deepEqual(result, { ok: true });
    assert.equal(captured.flowState.runId, "run-002");
    assert.equal(captured.specId, "002-demo");
    assert.deepEqual(captured.flowState, before, "execution uses the fresh canonical read under its real command lease");
    assert.deepEqual(manager.loadReadOnly("002-demo"), before);
  });

  it("requiresFlow:true commands still fail when no target disambiguates active flows", async (t) => {
    class RequiredCommand extends FlowCommand {
      execute() {
        return { ok: true };
      }
    }

    const cmd = new RequiredCommand();
    await assert.rejects(
      () => cmd.run(makeContainerWithAmbiguousActiveFlows(t), {}),
      /multiple active flows/,
    );
  });

  it("requiresFlow:false explicit commands return typed resolution failures without executing", async () => {
    let executed = false;
    const container = new Container();
    const recoveryError = Object.assign(new Error("selected target state is corrupt"), {
      code: "FLOW_TARGET_RECOVERY_REQUIRED",
      data: {
        runId: "run-corrupt",
        issue: 493,
        specId: "001-corrupt",
        reason: "FLOW_TARGET_STATE_INVALID",
      },
    });
    const flowManager = {
      resolveExplicitFlowTarget() {
        throw recoveryError;
      },
    };
    container.register("paths", { root: "/repo" });
    container.register("mainRoot", "/repo");
    container.register("config", {});
    container.register("flowManager", flowManager);
    container.register("inWorktree", false);

    class OptionalExplicitCommand extends FlowCommand {
      constructor() {
        super({ requiresFlow: false, explicitTargetResolution: true });
      }

      execute() {
        executed = true;
        return { ok: true };
      }
    }

    const result = await new OptionalExplicitCommand().run(container, {
      expectRunId: "run-corrupt",
      _envelopeType: "get",
      _envelopeKey: "next-action",
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "FLOW_TARGET_RECOVERY_REQUIRED");
    assert.equal(result.data.runId, "run-corrupt");
    assert.equal(executed, false);
  });
});
