import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, it } from "node:test";

import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { RuntimeLogBlockWriter, RuntimeLogFile } from "../../../src/lib/runtime-log.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const SENNEL = path.resolve("src/sennel.js");
const roots = [];

afterEach(() => {
  while (roots.length > 0) removeTmpDir(roots.pop());
});

function root() {
  const directory = createTmpDir("sennel-runtime-log-binding-");
  roots.push(directory);
  return directory;
}

function invoke(directory, args) {
  const result = spawnSync(process.execPath, [SENNEL, "flow", "get", "runtime-log", ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, SENNEL_WORK_ROOT: directory },
  });
  return { ...result, envelope: result.stdout.trim() === "" ? null : JSON.parse(result.stdout) };
}

it("reads a runtime log with the same opaque binding and rejects a genuine authority mismatch", () => {
  const directory = root();
  const flowManager = makeFlowManager(directory);
  const fixture = new CanonicalFlowFixture({
    flowManager,
    specId: "715-runtime-log-binding",
    runId: "runtime-log-binding-run",
  }).create().registerActive();
  const state = fixture.state();
  const writer = new RuntimeLogBlockWriter({
    root: directory,
    flowId: state.specId,
    runId: state.runId,
    command: "flow run gate",
  });
  writer.capture("stdout", "runtime log binding fixture\n");
  writer.close(0);
  const binding = FlowTargetBinding.captureContext({
    root: directory,
    mainRoot: directory,
    executionRoot: directory,
    flowState: state,
  }).serialize();

  const same = invoke(directory, ["--expect-binding", binding, "--format", "json"]);
  assert.equal(same.status, 0, same.stderr);
  assert.equal(same.envelope.ok, true);
  assert.match(same.envelope.data.text, /runtime log binding fixture/);

  const other = root();
  const mismatched = new FlowTargetBinding({
    runId: state.runId,
    issue: state.issue,
    specId: state.specId,
    authority: {
      mode: state.execution.mode,
      mainRoot: other,
      executionRoot: other,
      featureBranch: state.execution.mode === "branch" ? state.featureBranch : null,
      baseBranch: state.execution.mode === "branch" ? state.baseBranch : null,
    },
  }).serialize();
  const stale = invoke(directory, ["--expect-binding", mismatched, "--format", "json"]);
  assert.notEqual(stale.status, 0, stale.stderr);
  assert.equal(stale.envelope.errors[0].code, "ACTIVE_FLOW_MISMATCH");
});

it("returns the enclosing interval through the CLI and leaves a parent with only a child end incomplete", () => {
  const directory = root();
  const flowManager = makeFlowManager(directory);
  const fixture = new CanonicalFlowFixture({
    flowManager,
    specId: "runtime-log-interval",
    runId: "runtime-log-interval-run",
  }).create().registerActive();
  const state = fixture.state();
  const before = JSON.stringify(state);
  const binding = FlowTargetBinding.captureContext({
    root: directory,
    mainRoot: directory,
    executionRoot: directory,
    flowState: state,
  }).serialize();
  const file = new RuntimeLogFile(directory, state.specId);
  const writer = (command) => new RuntimeLogBlockWriter({
    root: directory,
    flowId: state.specId,
    runId: state.runId,
    command,
  });
  const parent = writer("flow run dispatch");
  parent.capture("stdout", "parent before child\n");
  const child = writer("flow get status");
  child.capture("stderr", "child diagnostic\n");
  const childMetadata = child.close(7);
  parent.capture("stdout", "parent after child\n");
  const parentMetadata = parent.close(3);
  const interval = file.read().trimEnd();
  const unfinished = writer("flow run finalize-sync");
  const finishedChild = writer("flow get status");
  finishedChild.capture("stdout", "child finished while parent remains open\n");
  finishedChild.close(0);
  const query = (args) => invoke(directory, ["--expect-binding", binding, "--format", "json", ...args]);

  const enclosing = query(["--sequence", String(parentMetadata.sequence)]);
  assert.equal(enclosing.status, 0, enclosing.stderr);
  assert.equal(enclosing.envelope.ok, true);
  assert.deepEqual(enclosing.envelope.data, {
    text: interval,
    runId: state.runId,
    sequence: parentMetadata.sequence,
    command: parentMetadata.command,
    startedAt: parentMetadata.startedAt,
    endedAt: parentMetadata.endedAt,
    exitCode: 3,
    complete: true,
  });

  const nested = query(["--run-id", `${state.runId}#${childMetadata.sequence}`]);
  assert.equal(nested.status, 0, nested.stderr);
  assert.equal(nested.envelope.data.exitCode, 7);
  assert.equal(nested.envelope.data.startedAt, childMetadata.startedAt);
  assert.equal(nested.envelope.data.endedAt, childMetadata.endedAt);
  assert.doesNotMatch(nested.envelope.data.text, /parent after child/);

  const incomplete = query(["--sequence", String(unfinished.metadata.sequence)]);
  assert.equal(incomplete.status, 0, incomplete.stderr);
  assert.equal(incomplete.envelope.data.complete, false);
  assert.equal(incomplete.envelope.data.exitCode, null);
  assert.equal(incomplete.envelope.data.endedAt, null);
  assert.equal(incomplete.envelope.data.startedAt, unfinished.metadata.startedAt);
  assert.match(incomplete.envelope.data.text, /child finished while parent remains open/);
  assert.equal(JSON.stringify(fixture.state()), before, "Diagnostic reads do not change canonical Flow state");
});
