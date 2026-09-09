import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { FileLock, FileLockTimeoutError, FileLockWaitPolicy } from "../../../src/lib/file-lock.js";
import { ProcessIdentitySource } from "../../../src/lib/process-identity.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { ExternalProcessLockOwner } from "../../support/infrastructure/external-lock-owner.js";

const holders = [];
const roots = [];

function root(name) {
  const value = createTmpDir(name);
  roots.push(value);
  return value;
}

function lockAt(directory, { processIdentitySource, waitPolicy = new FileLockWaitPolicy({ timeoutMs: 25, intervalMs: 1 }) } = {}) {
  return new FileLock({
    directoryAuthority: new RealDirectoryAuthority(directory),
    fileName: ".file-lock.test.lock",
    kind: "file-lock-test",
    authority: { root: fs.realpathSync(directory) },
    ...(processIdentitySource && { processIdentitySource }),
    waitPolicy,
  });
}

function externalHolder(directory) {
  const holder = ExternalProcessLockOwner.forFileLock({
    directory,
    fileName: ".file-lock.test.lock",
    kind: "file-lock-test",
    authority: { root: fs.realpathSync(directory) },
  });
  holders.push(holder);
  return holder;
}

function identitySource(bootIdentity) {
  return new ProcessIdentitySource({
    platform: "linux", pid: process.pid, readBootIdentity: () => bootIdentity, readProcessStartFingerprint: () => "441",
  });
}

