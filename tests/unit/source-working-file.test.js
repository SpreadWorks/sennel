import { FileIdentity } from "../../src/lib/file-identity.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { workerArtifactDigest, workerArtifactStableStringify } from "../../src/flow/lib/worker-artifact-input-format.js";
import { WorkerArtifactRepositoryMutationSnapshot } from "../../src/flow/lib/worker-artifact-handoff.js";
import { SourceRestoreCapability } from "../../src/flow/lib/source-git-restore-stage.js";
import { SourceRollbackOperationReceipt, SourceMutationManifestValue } from "../../src/flow/lib/source-mutation-manifest.js";
import { GitSourceEntry, SourceWorkingFile, WorkerArtifactRepositoryEntry, SourceGitState, SourceGitControlFiles } from "../../src/flow/lib/source-working-file.js";

const generation = new FileIdentity({ dev: 1n, ino: 2n });
const regular = () => new SourceWorkingFile({ kind: "file", digest: "a".repeat(64), generation });
const gitState = () => new SourceGitState({ filemode: true, symlinks: false, configDigest: "a".repeat(64),
      refsDigest: "b".repeat(64), flagsDigest: "c".repeat(64), attributesDigest: "d".repeat(64),
      workingAttributesDigest: "e".repeat(64), directories: { git: generation, common: generation },
      controlFiles: new SourceGitControlFiles({ head: regular(), index: regular(), commonConfig: regular(), worktreeConfig: new SourceWorkingFile({ kind: "missing" }) }) });
const logical = (mode = "120000") => new GitSourceEntry({ logicalMode: mode, indexOid: "b".repeat(40),
  assumeUnchanged: false, skipWorktree: false, worktreeMode: mode });

