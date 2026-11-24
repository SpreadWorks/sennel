import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RepositoryLockAuthority } from "../../../src/lib/repository-control-lock.js";
import { ReadOnlyInvocationWorkspace } from "../../../src/lib/readonly-invocation-workspace.js";
import { LockOwnerSession, ProcessLock } from "../../../src/lib/process-lock.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import path from "node:path";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import {
  RepositoryFlowOperationLock,
  RepositoryMaintenanceLock,
  resolveRepositoryLockRoot,
} from "../../../src/lib/repository-maintenance-lock.js";

function lockSnapshot(lockPath) {
  const stat = fs.lstatSync(lockPath);
  return { bytes: fs.readFileSync(lockPath), dev: stat.dev, ino: stat.ino };
}

function assertLockUnchanged(lockPath, snapshot, label) {
  assert.deepEqual(fs.readFileSync(lockPath), snapshot.bytes, `${label} preserves lock bytes`);
  const current = fs.lstatSync(lockPath);
  assert.equal(current.dev, snapshot.dev, `${label} preserves lock device`);
  assert.equal(current.ino, snapshot.ino, `${label} preserves lock identity`);
}

describe("repository maintenance lock", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("releases only its owned lock after the migration destination changes while preserving newly observed legacy evidence", () => {
    tmp = createTmpDir("repository-maintenance-migration-generation-");
    const canonical = path.join(tmp, ".sennel");
    fs.mkdirSync(canonical);
    const maintenance = new RepositoryMaintenanceLock({ mainRoot: tmp });
    maintenance.acquire();
    fs.renameSync(canonical, path.join(tmp, "retained-canonical"));
    fs.mkdirSync(canonical);
    const foreign = path.join(canonical, ".repository-maintenance.lock");
    fs.writeFileSync(foreign, "unverified legacy owner\n");
    const before = lockSnapshot(foreign);
    maintenance.release();
    assert.equal(fs.existsSync(RepositoryMaintenanceLock.pathFor(tmp)), false);
    assertLockUnchanged(foreign, before, "releasing current authority");
    assert.throws(() => new RepositoryMaintenanceLock({ mainRoot: tmp }).acquire(),
      { code: "REPOSITORY_MAINTENANCE_LOCK_UNKNOWN" });
    assertLockUnchanged(foreign, before, "refusing subsequent admission");
  });

  it("all scoped repository locks inspect without creating storage and acquire outside the migration destination", () => {
    tmp = createTmpDir("repository-control-scope-");
    const authority = new RepositoryLockAuthority(tmp);
    const options = { namespace: "fixture-record", identity: "record identity", fileName: "writer.lock" };
    const location = authority.location(options);
    const lock = new ProcessLock({ location, kind: "fixture-record", authority: { record: "record identity" } });
    assert.equal(lock.inspect(), null);
    assert.deepEqual(fs.readdirSync(tmp), []);
    assert.equal(new RepositoryLockAuthority(tmp).location(options).path, location.path);
    assert.notEqual(authority.location({ ...options, identity: "other record" }).path, location.path);
    lock.acquire();
    assert.ok(location.path.startsWith(path.join(tmp, ".tmp", "runtime", "repository-control") + path.sep));
    assert.equal(fs.existsSync(path.join(tmp, ".sennel")), false);
    assert.equal(new ProcessLock({ location: new RepositoryLockAuthority(tmp).location(options),
      kind: "fixture-record", authority: { record: "record identity" } }).inspect().owner.ownerToken, lock.ownerToken);
    lock.release();
    assert.equal(fs.existsSync(location.path), false);
  });

  it("retains the namespace ancestor identity between absent inspection and acquisition", () => {
    tmp = createTmpDir("repository-control-ancestor-");
    fs.mkdirSync(path.join(tmp, ".tmp"));
    const location = new RepositoryLockAuthority(tmp).location({ namespace: "fixture-record", identity: "record", fileName: "writer.lock" });
    const lock = new ProcessLock({ location, kind: "fixture-record", authority: {} });
    assert.equal(lock.inspect(), null);
    fs.renameSync(path.join(tmp, ".tmp"), path.join(tmp, "retained-original"));
    fs.mkdirSync(path.join(tmp, ".tmp"));
    assert.throws(() => lock.acquire(), { code: "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID" });
    assert.deepEqual(fs.readdirSync(path.join(tmp, ".tmp")), []);
  });

  it("minted read-only lock storage preserves the checkout and rejects a replaced workspace grant", () => {
    tmp = createTmpDir("repository-control-readonly-");
    const workspace = ReadOnlyInvocationWorkspace.create();
    try {
      const storagePolicy = workspace.processRuntimeStorage();
      const authority = new RepositoryLockAuthority(tmp, { storagePolicy });
      const location = authority.location({ namespace: "fixture-record", identity: "record", fileName: "writer.lock" });
      const before = fs.readdirSync(storagePolicy.directory).sort();
      const lock = new ProcessLock({ location, kind: "fixture-record", authority: {} });
      assert.equal(lock.inspect(), null);
      assert.deepEqual(fs.readdirSync(storagePolicy.directory).sort(), before);
      lock.acquire();
      assert.ok(location.path.startsWith(storagePolicy.directory + path.sep));
      assert.deepEqual(fs.readdirSync(tmp), []);
      lock.release();
      const marker = path.join(storagePolicy.directory, "storage-authority.json");
      fs.writeFileSync(marker, "replaced grant");
      assert.throws(() => lock.inspect(), { code: "READONLY_WORKSPACE_STORAGE_AUTHORITY_INVALID" });
      assert.deepEqual(fs.readdirSync(tmp), []);
    } finally { fs.rmSync(workspace.path, { recursive: true, force: true }); }
  });

  it("keeps a non-repository root inside an ancestor checkout isolated", () => {
    tmp = createTmpDir("repository-root-isolation-");
    assert.equal(resolveRepositoryLockRoot(tmp), path.resolve(tmp));
    const lock = new RepositoryFlowOperationLock({ mainRoot: tmp });
    assert.throws(() => lock.owner, { code: "REPOSITORY_LOCK_OWNERSHIP_CHANGED" });
    lock.acquire();
    const owner = lock.owner;
    assert.ok(owner instanceof LockOwnerSession);
    lock.release();
    assert.throws(() => lock.owner, { code: "REPOSITORY_LOCK_OWNERSHIP_CHANGED" });
  });

  it("serializes maintenance and flow activation across the common main authority", () => {
    tmp = createTmpDir("repository-maintenance-");
    const maintenance = new RepositoryMaintenanceLock({ mainRoot: tmp });
    maintenance.acquire();
    assert.throws(
      () => new RepositoryFlowOperationLock({ mainRoot: tmp }).acquire(),
      (error) => error.code === "REPOSITORY_MAINTENANCE_BUSY",
    );
    maintenance.release();

    const flow = new RepositoryFlowOperationLock({ mainRoot: tmp });
    flow.acquire();
    assert.throws(
      () => new RepositoryMaintenanceLock({ mainRoot: tmp }).acquire(),
      (error) => error.code === "REPOSITORY_FLOW_OPERATION_BUSY",
    );
    flow.release();
  });

  it("shares a flow-operation lock only with an explicitly supplied owner token", () => {
    tmp = createTmpDir("repository-flow-reentrant-");
    const outer = new RepositoryFlowOperationLock({ mainRoot: tmp });
    const ownerToken = outer.acquire();
    const nested = new RepositoryFlowOperationLock({
      mainRoot: tmp,
      operationOwnerToken: ownerToken,
    });

    assert.equal(nested.acquire(), ownerToken);
    assert.ok(outer.owner instanceof LockOwnerSession);
    assert.deepEqual(nested.owner.toJSON(), outer.owner.toJSON());
    nested.release();
    assert.equal(fs.existsSync(path.join(tmp, ".tmp", "runtime", "repository-control", ".repository-flow-operation.lock")), true);

    outer.release();
    assert.equal(fs.existsSync(path.join(tmp, ".tmp", "runtime", "repository-control", ".repository-flow-operation.lock")), false);
  });

  it("rejects implicit same-process borrowing and a different supplied owner token", () => {
    tmp = createTmpDir("repository-flow-explicit-owner-");
    const outer = new RepositoryFlowOperationLock({ mainRoot: tmp });
    outer.acquire();
    try {
      assert.throws(
        () => new RepositoryFlowOperationLock({ mainRoot: tmp }).acquire(),
        (error) => error.code === "REPOSITORY_FLOW_OPERATION_BUSY",
      );
      assert.throws(
        () => new RepositoryFlowOperationLock({
          mainRoot: tmp,
          operationOwnerToken: "22222222-2222-4222-8222-222222222222",
            }).acquire(),
        (error) => error.code === "REPOSITORY_FLOW_OPERATION_BUSY",
      );
    } finally {
      outer.release();
    }
  });

  it("requires both a supplied token and a locally held physical owner for borrowing", () => {
    tmp = createTmpDir("repository-flow-unregistered-");
    const outer = new RepositoryFlowOperationLock({ mainRoot: tmp });
    const ownerToken = outer.acquire();
    const record = fs.readFileSync(outer.lockPath);
    outer.release();
    fs.writeFileSync(outer.lockPath, record);
    const before = lockSnapshot(outer.lockPath);
    assert.throws(() => new RepositoryFlowOperationLock({ mainRoot: tmp, operationOwnerToken: ownerToken }).acquire(),
      (error) => error.code === "REPOSITORY_FLOW_OPERATION_BUSY");
    assertLockUnchanged(outer.lockPath, before, "unregistered owner");
  });

  it("rejects a supplied owner token after its canonical lock was released", () => {
    tmp = createTmpDir("repository-flow-released-owner-");
    const outer = new RepositoryFlowOperationLock({ mainRoot: tmp });
    const ownerToken = outer.acquire();
    outer.release();

    assert.throws(
      () => new RepositoryFlowOperationLock({
        mainRoot: tmp,
        operationOwnerToken: ownerToken,
        }).acquire(),
      (error) => error.code === "REPOSITORY_LOCK_OWNERSHIP_CHANGED",
    );
  });

  it("reports token/session contention without a PID or process-liveness claim", () => {
    tmp = createTmpDir("repository-flow-diagnostics-");
    const holder = new RepositoryFlowOperationLock({ mainRoot: tmp });
    const token = holder.acquire();
    try {
      assert.throws(() => new RepositoryFlowOperationLock({ mainRoot: tmp }).acquire(), (error) => {
        assert.equal(error.code, "REPOSITORY_FLOW_OPERATION_BUSY");
        assert.equal(error.contention.owner.ownerToken, token);
        assert.equal(error.contention.owner.ownerSession, error.contention.requester.ownerSession);
        assert.equal(Object.hasOwn(error.contention.owner, "pid"), false);
        return true;
      });
    } finally { holder.release(); }
  });

  it("inspect creates no namespace and locks outside the migration destination", () => {
    tmp = createTmpDir("repository-lock-inspect-");
    const flow = new RepositoryFlowOperationLock({ mainRoot: tmp });
    assert.equal(flow.inspectConflict(), null);
    assert.deepEqual(fs.readdirSync(tmp), []);
    flow.acquire();
    assert.equal(fs.existsSync(path.join(tmp, ".sennel")), false);
    assert.equal(fs.existsSync(flow.lockPath), true);
    flow.release();
  });

  it("preserves malformed and retired PID owner records", () => {
    tmp = createTmpDir("repository-maintenance-legacy-");
    const lockPath = RepositoryMaintenanceLock.pathFor(tmp);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    for (const [bytes, status] of [["{broken", "corrupt"], [JSON.stringify({ version: 1, processIdentity: { pid: process.pid } }), "unknown"]]) {
      fs.writeFileSync(lockPath, bytes);
      const before = lockSnapshot(lockPath);
      assert.throws(() => new RepositoryFlowOperationLock({ mainRoot: tmp }).acquire(), (error) => error.lockStatus === status);
      assertLockUnchanged(lockPath, before, status);
    }
  });

  it("does not bypass an old namespace owner after selecting a new lock location", () => {
    tmp = createTmpDir("repository-lock-old-location-");
    const directory = path.join(tmp, ".sennel");
    fs.mkdirSync(directory);
    const legacy = new ProcessLock({ directoryAuthority: new RealDirectoryAuthority(directory),
      fileName: ".repository-maintenance.lock", kind: "old-location-owner", authority: {} });
    const contender = new RepositoryMaintenanceLock({ mainRoot: tmp });
    legacy.acquire();
    const before = lockSnapshot(legacy.lockPath);
    try {
      assert.throws(() => contender.acquire(), (error) => error.lockStatus === "unknown"
        && error.reason === "legacy-owner-format");
      assertLockUnchanged(legacy.lockPath, before, "old namespace refusal");
      assert.equal(fs.existsSync(path.join(tmp, ".tmp")), false);
    } finally { legacy.release(); }
    contender.acquire();
    contender.release();
  });

  it("inspects old lock-only directories without accepting initialization residue or changing bytes", () => {
    tmp = createTmpDir("repository-lock-old-directory-");
    const directory = path.join(tmp, ".sennel", "review-execution-locks");
    fs.mkdirSync(directory, { recursive: true });
    const location = new RepositoryLockAuthority(tmp).location({ namespace: "review-execution",
      identity: "leases", fileName: "test.lock", legacyDirectories: [directory] });
    assert.equal(location.resolve(), null, "an empty old lock directory carries no exclusion");
    const residue = path.join(directory, ".owner-initializing");
    fs.writeFileSync(residue, "partial owner");
    const before = lockSnapshot(residue);
    assert.throws(() => location.resolve(), (error) => error.lockStatus === "unknown"
      && error.reason === "legacy-owner-format");
    assertLockUnchanged(residue, before, "initialization refusal");
    assert.equal(fs.existsSync(path.join(tmp, ".tmp")), false);
  });

  it("refuses the old hardlink publication staging name when its visible lock was never created", () => {
    tmp = createTmpDir("repository-lock-old-publication-");
    const directory = path.join(tmp, ".sennel");
    fs.mkdirSync(directory);
    const residue = path.join(directory, "..repository-maintenance.lock.3536a3cf-054c-44fa-a932-ce08d12a4312.owner.tmp");
    fs.writeFileSync(residue, "unfinished owner publication");
    const before = lockSnapshot(residue);
    assert.throws(() => new RepositoryMaintenanceLock({ mainRoot: tmp }).acquire(),
      (error) => error.lockStatus === "unknown" && error.lockReason === "legacy-owner-format");
    assertLockUnchanged(residue, before, "old publication staging refusal");
    assert.equal(fs.existsSync(path.join(tmp, ".tmp")), false);
  });

  it("rejects symlink, non-directory, and replaced temporary authorities without external writes", () => {
    for (const Lock of [RepositoryMaintenanceLock, RepositoryFlowOperationLock]) {
      const external = createTmpDir("repository-lock-external-");
      const sentinel = path.join(external, "sentinel");
      fs.writeFileSync(sentinel, "unchanged");
      try {
        const symlinkRoot = createTmpDir("repository-lock-symlink-");
        fs.symlinkSync(external, path.join(symlinkRoot, ".tmp"), "dir");
        assert.throws(
          () => new Lock({ mainRoot: symlinkRoot }).acquire(),
          (error) => error.code === "REPOSITORY_LOCK_AUTHORITY_INVALID",
        );
        assert.deepEqual(fs.readdirSync(external), ["sentinel"]);
        removeTmpDir(symlinkRoot);

        const fileRoot = createTmpDir("repository-lock-file-");
        fs.writeFileSync(path.join(fileRoot, ".tmp"), "not-a-directory");
        assert.throws(
          () => new Lock({ mainRoot: fileRoot }).acquire(),
          (error) => error.code === "REPOSITORY_LOCK_AUTHORITY_INVALID",
        );
        assert.equal(fs.readFileSync(path.join(fileRoot, ".tmp"), "utf8"), "not-a-directory");
        removeTmpDir(fileRoot);

        const replacementRoot = createTmpDir("repository-lock-replaced-");
        fs.mkdirSync(path.join(replacementRoot, ".tmp"));
        const lock = new Lock({ mainRoot: replacementRoot });
        fs.renameSync(path.join(replacementRoot, ".tmp"), path.join(replacementRoot, ".tmp-original"));
        fs.symlinkSync(external, path.join(replacementRoot, ".tmp"), "dir");
        assert.throws(
          () => lock.acquire(),
          (error) => error.code === "REPOSITORY_LOCK_AUTHORITY_INVALID",
        );
        assert.deepEqual(fs.readdirSync(external), ["sentinel"]);
        removeTmpDir(replacementRoot);
      } finally {
        removeTmpDir(external);
      }
    }
  });

  it("preserves acquire conflict and cleanup failures in causal order", () => {
    tmp = createTmpDir("repository-maintenance-acquire-cleanup-");
    const flow = new RepositoryFlowOperationLock({
      mainRoot: tmp,
    });
    flow.acquire();
    const maintenance = new RepositoryMaintenanceLock({
      mainRoot: tmp,
    });
    const originalRelease = maintenance.lock.release;
    maintenance.lock.release = () => {
      throw new Error("maintenance acquire cleanup failed");
    };
    try {
      assert.throws(
        () => maintenance.acquire(),
        (error) => error instanceof AggregateError
          && error.errors.length === 2
          && error.errors[0].code === "REPOSITORY_FLOW_OPERATION_BUSY"
          && error.errors[1].message === "maintenance acquire cleanup failed"
          && error.cause === error.errors[0],
      );
    } finally {
      maintenance.lock.release = originalRelease;
      maintenance.release();
      flow.release();
    }
  });

  it("preserves flow-operation acquire conflict, cleanup failure, and lock residue", () => {
    tmp = createTmpDir("repository-flow-acquire-cleanup-");
    const flow = new RepositoryFlowOperationLock({
      mainRoot: tmp,
    });
    const conflict = Object.assign(new Error("maintenance appeared after acquire"), {
      code: "REPOSITORY_MAINTENANCE_BUSY",
    });
    let inspections = 0;
    flow.maintenance.inspect = () => (++inspections === 1 ? null : { owner: true });
    flow.maintenance.conflict = () => conflict;
    flow.lock.release = () => {
      throw new Error("flow acquire cleanup failed");
    };

    assert.throws(
      () => flow.acquire(),
      (error) => error instanceof AggregateError
        && error.errors.length === 2
        && error.errors[0] === conflict
        && error.errors[1].message === "flow acquire cleanup failed"
        && error.cause === conflict
        && error.residue?.flowOperationLock === true,
    );
  });
});
