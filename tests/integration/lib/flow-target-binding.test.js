import { FlowExecutionCommand } from "../../../src/flow/lib/flow-execution-command.js";
import { guardedExecutionCommand } from "../../../src/flow/lib/guarded-command.js";
import { resolveDispatcherOwnedFlowAction } from "../../../src/flow/definition.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  FlowTargetBinding,
  FlowTargetExpectation,
  missingExactTargetGuardNames,
  targetMismatchEnvelopeForInput,
} from "../../../src/lib/flow-target-guard.js";
import {
  createTmpDir,
  removeTmpDir,
} from "../../support/builders/tmp-dir.js";
import { FlowTargetIdentity } from "../../../src/lib/flow-target-identity-authority.js";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTmpDir(root);
});

function root() {
  const value = createTmpDir("flow-target-binding-unit-");
  roots.push(value);
  return value;
}

function captureInput(repository, overrides = {}) {
  const flowState = {
    runId: "binding-unit-run",
    issue: 483,
    specId: "482-cli-target-binding",
    featureBranch: "feature/482-cli-target-binding",
    baseBranch: "main",
    worktree: false,
    execution: { mode: "branch" },
    ...overrides.flowState,
  };
  return {
    flowState,
    mode: overrides.mode ?? "branch",
    mainRoot: repository,
    authorityRoot: overrides.authorityRoot ?? repository,
    ...(overrides.worktreePath && { worktreePath: overrides.worktreePath }),
  };
}

test("FlowTargetBinding rejects a managed-worktree state captured as branch mode", () => {
  const repository = root();

  assert.throws(
    () => FlowTargetBinding.capture(captureInput(repository, {
      flowState: { worktree: true, execution: { mode: "worktree" } },
    })),
    (error) => error.code === "ACTIVE_FLOW_MISMATCH"
      && error.data.expectedMode === "branch"
      && error.data.activeMode === "worktree",
  );
});

test("active target identity resolves the canonical Version state location", () => {
  const identity = FlowTargetIdentity.active({
    runId: "target-location-run",
    issue: null,
    specId: "482-cli-target-binding",
    lifecycle: { state: "active" },
    execution: { mode: "branch" },
  }, "branch", "specs");

  assert.equal(identity.stateLocation, "specs/482-cli-target-binding/001/flow.json");
  assert.throws(() => new FlowTargetIdentity({
    ...identity.toJSON(),
    stateLocation: "specs/482-cli-target-binding/flow.json",
    revision: null,
  }), /state location is invalid/);
});

test("FlowTargetBinding rejects a branch state captured as worktree mode", () => {
  const repository = root();
  const worktreePath = root();

  assert.throws(
    () => FlowTargetBinding.capture(captureInput(repository, {
      mode: "worktree",
      authorityRoot: worktreePath,
      worktreePath,
    })),
    (error) => error.code === "ACTIVE_FLOW_MISMATCH"
      && error.data.expectedMode === "worktree"
      && error.data.activeMode === "branch",
  );
});

test("FlowTargetBinding captures direct mode without a feature branch", () => {
  const repository = root();
  const binding = FlowTargetBinding.capture(captureInput(repository, {
    mode: "direct",
    flowState: {
      featureBranch: null,
      baseBranch: "main",
      execution: { mode: "direct" },
    },
  }));

  assert.equal(binding.authority.mode, "direct");
});

test("FlowTargetBinding command exposes no-Issue guard explicitly", () => {
  const repository = root();
  const binding = FlowTargetBinding.capture(captureInput(repository, {
    flowState: {
      issue: null,
    },
  }));

  const command = binding.guardCommand("sennel flow get next-action");

  assert.match(command, /^sennel flow get next-action --expect-binding '[^']+' --expect-no-issue$/);
});

test("target guard envelope compares opaque binding authority before mutation", () => {
  const repository = root();
  const otherRepository = root();
  const input = captureInput(repository);
  const binding = FlowTargetBinding.capture(input);

  const envelope = targetMismatchEnvelopeForInput({
    type: "run",
    key: "reopen-draft",
    input: { expectBinding: binding.serialize() },
    flowState: input.flowState,
    mainRoot: otherRepository,
    authorityRoot: otherRepository,
  });

  assert.equal(envelope.ok, false);
  assert.equal(envelope.errors[0].code, "ACTIVE_FLOW_MISMATCH");
  assert.equal(envelope.errors[0].data.expectedMainRoot, repository);
  assert.equal(envelope.errors[0].data.activeMainRoot, otherRepository);
});

test("opaque binding satisfies exact target guard requirements", () => {
  const repository = root();
  const binding = FlowTargetBinding.capture(captureInput(repository));

  assert.deepEqual(
    missingExactTargetGuardNames({ expectBinding: binding.serialize() }, {
      issue: 483,
    }),
    [],
  );
  assert.deepEqual(
    missingExactTargetGuardNames({}, { issue: 483 }),
    ["--expect-run-id", "--expect-spec", "--expect-issue"],
  );
});

test("opaque binding and equivalent individual guards expose the same effective target identity", () => {
  const repository = root();
  const binding = FlowTargetBinding.capture(captureInput(repository));
  const opaque = new FlowTargetExpectation({ expectBinding: binding.serialize() });
  const individual = new FlowTargetExpectation({
    expectRunId: binding.runId,
    expectSpec: binding.specId,
    expectIssue: binding.issue,
  });

  assert.deepEqual(
    {
      runId: opaque.effectiveRunId,
      specId: opaque.effectiveSpecId,
      issue: opaque.effectiveIssue,
      expectsNoIssue: opaque.expectsNoIssue,
    },
    {
      runId: individual.effectiveRunId,
      specId: individual.effectiveSpecId,
      issue: individual.effectiveIssue,
      expectsNoIssue: individual.expectsNoIssue,
    },
  );
});

test("FlowTargetBinding rejects an oversized serialized token before decoding", () => {
  assert.throws(
    () => FlowTargetBinding.deserialize("x".repeat((32 * 1024) + 1)),
    /serialized FlowTargetBinding must not exceed 32768 bytes/,
  );
});

test("projection binds shared target guards once without mutating Definition semantic argv", () => {
  const repository = root();
  const state = { runId: "value-run", specId: "001-command-value", issue: null,
    execution: { mode: "direct" }, worktree: false, featureBranch: null, baseBranch: "main" };
  const binding = FlowTargetBinding.capture({ flowState: state, mainRoot: repository, authorityRoot: repository });
  const command = resolveDispatcherOwnedFlowAction({ stepId: "draft-questions-review" }).executionCommand;
  assert.ok(command instanceof FlowExecutionCommand);
  assert.deepEqual(command.args, ["--phase", "draft"]);
  const projected = guardedExecutionCommand(command, state, binding);
  assert.deepEqual(projected.args, [...command.args, "--expect-binding", binding.serialize(), "--expect-no-issue"]);
  assert.deepEqual(command.args, ["--phase", "draft"]);
  assert.deepEqual(FlowExecutionCommand.fromStored(JSON.parse(JSON.stringify(projected))).args, projected.args);
  assert.equal(projected.args.filter((arg) => arg === "--expect-binding").length, 1);
  assert.deepEqual(guardedExecutionCommand(command, state).args,
    [...command.args, "--expect-run-id", state.runId, "--expect-spec", state.specId, "--expect-no-issue"]);
});
