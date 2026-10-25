import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { devNull } from "node:os";
import { test } from "node:test";
import { collectUntrackedDiff } from "../../../src/flow/lib/run-gate.js";
import { FlowRepositoryRuntimeArtifactRegistry } from "../../../src/flow/lib/flow-repository-runtime-artifacts.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { withManagedProcessScope } from "../../../src/lib/managed-process.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";

function scenario(t) {
  const root = fs.mkdtempSync(path.join(testTemporaryRoot().path, "gate-untracked-diff-concurrency-"));
  t.after(() => removeQuiescentRuntimeFixture({ mainRoot: root, executionRoot: root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }));
  execFileSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "--quiet", "-m", "Create untracked diff runtime fixture"], { encoding: "utf8" });
  fs.writeFileSync(path.join(root, ".gitignore"), ".sennel/\nspecs/\n");
  execFileSync("git", ["-C", root, "add", ".gitignore"], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--quiet", "-m", "Ignore canonical fixture state"], { encoding: "utf8" });
  return root;
}

function calls(inventory) {
  return (inventory?.executions ?? []).flatMap((execution) => execution.calls);
}

test("concurrent untracked gate collections submit bounded Git children and retain every exact receipt", { timeout: 120000 }, async (t) => {
  const root = scenario(t);
  const relativeFiles = Array.from({ length: 16 }, (_, index) => `fixture-${String(index).padStart(2, "0")}.txt`);
  for (const relative of relativeFiles) fs.writeFileSync(path.join(root, relative), `content ${relative}\n`);

  const runtimeArtifacts = new FlowRepositoryRuntimeArtifactRegistry();
  assert.equal(runtimeArtifacts.owns(".tmp/process-runtime/fixture.json"), true);
  const expected = relativeFiles.map((relative) => {
    const result = spawnSync("git", ["diff", "--no-index", "--no-color", "--", devNull, relative], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    return result.stdout;
  }).join("");

  const before = ProcessExecutionRuntime.inspect({ mainRoot: root, executionRoot: root });
  const beforeCallIds = new Set(calls(before).map((call) => call.callId));
  try {
    // A normal caller-owned scope keeps both collections in the same durable
    // coordinator while each read-only helper borrows its existing authority.
    await withManagedProcessScope({ standaloneRoot: root }, async () => {
      const settled = await Promise.allSettled([
        collectUntrackedDiff(root, { excludeFile: (relative) => runtimeArtifacts.owns(relative) }),
        collectUntrackedDiff(root, { excludeFile: (relative) => runtimeArtifacts.owns(relative) }),
      ]);
      const failures = settled.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, "Concurrent untracked diff collection failed");
      assert.deepEqual(settled.map((result) => result.value), [expected, expected]);
    });

    const after = ProcessExecutionRuntime.inspect({ mainRoot: root, executionRoot: root });
    const submitted = after.executions.flatMap((execution) => execution.calls
      .filter((call) => !beforeCallIds.has(call.callId)).map((call) => ({ execution, call })));
    assert.equal(submitted.length, 34, "two listings and thirty-two file diffs must all have durable call records");
    assert.equal(new Set(submitted.map(({ call }) => call.callId)).size, 34);
    assert.ok(submitted.every(({ call, execution }) => call.receipt !== null
      && call.receipt.callId === call.callId
      && call.receipt.executionId === execution.executionId
      && call.receipt.ownerEpoch === execution.ownerEpoch),
    "every submitted Git child must have its matching exact stop receipt");
    assert.equal(submitted.filter(({ call }) => call.receipt.observation.code === 0).length, 2,
      "both untracked listings must exit successfully");
    assert.equal(submitted.filter(({ call }) => call.receipt.observation.code === 1).length, 32,
      "each non-empty no-index diff must report differences");

    const selectedExecutions = new Set(submitted.map(({ execution }) => execution.executionId));
    for (const executionId of selectedExecutions) {
      const execution = after.executions.find((entry) => entry.executionId === executionId);
      assert.equal(execution.status, "closed", "each ordinary implicit runtime epoch must have closed");
      const executionCalls = new Set(submitted.filter((entry) => entry.execution.executionId === executionId)
        .map(({ call }) => call.callId));
      for (const callId of executionCalls) {
        assert.deepEqual(execution.events.filter((event) => event.callId === callId).map((event) => event.type),
          ["reserved", "started", "exited", "result-finalized"]);
      }
    }
  } catch (error) {
    testTemporaryRoot().retainOnUnconfirmedExecution(error);
    throw error;
  }
});
