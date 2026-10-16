import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { FlowCommandExecutionLease } from "../../../src/flow/lib/flow-command-execution-lease.js";
import { WorkerArtifactRepositoryMutationSnapshot } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { runCmd } from "../../../src/lib/process.js";
import { CanonicalFlowFixture } from "../infrastructure/flow-setup.js";
import { SeedWorkRoot, observeSeedTiming } from "../builders/seed-work-root.js";
import { OfflineMigrationDirectorySnapshot } from "../../../src/lib/offline-migration-transaction.js";

/** An immutable canonical frontier. Its owner chooses and produces that frontier;
 * this value owns only copied evidence, readback and teardown verification. */
export class CanonicalScenarioSeed {
  #manager;

  constructor({ root, specId, frontier = null, snapshot = null, options = {}, git = true,
    observeTiming = observeSeedTiming }) {
    const started = performance.now();
    this.root = root;
    this.specId = specId;
    this.frontier = frontier;
    this.snapshot = snapshot;
    this.options = Object.freeze({ ...options });
    this.git = git;
    this.observeTiming = observeTiming;
    this.#manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    CanonicalFlowFixture.fromExisting({ flowManager: this.#manager, specId });
    this.persistence = new CanonicalPersistenceSnapshot(this.#manager, specId);
    if (git) {
      assert.equal(fs.statSync(path.join(root, ".git")).isDirectory(), true,
        "seed copies require standalone Git metadata");
      this.head = this.readHead(root);
    } else {
      assert.equal(fs.existsSync(path.join(root, ".git")), false, "non-Git seed retains its authority mode");
      this.head = null;
    }
    this.repositorySnapshot = WorkerArtifactRepositoryMutationSnapshot.capture({ root, authorities: ["execution"] });
    observeTiming("canonical-seed-readback", performance.now() - started);
    Object.freeze(this);
  }

  static freeze(owner, { root, specId, manager, prefix = "sennel-canonical-seed-", ...options }) {
    const runId = manager.canonicalState(specId).runId;
    ProcessExecutionRuntime.assertQuiescent({ mainRoot: root, executionRoot: root, runId, specId });
    assert.equal(ProcessExecutionRuntime.inspect({ mainRoot: root, executionRoot: root })?.slot ?? null, null,
      "a producer releases its physical runtime slot before its root becomes a seed");
    assert.equal(FlowCommandExecutionLease.forRun({ mainRoot: root, runId }).length, 0,
      "a producer releases every command lease before its root becomes a seed");
    const copy = new SeedWorkRoot(root, { prefix });
    let seed;
    owner.after(() => {
      const verificationStarted = performance.now();
      try { seed?.assertUnchanged(); }
      finally {
        (options.observeTiming ?? observeSeedTiming)("canonical-seed-verification", performance.now() - verificationStarted);
        copy.cleanup();
      }
    });
    seed = new this({ ...options, root: copy.root, specId });
    return seed;
  }

  readHead(root) {
    const result = runCmd("git", ["rev-parse", "HEAD"], { cwd: root });
    assert.equal(result.ok, true, result.stderr);
    return result.stdout.trim();
  }

  assertClone(manager) {
    const root = manager.specLocation(this.specId).repositoryRoot;
    assert.notEqual(root, this.root, "each case owns a separate root");
    this.persistence.assertUnchanged(manager, this.specId, "canonical frontier clone");
    if (this.git) assert.equal(this.readHead(root), this.head, "clone retains the seed Git HEAD");
    else assert.equal(fs.existsSync(path.join(root, ".git")), false, "clone retains non-Git authority");
    assert.equal(WorkerArtifactRepositoryMutationSnapshot.capture({ root, authorities: ["execution"] }).digest,
      this.repositorySnapshot.digest, "clone retains the seed source, index and filesystem contents");
  }

  assertUnchanged() {
    this.persistence.assertUnchanged(this.#manager, this.specId, "seed consumers");
    if (this.git) assert.equal(this.readHead(this.root), this.head, "consumers retain seed Git HEAD");
    else assert.equal(fs.existsSync(path.join(this.root, ".git")), false);
    assert.equal(WorkerArtifactRepositoryMutationSnapshot.capture({ root: this.root, authorities: ["execution"] }).digest,
      this.repositorySnapshot.digest, "consumers retain the immutable seed source and filesystem contents");
  }
}

/** Physical persistence protected by refusal and exact replay. A semantic
 * projection alone cannot detect a byte rewrite or a changed artifact identity.
 */
export class CanonicalPersistenceSnapshot {
  #files;

  constructor(manager, specId, additionalPaths = []) {
    const location = manager.specLocation(specId);
    this.flow = fs.readFileSync(location.flowStateFile);
    this.activities = fs.readFileSync(location.activitiesFile);
    this.catalog = fs.readFileSync(location.catalogFile);
    this.catalogHash = createHash("sha256").update(this.catalog).digest("hex");
    this.permanentArtifacts = manager.artifactCatalog(specId).toJSON().artifacts
      .filter((artifact) => artifact.retention === "permanent")
      .map(({ logicalKey, relativePath, hash, activityId }) =>
        Object.freeze({ logicalKey, relativePath, hash, activityId }));
    this.permanentBytes = new Map(this.permanentArtifacts.map(({ relativePath }) =>
      [relativePath, fs.readFileSync(location.resolve(relativePath))]));
    // Include attempted publication destinations even when no descriptor
    // exists yet, so a refusal cannot leave an uncataloged artifact behind.
    this.additionalPaths = Object.freeze([...additionalPaths]);
    this.additionalBytes = new Map(this.additionalPaths.map((file) =>
      [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
    this.#files = new Map([
      [location.flowStateFile, this.flow], [location.activitiesFile, this.activities],
      [location.catalogFile, this.catalog],
      ...[...this.permanentBytes].map(([relativePath, bytes]) => [location.resolve(relativePath), bytes]),
      ...this.additionalBytes,
    ]);
    Object.freeze(this.permanentArtifacts);
    Object.freeze(this);
  }

  /** A held writer lock forbids manager reads. Inspect the captured physical
   * destinations without acquiring that lock or changing its ownership.
   */
  assertPhysicalUnchanged(operation, expectedChanges = new Map()) {
    for (const [file, expected] of this.#files) {
      const actual = fs.existsSync(file) ? fs.readFileSync(file) : null;
      // A deliberate malformed input is captured before invoking its consumer.
      // Its changed bytes still need exact protection while catalog reads fail.
      const input = expectedChanges.has(file) ? expectedChanges.get(file) : expected;
      assert.deepEqual(actual, input, `${operation} must retain ${file}`);
    }
  }

  assertUnchanged(manager, specId, operation) {
    const actual = new CanonicalPersistenceSnapshot(manager, specId, this.additionalPaths);
    assert.deepEqual(actual.flow, this.flow, `${operation} must not rewrite flow.json`);
    assert.deepEqual(actual.activities, this.activities, `${operation} must not append an Activity`);
    assert.deepEqual(actual.catalog, this.catalog, `${operation} must not rewrite the catalog`);
    assert.equal(actual.catalogHash, this.catalogHash, `${operation} must retain the catalog hash`);
    assert.deepEqual(actual.permanentArtifacts, this.permanentArtifacts,
      `${operation} must retain permanent artifact identity`);
    assert.deepEqual(actual.permanentBytes, this.permanentBytes,
      `${operation} must retain permanent artifact bytes`);
    assert.deepEqual(actual.additionalBytes, this.additionalBytes,
      `${operation} must not publish rejected artifact bytes`);
  }
}

/** Physical source evidence before a legacy tree can pass current validation.
 * Include all authorities and uncataloged files; ignore only caller-owned
 * diagnostics. This does not parse or normalize persisted Flow documents. */
export class StoredFlowPersistenceSnapshot {
  constructor(root, { ignoredDirectories = [] } = {}) {
    this.root = path.resolve(root);
    this.ignoredDirectories = Object.freeze([...ignoredDirectories]);
    const snapshots = [];
    const visit = (directory, relative = "") => {
      const names = fs.readdirSync(directory).filter((name) => {
        const entryPath = relative ? `${relative}/${name}` : name;
        return !this.ignoredDirectories.some((ignored) => entryPath === ignored || entryPath.startsWith(`${ignored}/`));
      });
      snapshots.push(OfflineMigrationDirectorySnapshot.capture(path.dirname(this.root), directory, { includedNames: names }));
      for (const name of names.sort()) {
        const entry = path.join(directory, name);
        if (fs.lstatSync(entry).isDirectory()) visit(entry, relative ? `${relative}/${name}` : name);
      }
    };
    visit(this.root);
    this.snapshots = Object.freeze(snapshots);
    this.digest = createHash("sha256").update(JSON.stringify(snapshots.map((snapshot) => snapshot.toJSON()))).digest("hex");
    Object.freeze(this);
  }

  assertUnchanged() {
    const current = new StoredFlowPersistenceSnapshot(this.root, { ignoredDirectories: this.ignoredDirectories });
    assert.equal(current.digest, this.digest, "persisted source bytes and authorities must remain unchanged");
  }
}
