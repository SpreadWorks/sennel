import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { TestTemporaryRoot, TEST_CHECKOUT_ROOT } from "../test-temporary-root.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";
import { repoRoot } from "../../src/lib/cli.js";
import { sanitizeGitRepositoryEnvironment } from "../../src/lib/git-repository-environment.js";
import { resolveRepositoryLockRoot, RepositoryFlowOperationLock } from "../../src/lib/repository-maintenance-lock.js";
import { RepositoryLockAuthority } from "../../src/lib/repository-control-lock.js";
await import("../../src/sennel.js");
const { resolveCurrentReviewTreeSha } = await import("../../src/flow/lib/review-evidence-store.js");

const moduleUrl = (relative) => pathToFileURL(path.join(TEST_CHECKOUT_ROOT, relative)).href;

function environmentWithoutTemporaryRoot() {
  const environment = { ...process.env };
  delete environment.SENNEL_TEST_TEMP_ROOT;
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

function snapshot(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function repositoryLockPaths(root) {
  return [".repository-maintenance.lock", ".repository-flow-operation.lock"].flatMap((fileName) => [
    RepositoryLockAuthority.pathFor(root, { fileName }),
    path.join(root, ".sennel", fileName),
  ]);
}

test("repository scratch creates distinct owned roots and borrowers preserve owner data", async (t) => {
  const first = TestTemporaryRoot.select({ environment: {} });
  t.after(() => first.remove());
  const second = TestTemporaryRoot.select({ environment: {} });
  t.after(() => second.remove());
  assert.equal(path.dirname(first.path), path.join(fs.realpathSync(TEST_CHECKOUT_ROOT), ".tmp", "tests"));
  assert.notEqual(first.path, second.path);
  const environment = { TMPDIR: "previous", GIT_CEILING_DIRECTORIES: "prior-ceiling" };
  const previous = { ...environment };
  await first.use(async () => {
    fs.writeFileSync(path.join(first.path, "owner-data"), "preserved");
    const borrowed = TestTemporaryRoot.select({ environment });
    assert.equal(borrowed.path, first.path);
    assert.equal(borrowed.owned, false);
    await borrowed.use(() => {}, { environment, processEvents: new EventEmitter() });
    borrowed.remove();
    assert.equal(fs.readFileSync(path.join(first.path, "owner-data"), "utf8"), "preserved");
    assert.equal(fs.existsSync(second.path), true);
  }, { environment, processEvents: new EventEmitter() });
  assert.deepEqual(environment, previous);
  assert.equal(fs.existsSync(first.path), false);
  assert.equal(fs.existsSync(second.path), true);
});

test("invalid inherited shared roots fail before creation without switching storage", (t) => {
  const root = TestTemporaryRoot.select({ environment: {} });
  t.after(() => root.remove());
  const outside = path.join(TEST_CHECKOUT_ROOT, "tests");
  assert.throws(() => TestTemporaryRoot.select({ environment: { SENNEL_TEST_TEMP_ROOT: outside } }), {
    code: "TEMPORARY_PATH_OUTSIDE_PROJECT",
  });
  const missing = path.join(root.path, "missing");
  assert.throws(() => TestTemporaryRoot.select({ environment: { SENNEL_TEST_TEMP_ROOT: missing } }), { code: "ENOENT" });
  assert.equal(fs.existsSync(missing), false);
  const link = path.join(root.path, "outside");
  fs.symlinkSync(outside, link, "dir");
  assert.throws(() => TestTemporaryRoot.select({ environment: { SENNEL_TEST_TEMP_ROOT: link } }));
  assert.deepEqual(fs.readdirSync(root.path), ["outside"]);
  const project = createTmpDir("sennel-borrow-namespace-", { parent: root.path });
  const sharedLogs = path.join(project, ".tmp", "logs");
  fs.mkdirSync(sharedLogs, { recursive: true });
  fs.writeFileSync(path.join(sharedLogs, "sentinel"), "unchanged");
  assert.throws(() => TestTemporaryRoot.select({ repositoryRoot: project, environment: { SENNEL_TEST_TEMP_ROOT: sharedLogs } }), {
    code: "TEST_TEMPORARY_ROOT_OUTSIDE_TESTS",
  });
  assert.deepEqual(fs.readdirSync(sharedLogs), ["sentinel"]);
  assert.equal(fs.readFileSync(path.join(sharedLogs, "sentinel"), "utf8"), "unchanged");
});

test("repository non-Git fixtures cannot discover the checkout or acquire its repository lock", async (t) => {
  const temporary = TestTemporaryRoot.select({ environment: {} });
  t.after(() => temporary.remove());
  const parentLocks = repositoryLockPaths(TEST_CHECKOUT_ROOT);
  const before = parentLocks.map(snapshot);
  const originalDirectory = process.cwd();
  const previousWorkRoot = process.env.SENNEL_WORK_ROOT;
  const previousSourceRoot = process.env.SENNEL_SOURCE_ROOT;
  t.after(() => {
    process.chdir(originalDirectory);
    for (const [name, value] of [["SENNEL_WORK_ROOT", previousWorkRoot], ["SENNEL_SOURCE_ROOT", previousSourceRoot]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  await temporary.use(() => {
    const fixture = createTmpDir("sennel-nongit-", { parent: temporary.path });
    process.chdir(fixture);
    delete process.env.SENNEL_WORK_ROOT;
    delete process.env.SENNEL_SOURCE_ROOT;
    const raw = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: fixture, encoding: "utf8" });
    assert.notEqual(raw.status, 0);
    assert.equal(repoRoot(), fixture);
    assert.equal(resolveRepositoryLockRoot(fixture), fixture);
    assert.throws(() => resolveCurrentReviewTreeSha(fixture), { code: "REVIEW_TARGET_TREE_UNAVAILABLE" });
    const lock = new RepositoryFlowOperationLock({ mainRoot: resolveRepositoryLockRoot(fixture) });
    try {
      lock.acquire();
      assert.equal(lock.lockPath, RepositoryLockAuthority.pathFor(fixture, { fileName: ".repository-flow-operation.lock" }));
      assert.equal(fs.existsSync(lock.lockPath), true);
      assert.equal(fs.existsSync(path.join(fixture, ".sennel", ".repository-flow-operation.lock")), false);
      assert.deepEqual(parentLocks.map(snapshot), before);
    } finally {
      lock.release();
      process.chdir(originalDirectory);
    }
    assert.deepEqual(parentLocks.map(snapshot), before);
  });
});

test("repository owner root itself rejects ancestor Git and restores its activated environment", (t) => {
  const names = ["TMPDIR", "TMP", "TEMP", "SENNEL_TEST_TEMP_ROOT", "GIT_CEILING_DIRECTORIES"];
  const previous = names.map((name) => process.env[name]);
  const parentLocks = repositoryLockPaths(TEST_CHECKOUT_ROOT);
  const locksBefore = parentLocks.map(snapshot);
  const gitStatus = () => {
    const result = spawnSync("git", ["status", "--porcelain"], { cwd: TEST_CHECKOUT_ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const statusBefore = gitStatus();
  const owner = TestTemporaryRoot.createOnRepository();
  t.after(() => owner.remove());
  const release = owner.activate();
  try {
    assert.equal(process.env.TMPDIR, owner.path);
    assert.equal(process.env.SENNEL_TEST_TEMP_ROOT, owner.path);
    const raw = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: owner.path, encoding: "utf8" });
    assert.equal(raw.status, 128, raw.stdout + raw.stderr);
    assert.equal(raw.stdout, "");
    assert.match(raw.stderr, /not a git repository/);
  } finally {
    release();
    assert.deepEqual(names.map((name) => process.env[name]), previous);
    assert.equal(fs.existsSync(owner.path), false);
    assert.deepEqual(parentLocks.map(snapshot), locksBefore);
    assert.equal(gitStatus(), statusBefore);
  }
});

test("explicit sanitized Git boundaries retain real and linked repository lock sharing", (t) => {
  const root = createTmpDir("sennel-explicit-git-boundary-");
  t.after(() => removeTmpDir(root));
  const git = (args, cwd = root) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Seed"]);
  const linked = path.join(root, "linked");
  git(["worktree", "add", "-q", "-b", "linked", linked]);
  assert.equal(resolveRepositoryLockRoot(root), root);
  assert.equal(resolveRepositoryLockRoot(linked), root);
  const env = sanitizeGitRepositoryEnvironment({ ...process.env, GIT_DIR: "/foreign", GIT_WORK_TREE: "/foreign", GIT_CEILING_DIRECTORIES: "/foreign" }, { repositoryRoot: linked });
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_WORK_TREE, undefined);
  assert.equal(env.GIT_CEILING_DIRECTORIES, path.dirname(linked));
  const tree = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: linked, env, encoding: "utf8" });
  assert.equal(tree.status, 0, tree.stderr);
  assert.equal(tree.stdout.trim(), linked);
});

test("direct Node tests and the runner share selection and only the owner cleans repository roots", (t) => {
  const storage = TestTemporaryRoot.createOnRepository();
  t.after(() => storage.remove());
  const fixture = createTmpDir("sennel-temporary-bootstrap-probe-", { parent: storage.path });
  t.after(() => removeTmpDir(fixture));
  const testFile = path.join(fixture, "probe.test.js");
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(testFile, [
    `import { test } from "node:test";`,
    `import os from "node:os";`,
    `import { createTmpDir, removeTmpDir } from ${JSON.stringify(moduleUrl("tests/support/builders/tmp-dir.js"))};`,
    `import { testTemporaryRoot } from ${JSON.stringify(moduleUrl("tests/test-environment.js"))};`,
    `test("temporary bootstrap", () => { const fixture = createTmpDir("sennel-child-"); console.log("TEMPORARY_PROBE=" + JSON.stringify({ path: testTemporaryRoot().path, owned: testTemporaryRoot().owned, fixture, tmpdir: os.tmpdir() })); removeTmpDir(fixture); });`,
  ].join("\n"));
  for (const runner of [false, true]) {
    const script = `const { main } = await import(${JSON.stringify(moduleUrl("tests/run.js"))}); process.exitCode = await main(["--file", ${JSON.stringify(testFile)}, "--jobs", "1"]);`;
    const args = runner
      ? ["--input-type=module", "--eval", script]
      : ["--test", testFile];
    const result = spawnSync(process.execPath, args, {
      cwd: fixture, env: environmentWithoutTemporaryRoot(), encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const match = /TEMPORARY_PROBE=(\{[^\n]+\})/.exec(result.stdout);
    assert.ok(match, result.stdout + result.stderr);
    const probe = JSON.parse(match[1]);
    assert.equal(path.dirname(probe.path), path.join(TEST_CHECKOUT_ROOT, ".tmp", "tests"));
    assert.equal(probe.owned, !runner);
    assert.equal(probe.tmpdir, probe.path);
    assert.equal(path.dirname(probe.fixture), probe.path);
    assert.equal(fs.existsSync(probe.fixture), false);
    assert.equal(fs.existsSync(probe.path), false);
  }
});

test("a retained control failure keeps its fixture after exact receipt closure and process exit", (t) => {
  const script = [
    `import assert from "node:assert/strict";`,
    `import fs from "node:fs";`,
    `import path from "node:path";`,
    `await import(${JSON.stringify(moduleUrl("src/sennel.js"))});`,
    `const { testTemporaryRoot } = await import(${JSON.stringify(moduleUrl("tests/test-environment.js"))});`,
    `const { createTmpDir } = await import(${JSON.stringify(moduleUrl("tests/support/builders/tmp-dir.js"))});`,
    `const { removeQuiescentRuntimeFixture } = await import(${JSON.stringify(moduleUrl("tests/support/infrastructure/runtime-fixture-cleanup.js"))});`,
    `const { ProcessExecutionRuntime, ProcessExecutionControlFailure } = await import(${JSON.stringify(moduleUrl("src/lib/process-execution-runtime.js"))});`,
    `const { runCmdAsync } = await import(${JSON.stringify(moduleUrl("src/lib/process.js"))});`,
    `const outer = testTemporaryRoot();`,
    `outer.beginExecution();`,
    `const fixture = createTmpDir("retained-runtime-receipt-");`,
    `const evidence = path.join(fixture, "diagnostic-evidence.txt");`,
    `fs.writeFileSync(evidence, "preserve the first control failure");`,
    `const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: fixture });`,
    `const result = await runtime.enter(() => runCmdAsync(process.execPath, ["-e", ""], { cwd: fixture }));`,
    `assert.equal(result.status, 0);`,
    `assert.equal(result.ok, true);`,
    `await runtime.close();`,
    `const inventory = ProcessExecutionRuntime.inspect({ mainRoot: fixture });`,
    `assert.equal(inventory.slot, null);`,
    `const calls = inventory.executions.flatMap(execution => execution.calls);`,
    `assert.equal(calls.length, 1);`,
    `assert.ok(calls.every(call => call.receipt !== null));`,
    `outer.completeExecution();`,
    `outer.retainOnUnconfirmedExecution(new ProcessExecutionControlFailure("stop-unconfirmed", "Earlier cutoff remains a diagnostic failure"));`,
    `const removed = removeQuiescentRuntimeFixture({ mainRoot: fixture, cleanup: () => fs.rmSync(fixture, { recursive: true, force: true }) });`,
    `console.log("RETAINED_RUNTIME_PROBE=" + JSON.stringify({ outer: outer.path, fixture, removed, exactReceipts: calls.length }));`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: TEST_CHECKOUT_ROOT,
    env: environmentWithoutTemporaryRoot(),
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const match = /RETAINED_RUNTIME_PROBE=(\{[^\n]+\})/.exec(result.stdout);
  assert.ok(match, result.stdout + result.stderr);
  const probe = JSON.parse(match[1]);
  assert.equal(probe.exactReceipts, 1);
  // This probe created one child and confirmed its exact receipt before exiting.
  t.after(() => removeTmpDir(probe.outer));
  assert.equal(probe.removed, false);
  assert.equal(fs.existsSync(path.join(probe.outer, ".unconfirmed-execution")), true);
  assert.equal(fs.readFileSync(path.join(probe.fixture, "diagnostic-evidence.txt"), "utf8"),
    "preserve the first control failure");
});
