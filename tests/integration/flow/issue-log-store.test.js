import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { IssueLogStore } from "../../../src/flow/lib/issue-log-store.js";
import { ProcessIdentitySource } from "../../../src/lib/process-identity.js";
import { RepositoryFlowOperationLock } from "../../../src/lib/repository-maintenance-lock.js";
import { ExternalProcessLockOwner } from "../../support/infrastructure/external-lock-owner.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function makeStore(t, { processIdentitySource, operationOwnerToken } = {}) {
  const root = createTmpDir("sennel-issue-log-store-v1-");
  t.after(() => removeTmpDir(root));
  const manager = makeFlowManager(root);
  const fixture = new CanonicalFlowFixture({
    flowManager: manager,
    specId: "100-issue-log",
    runId: "run-100-issue-log",
  }).create().activate("branch");
  const location = fixture.location();
  const store = IssueLogStore.forVersion({ location, processIdentitySource, operationOwnerToken });
  return { root, manager, fixture, location, store };
}

test("IssueLogStore serializes idempotent Version publications through the Activity catalog", (t) => {
  const { manager, fixture, store } = makeStore(t);
  const beforeActivities = manager.activityLedger(fixture.specId).length;
  const first = store.append({ step: "gate", reason: "first" }, "event-1");
  const duplicate = store.append({ step: "gate", reason: "ignored duplicate" }, "event-1");
  const second = store.append({ step: "review", reason: "next" }, "event-2");

  assert.equal(first.appended.length, 1);
  assert.equal(duplicate.appended.length, 0);
  assert.equal(second.appended.length, 1);
  assert.deepEqual(store.read().document.entries.map((entry) => entry.issueLogId), ["event-1", "event-2"]);
  assert.equal(manager.activityLedger(fixture.specId).length, beforeActivities + 2);
  assert.equal(manager.artifactCatalog(fixture.specId).resolve("issue-log.json").logicalKey, "issue.log");
});

test("IssueLogStore claims an abandoned Version writer lock and releases it after append", (t) => {
  const abandonedIdentity = new ProcessIdentitySource({
    platform: "linux",
    pid: 999999999,
    readBootIdentity() { return "test-boot"; },
    readProcessStartFingerprint() { return "1"; },
  });
  const { location, store: abandoned } = makeStore(t, { processIdentitySource: abandonedIdentity });
  const lockPath = path.join(location.directory, ".runtime", "locks", "issue-log.lock");
  abandoned.lock.acquire();
  assert.equal(fs.existsSync(lockPath), true);

  const store = IssueLogStore.forVersion({ location });
  assert.equal(store.append({ step: "gate", reason: "after crash" }, "event-after-crash").appended.length, 1);
  assert.equal(fs.existsSync(lockPath), false);
});

test("IssueLogStore nests under an explicitly supplied repository operation owner", (t) => {
  const { root, location } = makeStore(t);
  const repositoryOperation = new RepositoryFlowOperationLock({ mainRoot: root });
  const operationOwnerToken = repositoryOperation.acquire();
  try {
    const nested = IssueLogStore.forVersion({ location, operationOwnerToken });
    assert.equal(nested.append({ step: "gate", reason: "nested writer" }, "nested-event").appended.length, 1);
    assert.equal(repositoryOperation.assertOwned(), operationOwnerToken);
  } finally {
    repositoryOperation.release();
  }
});

test("IssueLogStore rejects a busy repository operation without waiting for its writer lock", (t) => {
  const { root, store } = makeStore(t);
  const repositoryOperation = new RepositoryFlowOperationLock({ mainRoot: root });
  repositoryOperation.acquire();
  try {
    assert.throws(
      () => store.append({ step: "gate", reason: "must stay blocked" }, "blocked-event"),
      (error) => error.code === "REPOSITORY_FLOW_OPERATION_BUSY"
        && error.lockStatus === "live"
        && error.retryable !== true,
    );
  } finally {
    repositoryOperation.release();
  }
});

test("IssueLogStore preserves timeout diagnostics and recovers after an external writer releases", { timeout: 15_000 }, async (t) => {
  const { root, location, manager, fixture, store } = makeStore(t);
  const lockDirectory = location.resolve(".runtime/locks");
  const writerLockPath = path.join(lockDirectory, "issue-log.lock");
  const repositoryLockPath = path.join(root, ".sennel", ".repository-flow-operation.lock");
  const holder = ExternalProcessLockOwner.forFileLock({
    directory: lockDirectory,
    fileName: "issue-log.lock",
    kind: "issue-log-writer",
    authority: {
      versionRoot: location.directory,
      filePath: location.issueLogFile,
      runtimeDirectory: location.resolve(".runtime"),
    },
  });
  t.after(async () => { await holder.release(); });
  try {
    await holder.waitUntilReady();
    const beforeEntries = store.read().toJSON();
    const beforeActivities = manager.activityLedger(fixture.specId);

    assert.throws(
      () => store.append({ step: "gate", reason: "timeout must not publish" }, "timeout-event"),
      (error) => error.code === "ISSUE_LOG_BUSY"
        && error.lockStatus === "timeout"
        && error.lockPath === writerLockPath
        && typeof error.owner?.processIdentity?.ownerToken === "string"
        && error.retryable === true
        && error.waitedMs >= 5_000
        && error.cause?.code === "ISSUE_LOG_BUSY"
        && error.cause?.lockStatus === "timeout"
        && error.cause?.lockPath === writerLockPath
        && error.cause?.owner?.processIdentity?.ownerToken === error.owner.processIdentity.ownerToken
        && error.cause?.cause?.lockStatus === "live"
        && error.cause?.cause?.lockPath === writerLockPath,
    );
    assert.equal(fs.existsSync(repositoryLockPath), false, "writer timeout releases the repository operation lock");
    assert.deepEqual(store.read().toJSON(), beforeEntries, "timeout leaves the issue log unchanged");
    assert.deepEqual(manager.activityLedger(fixture.specId), beforeActivities, "timeout leaves the activity ledger unchanged");

    await holder.release();
    const recovered = store.append({ step: "gate", reason: "writer released" }, "recovered-event");
    assert.equal(recovered.appended.length, 1);
    assert.deepEqual(store.read().document.entries.map((entry) => entry.issueLogId), ["recovered-event"]);
  } finally {
    await holder.release();
  }
});

test("IssueLogStore requires a canonical typed Version location", () => {
  assert.throws(
    () => new IssueLogStore({}),
    /FlowVersionLocation is required/,
  );
});

test("IssueLogStore preserves a publication failure together with writer-lock release failure", (t) => {
  const { store } = makeStore(t);
  const release = store.lock.release.bind(store.lock);
  store.lock.release = () => {
    throw Object.assign(new Error("injected lock release failure"), { code: "LOCK_RELEASE_FAILURE" });
  };

  try {
    assert.throws(
      () => store.appendMany([null]),
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        assert.match(error.message, /file lock body and release both failed/);
        assert.equal(error.cause, error.errors[0]);
        assert.equal(error.errors.at(-1).code, "LOCK_RELEASE_FAILURE");
        return true;
      },
    );
  } finally {
    store.lock.release = release;
    release();
  }
});
