import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { ProcessLock } from "../../../src/lib/process-lock.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { spawnSync } from "node:child_process";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function makeLock(root) {
  return new ProcessLock({
    directoryAuthority: new RealDirectoryAuthority(root), fileName: ".process-lock.test.lock", kind: "process-lock-test",
    authority: { root: fs.realpathSync(root) },
  });
}

describe("ProcessLock", () => {
  const roots = [];
  afterEach(() => { for (const root of roots.splice(0)) removeTmpDir(root); });

  it("publishes token/session ownership without querying an OS process identity", () => {
    const root = createTmpDir("process-lock-session-");
    roots.push(root);
    const holder = makeLock(root);
    const token = holder.acquire();
    const owner = holder.inspect().owner;
    assert.equal(owner.ownerToken, token);
    assert.equal(owner.ownerSession, holder.ownerSession);
    assert.equal(Object.hasOwn(owner.toJSON(), "processIdentity"), false);
    assert.equal(holder.isOwnerCurrent(owner), true);
    assert.throws(() => makeLock(root).acquire(), (error) => error.lockStatus === "busy");
    holder.release();
    assert.equal(holder.ownerToken, null);
    assert.equal(fs.existsSync(holder.lockPath), false);
  });

  it("never exposes partial owner JSON to a competing normal observer", () => {
    const root = createTmpDir("process-lock-publication-observer-");
    roots.push(root);
    const holder = makeLock(root);
    const contender = makeLock(root);
    const write = fs.writeSync;
    let observed = false;
    let observation = null;
    let observationFailure = null;
    fs.writeSync = (descriptor, bytes, offset, length, position) => {
      if (observed) return write(descriptor, bytes, offset, length, position);
      const written = write(descriptor, bytes, offset, 1, position);
      observed = true;
      try { observation = contender.inspect(); } catch (error) { observationFailure = error; }
      return written;
    };
    let token;
    try { token = holder.acquire(); } finally { fs.writeSync = write; }
    try {
      assert.equal(observed, true);
      assert.equal(observationFailure, null);
      if (observation !== null) assert.equal(observation.owner.ownerToken, token);
      assert.equal(holder.inspect().owner.ownerToken, token);
      assert.equal(holder.isOwnerCurrent(holder.inspect().owner), true);
      assert.throws(() => contender.acquire(), (error) => error.lockStatus === "busy");
    } finally { holder.release(); }
    assert.equal(contender.inspect(), null);
    assert.deepEqual(fs.readdirSync(root), []);
  });

  it("never reclaims a complete record left by a child that exits without release", () => {
    const root = createTmpDir("process-lock-exited-owner-");
    roots.push(root);
    const lock = makeLock(root);
    const script = `import { ProcessLock } from ${JSON.stringify(new URL("../../../src/lib/process-lock.js", import.meta.url).href)};
      import { RealDirectoryAuthority } from ${JSON.stringify(new URL("../../../src/lib/real-directory-authority.js", import.meta.url).href)};
      const lock = new ProcessLock({ directoryAuthority: new RealDirectoryAuthority(${JSON.stringify(root)}),
        fileName: ${JSON.stringify(path.basename(lock.lockPath))}, kind: ${JSON.stringify(lock.kind)}, authority: ${JSON.stringify(lock.authority)} });
      process.stdout.write(lock.acquire());`;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const bytes = fs.readFileSync(lock.lockPath);
    assert.equal(lock.inspect().owner.ownerToken, child.stdout);
    assert.equal(lock.isOwnerCurrent(lock.inspect().owner), false);
    assert.throws(() => lock.acquire(), (error) => error.lockStatus === "busy");
    assert.deepEqual(fs.readFileSync(lock.lockPath), bytes);
  });

  it("retains a legacy process-identity record for explicit investigation", () => {
    const root = createTmpDir("process-lock-legacy-");
    roots.push(root);
    const lock = makeLock(root);
    const bytes = JSON.stringify({ version: 1, kind: "process-lock-test", processIdentity: { pid: process.pid } });
    fs.writeFileSync(lock.lockPath, bytes);
    assert.throws(() => lock.acquire(), (error) => error.lockStatus === "unknown");
    assert.equal(fs.readFileSync(lock.lockPath, "utf8"), bytes);
  });

  it("re-observes an owner that releases between lstat and open, then acquires", () => {
    const root = createTmpDir("process-lock-owner-release-race-");
    roots.push(root);
    const holder = makeLock(root);
    holder.acquire();
    const candidate = makeLock(root);
    const originalOpen = fs.openSync;
    let released = false;
    fs.openSync = (target, ...args) => {
      if (!released && target === holder.lockPath) {
        released = true;
        holder.release();
      }
      return originalOpen(target, ...args);
    };
    try {
      const token = candidate.acquire();
      assert.equal(typeof token, "string");
      assert.equal(released, true);
      candidate.release();
    } finally {
      fs.openSync = originalOpen;
    }
  });

  it("fails closed after bounded owner-observation churn without changing the owner", () => {
    const root = createTmpDir("process-lock-observation-churn-");
    roots.push(root);
    const holder = makeLock(root);
    holder.acquire();
    const before = fs.readFileSync(holder.lockPath);
    const inode = fs.lstatSync(holder.lockPath).ino;
    const candidate = makeLock(root);
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
      assert.throws(() => candidate.acquire(), (error) => error.lockStatus === "transition-failed");
    } finally {
      fs.openSync = originalOpen;
    }
    assert.equal(observations, 4);
    assert.deepEqual(fs.readFileSync(holder.lockPath), before);
    assert.equal(fs.lstatSync(holder.lockPath).ino, inode);
    holder.release();
  });

  it("refuses a stable malformed replacement after re-observing a changed owner", () => {
    const root = createTmpDir("process-lock-malformed-replacement-");
    roots.push(root);
    const holder = makeLock(root);
    holder.acquire();
    const candidate = makeLock(root);
    const originalOpen = fs.openSync;
    let replaced = false;
    fs.openSync = (target, ...args) => {
      const descriptor = originalOpen(target, ...args);
      if (!replaced && target === holder.lockPath) {
        replaced = true;
        fs.unlinkSync(holder.lockPath);
        fs.writeFileSync(holder.lockPath, "invalid-json", { mode: 0o600 });
      }
      return descriptor;
    };
    try {
      assert.throws(() => candidate.acquire(), (error) => error.lockStatus === "corrupt");
    } finally {
      fs.openSync = originalOpen;
    }
    assert.equal(replaced, true);
    assert.equal(fs.readFileSync(holder.lockPath, "utf8"), "invalid-json");
  });

  it("does not retry an observation change when owner descriptor cleanup also fails", () => {
    const root = createTmpDir("process-lock-observation-close-");
    roots.push(root);
    const holder = makeLock(root);
    holder.acquire();
    const candidate = makeLock(root);
    const before = fs.readFileSync(holder.lockPath);
    const inode = fs.lstatSync(holder.lockPath).ino;
    const originalOpen = fs.openSync;
    const originalFstat = fs.fstatSync;
    const originalClose = fs.closeSync;
    const closeError = Object.assign(new Error("owner descriptor close failed"), { code: "EIO" });
    let ownerDescriptor = null;
    fs.openSync = (target, ...args) => {
      const descriptor = originalOpen(target, ...args);
      if (target === holder.lockPath) ownerDescriptor = descriptor;
      return descriptor;
    };
    fs.fstatSync = (descriptor, ...options) => {
      const stat = originalFstat(descriptor, ...options);
      if (descriptor !== ownerDescriptor) return stat;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: stat.ino + (typeof stat.ino === "bigint" ? 1n : 1) });
    };
    fs.closeSync = (descriptor) => {
      originalClose(descriptor);
      if (descriptor === ownerDescriptor) throw closeError;
    };
    try {
      assert.throws(() => candidate.acquire(), (error) => {
        assert.equal(error.lockStatus, "corrupt");
        assert.ok(error.cause instanceof AggregateError);
        assert.equal(error.cause.errors[0].name, "ProcessLockOwnerObservationChanged");
        assert.equal(error.cause.errors[1], closeError);
        assert.equal(error.cause.cause, error.cause.errors[0]);
        return true;
      });
    } finally {
      fs.openSync = originalOpen;
      fs.fstatSync = originalFstat;
      fs.closeSync = originalClose;
    }
    assert.deepEqual(fs.readFileSync(holder.lockPath), before);
    assert.equal(fs.lstatSync(holder.lockPath).ino, inode);
    holder.release();
  });

  it("does not unlink a foreign owner that replaces the held inode and token", () => {
    const root = createTmpDir("process-lock-foreign-replacement-");
    roots.push(root);
    const holder = makeLock(root);
    holder.acquire();
    fs.unlinkSync(holder.lockPath);
    const foreign = makeLock(root);
    foreign.acquire();
    const before = fs.readFileSync(foreign.lockPath);
    const inode = fs.lstatSync(foreign.lockPath).ino;
    assert.throws(() => holder.release(), (error) => error.lockStatus === "ownership-changed");
    assert.deepEqual(fs.readFileSync(foreign.lockPath), before);
    assert.equal(fs.lstatSync(foreign.lockPath).ino, inode);
    foreign.release();
  });

  it("does not unlink a replacement inode even when its owner token is unchanged", () => {
    const root = createTmpDir("process-lock-inode-replacement-");
    roots.push(root);
    const holder = makeLock(root);
    holder.acquire();
    const ownerBytes = fs.readFileSync(holder.lockPath);
    const replacementPath = path.join(root, "replacement-owner");
    fs.writeFileSync(replacementPath, ownerBytes, { mode: 0o600 });
    fs.renameSync(replacementPath, holder.lockPath);
    const replacement = fs.lstatSync(holder.lockPath);
    assert.notEqual(replacement.ino, holder.lockIdentity.ino);
    assert.throws(() => holder.release(), (error) => error.lockStatus === "ownership-changed");
    assert.deepEqual(fs.readFileSync(holder.lockPath), ownerBytes);
    assert.equal(fs.lstatSync(holder.lockPath).ino, replacement.ino);
  });

  it("does not unlink a changed owner token when the lock inode is unchanged", () => {
    const root = createTmpDir("process-lock-token-replacement-");
    roots.push(root);
    const holder = makeLock(root);
    holder.acquire();
    const foreign = new ProcessLock({
      directoryAuthority: new RealDirectoryAuthority(root), fileName: ".process-lock.foreign.test.lock", kind: "process-lock-test",
      authority: { root: fs.realpathSync(root) },
    });
    foreign.acquire();
    const inode = fs.lstatSync(holder.lockPath).ino;
    const foreignBytes = fs.readFileSync(foreign.lockPath);
    fs.writeFileSync(holder.lockPath, foreignBytes);
    assert.equal(fs.lstatSync(holder.lockPath).ino, inode);
    assert.throws(() => holder.release(), (error) => error.lockStatus === "ownership-changed");
    assert.deepEqual(fs.readFileSync(holder.lockPath), foreignBytes);
    assert.equal(fs.lstatSync(holder.lockPath).ino, inode);
    foreign.release();
  });

  it("revalidates the exact token after release starts before removing the file", () => {
    const root = createTmpDir("process-lock-release-token-race-");
    roots.push(root);
    const holder = makeLock(root);
    holder.acquire();
    const record = holder.inspect().owner.toJSON();
    record.ownerToken = "11111111-1111-4111-8111-111111111111";
    const replacement = JSON.stringify(record);
    const open = fs.openSync;
    let reads = 0;
    fs.openSync = (target, flags, ...args) => {
      if (target === holder.lockPath && flags === "r" && ++reads === 2) fs.writeFileSync(holder.lockPath, replacement);
      return open(target, flags, ...args);
    };
    try {
      assert.throws(() => holder.release(), (error) => error.name === "ProcessLockTransitionError"
        && error.cause.cause.lockStatus === "ownership-changed");
    } finally { fs.openSync = open; }
    assert.equal(fs.readFileSync(holder.lockPath, "utf8"), replacement);
  });

  it("read-only inspection of an absent namespace creates no directory", () => {
    const root = createTmpDir("process-lock-absent-inspection-");
    roots.push(root);
    const lock = new ProcessLock({ directoryAuthority: new RealDirectoryAuthority(path.join(root, "missing"), { create: true }),
      fileName: "owner.lock", kind: "inspection", authority: { root } });
    assert.equal(lock.inspect(), null);
    assert.deepEqual(fs.readdirSync(root), []);
  });

  it("a separate observer cannot release a holder using the persisted token", () => {
    const root = createTmpDir("process-lock-observer-release-");
    roots.push(root);
    const holder = makeLock(root);
    holder.acquire();
    const observer = makeLock(root);
    const before = fs.readFileSync(holder.lockPath);
    observer.inspect();
    observer.release();
    assert.deepEqual(fs.readFileSync(holder.lockPath), before);
    holder.release();
  });

  it("preserves owner-read and descriptor-close failures without changing the lock", () => {
    for (const malformed of [false, true]) {
      const root = createTmpDir("process-lock-read-close-");
      roots.push(root);
      const holder = makeLock(root);
      holder.acquire();
      if (malformed) fs.writeFileSync(holder.lockPath, "invalid-json");
      const before = fs.readFileSync(holder.lockPath);
      const inode = fs.lstatSync(holder.lockPath).ino;
      const candidate = makeLock(root);
      const originalOpen = fs.openSync;
      const originalClose = fs.closeSync;
      const closeError = Object.assign(new Error("owner close failed"), { code: "EIO" });
      let ownerDescriptor;
      fs.openSync = (target, ...args) => {
        const descriptor = originalOpen(target, ...args);
        if (target === holder.lockPath) ownerDescriptor = descriptor;
        return descriptor;
      };
      fs.closeSync = (descriptor) => {
        originalClose(descriptor);
        if (descriptor === ownerDescriptor) throw closeError;
      };
      try {
        assert.throws(() => candidate.acquire(), (error) => {
          assert.equal(error.lockStatus, "corrupt");
          assert.equal(error.lockPath, holder.lockPath);
          if (malformed) {
            assert.ok(error.cause instanceof AggregateError);
            assert.ok(error.cause.errors[0] instanceof SyntaxError);
            assert.equal(error.cause.errors[1], closeError);
            assert.equal(error.cause.cause, error.cause.errors[0]);
          } else {
            assert.equal(error.cause, closeError);
          }
          return true;
        });
      } finally {
        fs.openSync = originalOpen;
        fs.closeSync = originalClose;
      }
      assert.deepEqual(fs.readFileSync(holder.lockPath), before);
      assert.equal(fs.lstatSync(holder.lockPath).ino, inode);
    }
  });
});