async function assertScheduledWaitDelays(method, lock) {
  const performancePrototype = Object.getPrototypeOf(performance);
  const nowDescriptor = Object.getOwnPropertyDescriptor(performancePrototype, "now");
  const originalWait = Atomics.wait;
  const originalSetTimeout = globalThis.setTimeout;
  const delays = [];
  let now = 0;
  Object.defineProperty(performancePrototype, "now", { ...nowDescriptor, value: () => now });
  Atomics.wait = (_array, _index, _value, delay) => {
    delays.push(delay);
    now += delay;
    return "timed-out";
  };
  globalThis.setTimeout = (callback, delay) => {
    delays.push(delay);
    now += delay;
    queueMicrotask(callback);
    return 0;
  };
  try {
    const assertTimeout = (error) => error instanceof FileLockTimeoutError
      && error.waitedMs === 10 && error.cause.cause.lockStatus === "live";
    if (method === "sync") assert.throws(() => lock.acquire(), assertTimeout);
    else await assert.rejects(lock.acquireAsync(), assertTimeout);
  } finally {
    Object.defineProperty(performancePrototype, "now", nowDescriptor);
    Atomics.wait = originalWait;
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.deepEqual(delays, [6, 4]);
}

function snapshot(lock) {
  return { bytes: fs.readFileSync(lock.lockPath), stat: fs.lstatSync(lock.lockPath) };
}

function assertUnchanged(lock, before) {
  assert.deepEqual(fs.readFileSync(lock.lockPath), before.bytes);
  const after = fs.lstatSync(lock.lockPath);
  assert.equal(after.dev === before.stat.dev && after.ino === before.stat.ino, true);
}

async function assertRejectedWithoutMutation(lock, method, status, errorType = null) {
  const before = snapshot(lock);
  const assertion = (error) => {
    assert.equal(error.lockStatus, status);
    if (errorType) assert.ok(error instanceof errorType);
    return true;
  };
  if (method === "sync") assert.throws(() => lock.acquire(), assertion);
  else await assert.rejects(() => lock.acquireAsync(), assertion);
  assertUnchanged(lock, before);
}

describe("FileLock", () => {
  afterEach(async () => {
    for (const holder of holders.splice(0)) await holder.release();
    for (const directory of roots.splice(0)) removeTmpDir(directory);
  });

  it("times out without changing a live external owner in sync and async acquisition", async () => {
    for (const method of ["sync", "async"]) {
      const directory = root(`file-lock-timeout-${method}-`);
      const holder = externalHolder(directory);
      await holder.waitUntilReady();
      const waiter = lockAt(directory, { waitPolicy: new FileLockWaitPolicy({ timeoutMs: 0, intervalMs: 1 }) });
      await assertRejectedWithoutMutation(waiter, method, "timeout", FileLockTimeoutError);
      await holder.release();
    }
  });

  it("reports positive timeout, interval, and waited duration for sync and async acquisition", async () => {
    for (const method of ["sync", "async"]) {
      const directory = root(`file-lock-positive-timeout-${method}-`);
      const holder = externalHolder(directory);
      await holder.waitUntilReady();
      const waitPolicy = new FileLockWaitPolicy({ timeoutMs: 20, intervalMs: 3 });
      const waiter = lockAt(directory, { waitPolicy });
      const before = snapshot(waiter);
      const assertion = (error) => {
        assert.ok(error instanceof FileLockTimeoutError);
        assert.equal(error.lockStatus, "timeout");
        assert.equal(error.retryable, true);
        assert.equal(error.waitedMs >= waitPolicy.timeoutMs, true);
        assert.equal(error.cause.lockStatus, "timeout");
        assert.equal(error.cause.cause.lockStatus, "live");
        return true;
      };
      if (method === "sync") assert.throws(() => waiter.acquire(), assertion);
      else await assert.rejects(waiter.acquireAsync(), assertion);
      assertUnchanged(waiter, before);
      await holder.release();
    }
  });

  it("schedules sync and async waits by interval then remaining timeout", async () => {
    for (const method of ["sync", "async"]) {
      const directory = root(`file-lock-scheduled-delays-${method}-`);
      const holder = externalHolder(directory);
      await holder.waitUntilReady();
      const lock = lockAt(directory, {
        waitPolicy: new FileLockWaitPolicy({ timeoutMs: 10, intervalMs: 6 }),
      });
      await assertScheduledWaitDelays(method, lock);
      await holder.release();
    }
  });

  it("keeps the shared finite default and permits Infinity only when explicit", () => {
    const defaults = new FileLockWaitPolicy();
    const unlimited = new FileLockWaitPolicy({ timeoutMs: Infinity, intervalMs: 3 });
    assert.deepEqual(
      { timeoutMs: defaults.timeoutMs, intervalMs: defaults.intervalMs },
      { timeoutMs: 5000, intervalMs: 50 },
    );
    assert.deepEqual(
      { timeoutMs: unlimited.timeoutMs, intervalMs: unlimited.intervalMs },
      { timeoutMs: Infinity, intervalMs: 3 },
    );
  });

  it("fails closed for unknown and corrupt locks in sync and async acquisition", async () => {
    for (const method of ["sync", "async"]) {
      const unknownDirectory = root(`file-lock-unknown-${method}-`);
      const holder = lockAt(unknownDirectory);
      holder.acquire();
      const unknown = lockAt(unknownDirectory, { processIdentitySource: new ProcessIdentitySource({
        platform: "linux", pid: process.pid, readBootIdentity: () => { throw new Error("boot identity unavailable"); }, readProcessStartFingerprint: () => "441",
      }) });
      await assertRejectedWithoutMutation(unknown, method, "unknown");
      holder.release();

      const corruptDirectory = root(`file-lock-corrupt-${method}-`);
      const corrupt = lockAt(corruptDirectory);
      fs.writeFileSync(corrupt.lockPath, "not-json");
      await assertRejectedWithoutMutation(corrupt, method, "corrupt");
    }
  });

  it("does not convert bounded owner-observation churn into a wait timeout", () => {
    const directory = root("file-lock-observation-churn-");
    const holder = lockAt(directory);
    holder.acquire();
    const waiter = lockAt(directory, { waitPolicy: new FileLockWaitPolicy({ timeoutMs: 25, intervalMs: 1 }) });
    const before = snapshot(holder);
    const originalOpen = fs.openSync;
    let observations = 0;
    fs.openSync = (target, ...args) => {
      if (target === holder.lockPath) {
        observations += 1;
        throw Object.assign(new Error("owner changed"), { code: "ENOENT" });
      }
      return originalOpen(target, ...args);
    };
    try {
      assert.throws(
        () => waiter.acquire(),
        (error) => error.lockStatus === "transition-failed" && error.waitedMs === undefined,
      );
    } finally {
      fs.openSync = originalOpen;
    }
    assert.equal(observations, 4);
    assertUnchanged(holder, before);
    holder.release();
  });

  it("rejects same-instance and distinct-instance same-birth reentrancy", async () => {
    for (const relation of ["same-instance", "different-instance"]) {
      for (const method of ["sync", "async"]) {
        const directory = root(`file-lock-${relation}-${method}-`);
        const owner = lockAt(directory);
        owner.acquire();
        const contender = relation === "same-instance" ? owner : lockAt(directory);
        try { await assertRejectedWithoutMutation(contender, method, "reentrant"); } finally { owner.release(); }
      }
    }
  });

  it("reclaims a proven stale owner without consuming the waiting policy", () => {
    const directory = root("file-lock-stale-");
    const stale = lockAt(directory, { processIdentitySource: identitySource("stale"), waitPolicy: new FileLockWaitPolicy({ timeoutMs: 0, intervalMs: 1 }) });
    stale.acquire();
    const current = lockAt(directory, { processIdentitySource: identitySource("current"), waitPolicy: new FileLockWaitPolicy({ timeoutMs: 0, intervalMs: 1 }) });
    assert.equal(typeof current.acquire(), "string");
    current.release();
  });

  it("does not retry a publication transition failure or discard its diagnostics", () => {
    const directory = root("file-lock-transition-");
    const lock = lockAt(directory);
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    let ownerTempOpens = 0;
    fs.openSync = (target, ...args) => {
      if (String(target).endsWith(".owner.tmp")) ownerTempOpens += 1;
      return originalOpen(target, ...args);
    };
    fs.fsyncSync = (descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) throw new Error("publication directory sync failed");
      return originalFsync(descriptor);
    };
    try {
      assert.throws(
        () => lock.acquire(),
        (error) => error.name === "ProcessLockTransitionError"
          && error.phase === "publish-directory-fsync"
          && error.lockStatus === "durability-uncertain"
          && error.publishedToVisibleName === true
          && error.durabilityUnknown === true
          && typeof error.owner?.processIdentity?.ownerToken === "string"
          && error.cause instanceof AggregateError,
      );
      assert.equal(ownerTempOpens, 1);
    } finally {
      fs.openSync = originalOpen;
      fs.fsyncSync = originalFsync;
    }
  });

  it("aggregates a failing body before a failing release", () => {
    const directory = root("file-lock-aggregate-");
    const lock = lockAt(directory);
    const originalFsync = fs.fsyncSync;
    try {
      assert.throws(
        () => lock.runExclusive(() => {
          fs.fsyncSync = (descriptor) => {
            if (fs.fstatSync(descriptor).isDirectory()) throw new Error("release sync failed");
            return originalFsync(descriptor);
          };
          throw new Error("body failed");
        }),
        (error) => error instanceof AggregateError && error.cause === error.errors[0]
          && error.errors[0].message === "body failed" && error.errors[1].name === "ProcessLockTransitionError",
      );
    } finally { fs.fsyncSync = originalFsync; }
  });

  it("preserves async body-and-release AggregateError order and diagnostics", async () => {
    const directory = root("file-lock-async-aggregate-");
    const lock = lockAt(directory);
    const originalFsync = fs.fsyncSync;
    try {
      await assert.rejects(
        lock.runExclusiveAsync(async () => {
          fs.fsyncSync = (descriptor) => {
            if (fs.fstatSync(descriptor).isDirectory()) throw new Error("async release sync failed");
            return originalFsync(descriptor);
          };
          throw new Error("async body failed");
        }),
        (error) => error instanceof AggregateError && error.cause === error.errors[0]
          && error.errors[0].message === "async body failed"
          && error.errors[1].name === "ProcessLockTransitionError"
          && error.errors[1].phase === "release-directory-fsync"
          && error.errors[1].lockStatus === "durability-uncertain",
      );
    } finally { fs.fsyncSync = originalFsync; }
  });

  it("rejects changed directory authority with complete diagnostics before acquisition", async () => {
    const parent = root("file-lock-authority-");
    for (const asynchronous of [false, true]) {
      const directory = path.join(parent, String(asynchronous));
      fs.mkdirSync(directory);
      const lock = lockAt(directory);
      fs.renameSync(directory, `${directory}-original`);
      fs.mkdirSync(directory);
      const check = (error) => {
        assert.equal(error.lockStatus, "authority-invalid");
        assert.equal(error.lockPath, directory);
        assert.equal(error.owner, null);
        assert.ok(Object.hasOwn(error, "cause"));
        assert.equal(error.waitedMs, undefined);
        return true;
      };
      if (asynchronous) await assert.rejects(lock.acquireAsync(), check);
      else assert.throws(() => lock.acquire(), check);
      assert.deepEqual(fs.readdirSync(directory), []);
      assert.deepEqual(fs.readdirSync(`${directory}-original`), []);
    }
  });

  it("waits asynchronously for an external release and runs an exclusive body", async () => {
    const directory = root("file-lock-async-");
    const holder = externalHolder(directory);
    await holder.waitUntilReady();
    const waiter = lockAt(directory, { waitPolicy: new FileLockWaitPolicy({ timeoutMs: Infinity, intervalMs: 1 }) });
    const acquired = waiter.acquireAsync();
    const [token] = await Promise.all([acquired, holder.release()]);
    assert.equal(typeof token, "string");
    waiter.release();
    assert.equal(await waiter.runExclusiveAsync(async () => "done"), "done");
  });
});
