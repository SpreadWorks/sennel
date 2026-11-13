import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { it } from "node:test";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { WorkerArtifactRepositoryMutationSnapshot, WorkerArtifactSourceRollbackCheckpoint } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { testTemporaryRoot } from "../../test-environment.js";

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
}

function gitTree(root) {
  const entries = [];
  const visit = (directory, relative = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const logical = relative ? `${relative}/${name}` : name;
      const info = fs.lstatSync(file);
      assert.equal(info.isSymbolicLink(), false, "the test Git seed contains no native links");
      if (info.isDirectory()) {
        entries.push([logical, "directory"]);
        visit(file, logical);
      } else {
        assert.equal(info.isFile(), true);
        entries.push([logical, "file", fs.readFileSync(file)]);
      }
    }
  };
  visit(path.join(root, ".git"));
  return entries;
}

it("restores edited attributes and raw bytes without running smudge or changing any user Git storage", async (t) => {
  const root = createTmpDir("source-git-storage-");
  t.after(() => removeQuiescentRuntimeFixture({ mainRoot: root }));
  initGitRepo(root);
  const raw = Buffer.from("$Id$\r\nfirst\nlast\r\n");
  const attributes = Buffer.from("data.txt text eol=crlf filter=restore-contract ident\n.gitattributes -text -filter -ident\n");
  const unrelated = Buffer.from([0, 255, 13, 10, 65]);
  const sentinel = path.join(root, "smudge-ran");
  const filter = path.join(root, "filter.cjs");
  fs.writeFileSync(filter, "const fs = require('node:fs');\nif (process.argv[2] === 'smudge') { fs.writeFileSync(process.argv[3], 'unexpected'); process.stdout.write('transformed'); } else process.stdin.pipe(process.stdout);\n");
  const executable = `"${process.execPath.replaceAll("\\", "/")}"`;
  const script = `"${filter.replaceAll("\\", "/")}"`;
  git(root, "config", "filter.restore-contract.clean", `${executable} ${script} clean`);
  git(root, "config", "filter.restore-contract.smudge", `${executable} ${script} smudge "${sentinel.replaceAll("\\", "/")}"`);
  git(root, "config", "core.autocrlf", "true");
  fs.writeFileSync(path.join(root, ".gitattributes"), attributes);
  fs.writeFileSync(path.join(root, "data.txt"), raw);
  fs.writeFileSync(path.join(root, "unrelated.bin"), unrelated);
  commitAll(root, "raw restore contract");
  assert.notDeepEqual(git(root, "show", ":data.txt"), raw, "index normalization must differ from the raw before-image");
  assert.equal(fs.existsSync(sentinel), false);
  const userGit = gitTree(root);
  const untouchedGeneration = fs.statSync(path.join(root, "unrelated.bin"), { bigint: true }).ino;
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root });
  let failure = null;
  try {
    await runtime.enter(() => {
      const snapshot = WorkerArtifactRepositoryMutationSnapshot.capture({ root, authorities: ["execution"] });
      const blob = new WorkerArtifactSourceRollbackCheckpoint([snapshot]).blobBytes();
      assert.deepEqual(gitTree(root), userGit, "capability capture must leave user Git storage unchanged");
      fs.writeFileSync(path.join(root, ".gitattributes"), "* -text -filter -ident\n");
      fs.writeFileSync(path.join(root, "data.txt"), "worker bytes\n");
      WorkerArtifactSourceRollbackCheckpoint.fromBlob(blob, { root }).restore();
      assert.deepEqual(fs.readFileSync(path.join(root, ".gitattributes")), attributes);
      assert.deepEqual(fs.readFileSync(path.join(root, "data.txt")), raw);
      assert.deepEqual(fs.readFileSync(path.join(root, "unrelated.bin")), unrelated);
      assert.equal(fs.statSync(path.join(root, "unrelated.bin"), { bigint: true }).ino, untouchedGeneration);
      assert.equal(fs.existsSync(sentinel), false, "restore must never execute the user smudge filter");
      assert.deepEqual(gitTree(root), userGit, "restore must preserve the complete user index/object/ref/config tree");
    });
  } catch (error) {
    failure = error;
    testTemporaryRoot().retainOnUnconfirmedExecution(error);
    throw error;
  } finally {
    try { await runtime.close(); }
    catch (error) {
      testTemporaryRoot().retainOnUnconfirmedExecution(error);
      if (failure !== null) throw new AggregateError([failure, error], "source assertion and runtime closure both failed", { cause: failure });
      throw error;
    }
  }
});
