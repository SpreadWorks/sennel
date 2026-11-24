import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { FileLock, FileLockTimeoutError, FileLockWaitPolicy } from "../../../src/lib/file-lock.js";
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

function lockAt(directory, { waitPolicy = new FileLockWaitPolicy({ timeoutMs: 25, intervalMs: 1 }) } = {}) {
  return new FileLock({
    directoryAuthority: new RealDirectoryAuthority(directory),
    fileName: ".file-lock.test.lock",
    kind: "file-lock-test",
    authority: { root: fs.realpathSync(directory) },
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

async function assertScheduledWaitDelays(method, lock) {
  let performancePrototype = performance;
  while (!Object.hasOwn(performancePrototype, "now")) performancePrototype = Object.getPrototypeOf(performancePrototype);
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
      && error.waitedMs === 10 && error.cause.cause.lockStatus === "busy";
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

function failRemovalReadback(message) {
  const unlink = fs.unlinkSync;
  const lstat = fs.lstatSync;
  let removed = null;
  let failed = false;
  fs.unlinkSync = (target) => { const result = unlink(target); removed = target; return result; };
  fs.lstatSync = (target, ...args) => {
    if (target === removed && !failed) { failed = true; throw new Error(message); }
    return lstat(target, ...args);
  };
  return () => { fs.unlinkSync = unlink; fs.lstatSync = lstat; };
}

describe("FileLock", () => {
  afterEach(async () => {
    for (const holder of holders.splice(0)) await holder.release();
    for (const directory of roots.splice(0)) removeTmpDir(directory);
  });

  it("times out without changing a published external owner in sync and async acquisition", async () => {
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
        assert.equal(error.cause.cause.lockStatus, "busy");
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

  it("waits through a normal exclusive publication without accepting linked owner bytes", async () => {
    const directory = root("file-lock-stage-publication-");
    const publisher = lockAt(directory);
    const contender = lockAt(directory, { waitPolicy: new FileLockWaitPolicy({ timeoutMs: 1000, intervalMs: 1 }) });
    const link = fs.linkSync;
    let acquisition = null;
    let pending = null;
    let linkedToken = null;
    fs.linkSync = (source, target) => {
      const result = link(source, target);
      if (target === publisher.lockPath && acquisition === null) {
        assert.equal(fs.lstatSync(target).nlink, 2);
        try { contender.inspect(); } catch (error) { pending = error; }
        linkedToken = contender.ownerToken;
        acquisition = contender.acquireAsync();
      }
      return result;
    };
    let publisherToken;
    try { publisherToken = publisher.acquire(); } finally { fs.linkSync = link; }
    try {
      assert.equal(pending.name, "ProcessLockPublicationPendingError");
      assert.equal(pending.lockStatus, "publication-pending");
      assert.equal(pending.owner, null);
      assert.equal(linkedToken, null);
      assert.equal(publisher.inspect().owner.ownerToken, publisherToken);
      assert.equal(fs.lstatSync(publisher.lockPath).nlink, 1);
    } finally { publisher.release(); }
    const token = await acquisition;
    try {
      assert.equal(typeof token, "string");
      assert.notEqual(token, publisherToken);
      assert.equal(contender.inspect().owner.ownerToken, token);
    } finally { contender.release(); }
    assert.deepEqual(fs.readdirSync(directory), []);
  });

  it("preserves persistent foreign hard links through sync and async finite waits", async () => {
    for (const method of ["sync", "async"]) {
      const directory = root(`file-lock-persistent-link-${method}-`);
      const owner = lockAt(directory);
      owner.acquire();
      const alias = path.join(directory, "foreign-owner-link");
      fs.linkSync(owner.lockPath, alias);
      const before = snapshot(owner);
      const waiter = lockAt(directory, { waitPolicy: new FileLockWaitPolicy({ timeoutMs: 10, intervalMs: 1 }) });
      const check = (error) => {
        assert.ok(error instanceof FileLockTimeoutError);
        assert.equal(error.cause.cause.name, "ProcessLockPublicationPendingError");
        assert.equal(error.cause.cause.owner, null);
        assert.equal(error.owner, null);
        assert.equal(error.waitedMs >= 10, true);
        return true;
      };
      try {
        if (method === "sync") assert.throws(() => waiter.acquire(), check);
        else await assert.rejects(waiter.acquireAsync(), check);
        assert.equal(waiter.ownerToken, null);
        assertUnchanged(owner, before);
        assert.deepEqual(fs.readFileSync(alias), before.bytes);
        assert.equal(fs.lstatSync(alias).nlink, 2);
        assert.throws(() => owner.release(), (error) => error.name === "ProcessLockPublicationPendingError");
        assertUnchanged(owner, before);
      } finally {
        // Only this test-created alias is removed, after preservation is proved.
        fs.unlinkSync(alias);
        owner.release();
      }
    }
  });

  it("immediately refuses more than two links without reading or adopting an owner", async () => {
    for (const method of ["sync", "async"]) {
      const directory = root(`file-lock-extra-links-${method}-`);
      const owner = lockAt(directory);
      owner.acquire();
      const aliases = [path.join(directory, "foreign-one"), path.join(directory, "foreign-two")];
      for (const alias of aliases) fs.linkSync(owner.lockPath, alias);
      const before = snapshot(owner);
      const waiter = lockAt(directory);
      const check = (error) => {
        assert.equal(error.lockStatus, "corrupt");
        assert.equal(error.owner, null);
        assert.equal(error.waitedMs, undefined);
        return true;
      };
      try {
        if (method === "sync") assert.throws(() => waiter.acquire(), check);
        else await assert.rejects(waiter.acquireAsync(), check);
        assert.equal(waiter.ownerToken, null);
        assertUnchanged(owner, before);
        assert.equal(fs.lstatSync(owner.lockPath).nlink, 3);
        for (const alias of aliases) assert.deepEqual(fs.readFileSync(alias), before.bytes);
      } finally {
        for (const alias of aliases) fs.unlinkSync(alias);
        owner.release();
      }
    }
  });

  it("fails closed for unknown and corrupt locks in sync and async acquisition", async () => {
    for (const method of ["sync", "async"]) {
      const unknownDirectory = root(`file-lock-unknown-${method}-`);
      const unknown = lockAt(unknownDirectory);
      fs.writeFileSync(unknown.lockPath, JSON.stringify({ version: 1, processIdentity: { pid: process.pid } }));
      await assertRejectedWithoutMutation(unknown, method, "unknown");

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

  it("rejects same-instance and distinct-instance same-session reentrancy", async () => {
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

  it("retains a complete foreign-session record and exhausts the finite wait", () => {
    const directory = root("file-lock-retained-owner-");
    const owner = lockAt(directory);
    owner.acquire();
    const record = JSON.parse(fs.readFileSync(owner.lockPath, "utf8"));
    owner.release();
    record.ownerSession = "11111111-1111-4111-8111-111111111111";
    fs.writeFileSync(owner.lockPath, JSON.stringify(record));
    const current = lockAt(directory, { waitPolicy: new FileLockWaitPolicy({ timeoutMs: 0, intervalMs: 1 }) });
    const before = snapshot(current);
    assert.throws(() => current.acquire(), (error) => error instanceof FileLockTimeoutError);
    assertUnchanged(current, before);
  });

  it("aggregates a failing body before a failing release", () => {
    const directory = root("file-lock-aggregate-");
    const lock = lockAt(directory);
    let restore;
    try {
      assert.throws(() => lock.runExclusive(() => {
        restore = failRemovalReadback("release readback failed");
        throw new Error("body failed");
      }), (error) => error instanceof AggregateError && error.cause === error.errors[0]
        && error.errors[0].message === "body failed" && error.errors[1].name === "ProcessLockTransitionError");
    } finally { restore?.(); }
  });

  it("preserves async body-and-release AggregateError order and diagnostics", async () => {
    const directory = root("file-lock-async-aggregate-");
    const lock = lockAt(directory);
    let restore;
    try {
      await assert.rejects(lock.runExclusiveAsync(async () => {
        restore = failRemovalReadback("async release readback failed");
        throw new Error("async body failed");
      }), (error) => error instanceof AggregateError && error.cause === error.errors[0]
        && error.errors[0].message === "async body failed" && error.errors[1].name === "ProcessLockTransitionError"
        && error.errors[1].phase === "release-readback" && error.errors[1].lockStatus === "publication-unconfirmed");
    } finally { restore?.(); }
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
