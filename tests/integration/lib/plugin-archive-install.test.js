import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { TemporaryPaths } from "../../../src/lib/temporary-paths.js";

import { GitCommandExecution } from "../../../src/lib/git-command-execution.js";
import {
  installPlugin,
  syncInstalledPlugins,
  updateInstalledPlugin,
} from "../../../src/lib/plugin-registry.js";
import { FilePermissionHint } from "../../../src/lib/regular-file-snapshot.js";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";

const pluginId = "archive-plugin";
const sourceId = "archive-source";
const longPath = `lib/資料/${"long-name-".repeat(13)}.bin`;
const binary = Buffer.from([0, 255, 128, 13, 10, 0, 1]);

function git(repository, args, options = {}) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options }).trim();
}

function fixture(t, { gitSource = true, remote = false } = {}) {
  const root = createTmpDir("plugin-archive-install-");
  t.after(() => removeTmpDir(root));
  const source = path.join(root, "source");
  writeJson(source, "plugin.json", {
    name: pluginId,
    type: "mixed",
    files: ["plugin.json", "commands/", "lib/"],
    contributions: { commands: [{ name: "archive-probe", path: "commands/probe.js" }] },
  });
  writeFile(source, "commands/probe.js", `#!${process.execPath}\nprocess.stdout.write("archive executable\\n");\n`);
  writeFile(source, longPath, binary);
  writeFile(source, "lib/version.txt", "first commit\n");
  writeFile(source, "lib/ignored.txt", "export ignored\n");
  writeFile(source, "lib/substituted.txt", "$Format:%H$\n");
  writeFile(source, ".gitattributes", "lib/ignored.txt export-ignore\nlib/substituted.txt export-subst\n");
  let commit = null;
  if (gitSource) {
    initGitRepo(source);
    git(source, ["config", "core.autocrlf", "false"]);
    git(source, ["config", "core.filemode", "false"]);
    git(source, ["config", "tar.umask", "0022"]);
    git(source, ["add", "-A"]);
    git(source, ["update-index", "--chmod=+x", "commands/probe.js"]);
    commitAll(source, "Initial archive package");
    commit = git(source, ["rev-parse", "HEAD"]);
  }
  const sourceEntry = remote
    ? { id: sourceId, type: "git", url: pathToFileURL(source).href, ref: commit }
    : { id: sourceId, type: "local", path: "source" };
  writeJson(root, ".sennel/config.json", { plugin: { sources: [sourceEntry], packages: [] } });
  writeJson(root, ".sennel/config.local.json", { plugin: { config: { privateMarker: "retained" } } });
  return {
    root, source, commit,
    destination: path.join(root, ".sennel/plugins", pluginId),
    configPath: path.join(root, ".sennel/config.json"),
    localConfigPath: path.join(root, ".sennel/config.local.json"),
  };
}

function config(fixture) { return JSON.parse(fs.readFileSync(fixture.configPath, "utf8")); }
function nextCommit(fixture, version) {
  writeFile(fixture.source, "lib/version.txt", `${version}\n`);
  commitAll(fixture.source, "Update archive package");
  return git(fixture.source, ["rev-parse", "HEAD"]);
}
function snapshotTree(root, relative = "") {
  return fs.readdirSync(path.join(root, relative)).sort().flatMap((name) => {
    const child = relative ? `${relative}/${name}` : name;
    return fs.lstatSync(path.join(root, child)).isDirectory()
      ? [[`${child}/`, null], ...snapshotTree(root, child)]
      : [[child, fs.readFileSync(path.join(root, child))]];
  });
}
function snapshot(fixture) {
  return {
    config: fs.readFileSync(fixture.configPath),
    localConfig: fs.readFileSync(fixture.localConfigPath),
    installed: snapshotTree(fixture.destination),
  };
}
function assertUnchanged(fixture, before) {
  assert.deepEqual(snapshot(fixture), before);
  assert.deepEqual(fs.readdirSync(path.dirname(fixture.destination)), [pluginId]);
}

