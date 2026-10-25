import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { ProcessLock } from "../../../src/lib/process-lock.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";

function makeLock(root) {
  return new ProcessLock({
    directoryAuthority: new RealDirectoryAuthority(root),
    fileName: ".candidate8.lock",
    kind: "candidate8-lock",
    authority: { root: fs.realpathSync(root), scope: "failure-semantics" },
  });
}


function assertTransition(error, {
  phase,
  publishedToVisibleName,
  publicationUnknown,
  tempResidue,
  visibleResidue,
}) {
  assert.equal(error.name, "ProcessLockTransitionError");
  assert.match(error.code, /^PROCESS_LOCK_/);
  assert.equal(error.phase, phase);
  assert.equal(error.publishedToVisibleName, publishedToVisibleName);
  assert.equal(error.publicationUnknown, publicationUnknown);
  assert.deepEqual(error.residue, { temp: tempResidue, visible: visibleResidue });
  assert.equal(typeof error.lockPath, "string");
  assert.equal(typeof error.owner?.ownerToken, "string");
  return true;
}

describe("ProcessLock transition failure semantics", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) removeTmpDir(root);
  });

  it("never publishes an owner when its closed stage cannot be completely written", () => {
    const root = createTmpDir("process-lock-partial-owner-");
    roots.push(root);
    const lock = makeLock(root);
    const write = fs.writeSync;
    const failure = Object.assign(new Error("owner write failed"), { code: "EIO" });
    let partial = false;
    fs.writeSync = (descriptor, bytes, offset, length, position) => {
      if (partial) throw failure;
      partial = true;
      return write(descriptor, bytes, offset, 1, position);
    };
    try {
      assert.throws(() => lock.acquire(), (error) => {
        assertTransition(error, { phase: "owner-create", publishedToVisibleName: false,
          publicationUnknown: false, tempResidue: false, visibleResidue: false });
        assert.equal(error.cause.name, "AtomicFileWriteError");
        assert.equal(error.cause.cause, failure);
        return true;
      });
    } finally { fs.writeSync = write; }
    assert.equal(lock.ownerToken, null);
    assert.equal(lock.inspect(), null);
    assert.deepEqual(fs.readdirSync(root), []);
    const successor = makeLock(root);
    successor.acquire();
    successor.release();
  });

  it("reports owner write and close failures in causal order without removing residue", () => {
    const root = createTmpDir("process-lock-write-close-");
    roots.push(root);
    const lock = makeLock(root);
    const open = fs.openSync;
    const close = fs.closeSync;
    const write = fs.writeSync;
    let descriptor = null;
    let stagePath = null;
    fs.openSync = (target, flags, ...args) => {
      const fd = open(target, flags, ...args);
      if (typeof target === "string" && path.dirname(target) === root && target !== lock.lockPath) {
        descriptor = fd;
        stagePath = target;
      }
      return fd;
    };
    fs.writeSync = (fd, ...args) => { if (fd === descriptor) throw new Error("owner write failed"); return write(fd, ...args); };
    fs.closeSync = (fd) => { if (fd === descriptor) throw new Error("owner close failed"); return close(fd); };
    try {
      assert.throws(() => lock.acquire(), (error) => {
        assertTransition(error, { phase: "owner-create", publishedToVisibleName: false,
          publicationUnknown: false, tempResidue: true, visibleResidue: false });
        assert.deepEqual(error.cause.errors.map((entry) => entry.message), ["owner write failed", "owner close failed"]);
        assert.equal(error.cause.cause, error.cause.errors[0]);
        return true;
      });
    } finally { fs.openSync = open; fs.closeSync = close; fs.writeSync = write; if (descriptor !== null) close(descriptor); }
    assert.equal(typeof stagePath, "string");
    assert.equal(fs.readFileSync(stagePath, "utf8"), "");
    assert.equal(fs.existsSync(lock.lockPath), false);
    assert.equal(lock.inspect(), null);
    assert.equal(lock.ownerToken, null);
  });

  it("retains both names and the cleanup cause when exclusive publication cannot remove its stage", () => {
    const root = createTmpDir("process-lock-published-stage-");
    roots.push(root);
    const lock = makeLock(root);
    const unlink = fs.unlinkSync;
    const failure = Object.assign(new Error("published stage cleanup failed"), { code: "EIO" });
    let stagePath = null;
    fs.unlinkSync = (target) => {
      if (target !== lock.lockPath && fs.existsSync(lock.lockPath)) {
        stagePath = target;
        throw failure;
      }
      return unlink(target);
    };
    try {
      assert.throws(() => lock.acquire(), (error) => {
        assertTransition(error, { phase: "owner-create", publishedToVisibleName: true,
          publicationUnknown: true, tempResidue: true, visibleResidue: true });
        assert.equal(error.cause.cause, failure);
        assert.equal(error.cause.cleanupErrors[0], failure);
        return true;
      });
    } finally { fs.unlinkSync = unlink; }
    assert.equal(lock.ownerToken, null);
    const visible = fs.lstatSync(lock.lockPath);
    const staged = fs.lstatSync(stagePath);
    assert.equal(visible.ino, staged.ino);
    assert.equal(visible.dev, staged.dev);
    assert.equal(visible.nlink, 2);
    const before = fs.readFileSync(lock.lockPath);
    assert.throws(() => makeLock(root).acquire(), (error) => {
      assert.equal(error.name, "ProcessLockPublicationPendingError");
      assert.equal(error.lockStatus, "publication-pending");
      assert.equal(error.owner, null);
      return true;
    });
    lock.release();
    assert.deepEqual(fs.readFileSync(lock.lockPath), before);
    assert.equal(fs.existsSync(stagePath), true);
  });

  it("does not clobber an owner that wins after the contender closes its stage", () => {
    const root = createTmpDir("process-lock-publication-race-");
    roots.push(root);
    const contender = makeLock(root);
    const winner = makeLock(root);
    const link = fs.linkSync;
    let won = false;
    let winnerToken;
    fs.linkSync = (source, target) => {
      if (target === contender.lockPath && !won) {
        won = true;
        winnerToken = winner.acquire();
      }
      return link(source, target);
    };
    try {
      assert.throws(() => contender.acquire(), (error) => {
        assert.equal(error.lockStatus, "busy");
        assert.equal(error.owner.ownerToken, winnerToken);
        return true;
      });
    } finally { fs.linkSync = link; }
    try {
      assert.equal(won, true);
      assert.equal(contender.ownerToken, null);
      assert.equal(winner.inspect().owner.ownerToken, winnerToken);
      assert.equal(winner.isOwnerCurrent(winner.inspect().owner), true);
      assert.deepEqual(fs.readdirSync(root), [path.basename(winner.lockPath)]);
    } finally { winner.release(); }
    assert.deepEqual(fs.readdirSync(root), []);
  });

  it("reports release readback failure without a retry-recovery sidecar transaction", () => {
    const root = createTmpDir("lock-release-failure-");
    roots.push(root);
    const lock = makeLock(root);
    lock.acquire();
    const originalLstat = fs.lstatSync;
    const originalUnlink = fs.unlinkSync;
    let removed = false;
    let failed = false;
    fs.unlinkSync = (target) => { const result = originalUnlink(target); if (target === lock.lockPath) removed = true; return result; };
    fs.lstatSync = (target, ...args) => {
      if (target === lock.lockPath && removed && !failed) { failed = true; throw Object.assign(new Error("release readback failed"), { code: "EIO" }); }
      return originalLstat(target, ...args);
    };
    try {
      assert.throws(
        () => lock.release(),
        (error) => {
          assertTransition(error, {
            phase: "release-readback",
            publishedToVisibleName: false,
            publicationUnknown: true,
            tempResidue: false,
            visibleResidue: false,
          });
          return true;
        },
      );
      assert.equal(fs.existsSync(lock.lockPath), false);
    } finally { fs.lstatSync = originalLstat; fs.unlinkSync = originalUnlink; }
  });
});
