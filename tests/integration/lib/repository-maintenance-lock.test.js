import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import {
  RepositoryFlowOperationLock,
  RepositoryMaintenanceLock,
} from "../../../src/lib/repository-maintenance-lock.js";
import { ProcessIdentitySource } from "../../../src/lib/process-identity.js";

function identitySource({ boot = "boot", start = "100", unknown = false } = {}) {
  return new ProcessIdentitySource({
    platform: "linux",
    pid: process.pid,
    readBootIdentity() {
      if (unknown) throw Object.assign(new Error("unavailable"), { code: "EACCES" });
      return boot;
    },
    readProcessStartFingerprint() {
      if (unknown) throw Object.assign(new Error("unavailable"), { code: "EACCES" });
      return start;
    },
  });
}

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

  it("serializes maintenance and flow activation across the common main authority", () => {
    tmp = createTmpDir("repository-maintenance-");
    const maintenance = new RepositoryMaintenanceLock({ mainRoot: tmp, processIdentitySource: identitySource() });
    maintenance.acquire();
    assert.throws(
      () => new RepositoryFlowOperationLock({ mainRoot: tmp, processIdentitySource: identitySource() }).acquire(),
      (error) => error.code === "REPOSITORY_MAINTENANCE_BUSY",
    );
    maintenance.release();

    const flow = new RepositoryFlowOperationLock({ mainRoot: tmp, processIdentitySource: identitySource() });
    flow.acquire();
    assert.throws(
      () => new RepositoryMaintenanceLock({ mainRoot: tmp, processIdentitySource: identitySource() }).acquire(),
      (error) => error.code === "REPOSITORY_FLOW_OPERATION_BUSY",
    );
    flow.release();
  });

  it("shares a flow-operation lock only with an explicitly supplied owner token", () => {
    tmp = createTmpDir("repository-flow-reentrant-");
    const outer = new RepositoryFlowOperationLock({ mainRoot: tmp, processIdentitySource: identitySource() });
    const ownerToken = outer.acquire();
    const nested = new RepositoryFlowOperationLock({
      mainRoot: tmp,
      operationOwnerToken: ownerToken,
      processIdentitySource: identitySource(),
    });

    assert.equal(nested.acquire(), ownerToken);
    nested.release();
    assert.equal(fs.existsSync(path.join(tmp, ".sennel", ".repository-flow-operation.lock")), true);

    outer.release();
    assert.equal(fs.existsSync(path.join(tmp, ".sennel", ".repository-flow-operation.lock")), false);
  });

  it("rejects implicit same-process borrowing and a different supplied owner token", () => {
    tmp = createTmpDir("repository-flow-explicit-owner-");
    const source = identitySource();
    const outer = new RepositoryFlowOperationLock({ mainRoot: tmp, processIdentitySource: source });
    outer.acquire();
    try {
      assert.throws(
        () => new RepositoryFlowOperationLock({ mainRoot: tmp, processIdentitySource: source }).acquire(),
        (error) => error.code === "REPOSITORY_FLOW_OPERATION_BUSY",
      );
      assert.throws(
        () => new RepositoryFlowOperationLock({
          mainRoot: tmp,
          operationOwnerToken: "22222222-2222-4222-8222-222222222222",
          processIdentitySource: source,
        }).acquire(),
        (error) => error.code === "REPOSITORY_FLOW_OPERATION_BUSY",
      );
    } finally {
      outer.release();
    }
  });

  it("assesses the canonical owner before rejecting supplied operation tokens", () => {
    tmp = createTmpDir("repository-flow-owner-assessment-");
    const ownerSource = identitySource();
    const outer = new RepositoryFlowOperationLock({ mainRoot: tmp, processIdentitySource: ownerSource });
    const ownerToken = outer.acquire();
    const lockPath = path.join(tmp, ".sennel", ".repository-flow-operation.lock");
    const before = lockSnapshot(lockPath);
    const differentToken = "22222222-2222-4222-8222-222222222222";

    try {
      const cases = [
        ["without a token", null, identitySource(), "REPOSITORY_FLOW_OPERATION_BUSY", "live"],
        ["without a token against an unknown owner", null, identitySource({ unknown: true }), "REPOSITORY_FLOW_OPERATION_LOCK_UNKNOWN", "unknown"],
        ["with the matching live token", ownerToken, identitySource(), null, null],
        ["with a different live token", differentToken, identitySource(), "REPOSITORY_FLOW_OPERATION_BUSY", "live"],
        ["with the matching unknown token", ownerToken, identitySource({ unknown: true }), "REPOSITORY_FLOW_OPERATION_LOCK_UNKNOWN", "unknown"],
        ["with a different unknown token", differentToken, identitySource({ unknown: true }), "REPOSITORY_FLOW_OPERATION_LOCK_UNKNOWN", "unknown"],
        ["with the matching stale token", ownerToken, identitySource({ boot: "other-boot" }), "REPOSITORY_FLOW_OPERATION_LOCK_STALE", "stale"],
        ["with a different stale token", differentToken, identitySource({ boot: "other-boot" }), "REPOSITORY_FLOW_OPERATION_LOCK_STALE", "stale"],
      ];

      for (const [label, operationOwnerToken, processIdentitySource, code, lockStatus] of cases) {
        const candidate = new RepositoryFlowOperationLock({
          mainRoot: tmp,
          operationOwnerToken,
          processIdentitySource,
        });
        if (code === null) {
          assert.equal(candidate.acquire(), ownerToken, label);
          assert.equal(candidate.assertOwned(), ownerToken, `${label} retains canonical ownership`);
          candidate.release();
        } else {
          assert.throws(
            () => candidate.acquire(),
            (error) => error.code === code
              && error.lockStatus === lockStatus
              && error.lockPath === lockPath
              && error.owner?.processIdentity?.ownerToken === ownerToken
              && Object.hasOwn(error, "cause")
              && error.cause === undefined,
            label,
          );
        }
        assertLockUnchanged(lockPath, before, label);
      }
    } finally {
      outer.release();
    }
  });

  it("rejects a supplied owner token after its canonical lock was released", () => {
    tmp = createTmpDir("repository-flow-released-owner-");
    const source = identitySource();
    const outer = new RepositoryFlowOperationLock({ mainRoot: tmp, processIdentitySource: source });
    const ownerToken = outer.acquire();
    outer.release();

    assert.throws(
      () => new RepositoryFlowOperationLock({
        mainRoot: tmp,
        operationOwnerToken: ownerToken,
        processIdentitySource: source,
      }).acquire(),
      (error) => error.code === "REPOSITORY_LOCK_OWNERSHIP_CHANGED",
    );
  });

  it("reports structured diagnostics for a foreign live flow-operation owner", () => {
    tmp = createTmpDir("repository-flow-foreign-diagnostics-");
    const lockPath = path.join(tmp, ".sennel", ".repository-flow-operation.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify({
      version: 1,
      kind: "repository-flow-operation",
      mainRoot: fs.realpathSync(tmp),
      processIdentity: {
        pid: process.pid,
        bootIdentity: "boot",
        startFingerprint: "100",
        ownerToken: "11111111-1111-4111-8111-111111111111",
      },
    })}\n`);

    assert.throws(
      () => new RepositoryFlowOperationLock({ mainRoot: tmp, processIdentitySource: identitySource() }).acquire(),
      (error) => error.code === "REPOSITORY_FLOW_OPERATION_BUSY"
        && error.contention?.owner?.ownerToken === "11111111-1111-4111-8111-111111111111"
        && error.contention?.requester?.pid === process.pid
        && error.contention?.operation === "repository-flow-operation"
        && error.contention?.boundary === "acquire",
    );
  });

  it("fails closed for malformed, stale, and unknown maintenance owners", () => {
    tmp = createTmpDir("repository-maintenance-owner-");
    const lockPath = RepositoryMaintenanceLock.pathFor(tmp);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const cases = [
      ["malformed", "{broken\n", identitySource(), "REPOSITORY_MAINTENANCE_LOCK_CORRUPT"],
      ["stale", JSON.stringify({
        version: 1,
        kind: "repository-maintenance",
        mainRoot: fs.realpathSync(tmp),
        processIdentity: {
          pid: process.pid,
          bootIdentity: "old-boot",
          startFingerprint: "100",
          ownerToken: "11111111-1111-4111-8111-111111111111",
        },
      }), identitySource(), "REPOSITORY_MAINTENANCE_LOCK_STALE"],
      ["unknown", JSON.stringify({
        version: 1,
        kind: "repository-maintenance",
        mainRoot: fs.realpathSync(tmp),
        processIdentity: {
          pid: process.pid,
          bootIdentity: "boot",
          startFingerprint: "100",
          ownerToken: "11111111-1111-4111-8111-111111111111",
        },
      }), identitySource({ unknown: true }), "REPOSITORY_MAINTENANCE_LOCK_UNKNOWN"],
    ];

    for (const [label, content, source, code] of cases) {
      fs.writeFileSync(lockPath, content);
      assert.throws(
        () => new RepositoryFlowOperationLock({ mainRoot: tmp, processIdentitySource: source }).acquire(),
        (error) => error.code === code,
        label,
      );
      assert.equal(fs.readFileSync(lockPath, "utf8"), content, label);
      fs.unlinkSync(lockPath);
    }
  });

  it("rejects symlink, non-directory, and replaced .sennel authorities without external writes", () => {
    for (const Lock of [RepositoryMaintenanceLock, RepositoryFlowOperationLock]) {
      const external = createTmpDir("repository-lock-external-");
      const sentinel = path.join(external, "sentinel");
      fs.writeFileSync(sentinel, "unchanged");
      try {
        const symlinkRoot = createTmpDir("repository-lock-symlink-");
        fs.symlinkSync(external, path.join(symlinkRoot, ".sennel"), "dir");
        assert.throws(
          () => new Lock({ mainRoot: symlinkRoot }).acquire(),
          (error) => error.code === "REPOSITORY_LOCK_AUTHORITY_INVALID",
        );
        assert.deepEqual(fs.readdirSync(external), ["sentinel"]);
        removeTmpDir(symlinkRoot);

        const fileRoot = createTmpDir("repository-lock-file-");
        fs.writeFileSync(path.join(fileRoot, ".sennel"), "not-a-directory");
        assert.throws(
          () => new Lock({ mainRoot: fileRoot }).acquire(),
          (error) => error.code === "REPOSITORY_LOCK_AUTHORITY_INVALID",
        );
        assert.equal(fs.readFileSync(path.join(fileRoot, ".sennel"), "utf8"), "not-a-directory");
        removeTmpDir(fileRoot);

        const replacementRoot = createTmpDir("repository-lock-replaced-");
        fs.mkdirSync(path.join(replacementRoot, ".sennel"));
        const lock = new Lock({ mainRoot: replacementRoot });
        fs.renameSync(path.join(replacementRoot, ".sennel"), path.join(replacementRoot, ".sennel-original"));
        fs.symlinkSync(external, path.join(replacementRoot, ".sennel"), "dir");
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

  it("reclaims only a proven-stale flow-operation owner and preserves all rejected owners", () => {
    tmp = createTmpDir("repository-flow-operation-stale-");
    const lockPath = path.join(tmp, ".sennel", ".repository-flow-operation.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const owner = (overrides = {}) => ({
      version: 1,
      kind: "repository-flow-operation",
      mainRoot: fs.realpathSync(tmp),
      processIdentity: {
        pid: process.pid,
        bootIdentity: "boot",
        startFingerprint: "100",
        ownerToken: "11111111-1111-4111-8111-111111111111",
      },
      ...overrides,
    });

    fs.writeFileSync(lockPath, `${JSON.stringify(owner({
      processIdentity: { ...owner().processIdentity, bootIdentity: "old-boot" },
    }))}\n`);
    const reclaimed = new RepositoryFlowOperationLock({ mainRoot: tmp, processIdentitySource: identitySource() });
    assert.notEqual(reclaimed.acquire(), owner().processIdentity.ownerToken);
    reclaimed.release();
    assert.equal(fs.existsSync(lockPath), false);

    const rejected = [
      ["live", owner(), identitySource(), "REPOSITORY_FLOW_OPERATION_BUSY"],
      ["unknown", owner(), identitySource({ unknown: true }), "REPOSITORY_FLOW_OPERATION_LOCK_UNKNOWN"],
      ["corrupt", { broken: true }, identitySource(), "REPOSITORY_FLOW_OPERATION_LOCK_CORRUPT"],
      ["foreign-authority", owner({ mainRoot: path.join(tmp, "foreign") }), identitySource(), "REPOSITORY_FLOW_OPERATION_LOCK_CORRUPT"],
    ];
    for (const [label, value, source, code] of rejected) {
      const bytes = `${JSON.stringify(value)}\n`;
      fs.writeFileSync(lockPath, bytes);
      assert.throws(
        () => new RepositoryFlowOperationLock({ mainRoot: tmp, processIdentitySource: source }).acquire(),
        (error) => error.code === code,
        label,
      );
      assert.equal(fs.readFileSync(lockPath, "utf8"), bytes, label);
      fs.unlinkSync(lockPath);
    }
  });

  it("preserves acquire conflict and cleanup failures in causal order", () => {
    tmp = createTmpDir("repository-maintenance-acquire-cleanup-");
    const flow = new RepositoryFlowOperationLock({
      mainRoot: tmp,
      processIdentitySource: identitySource(),
    });
    flow.acquire();
    const maintenance = new RepositoryMaintenanceLock({
      mainRoot: tmp,
      processIdentitySource: identitySource(),
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
      processIdentitySource: identitySource(),
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