function withReplacedWriteParent(relativeFile, retained, operation) {
  let replaced = null;
  const write = AtomicFile.prototype.write;
  AtomicFile.prototype.write = function (...args) {
    const result = write.apply(this, args);
    if (replaced === null && this.filePath.endsWith(relativeFile)) {
      replaced = path.dirname(this.filePath);
      fs.renameSync(replaced, retained);
      fs.mkdirSync(replaced);
      fs.writeFileSync(path.join(replaced, "foreign-marker.txt"), "replacement must survive\n");
    }
    return result;
  };
  try { operation(); }
  finally { AtomicFile.prototype.write = write; }
  assert.ok(replaced, "the producer reached the replacement boundary");
  return replaced;
}

test("local Git install, pinned sync and update publish archive bytes with export attributes and native permissions", (t) => {
  const f = fixture(t);
  const localBefore = fs.readFileSync(f.localConfigPath);
  assert.deepEqual(installPlugin(f.root, pluginId), { id: pluginId, source: sourceId, commit: f.commit });
  assert.deepEqual(fs.readFileSync(path.join(f.destination, longPath)), binary);
  assert.equal(fs.existsSync(path.join(f.destination, "lib/ignored.txt")), false);
  assert.equal(fs.readFileSync(path.join(f.destination, "lib/substituted.txt"), "utf8"), `${f.commit}\n`);
  assert.equal(new FilePermissionHint(0o755).matches(FilePermissionHint.fromStat(fs.statSync(path.join(f.destination, "commands/probe.js")))), true);
  assert.equal(new FilePermissionHint(0o644).matches(FilePermissionHint.fromStat(fs.statSync(path.join(f.destination, longPath)))), true);
  const executable = path.join(f.destination, "commands/probe.js");
  const executed = process.platform === "win32"
    ? spawnSync(process.execPath, [executable], { encoding: "utf8" })
    : spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(executed.error, undefined, executed.error?.stack);
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(executed.stdout, "archive executable\n");

  const next = nextCommit(f, "second commit");
  assert.deepEqual(syncInstalledPlugins(f.root), [{ id: pluginId, source: sourceId, commit: f.commit }]);
  assert.equal(fs.readFileSync(path.join(f.destination, "lib/version.txt"), "utf8"), "first commit\n");
  assert.equal(fs.readFileSync(path.join(f.destination, "lib/substituted.txt"), "utf8"), `${f.commit}\n`);
  assert.equal(config(f).plugin.packages[0].commit, f.commit);

  assert.deepEqual(updateInstalledPlugin(f.root, pluginId), {
    id: pluginId, source: sourceId, commit: next, previousCommit: f.commit, updated: true,
  });
  assert.equal(fs.readFileSync(path.join(f.destination, "lib/version.txt"), "utf8"), "second commit\n");
  assert.equal(fs.readFileSync(path.join(f.destination, "lib/substituted.txt"), "utf8"), `${next}\n`);
  assert.equal(config(f).plugin.packages[0].commit, next);
  assert.deepEqual(fs.readFileSync(f.localConfigPath), localBefore);
  assert.equal(git(f.source, ["status", "--porcelain"]), "", "read-only source probes must not dirty a clean repository");
  assert.equal(fs.existsSync(path.join(f.source, ".tmp")), false);
  assert.equal(fs.existsSync(path.join(f.source, ".sennel")), false);
});

test("file URL remote install publishes its selected commit when remote HEAD has advanced", (t) => {
  const f = fixture(t, { remote: true });
  const next = nextCommit(f, "remote HEAD advanced");
  assert.notEqual(next, f.commit);
  assert.equal(installPlugin(f.root, pluginId).commit, f.commit);
  assert.equal(git(path.join(f.root, ".sennel/plugin-sources", sourceId), ["config", "--get", "core.longpaths"]), "true");
  assert.equal(fs.readFileSync(path.join(f.destination, "lib/version.txt"), "utf8"), "first commit\n");
  assert.equal(fs.readFileSync(path.join(f.destination, "lib/substituted.txt"), "utf8"), `${f.commit}\n`);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, longPath)), binary);
  assert.equal(config(f).plugin.packages[0].commit, f.commit);
});

