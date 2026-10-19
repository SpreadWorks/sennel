import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { ProcessLock } from "../../../src/lib/process-lock.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { ProcessIdentitySource } from "../../../src/lib/process-identity.js";

function identitySource(bootIdentity = "candidate8-boot") {
  return new ProcessIdentitySource({
    platform: "linux",
    pid: process.pid,
    readBootIdentity: () => bootIdentity,
    readProcessStartFingerprint: () => "441",
  });
}

function makeLock(root, source = identitySource()) {
  return new ProcessLock({
    directoryAuthority: new RealDirectoryAuthority(root),
    fileName: ".candidate8.lock",
    kind: "candidate8-lock",
    authority: { root: fs.realpathSync(root), scope: "failure-semantics" },
    processIdentitySource: source,
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
  assert.equal(typeof error.owner?.processIdentity?.ownerToken, "string");
  return true;
}

describe("ProcessLock transition failure semantics", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) removeTmpDir(root);
  });

  it("reports file-fsync and close failures while retaining the still-open owned stage", () => {
    const root = createTmpDir("process-lock-prepublish-failure-");
    roots.push(root);
    const lock = makeLock(root);
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    const originalClose = fs.closeSync;
    const originalUnlink = fs.unlinkSync;
    let tempDescriptor = null;
    let tempPath = null;
    let tempUnlinkAttempts = 0;
    fs.openSync = (target, ...args) => {
      const descriptor = originalOpen(target, ...args);
      if (String(target).endsWith(".owner.tmp")) {
        tempDescriptor = descriptor;
        tempPath = String(target);
      }
      return descriptor;
    };
    fs.fsyncSync = (descriptor) => {
      if (descriptor === tempDescriptor) throw Object.assign(new Error("owner file fsync failed"), { code: "EIO" });
      return originalFsync(descriptor);
    };
    fs.closeSync = (descriptor) => {
      if (descriptor === tempDescriptor) throw Object.assign(new Error("owner descriptor close failed"), { code: "EIO" });
      return originalClose(descriptor);
    };
    fs.unlinkSync = (target) => {
      if (String(target) === tempPath) { tempUnlinkAttempts++; throw Object.assign(new Error("owner temp unlink failed"), { code: "EACCES" }); }
      return originalUnlink(target);
    };
    try {
      assert.throws(
        () => lock.acquire(),
        (error) => {
          assertTransition(error, {
            phase: "before-owner-fsync",
            publishedToVisibleName: false,
            publicationUnknown: false,
            tempResidue: true,
            visibleResidue: false,
          });
          assert.ok(error.cause instanceof AggregateError);
          assert.equal(error.cause.cause, error.cause.errors[0]);
          assert.deepEqual(
            error.cause.errors.map((item) => item.message),
            ["owner file fsync failed", "owner descriptor close failed"],
          );
          return true;
        },
      );
      assert.equal(tempUnlinkAttempts, 0, "an unconfirmed descriptor close must prevent unlink of its owned stage");
      assert.equal(fs.existsSync(tempPath), true);
      assert.equal(fs.existsSync(lock.lockPath), false);
    } finally {
      fs.openSync = originalOpen;
      fs.fsyncSync = originalFsync;
      fs.closeSync = originalClose;
      fs.unlinkSync = originalUnlink;
      if (tempDescriptor != null) originalClose(tempDescriptor);
      if (tempPath && fs.existsSync(tempPath)) originalUnlink(tempPath);
    }
    const token = lock.acquire();
    assert.equal(typeof token, "string");
    lock.release();
  });

  it("reports visible lock residue when publication readback and cleanup both fail", () => {
    const root = createTmpDir("process-lock-postpublish-failure-");
    roots.push(root);
    const lock = makeLock(root);
    const originalLstat = fs.lstatSync;
    const originalLink = fs.linkSync;
    const originalUnlink = fs.unlinkSync;
    let published = false;
    let failed = false;
    fs.linkSync = (...args) => { const result = originalLink(...args); published = true; return result; };
    fs.lstatSync = (target, ...args) => {
      if (target === lock.lockPath && published && !failed) { failed = true; throw Object.assign(new Error("publish readback failed"), { code: "EIO" }); }
      return originalLstat(target, ...args);
    };
    fs.unlinkSync = (target) => {
      if (path.resolve(String(target)) === lock.lockPath) {
        throw Object.assign(new Error("published lock cleanup failed"), { code: "EACCES" });
      }
      return originalUnlink(target);
    };
    try {
      assert.throws(
        () => lock.acquire(),
        (error) => {
          assertTransition(error, {
            phase: "before-owner-readback",
            publishedToVisibleName: true,
            publicationUnknown: true,
            tempResidue: false,
            visibleResidue: true,
          });
          assert.ok(error.cause instanceof AggregateError);
          assert.equal(error.cause.cause, error.cause.errors[0]);
          assert.deepEqual(
            error.cause.errors.map((item) => item.message),
            ["publish readback failed", "published lock cleanup failed"],
          );
          const bytes = JSON.parse(fs.readFileSync(lock.lockPath, "utf8"));
          assert.equal(bytes.processIdentity.ownerToken, error.owner.processIdentity.ownerToken);
          return true;
        },
      );
      assert.equal(fs.existsSync(lock.lockPath), true);
    } finally {
      fs.lstatSync = originalLstat;
      fs.linkSync = originalLink;
      fs.unlinkSync = originalUnlink;
    }

    originalUnlink(lock.lockPath);
    const retry = makeLock(root);
    retry.acquire();
    retry.release();
  });

  it("reports stale-unlink readback uncertainty without implicitly publishing a replacement", () => {
    const root = createTmpDir("process-lock-stale-fsync-");
    roots.push(root);
    const currentSource = identitySource("current-boot");
    const staleSource = identitySource("stale-boot");
    const lock = makeLock(root, currentSource);
    const staleOwner = staleSource.createOwner("11111111-1111-4111-8111-111111111111");
    fs.writeFileSync(lock.lockPath, `${JSON.stringify({
      version: 1,
      kind: "candidate8-lock",
      root: fs.realpathSync(root),
      scope: "failure-semantics",
      processIdentity: staleOwner,
    }, null, 2)}\n`, { mode: 0o600 });
    const originalLstat = fs.lstatSync;
    const originalUnlink = fs.unlinkSync;
    let removed = false;
    let failed = false;
    fs.unlinkSync = (target) => { const result = originalUnlink(target); if (target === lock.lockPath) removed = true; return result; };
    fs.lstatSync = (target, ...args) => {
      if (target === lock.lockPath && removed && !failed) { failed = true; throw Object.assign(new Error("stale unlink readback failed"), { code: "EIO" }); }
      return originalLstat(target, ...args);
    };
    try {
      assert.throws(
        () => lock.acquire(),
        (error) => {
          assertTransition(error, {
            phase: "stale-remove-readback",
            publishedToVisibleName: false,
            publicationUnknown: true,
            tempResidue: false,
            visibleResidue: false,
          });
          assert.equal(error.owner.processIdentity.ownerToken, staleOwner.ownerToken);
          assert.equal(error.cause.message, "stale unlink readback failed");
          return true;
        },
      );
      assert.equal(fs.existsSync(lock.lockPath), false);
    } finally { fs.lstatSync = originalLstat; fs.unlinkSync = originalUnlink; }
    const token = lock.acquire();
    assert.notEqual(token, staleOwner.ownerToken);
    lock.release();
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
