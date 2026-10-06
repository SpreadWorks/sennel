import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, it } from "node:test";
import { fileURLToPath } from "node:url";

import GetStatusCommand from "../../../src/flow/lib/get-status.js";
import { resolveFlowContext } from "../../../src/flow/lib/flow-context.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { WorktreeFlowBindingStore, WorktreeFlowIdentity } from "../../../src/lib/worktree-flow-binding.js";
import { createFlowQueryFixture } from "../../support/builders/flow-query-fixture.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { dispatchContainer } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { makeFlowManager } from "../../support/infrastructure/flow-setup.js";

const CLI = fileURLToPath(new URL("../../../src/sennel.js", import.meta.url));
const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) removeTmpDir(fixture.root);
});

function fixture(mode = "branch") {
  const value = createFlowQueryFixture({
    git: mode === "worktree",
    autoApprove: false,
    execution: { mode, baseBranch: "main", featureBranch: "feature/status-binding" },
  });
  fixtures.push(value);
  value.flow.activate("draft");
  if (mode === "worktree") {
    const worktreePath = path.join(value.root, ".sennel", "worktree", "feature-status-binding");
    execFileSync("git", ["worktree", "add", worktreePath, "-b", "feature/status-binding"], {
      cwd: value.root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const state = value.flow.state();
    new WorktreeFlowBindingStore({ worktreePath }).save(new WorktreeFlowIdentity({
      runId: state.runId, issue: state.issue, specId: state.specId, worktreePath,
    }));
  }
  return value;
}

function invoke(value, args, root = value.root) {
  const result = spawnSync(process.execPath, [CLI, "flow", "get", ...args], {
    cwd: root,
    env: { ...value.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root },
    encoding: "utf8",
  });
  return { ...result, envelope: JSON.parse(result.stdout) };
}

function issuedBinding(value) {
  const result = invoke(value, ["next-action", "--expect-run-id", value.flow.state().runId]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.envelope.ok, true);
  assert.equal(typeof result.envelope.data.binding, "string");
  return result.envelope.data.binding;
}

function canonicalSnapshot(value) {
  // Keep persistent state and caches protected; CLI diagnostic logs may append.
  return value.snapshot().entries.filter((entry) =>
    !/(^|\/)\.tmp(?:\/logs(?:\/|$)|$)/.test(entry.path));
}

function selectedContext(value) {
  return resolveFlowContext(dispatchContainer({
    root: value.root,
    flowManager: makeFlowManager(value.root),
  }), {
    allowMissingActive: true,
    explicitTargetResolution: true,
    preparingRunIdSelection: false,
    input: { expectRunId: value.flow.state().runId },
  });
}

for (const mode of ["branch", "worktree"]) {
  it(`reads CLI-issued status/details in-process after reload in ${mode} mode without changing any fixture bytes`, async () => {
    const value = fixture(mode);
    const binding = issuedBinding(value);
    const state = value.flow.state();
    const before = value.snapshot();

    for (const details of [false, true]) {
      const result = await new GetStatusCommand().run(dispatchContainer({
        root: value.root,
        flowManager: makeFlowManager(value.root),
      }), { expectBinding: binding, details, _envelopeType: "get", _envelopeKey: "status" });

      assert.equal(result.active, true);
      assert.equal(result.runId, state.runId);
      assert.equal(result.specId, state.specId);
      assert.equal(result.worktree, mode === "worktree");
      assert.equal(result.autoApprove, false);
      if (details) assert.equal(result.request, state.request);
      else assert.equal(Object.hasOwn(result, "request"), false);
      assert.deepEqual(value.snapshot(), before);
    }

    const cliBefore = canonicalSnapshot(value);
    const cli = invoke(value, ["status", "--details", "--expect-binding", binding]);
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.equal(cli.envelope.ok, true);
    assert.equal(cli.envelope.data.runId, state.runId);
    assert.equal(cli.envelope.data.request, state.request);
    assert.deepEqual(canonicalSnapshot(value), cliBefore);
  });
}

it("reads a binding from its managed worktree cwd using the canonical issuing authority", () => {
  const value = fixture("worktree");
  const binding = issuedBinding(value);
  const worktreePath = FlowTargetBinding.deserialize(binding).authority.executionRoot;
  const before = canonicalSnapshot(value);

  const result = invoke(value, ["status", "--details", "--expect-binding", binding], worktreePath);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.envelope.ok, true);
  assert.equal(result.envelope.data.runId, value.flow.state().runId);
  assert.equal(result.envelope.data.worktree, true);
  assert.deepEqual(canonicalSnapshot(value), before);
});

it("rejects a stale branch binding against the selected context and at CLI selection without changing canonical bytes", () => {
  const value = fixture();
  const issued = FlowTargetBinding.deserialize(issuedBinding(value)).toJSON();
  const stale = new FlowTargetBinding({
    ...issued,
    authority: { ...issued.authority, featureBranch: "feature/previous-status-binding" },
  }).serialize();
  const before = value.snapshot();

  const result = new GetStatusCommand().execute({ ...selectedContext(value), expectBinding: stale });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "ACTIVE_FLOW_MISMATCH");
  assert.equal(result.data.expectedFeatureBranch, "feature/previous-status-binding");
  assert.equal(result.data.activeFeatureBranch, "feature/status-binding");
  assert.deepEqual(value.snapshot(), before);

  const cliBefore = canonicalSnapshot(value);
  const cli = invoke(value, ["status", "--expect-binding", stale]);
  assert.notEqual(cli.status, 0);
  assert.equal(cli.envelope.errors[0].code, "FLOW_TARGET_NOT_FOUND");
  assert.deepEqual(canonicalSnapshot(value), cliBefore);
});

it("preserves both artifact trees when refusing a foreign authority against the selected context", () => {
  const issuer = fixture();
  const selected = fixture();
  const binding = issuedBinding(issuer);
  assert.equal(issuer.flow.state().runId, selected.flow.state().runId);
  const issuerBefore = issuer.snapshot();
  const selectedBefore = selected.snapshot();

  const result = new GetStatusCommand().execute({ ...selectedContext(selected), expectBinding: binding });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "ACTIVE_FLOW_MISMATCH");
  assert.equal(result.data.expectedMainRoot, issuer.root);
  assert.equal(result.data.activeMainRoot, selected.root);
  assert.deepEqual(issuer.snapshot(), issuerBefore);
  assert.deepEqual(selected.snapshot(), selectedBefore);
});
