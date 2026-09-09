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
      "lease.acquire();",
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

  it("waits for an already-held Flow lease and then acquires it without a timeout", async (t) => {
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

  it("reclaims a stale checkout lease owner", async () => {
    const root = createTmpDir("flow-handoff-authority-stale-");
    try {
      fs.mkdirSync(`${root}/.sennel`);
      const child = spawnLeaseOwner(root, "process.exit(0);");
      const exited = once(child, "exit");
      assert.equal((await once(child, "message"))[0], "locked");
      const [code] = await exited;
      assert.equal(code, 0);

      const lease = new FlowHandoffAuthorityLease({ mainRoot: root, executionRoot: root });
      lease.acquire();
      lease.release();
    } finally {
      removeTmpDir(root);
    }
  });
});
