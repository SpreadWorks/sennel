import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { FileLockWaitPolicy } from "../../../src/lib/file-lock.js";
import { ProcessLock } from "../../../src/lib/process-lock.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { FlowArtifactCatalog, FlowArtifactCatalogStore, FlowVersionAuthorityScope, FlowVersionLocation } from "../../../src/lib/flow-version.js";
import { FlowHandoffAuthorityLease } from "../../../src/lib/flow-handoff-authority-lease.js";
import { FlowTargetBinding, FlowTargetExpectation } from "../../../src/lib/flow-target-guard.js";
import { buildCurrentFlowDefinition } from "../../../src/flow/definition.js";
import { CurrentFlowStateStore } from "../../../src/flow/lib/current-flow-state.js";
import { FlowDispatchSession, FlowDispatchTarget } from "../../../src/flow/lib/dispatch-invocation.js";
import { FlowDispatchLease } from "../../../src/flow/lib/run-dispatch.js";
import { ReviewExecutionLease } from "../../../src/flow/lib/review-execution-lease.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { ExternalProcessLockOwner } from "../../support/infrastructure/external-lock-owner.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

// This suite owns domain mappings, not the primitive's wait/ownership matrix.
// The child publishes through the shared physical lock API, while each parent
// calls its real wrapper entrypoint. Only the clock and OS identity reader are
// controlled at their nondeterministic boundaries.
async function withExternalOwner(core, body) {
  core.directoryAuthority.ensure();
  const owner = ExternalProcessLockOwner.forFileLock({
    directory: core.directory,
    fileName: path.basename(core.lockPath),
    kind: core.kind,
    authority: core.authority,
  });
  try {
    await owner.waitUntilReady();
    await body(owner.child.pid);
  } finally {
    await owner.release();
  }
}

function currentState(root) {
  const store = new CurrentFlowStateStore({ directory: root, definition: buildCurrentFlowDefinition() });
  return { core: store.lock.processLock, invoke: () => store.assertWritable(), busy: "FLOW_STATE_ATOMIC_BUSY", name: "FlowStateAtomicSaveError", prefix: "CURRENT_FLOW_STATE_LOCK", timeout: 5_000 };
}

function catalog(root) {
  const location = new FlowVersionLocation({ repositoryRoot: root, authorityScope: FlowVersionAuthorityScope.canonical(), specId: "530-lock-mapping", version: 1 });
  fs.mkdirSync(location.directory, { recursive: true });
  const store = new FlowArtifactCatalogStore({ location });
  store.initialize(new FlowArtifactCatalog({ artifacts: [] }));
  const runtime = location.runtimeLock("runtime.lock.artifact-catalog");
  const core = new ProcessLock({ directoryAuthority: new RealDirectoryAuthority(runtime.directory), fileName: runtime.fileName, kind: "artifact-catalog-publication", authority: { directory: location.directory, runtimeDirectory: runtime.runtimeDirectory, catalog: location.catalogFile } });
  return { core, invoke: () => store.load(), busy: "FLOW_ARTIFACT_CATALOG_BUSY", name: "FlowArtifactCatalogBusyError", prefix: "PROCESS_LOCK", timeout: 10_000 };
}

function handoff(root) {
  const lease = new FlowHandoffAuthorityLease({ mainRoot: root, executionRoot: root, waitPolicy: new FileLockWaitPolicy({ timeoutMs: 500, intervalMs: 50 }) });
  return { core: lease.lock.processLock, invoke: () => lease.acquire(), busy: "FLOW_HANDOFF_AUTHORITY_WAIT_TIMEOUT", name: "FlowHandoffAuthorityLeaseTimeoutError", prefix: "FLOW_HANDOFF_AUTHORITY_LOCK", timeout: 500 };
}

function review(root) {
  const lease = new ReviewExecutionLease({ mainRoot: root, runId: "review-mapping", nodeId: "spec-review", attemptId: "review-attempt" });
  lease.managedDirectory.ensure();
  return { core: lease.lock, invoke: () => lease.acquire(), busy: "REVIEW_EXECUTION_BUSY", name: "ReviewExecutionLeaseError", prefix: "REVIEW_EXECUTION_LOCK", timeout: null };
}

