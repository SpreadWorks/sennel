import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  CanonicalFlowArtifactRemoval, CanonicalFlowArtifactWrite, CanonicalFlowReviewEvidenceWrite,
  CanonicalFlowRuntimeArtifactWrite, CanonicalSourceWorkerUpgradeResult,
} from "../../../src/flow/lib/current-flow-state.js";
import { FlowVersionAuthorityScope, FlowVersionLocation } from "../../../src/lib/flow-version.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { TemporaryPaths } from "../../../src/lib/temporary-paths.js";
import { OwnedTemporaryDirectory } from "../../../src/lib/owned-temporary-directory.js";
import { TemporaryAgentFileInput } from "../../../src/lib/agent-file-reference.js";
import { AgentFileInputFailure } from "../../../src/lib/agent-file-input-failure.js";
import { CanonicalNextActionScenario, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const bytes = Buffer.from("Exact publication あ\n");
const upgrade = Buffer.from(JSON.stringify({ version: 1, command: "sennel upgrade", dryRun: false,
  exitCode: 0, result: "success-no-change", summary: { skills: { updated: 0, unchanged: 1, removed: 0 } },
  failureReason: null, checkedPaths: [] }));
const writes = [
  ["ordinary artifact", () => new CanonicalFlowArtifactWrite({ logicalKey: "issue.snapshot", mediaType: "text/markdown", bytes })],
  ["source upgrade", () => new CanonicalSourceWorkerUpgradeResult({ bytes: upgrade })],
  ["review evidence", () => new CanonicalFlowReviewEvidenceWrite({ logicalKey: "review.evidence", reviewStep: "spec-review",
    digest: crypto.createHash("sha256").update(bytes).digest("hex"), mediaType: "application/json", bytes })],
];

function root(t) {
  const directory = createTmpDir("retained-publication-");
  t.after(() => removeTmpDir(directory));
  return directory;
}

function locationAt(repositoryRoot) {
  return new FlowVersionLocation({ repositoryRoot, authorityScope: FlowVersionAuthorityScope.canonical(),
    specId: "retained-publication", version: 1 });
}

function replace(directory, backup) {
  fs.renameSync(directory, backup);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "foreign.txt"), "foreign owner\n");
}

function assertForeign(directory) {
  assert.deepEqual(fs.readdirSync(directory), ["foreign.txt"]);
  assert.equal(fs.readFileSync(path.join(directory, "foreign.txt"), "utf8"), "foreign owner\n");
}

for (const [name, produce] of writes) {
  test(`${name} creates descendants and publishes exact bytes with fresh readback`, (t) => {
    const location = locationAt(root(t));
    const write = produce();
    assert.equal(write.write(location).committed, true);
    assert.deepEqual(fs.readFileSync(location.resolve(write.artifact.relativePath)), write.bytes);
  });

  for (const frontier of ["repository", "ensured parent", "retained Version"]) {
    test(`${name} refuses ${frontier} replacement before foreign publication`, (t) => {
      const directory = root(t);
      const repository = path.join(directory, "repository");
      fs.mkdirSync(repository);
      const location = locationAt(repository);
      const write = produce();
      let parent = null;
      let foreign;
      let replaced = false;
      if (frontier === "repository") {
        foreign = repository;
        replace(foreign, path.join(directory, "original-repository"));
        replaced = true;
      } else if (frontier === "retained Version") {
        parent = location.repositoryAuthority.descendant(location.directory, { create: true });
        foreign = location.directory;
        replace(foreign, path.join(directory, "original-version"));
        replaced = true;
      } else {
        foreign = path.dirname(location.resolve(write.artifact.relativePath));
        const resolve = RealDirectoryAuthority.resolve;
        t.mock.method(RealDirectoryAuthority, "resolve", function (target, options = {}) {
          const authority = resolve.call(this, target, options);
          if (!replaced && options.create && path.resolve(target) === foreign) {
            replace(foreign, path.join(directory, "original-parent"));
            replaced = true;
          }
          return authority;
        });
      }
      let failure;
      try { write.write(location, parent); } catch (error) { failure = error; }
      assert.equal(replaced, true);
      assertForeign(foreign);
      assert.ok(failure instanceof Error);
    });
  }
}

