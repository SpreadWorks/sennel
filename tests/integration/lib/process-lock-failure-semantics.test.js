import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { ProcessLock } from "../../../src/lib/process-lock.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { ProcessIdentitySource } from "../../../src/lib/process-identity.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function identitySource(bootIdentity = "process-lock-boot", startFingerprint = "441") {
  return new ProcessIdentitySource({
    platform: "linux", pid: process.pid, readBootIdentity: () => bootIdentity, readProcessStartFingerprint: () => startFingerprint,
  });
}

function makeLock(root, source = identitySource()) {
  return new ProcessLock({
    directoryAuthority: new RealDirectoryAuthority(root), fileName: ".process-lock.test.lock", kind: "process-lock-test",
    authority: { root: fs.realpathSync(root) }, processIdentitySource: source,
  });
}

describe("ProcessLock", () => {
  const roots = [];
  afterEach(() => { for (const root of roots.splice(0)) removeTmpDir(root); });

  it("reclaims a conclusively stale owner without a caller option", () => {
    const root = createTmpDir("process-lock-stale-");
    roots.push(root);
    const stale = makeLock(root, identitySource("stale-boot"));
    stale.acquire();
    const current = makeLock(root, identitySource("current-boot"));
    const token = current.acquire();
    assert.notEqual(token, stale.processIdentity.ownerToken);
    current.release();
  });

  it("reclaims an owner whose PID has been reused without a caller option", () => {
    const root = createTmpDir("process-lock-pid-reuse-");
    roots.push(root);
    const reused = makeLock(root, identitySource("shared-boot", "440"));
    reused.acquire();
    const current = makeLock(root, identitySource("shared-boot", "441"));
    const token = current.acquire();
    assert.notEqual(token, reused.processIdentity.ownerToken);
    current.release();
  });

  it("rejects unavailable requester identity before creating a lock artifact", () => {
    const root = createTmpDir("process-lock-identity-unavailable-");
    roots.push(root);
    const lock = makeLock(root, new ProcessIdentitySource({
      platform: "linux", pid: process.pid,
      readBootIdentity: () => { throw new Error("boot unavailable"); },
      readProcessStartFingerprint: () => "441",
    }));
    assert.throws(() => lock.acquire(), (error) => error.code === "PROCESS_IDENTITY_UNAVAILABLE");
    assert.deepEqual(fs.readdirSync(root), []);
  });

  it("retains a proven stale owner when requester identity becomes unavailable before reclamation", () => {
    const root = createTmpDir("process-lock-stale-identity-unavailable-");
    roots.push(root);
    const stale = makeLock(root, identitySource("stale-boot"));
    stale.acquire();
    const before = fs.readFileSync(stale.lockPath);
    const inode = fs.lstatSync(stale.lockPath).ino;
    let bootReads = 0;
    const candidate = makeLock(root, new ProcessIdentitySource({
      platform: "linux", pid: process.pid,
      readBootIdentity: () => {
        bootReads += 1;
        if (bootReads === 1) return "current-boot";
        throw new Error("boot unavailable");
      },
      readProcessStartFingerprint: () => "441",
    }));
    assert.throws(() => candidate.acquire(), (error) => error.code === "PROCESS_IDENTITY_UNAVAILABLE");
    assert.equal(bootReads, 2);
    assert.deepEqual(fs.readFileSync(stale.lockPath), before);
    assert.equal(fs.lstatSync(stale.lockPath).ino, inode);
    stale.release();
  });

  it("fails closed for an indeterminate owner without removing its lock", () => {
    const root = createTmpDir("process-lock-unknown-");
    roots.push(root);
    const holder = makeLock(root);
    holder.acquire();
    const candidate = makeLock(root, new ProcessIdentitySource({
      platform: "linux", pid: process.pid,
      readBootIdentity: () => { throw new Error("boot unavailable"); },
      readProcessStartFingerprint: () => "441",
    }));
    assert.throws(() => candidate.acquire(), (error) => error.lockStatus === "unknown");
    assert.equal(fs.existsSync(holder.lockPath), true);
    holder.release();
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
    fs.fstatSync = (descriptor) => {
      const stat = originalFstat(descriptor);
      if (descriptor !== ownerDescriptor) return stat;
      return { dev: stat.dev, ino: stat.ino + 1, size: stat.size, isFile: () => true };
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
      authority: { root: fs.realpathSync(root) }, processIdentitySource: identitySource(),
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
