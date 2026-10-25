import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { FlowHandoffAuthorityLease } from "../../../src/lib/flow-handoff-authority-lease.js";
import { FileLockWaitPolicy } from "../../../src/lib/file-lock.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const LEASE_MODULE_PATH = fileURLToPath(new URL("../../../src/lib/flow-handoff-authority-lease.js", import.meta.url));

function spawnLeaseOwner(root, afterAcquire) {
  return spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      `import { FlowHandoffAuthorityLease } from ${JSON.stringify(LEASE_MODULE_PATH)};`,
      `const lease = new FlowHandoffAuthorityLease({ mainRoot: ${JSON.stringify(root)}, executionRoot: ${JSON.stringify(root)} });`,
      "lease.acquire();",
      "process.send('locked');",
      afterAcquire,
    ].join("\n"),
  ], { stdio: ["pipe", "ignore", "pipe", "ipc"] });
}

function spawnLeaseWaiter(root) {
  return spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      `import { FlowHandoffAuthorityLease } from ${JSON.stringify(LEASE_MODULE_PATH)};`,
      `const lease = new FlowHandoffAuthorityLease({ mainRoot: ${JSON.stringify(root)}, executionRoot: ${JSON.stringify(root)} });`,
      "process.send('waiting');",
      "try { lease.acquire(); } catch (error) { process.send({ code: error.code, lockStatus: error.lockStatus, waitedMs: error.waitedMs, retryable: error.retryable }); process.exit(1); }",
      "process.send('acquired');",
      "lease.release();",
      "process.exit(0);",
    ].join("\n"),
  ], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
}

function cleanUpChild(t, child) {
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
}