test("artifact removal preserves an absent parent and refuses a replaced retained Version", (t) => {
  const directory = root(t);
  const location = locationAt(directory);
  const removal = new CanonicalFlowArtifactRemoval({ logicalKey: "tests.source", parameters: { testPath: "check.js" } });
  assert.equal(removal.remove(location).committed, false);
  assert.deepEqual(fs.readdirSync(directory), []);
  const parent = location.repositoryAuthority.descendant(location.directory, { create: true });
  const file = location.resolve(removal.artifact.relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  replace(location.directory, path.join(directory, "original-version"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "foreign source\n");
  assert.throws(() => removal.remove(location, parent));
  assert.equal(fs.readFileSync(file, "utf8"), "foreign source\n");
});

test("staging locations retain the original repository identity", (t) => {
  const directory = root(t);
  const repository = path.join(directory, "repository");
  fs.mkdirSync(repository);
  const location = locationAt(repository);
  replace(repository, path.join(directory, "original-repository"));
  assert.throws(() => location.stagingSibling("staged"));
  assertForeign(repository);
});

function canonicalFlow(t) {
  const directory = root(t);
  const manager = makeFlowManager(directory);
  const specId = "001-retained-publication";
  new CanonicalNextActionScenario({ flowManager: manager, specId, runId: "retained-publication-run" }).create();
  return { directory, manager, specId, location: manager.specLocation(specId) };
}

test("Store forwards its Version authority into upgrade-result publication", (t) => {
  const { directory, manager, specId, location } = canonicalFlow(t);
  const write = CanonicalFlowArtifactWrite.prototype.write;
  let replaced = false;
  t.mock.method(CanonicalFlowArtifactWrite.prototype, "write", function (...args) {
    if (!replaced && this.artifact.logicalKey === "upgrade.result") {
      replace(location.directory, path.join(directory, "original-version"));
      replaced = true;
    }
    return write.apply(this, args);
  });
  let failure;
  try { manager.publishUpgradeResult({ specId,
    artifact: { logicalKey: "upgrade.result", mediaType: "application/json", bytes: upgrade } }); }
  catch (error) { failure = error; }
  assert.equal(replaced, true);
  assertForeign(location.directory);
  assert.ok(failure instanceof Error);
});

test("runtime publication retains the already-locked runtime directory", (t) => {
  const { directory, manager, specId, location } = canonicalFlow(t);
  const runtime = location.runtimeLock("runtime.lock.artifact-catalog").runtimeDirectory;
  const write = CanonicalFlowRuntimeArtifactWrite.prototype.write;
  let replaced = false;
  t.mock.method(CanonicalFlowRuntimeArtifactWrite.prototype, "write", function (...args) {
    replace(runtime, path.join(directory, "original-runtime"));
    replaced = true;
    return write.apply(this, args);
  });
  assert.throws(() => manager.writeRuntimeArtifact({ specId, nodeId: "finalize-cleanup",
    artifact: { logicalKey: "finalize.cleanup.runtime-log", mediaType: "application/json", bytes: "{}\n" } }));
  assert.equal(replaced, true);
  assertForeign(runtime);
});

function inputOptions(directory) {
  return { projectRoot: directory, runtimeRoot: TemporaryPaths.runtimePath(directory, "input"),
    text: "Exact input あ", logicalName: "input.txt" };
}

test("temporary input keeps its subclass, exact bytes and full owned cleanup", (t) => {
  class SpecializedInput extends TemporaryAgentFileInput {}
  const input = SpecializedInput.create(inputOptions(root(t)));
  assert.ok(input instanceof SpecializedInput);
  assert.deepEqual(fs.readFileSync(input.filePath), Buffer.from("Exact input あ"));
  input.assertUnchanged();
  input.dispose();
  assert.equal(fs.existsSync(input.directory), false);
});

test("temporary input refuses an ensured runtime replacement before allocating in a foreign tree", (t) => {
  const directory = root(t);
  const options = inputOptions(directory);
  const ensure = TemporaryPaths.prototype.ensureDirectory;
  let replaced = false;
  t.mock.method(TemporaryPaths.prototype, "ensureDirectory", function (...args) {
    const selected = ensure.apply(this, args);
    replace(selected, path.join(directory, "original-input-runtime"));
    replaced = true;
    return selected;
  });
  let failure;
  try { TemporaryAgentFileInput.create(options); } catch (error) { failure = error; }
  assert.equal(replaced, true);
  assertForeign(options.runtimeRoot);
  assert.ok(failure instanceof AgentFileInputFailure);
});

test("temporary input refuses a replaced minted owner and preserves its cleanup failure", (t) => {
  const directory = root(t);
  const create = OwnedTemporaryDirectory.create;
  let foreign;
  t.mock.method(OwnedTemporaryDirectory, "create", function (...args) {
    const owned = create.apply(this, args);
    foreign = owned.path;
    replace(foreign, path.join(directory, "original-input"));
    return owned;
  });
  let failure;
  try { TemporaryAgentFileInput.create(inputOptions(directory)); } catch (error) { failure = error; }
  assertForeign(foreign);
  assert.ok(failure instanceof AgentFileInputFailure);
  assert.ok(failure.cause instanceof AggregateError);
  assert.equal(failure.cause.errors.length, 2);
});

test("temporary input revalidation refuses a byte-identical owner replacement", (t) => {
  const directory = root(t);
  const input = TemporaryAgentFileInput.create(inputOptions(directory));
  replace(input.directory, path.join(directory, "original-input"));
  fs.writeFileSync(input.filePath, "Exact input あ");
  assert.throws(() => input.assertUnchanged(), AgentFileInputFailure);
  assert.deepEqual(fs.readdirSync(input.directory).sort(), ["foreign.txt", "input.txt"]);
  assert.deepEqual(fs.readFileSync(input.filePath), Buffer.from("Exact input あ"));
});