function dispatch(root) {
  const manager = makeFlowManager(root);
  const fixture = new CanonicalFlowFixture({ flowManager: manager }).create().activate("branch");
  const binding = FlowTargetBinding.captureContext({ root, mainRoot: root, flowState: manager.loadReadOnly(fixture.specId) });
  const expectation = new FlowTargetExpectation({ expectBinding: binding.serialize() });
  const target = new FlowDispatchTarget({ expectation, binding });
  const lease = new FlowDispatchLease(new FlowDispatchSession({ target }));
  return { core: lease.lock, invoke: () => lease.acquire(), busy: "FLOW_DISPATCH_BUSY", name: "FlowDispatchLockError", prefix: "FLOW_DISPATCH_LOCK", timeout: null };
}

for (const create of [currentState, catalog, handoff, review, dispatch]) {
  test(`${create.name} preserves its domain mappings and rejected owner bytes`, { timeout: 30_000 }, async (t) => {
    const root = createTmpDir(`lock-mapping-${create.name}-`);
    t.after(() => removeTmpDir(root));
    const wrapper = create(root);
    const { core, invoke } = wrapper;
    await withExternalOwner(core, async (pid) => {
      const bytes = fs.readFileSync(core.lockPath);
      const inode = fs.lstatSync(core.lockPath).ino;
      const assertUnchanged = () => {
        assert.deepEqual(fs.readFileSync(core.lockPath), bytes);
        assert.equal(fs.lstatSync(core.lockPath).ino, inode);
      };
      let tick = 0;
      // Primitive tests exercise actual positive waits. Here advancing the OS
      // clock avoids spending 5/10 seconds just to verify wrapper projection.
      const clock = t.mock.method(performance, "now", () => (tick += wrapper.timeout ?? 1));
      try {
        assert.throws(invoke, (error) => {
          assert.equal(error.code, wrapper.busy);
          assert.equal(error.name, wrapper.name);
          assert.equal(error.lockStatus, wrapper.timeout === null ? "live" : "timeout");
          assert.equal(error.lockPath, core.lockPath);
          assert.equal(error.owner.processIdentity.pid, pid);
          assert.ok(Object.hasOwn(error, "cause"));
          if (wrapper.timeout !== null) {
            assert.equal(error.waitedMs, wrapper.timeout);
            assert.equal(error.retryable, true);
            assert.ok(error.cause instanceof Error);
          }
          return true;
        });
      } finally { clock.mock.restore(); }
      assertUnchanged();

      const read = fs.readFileSync;
      const denied = t.mock.method(fs, "readFileSync", (target, ...args) => {
        if (target === "/proc/sys/kernel/random/boot_id") throw Object.assign(new Error("identity unavailable"), { code: "EACCES" });
        return read(target, ...args);
      });
      try {
        assert.throws(invoke, (error) => {
          assert.equal(error.code, `${wrapper.prefix}_UNKNOWN`);
          assert.equal(error.lockStatus, "unknown");
          assert.equal(error.owner.processIdentity.pid, pid);
          assert.equal(error.lockPath, core.lockPath);
          assert.notEqual(error.retryable, true);
          assert.equal(error.waitedMs, undefined);
          assert.ok(Object.hasOwn(error, "cause"));
          return true;
        });
      } finally { denied.mock.restore(); }
      assertUnchanged();
    });
    assert.equal(fs.existsSync(core.lockPath), false);

    fs.writeFileSync(core.lockPath, "malformed-owner\n");
    assert.throws(invoke, (error) => {
      assert.equal(error.code, `${wrapper.prefix}_CORRUPT`);
      assert.equal(error.lockStatus, "corrupt");
      assert.equal(error.lockPath, core.lockPath);
      assert.equal(error.owner, null);
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    });
    assert.equal(fs.readFileSync(core.lockPath, "utf8"), "malformed-owner\n");
  });
}