describe("FlowHandoffAuthorityLease", () => {
  it("keeps unrelated worktree Flow handoffs independent and releases cleanly", () => {
    const root = createTmpDir("flow-handoff-authority-");
    try {
      fs.mkdirSync(`${root}/.sennel`);
      const worktree = path.join(root, "worktree-one"); fs.mkdirSync(worktree);
      const otherWorktree = path.join(root, "worktree-two"); fs.mkdirSync(otherWorktree);
      const first = new FlowHandoffAuthorityLease({ mainRoot: root, executionRoot: worktree });
      const sameFlow = new FlowHandoffAuthorityLease({ mainRoot: root, executionRoot: worktree });
      const otherFlow = new FlowHandoffAuthorityLease({ mainRoot: root, executionRoot: otherWorktree });
      first.acquire();
      assert.throws(
        () => sameFlow.acquire(),
        (error) => error.code === "FLOW_HANDOFF_AUTHORITY_LOCK_REENTRANT"
          && error.lockStatus === "reentrant",
      );
      otherFlow.acquire();
      otherFlow.release();
      first.release();

      sameFlow.acquire();
      sameFlow.release();
    } finally {
      removeTmpDir(root);
    }
  });

  it("serializes distinct direct Flow runs that share one checkout", () => {
    const root = createTmpDir("flow-handoff-authority-direct-");
    try {
      fs.mkdirSync(`${root}/.sennel`);
      const first = new FlowHandoffAuthorityLease({ mainRoot: root, executionRoot: root });
      const second = new FlowHandoffAuthorityLease({ mainRoot: root, executionRoot: root });
      first.acquire();
      assert.throws(
        () => second.acquire(),
        (error) => error.code === "FLOW_HANDOFF_AUTHORITY_LOCK_REENTRANT"
          && error.lockStatus === "reentrant",
      );
      first.release();
      second.acquire();
      second.release();
    } finally {
      removeTmpDir(root);
    }
  });

  it("waits for a cooperative owner to release within the common finite policy", async (t) => {
    const root = createTmpDir("flow-handoff-authority-wait-");
    try {
      fs.mkdirSync(`${root}/.sennel`);
      const owner = spawnLeaseOwner(root, "process.stdin.once('data', () => { lease.release(); process.exit(0); });");
      cleanUpChild(t, owner);
      const ownerExit = once(owner, "exit");
      assert.equal((await once(owner, "message"))[0], "locked");
      const waiting = spawnLeaseWaiter(root);
      cleanUpChild(t, waiting);
      const waitingExit = once(waiting, "exit");
      assert.equal((await once(waiting, "message"))[0], "waiting");
      const acquired = once(waiting, "message");
      owner.stdin.write("release\n");
      assert.equal((await acquired)[0], "acquired");
      const [ownerCode] = await ownerExit;
      const [waitingCode] = await waitingExit;
      assert.equal(ownerCode, 0);
      assert.equal(waitingCode, 0);
    } finally {
      removeTmpDir(root);
    }
  });

  it("times out with the handoff domain error while another process owns the lease", async (t) => {
    const root = createTmpDir("flow-handoff-authority-timeout-");
    try {
      fs.mkdirSync(`${root}/.sennel`);
      const child = spawnLeaseOwner(root, "process.stdin.once('data', () => { lease.release(); process.exit(0); });");
      cleanUpChild(t, child);
      const childExit = once(child, "exit");
      assert.equal((await once(child, "message"))[0], "locked");

      const waiting = new FlowHandoffAuthorityLease({
        mainRoot: root,
        executionRoot: root,
        waitPolicy: new FileLockWaitPolicy({ timeoutMs: 0, intervalMs: 50 }),
      });
      assert.throws(
        () => waiting.acquire(),
        (error) => error.code === "FLOW_HANDOFF_AUTHORITY_WAIT_TIMEOUT"
          && error.lockStatus === "timeout"
          && error.retryable === true,
      );
      child.stdin.write("release\n");
      const [code] = await childExit;
      assert.equal(code, 0);
    } finally {
      removeTmpDir(root);
    }
  });

  it("uses the common finite default while another process keeps its ownership", { timeout: 15000 }, async () => {
    const root = createTmpDir("flow-handoff-authority-default-timeout-");
    let owner, waiting;
    try {
      owner = spawnLeaseOwner(root, "process.stdin.once('data', () => { lease.release(); process.exit(0); });");
      assert.equal((await once(owner, "message", { signal: AbortSignal.timeout(10000) }))[0], "locked");
      const lockPath = FlowHandoffAuthorityLease.pathFor({ mainRoot: root, executionRoot: root });
      const before = fs.readFileSync(lockPath);
      waiting = spawnLeaseWaiter(root);
      const waitingExit = once(waiting, "exit");
      assert.equal((await once(waiting, "message", { signal: AbortSignal.timeout(10000) }))[0], "waiting");
      const [failure] = await once(waiting, "message", { signal: AbortSignal.timeout(10000) });
      assert.equal(failure.code, "FLOW_HANDOFF_AUTHORITY_WAIT_TIMEOUT");
      assert.equal(failure.lockStatus, "timeout");
      assert.equal(failure.retryable, true);
      assert.ok(failure.waitedMs >= new FileLockWaitPolicy().timeoutMs);
      assert.equal((await waitingExit)[0], 1);
      assert.deepEqual(fs.readFileSync(lockPath), before);
      const ownerExit = once(owner, "exit");
      owner.stdin.write("release\n");
      assert.equal((await ownerExit)[0], 0);
      const successor = new FlowHandoffAuthorityLease({ mainRoot: root, executionRoot: root });
      successor.acquire(); successor.release();
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      for (const child of [waiting, owner]) if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill(); await exited;
      }
      removeTmpDir(root);
    }
  });

  it("refuses an abandoned token lease without changing its owner bytes", async () => {
    const root = createTmpDir("flow-handoff-authority-abandoned-");
    try {
      const child = spawnLeaseOwner(root, "process.exit(0);");
      const exited = once(child, "exit");
      assert.equal((await once(child, "message"))[0], "locked");
      assert.equal((await exited)[0], 0);
      const lockPath = FlowHandoffAuthorityLease.pathFor({ mainRoot: root, executionRoot: root });
      const before = fs.readFileSync(lockPath);
      const lease = new FlowHandoffAuthorityLease({ mainRoot: root, executionRoot: root,
        waitPolicy: new FileLockWaitPolicy({ timeoutMs: 0 }) });
      assert.throws(() => lease.acquire(), { code: "FLOW_HANDOFF_AUTHORITY_WAIT_TIMEOUT" });
      assert.deepEqual(fs.readFileSync(lockPath), before);
    } finally { removeTmpDir(root); }
  });
});