describe("source representation invariants", () => {
  it("keeps logical link type independent of its regular host representation", () => {
    assert.equal(logical().assertRepresentation(regular(), { symlinks: false }).logicalMode, "120000");
    assert.equal(logical().materializationMode, "100644");
    assert.throws(() => logical().assertRepresentation(regular(), { symlinks: true }), /inconsistent regular host/);
  });
  it("rejects unknown logical modes, native links, absent raw digest, and old mode-shaped records", () => {
    assert.throws(() => logical("160000"), /unsupported Git logical source mode/);
    assert.throws(() => new SourceWorkingFile({ kind: "symlink", digest: "a".repeat(64), generation }), /unsupported source host/);
    assert.throws(() => new SourceWorkingFile({ kind: "file", generation }), /raw SHA-256/);
    assert.throws(() => SourceWorkingFile.fromStored({ kind: "file", digest: "a".repeat(64), mode: 0o644 }), /invalid schema/);
  });
  it("preserves physical generation without using it as content equality", () => {
    const copied = new SourceWorkingFile({ kind: "file", digest: "a".repeat(64), generation: new FileIdentity({ dev: 3n, ino: 4n }) });
    assert.equal(regular().sameContent(copied), true);
    assert.equal(regular().generation.equals(copied.generation), false);
    assert.deepEqual(SourceWorkingFile.fromStored(regular().toJSON()).toJSON(), regular().toJSON());
  });
  it("rejects a persisted rollback operation without its exact digest", () => {
    const receipt = new SourceRollbackOperationReceipt({ path: "source", workingPath: "source", operation: "write", phase: "prepared",
      before: new SourceWorkingFile({ kind: "missing" }), after: regular(), beforeMode: null, afterMode: 0o644 });
    assert.deepEqual(SourceRollbackOperationReceipt.fromStored(receipt.toJSON()).toJSON(), receipt.toJSON());
    assert.throws(() => SourceRollbackOperationReceipt.fromStored({ ...receipt.toJSON(), digest: null }), /requires SHA-256/);
    assert.throws(() => SourceRollbackOperationReceipt.fromStored({ ...receipt.toJSON(), digest: "b".repeat(64) }), /digest mismatch/);
  });

  it("requires complete canonical stopped observations and matching mutation after-images", () => {
    const attempt = { id: "attempt", nodeId: "implement", sequence: 1 };
    const observation = new WorkerArtifactRepositoryEntry({ path: "source", workingPath: "source", working: regular() });
    const manifest = new SourceMutationManifestValue({ attempt, baselineDigest: "a".repeat(64), observations: [observation] });
    assert.equal(manifest.mutations.length, 0);
    assert.deepEqual(SourceMutationManifestValue.fromStored(manifest.toJSON()).observations[0].toJSON(), observation.toJSON());
    const missing = manifest.toJSON(); delete missing.observations;
    assert.throws(() => SourceMutationManifestValue.fromStored(missing), /invalid schema/);
    const extra = manifest.toJSON(); extra.observations[0].working.generation.extra = true;
    assert.throws(() => SourceMutationManifestValue.fromStored(extra), /exact stored decimal/);
    assert.throws(() => new SourceMutationManifestValue({ attempt, baselineDigest: "a".repeat(64), observations: [], mutations: [{
      mutationId: SourceMutationManifestValue.mutationId(attempt, "source"), path: "source", changeKind: "added",
      beforeKind: "missing", beforeMode: null, beforeDigest: null, beforeGeneration: null,
      afterKind: "file", afterMode: null, afterDigest: regular().digest, afterGeneration: generation,
    }] }), /after-image differs/);
  });

  it("distinguishes absent indexed descendants from conflicting physical file targets", () => {
    const attempt = { id: "attempt", nodeId: "implement", sequence: 1 };
    const parent = new WorkerArtifactRepositoryEntry({ path: "parent", workingPath: "parent", working: regular() });
    const missing = WorkerArtifactRepositoryEntry.missing("parent/child");
    const manifest = new SourceMutationManifestValue({ attempt, baselineDigest: "a".repeat(64), observations: [parent, missing] });
    assert.equal(SourceMutationManifestValue.fromStored(manifest.toJSON()).observations[1].kind, "missing");
    const child = new WorkerArtifactRepositoryEntry({ path: "parent/child", workingPath: "parent/child", working: regular() });
    assert.throws(() => new SourceMutationManifestValue({ attempt, baselineDigest: "a".repeat(64), observations: [parent, child] }), /prefixes another target/);
    const alias = new WorkerArtifactRepositoryEntry({ path: "Parent/absent", workingPath: "Parent/absent", working: new SourceWorkingFile({ kind: "missing" }) });
    assert.throws(() => new SourceMutationManifestValue({ attempt, baselineDigest: "a".repeat(64), observations: [parent, alias] }), /paths collide/);
  });

  it("rejects a rehashed mutation identifier that belongs to another Attempt or path", () => {
    const attempt = { id: "attempt", nodeId: "implement", sequence: 1 };
    const manifest = new SourceMutationManifestValue({ attempt, baselineDigest: "a".repeat(64),
      observations: [new WorkerArtifactRepositoryEntry({ path: "source", workingPath: "source", working: regular() })], mutations: [{
        mutationId: SourceMutationManifestValue.mutationId(attempt, "source"), path: "source", changeKind: "added",
        beforeKind: "missing", beforeMode: null, beforeDigest: null, beforeGeneration: null,
        afterKind: "file", afterMode: null, afterDigest: regular().digest, afterGeneration: generation,
      }] });
    assert.deepEqual(SourceMutationManifestValue.fromStored(manifest.toJSON()).toJSON(), manifest.toJSON());
    const altered = manifest.unsignedJSON();
    altered.mutations[0].mutationId = SourceMutationManifestValue.mutationId(attempt, "another-path");
    assert.throws(() => SourceMutationManifestValue.fromStored({ ...altered,
      digest: workerArtifactDigest(workerArtifactStableStringify(altered)) }), /id does not bind its Attempt and path/);
  });

  it("binds named Git control generations without changing semantic source identity", () => {
    const state = gitState();
    const differentGeneration = new SourceWorkingFile({ kind: "file", digest: regular().digest, generation: new FileIdentity({ dev: 8n, ino: 9n }) });
    const changedControls = new SourceGitState({ ...state.toJSON(), controlFiles: new SourceGitControlFiles({
      ...state.controlFiles, index: differentGeneration }) });
    assert.deepEqual(changedControls.contentJSON(), state.contentJSON(), "physical control generations do not change semantic clone/progress identity");
    assert.notDeepEqual(changedControls.controlJSON(), state.controlJSON(), "physical control replacement remains an integrity change");
    const absentControls = state.toJSON(); delete absentControls.controlFiles;
    assert.throws(() => SourceGitState.fromStored(absentControls), /invalid schema/);
    assert.throws(() => SourceGitControlFiles.fromStored({ ...state.controlFiles.toJSON(), head: new SourceWorkingFile({ kind: "missing" }).toJSON() }), /invalid physical representation/);
    const snapshot = new WorkerArtifactRepositoryMutationSnapshot({ root: process.cwd(), authorities: ["execution"],
      mode: "git", head: "b".repeat(40), indexDigest: "a".repeat(64), gitState: state, generation, entries: [] });
    const changed = new WorkerArtifactRepositoryMutationSnapshot({ ...snapshot, gitState: changedControls });
    assert.equal(changed.digest, snapshot.digest);
    assert.deepEqual(snapshot.allChangedPaths(changed), ["<git-control>"]);
    assert.equal(snapshot.sameObservation(snapshot), true);
    assert.equal(snapshot.sameObservation(changed), false, "same-byte named Git control replacement remains an observation change");
    assert.deepEqual(snapshot.observationChanges(changed), ["<observation-header>"]);
    assert.equal(snapshot.publicationPaths(changed, ["receipt.json"]).has("<observation-header>"), false,
      "a known publication cannot explain a changed Git control header");
    assert.equal(snapshot.sameObservation(new WorkerArtifactRepositoryMutationSnapshot({ ...snapshot,
      ignoredDirectories: ["canonical/execution/contract.json"] })), false, "the exact ignored scope remains bound");
    assert.equal(snapshot.sameObservation(new WorkerArtifactRepositoryMutationSnapshot({ ...snapshot,
      generation: new FileIdentity({ dev: 8n, ino: 9n }) })), false, "repository generation remains bound");
    assert.equal(snapshot.sameObservation(new WorkerArtifactRepositoryMutationSnapshot({ ...snapshot,
      gitState: new SourceGitState({ ...state.toJSON(), workingAttributesDigest: "f".repeat(64) }) })), false,
    "full observation equality retains worktree attribute facts as well as immutable controls");
  });

  it("rejects singleton arrays at current source hash and Git OID boundaries", () => {
    const logicalEntry = logical().toJSON();
    assert.throws(() => GitSourceEntry.fromStored({ ...logicalEntry, indexOid: [logicalEntry.indexOid] }), /mode and OID must be bound/);
    const state = gitState();
    assert.deepEqual(SourceGitState.fromStored(state.toJSON()).toJSON(), state.toJSON());
    for (const field of ["configDigest", "refsDigest", "flagsDigest", "attributesDigest", "workingAttributesDigest"]) {
      const stored = state.toJSON();
      assert.throws(() => SourceGitState.fromStored({ ...stored, [field]: [stored[field]] }), /exact digests/);
    }
    const capability = new SourceRestoreCapability({ snapshotDigest: "a".repeat(64), entriesDigest: "b".repeat(64), gitState: state });
    assert.deepEqual(SourceRestoreCapability.fromStored(capability.toJSON()).toJSON(), capability.toJSON());
    for (const field of ["snapshotDigest", "entriesDigest"]) {
      const stored = capability.toJSON();
      assert.throws(() => SourceRestoreCapability.fromStored({ ...stored, [field]: [stored[field]] }), /capability is invalid/);
    }
    const snapshot = new WorkerArtifactRepositoryMutationSnapshot({ root: process.cwd(), authorities: ["execution"],
      mode: "git", head: "b".repeat(40), indexDigest: "a".repeat(64), gitState: state, generation, entries: [] });
    assert.deepEqual(WorkerArtifactRepositoryMutationSnapshot.fromStored(snapshot.toJSON(), { root: process.cwd() }).toJSON(), snapshot.toJSON());
    for (const field of ["head", "indexDigest"]) {
      const stored = snapshot.toJSON();
      assert.throws(() => WorkerArtifactRepositoryMutationSnapshot.fromStored({ ...stored, [field]: [stored[field]] }, { root: process.cwd() }), /control identity is invalid/);
    }
  });

  it("rejects normalized extras in a persisted source Attempt", () => {
    const manifest = new SourceMutationManifestValue({ attempt: { id: "attempt", nodeId: "implement", sequence: 1 }, baselineDigest: "a".repeat(64) });
    const stored = manifest.toJSON();
    assert.deepEqual(SourceMutationManifestValue.fromStored(stored).toJSON(), stored);
    assert.throws(() => SourceMutationManifestValue.fromStored({ ...stored, attempt: { ...stored.attempt, extra: true } }), /noncanonical fields/);
  });

});