test("remote cleanup with an unknown result stops without cloning or resolving its ref again", (t) => {
  const f = fixture(t, { remote: true });
  const value = config(f);
  value.plugin.sources[0].ref = "main";
  writeJson(f.root, ".sennel/config.json", value);
  const publicBefore = fs.readFileSync(f.configPath);
  const localBefore = fs.readFileSync(f.localConfigPath);
  const primary = new Error("remote cleanup result unavailable");
  const calls = [];
  const run = GitCommandExecution.prototype.run;
  let faultIndex = null;
  GitCommandExecution.prototype.run = function () {
    const args = [...this.invocation.args];
    calls.push(args);
    const result = run.call(this);
    if (args[0] === "clean" && faultIndex === null) {
      assert.equal(result.ok, true, result.stderr);
      faultIndex = calls.length - 1;
      // The external operation ran, but its successful result was not delivered.
      // The registry must not replace the cache or resolve a mutable ref again.
      throw primary;
    }
    return result;
  };
  try {
    assert.throws(() => installPlugin(f.root, pluginId), (error) => error === primary);
  } finally { GitCommandExecution.prototype.run = run; }
  assert.notEqual(faultIndex, null);
  assert.deepEqual(calls.slice(faultIndex + 1), []);
  assert.equal(calls.filter((args) => args[0] === "clone").length, 1);
  assert.equal(calls.filter((args) => args[0] === "rev-parse" && args.includes("--verify")).length, 1);
  assert.deepEqual(fs.readFileSync(f.configPath), publicBefore);
  assert.deepEqual(fs.readFileSync(f.localConfigPath), localBefore);
  assert.equal(fs.existsSync(f.destination), false);
});

test("non-Git local install preserves materialized input without applying archive attributes", (t) => {
  const f = fixture(t, { gitSource: false });
  let materializationCleanups = 0;
  const result = installPlugin(f.root, pluginId, {
    faultInjector(event) { if (event.phase === "materialization-cleanup") materializationCleanups += 1; },
  });
  assert.equal(result.id, pluginId);
  assert.match(result.commit, /^[a-f0-9]{40}$/);
  assert.equal(config(f).plugin.packages[0].commit, result.commit);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, longPath)), binary);
  assert.equal(fs.readFileSync(path.join(f.destination, "lib/substituted.txt"), "utf8"), "$Format:%H$\n");
  assert.equal(fs.readFileSync(path.join(f.destination, "lib/ignored.txt"), "utf8"), "export ignored\n");
  assert.equal(materializationCleanups, 0);
});

test("pinned sync rejects a nonportable Git entry outside package allowlists before publication", (t) => {
  const f = fixture(t);
  installPlugin(f.root, pluginId);
  const blob = git(f.source, ["rev-parse", "HEAD:lib/version.txt"]);
  // Git objects can name Windows-reserved files without asking the host to
  // create them. Keep the checked-out source clean and pin the alternate commit.
  const entries = git(f.source, ["ls-tree", "HEAD"]);
  const tree = git(f.source, ["mktree"], { input: `${entries}\n100644 blob ${blob}\tCON\n` });
  const nonportable = git(f.source, ["commit-tree", tree, "-p", f.commit, "-m", "Nonportable archive entry"]);
  const value = config(f);
  value.plugin.packages[0].commit = nonportable;
  writeJson(f.root, ".sennel/config.json", value);
  const before = snapshot(f);
  assert.throws(() => syncInstalledPlugins(f.root), { code: "PORTABLE_PATH_INVALID" });
  assertUnchanged(f, before);
  assert.equal(fs.existsSync(path.join(f.destination, "CON")), false);
  assert.equal(git(f.source, ["status", "--porcelain"]), "");
  assert.deepEqual(fs.readdirSync(TemporaryPaths.runtimePath(f.root, "plugin-materialization")), []);
});