describe("source logical and native path observations", () => {
  const entry = (logicalPath, workingPath, working = regular()) => new WorkerArtifactRepositoryEntry({
    path: logicalPath, workingPath, working, git: working.kind === "directory" ? null : logical("100644") });
  it("requires native spelling while preserving stable logical semantic identity", () => {
    const nfc = entry("Café/é.bin", "Café/é.bin");
    const nfd = entry("Café/é.bin", "Cafe\u0301/e\u0301.bin");
    assert.deepEqual(nfd.contentJSON(), nfc.contentJSON());
    assert.notDeepEqual(nfd.toJSON(), nfc.toJSON());
    assert.deepEqual(WorkerArtifactRepositoryEntry.fromStored(nfd.toJSON()).toJSON(), nfd.toJSON());
    const omitted = nfd.toJSON(); delete omitted.workingPath;
    assert.throws(() => WorkerArtifactRepositoryEntry.fromStored(omitted), /invalid schema/);
    assert.throws(() => entry("Café/é.bin", "neighbor/é.bin"), /native spelling must represent/);
    const before = new WorkerArtifactRepositoryMutationSnapshot({ root: process.cwd(), authorities: ["execution"],
      mode: "git", head: "b".repeat(40), indexDigest: "a".repeat(64), gitState: gitState(), generation, entries: [nfc] });
    const after = new WorkerArtifactRepositoryMutationSnapshot({ ...before, entries: [nfd] });
    assert.equal(before.digest, after.digest);
    assert.deepEqual(before.allChangedPaths(after), []);
    assert.deepEqual(before.observationChanges(after), ["Café/é.bin"]);
    assert.throws(() => before.assertCurrentGenerations(after), /physical generation changed before worker/);
    assert.throws(() => new WorkerArtifactRepositoryMutationSnapshot({ ...before, mode: "filesystem", head: null,
      indexDigest: null, gitState: null, entries: [new WorkerArtifactRepositoryEntry({ ...nfd, git: null })] }), /repository policy differs/);
  });

  it("binds rollback targets to stopped native leaves and published parent directories", () => {
    const directory = new SourceWorkingFile({ kind: "directory", generation });
    const missing = new SourceWorkingFile({ kind: "missing" });
    const baselineEntries = [entry("Café", "Cafe\u0301", directory), entry("Café/é.bin", "Cafe\u0301/e\u0301.bin")];
    const stoppedEntries = [entry("Café", "CAFÉ", directory), entry("Café/é.bin", "CAFÉ/É.BIN")];
    const operations = new Map();
    const facts = { baselineEntries, stoppedEntries, operations };
    const receipt = new SourceRollbackOperationReceipt({ path: "Café/é.bin", workingPath: "CAFÉ/É.BIN",
      operation: "remove", phase: "prepared", before: regular(), after: missing, beforeMode: 0o644, afterMode: null });
    assert.equal(receipt.assertPathBinding(facts), receipt);
    assert.equal(receipt.matchesEntry(stoppedEntries[1], "before"), true);
    assert.equal(receipt.matchesEntry(baselineEntries[1], "before"), false, "same generation and bytes do not authorize another observed native spelling");
    assert.throws(() => new SourceRollbackOperationReceipt({ ...receipt.unsignedJSON(), workingPath: "Cafe\u0301/e\u0301.bin" }).assertPathBinding(facts), /captured native target/);
    operations.set(receipt.path, receipt.published());
    assert.equal(SourceRollbackOperationReceipt.targetWorkingPath(receipt.path, facts), "CAFÉ/e\u0301.bin", "a removed leaf takes baseline spelling under the stopped real parent");
    const preparedWrite = new SourceRollbackOperationReceipt({ ...receipt.unsignedJSON(), workingPath: "CAFÉ/e\u0301.bin",
      operation: "write", phase: "prepared", before: missing, after: regular(), beforeMode: null, afterMode: 0o644 });
    const latestHeads = new Map(operations); latestHeads.set(receipt.path, preparedWrite);
    assert.equal(preparedWrite.assertPathBinding(facts), preparedWrite, "an unconfirmed write leaves its prior published removal in the publication facts");
    assert.throws(() => preparedWrite.assertPathBinding({ ...facts, operations: latestHeads }), /captured native target/,
      "latest prepared heads cannot replace the retained published-facts map");
    const parent = new SourceRollbackOperationReceipt({ path: "Café", workingPath: "Cafe\u0301", operation: "directory", phase: "prepared",
      before: missing, after: directory, beforeMode: null, afterMode: null });
    operations.set(parent.path, parent);
    assert.equal(SourceRollbackOperationReceipt.targetWorkingPath(receipt.path, facts), "CAFÉ/e\u0301.bin", "an unconfirmed parent cannot supply publication spelling");
    operations.set(parent.path, parent.published());
    assert.equal(SourceRollbackOperationReceipt.targetWorkingPath(receipt.path, facts), "Cafe\u0301/e\u0301.bin");
    latestHeads.set(parent.path, new SourceRollbackOperationReceipt({ ...parent.unsignedJSON(), operation: "remove",
      before: directory, after: missing }));
    assert.equal(SourceRollbackOperationReceipt.targetWorkingPath(receipt.path, facts), "Cafe\u0301/e\u0301.bin",
      "unconfirmed parent heads never overwrite the separate published native ancestor facts");
    const stored = receipt.toJSON(); delete stored.workingPath;
    assert.throws(() => SourceRollbackOperationReceipt.fromStored(stored), /invalid schema/);
  });
});