test("materialization cleanup preserves a replaced descendant after extraction loses authority", (t) => {
  const f = fixture(t);
  installPlugin(f.root, pluginId);
  const next = nextCommit(f, "unpublished replacement");
  const before = snapshot(f);
  const retained = path.join(f.root, "retained-materialized-lib");
  const replaced = withReplacedWriteParent(path.join("lib", "substituted.txt"), retained, () => {
    assert.throws(() => installPlugin(f.root, pluginId), (error) => {
      assert.equal(RealDirectoryAuthority.isAuthorityFailure(error), true);
      return true;
    });
  });
  assert.equal(fs.readFileSync(path.join(replaced, "foreign-marker.txt"), "utf8"), "replacement must survive\n");
  assert.equal(fs.readFileSync(path.join(retained, "substituted.txt"), "utf8"), `${next}\n`);
  assertUnchanged(f, before);
});

test("installer cleanup preserves a replaced descendant after the production copy loses authority", (t) => {
  const f = fixture(t, { gitSource: false });
  installPlugin(f.root, pluginId);
  writeFile(f.source, "lib/version.txt", "unpublished copy\n");
  const before = snapshot(f);
  const retained = path.join(f.root, "retained-copy-lib");
  const replaced = withReplacedWriteParent(path.join("lib", "substituted.txt"), retained, () => {
    assert.throws(() => installPlugin(f.root, pluginId), (error) => {
      assert.equal(RealDirectoryAuthority.isAuthorityFailure(error), true);
      return true;
    });
  });
  assert.equal(fs.readFileSync(path.join(replaced, "foreign-marker.txt"), "utf8"), "replacement must survive\n");
  assert.equal(fs.readFileSync(path.join(retained, "substituted.txt"), "utf8"), "$Format:%H$\n");
  assert.deepEqual(snapshot(f), before);
});

test("materialization cleanup failure retains input and restores the installed package and config", (t) => {
  const f = fixture(t);
  installPlugin(f.root, pluginId);
  nextCommit(f, "unpublished commit");
  const before = snapshot(f);
  const cleanup = new Error("materialization cleanup denied");
  let retained = null;
  let packageRoot = null;
  let cleanupAttempts = 0;
  assert.throws(() => installPlugin(f.root, pluginId, {
    faultInjector(event) {
      if (event.phase === "materialization-cleanup") {
        retained = event.directory;
        packageRoot = event.packageRoot;
        cleanupAttempts += 1;
        throw cleanup;
      }
    },
  }), (error) => error === cleanup);
  assert.equal(cleanupAttempts, 1);
  assertUnchanged(f, before);
  assert.ok(retained);
  assert.ok(packageRoot);
  assert.equal(fs.readFileSync(path.join(packageRoot, "lib/version.txt"), "utf8"), "unpublished commit\n");
  assert.ok(fs.statSync(path.join(retained, "package.tar")).size > 0);
});

test("manifest failure and materialization cleanup failure retain both causes and the original installation", (t) => {
  const f = fixture(t);
  installPlugin(f.root, pluginId);
  writeFile(f.source, ".gitattributes", "plugin.json export-ignore\n");
  commitAll(f.source, "Archive without a manifest");
  const before = snapshot(f);
  const cleanup = new Error("failed manifest materialization cleanup denied");
  let retained = null;
  let packageRoot = null;
  let cleanupAttempts = 0;
  assert.throws(() => installPlugin(f.root, pluginId, {
    faultInjector(event) {
      if (event.phase === "materialization-cleanup") {
        retained = event.directory;
        packageRoot = event.packageRoot;
        cleanupAttempts += 1;
        throw cleanup;
      }
    },
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause?.code, "ENOENT");
    assert.match(error.cause.path, /plugin\.json$/);
    assert.equal(error.errors[0], error.cause);
    assert.equal(error.errors[1], cleanup);
    return true;
  });
  assert.equal(cleanupAttempts, 1);
  assertUnchanged(f, before);
  assert.ok(retained);
  assert.ok(packageRoot);
  assert.equal(fs.existsSync(path.join(packageRoot, "plugin.json")), false);
  assert.equal(fs.readFileSync(path.join(packageRoot, "lib/version.txt"), "utf8"), "first commit\n");
  assert.ok(fs.statSync(path.join(retained, "package.tar")).size > 0);
});
