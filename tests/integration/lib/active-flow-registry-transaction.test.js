import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";

import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { ActiveFlowRegistry } from "../../../src/lib/active-flow-registry.js";
import { RepositoryMaintenanceLock } from "../../../src/lib/repository-maintenance-lock.js";

const REGISTRY_MODULE = pathToFileURL(path.resolve("src/lib/active-flow-registry.js")).href;

describe("active-flow registry transaction", () => {
  let root;
  afterEach(() => root && removeTmpDir(root));

  it("fails closed when the registry authority is malformed", () => {
    root = createTmpDir("active-flow-malformed-");
    const registryPath = path.join(root, ".sennel", ".active-flow");
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, "{malformed\n");
    const before = fs.readFileSync(registryPath);

    assert.throws(
      () => new ActiveFlowRegistry({ mainRoot: root }).load(),
      /active-flow|malformed|JSON|authority/i,
    );

    assert.deepEqual(fs.readFileSync(registryPath), before);
  });

  it("does not retry or rewrite malformed and unknown registry documents", () => {
    root = createTmpDir("active-flow-invalid-document-");
    const registryPath = path.join(root, ".sennel", ".active-flow");
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const originalLstat = fs.lstatSync;
    for (const bytes of [
      "{malformed\n",
      `${JSON.stringify([{ specId: "441-unknown", mode: "local", extra: true }])}\n`,
    ]) {
      fs.writeFileSync(registryPath, bytes);
      let reads = 0;
      fs.lstatSync = (target, ...args) => {
        if (path.resolve(String(target)) === registryPath) reads += 1;
        return originalLstat(target, ...args);
      };
      try {
        assert.throws(() => new ActiveFlowRegistry({ mainRoot: root }).load());
      } finally {
        fs.lstatSync = originalLstat;
      }
      assert.equal(reads, 1);
      assert.equal(fs.readFileSync(registryPath, "utf8"), bytes);
    }
  });

  it("allows concurrent readers to observe an atomic registry snapshot", () => {
    root = createTmpDir("active-flow-concurrent-readers-");
    const registry = new ActiveFlowRegistry({ mainRoot: root });
    registry.add("441-reader", "direct");
    const registryPath = path.join(root, ".sennel", ".active-flow");
    const expected = [{ specId: "441-reader", mode: "direct" }];
    const originalOpen = fs.openSync;
    let nested = null;
    let interleaved = false;
    fs.openSync = (target, ...args) => {
      if (!interleaved && path.resolve(String(target)) === registryPath) {
        interleaved = true;
        nested = new ActiveFlowRegistry({ mainRoot: root }).load();
      }
      return originalOpen(target, ...args);
    };
    try {
      assert.deepEqual(registry.load(), expected);
    } finally {
      fs.openSync = originalOpen;
    }
    assert.equal(interleaved, true);
    assert.deepEqual(nested, expected);
    assert.equal(fs.existsSync(ActiveFlowRegistry.lockPathFor(root)), false);
  });

  it("exposes only complete old or new documents to readers across writer rename", () => {
    root = createTmpDir("active-flow-reader-writer-");
    const registry = new ActiveFlowRegistry({ mainRoot: root });
    registry.add("441-old", "direct");
    const registryPath = path.join(root, ".sennel", ".active-flow");
    const oldDocument = [{ specId: "441-old", mode: "direct" }];
    const newDocument = [
      { specId: "441-old", mode: "direct" },
      { specId: "442-new", mode: "branch" },
    ];
    const observations = [];
    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (path.resolve(String(to)) !== registryPath) return originalRename(from, to);
      for (let index = 0; index < 8; index += 1) {
        observations.push(new ActiveFlowRegistry({ mainRoot: root }).load());
      }
      originalRename(from, to);
      for (let index = 0; index < 8; index += 1) {
        observations.push(new ActiveFlowRegistry({ mainRoot: root }).load());
      }
    };
    try {
      registry.add("442-new", "branch");
    } finally {
      fs.renameSync = originalRename;
    }

    assert.equal(observations.length, 16);
    assert.deepEqual(observations.slice(0, 8), Array(8).fill(oldDocument));
    assert.deepEqual(observations.slice(8), Array(8).fill(newDocument));
    assert.deepEqual(registry.load(), newDocument);
  });

  it("retries an atomic path replacement and returns the complete new document", () => {
    root = createTmpDir("active-flow-reader-replacement-");
    const registry = new ActiveFlowRegistry({ mainRoot: root });
    registry.add("441-old", "direct");
    const registryPath = path.join(root, ".sennel", ".active-flow");
    const replacementPath = path.join(root, ".sennel", ".active-flow.replacement");
    const expected = [{ specId: "442-new", mode: "branch" }];
    fs.writeFileSync(replacementPath, `${JSON.stringify(expected, null, 2)}\n`);
    const originalOpen = fs.openSync;
    let replaced = false;
    fs.openSync = (target, ...args) => {
      if (!replaced && path.resolve(String(target)) === registryPath) {
        replaced = true;
        fs.renameSync(replacementPath, registryPath);
      }
      return originalOpen(target, ...args);
    };
    try {
      assert.deepEqual(registry.load(), expected);
    } finally {
      fs.openSync = originalOpen;
    }
    assert.equal(replaced, true);
  });

  it("retries when the visible registry identity changes after descriptor read", () => {
    root = createTmpDir("active-flow-reader-post-replacement-");
    const registry = new ActiveFlowRegistry({ mainRoot: root });
    registry.add("441-old", "direct");
    const registryPath = path.join(root, ".sennel", ".active-flow");
    const replacementPath = path.join(root, ".sennel", ".active-flow.replacement");
    const expected = [{ specId: "442-new", mode: "branch" }];
    fs.writeFileSync(replacementPath, `${JSON.stringify(expected, null, 2)}\n`);
    const originalRead = fs.readFileSync;
    let replaced = false;
    fs.readFileSync = (target, ...args) => {
      const bytes = originalRead(target, ...args);
      if (!replaced && typeof target === "number") {
        replaced = true;
        fs.renameSync(replacementPath, registryPath);
      }
      return bytes;
    };
    try {
      assert.deepEqual(registry.load(), expected);
    } finally {
      fs.readFileSync = originalRead;
    }
    assert.equal(replaced, true);
  });

  it("fails busy without mutation after two consecutive identity races", () => {
    root = createTmpDir("active-flow-reader-unstable-");
    const registry = new ActiveFlowRegistry({ mainRoot: root });
    registry.add("441-stable", "direct");
    const registryPath = path.join(root, ".sennel", ".active-flow");
    const before = fs.readFileSync(registryPath);
    const originalLstat = fs.lstatSync;
    let targetStats = 0;
    fs.lstatSync = (target, ...args) => {
      const stat = originalLstat(target, ...args);
      if (path.resolve(String(target)) !== registryPath) return stat;
      targetStats += 1;
      if (targetStats % 2 === 1) return stat;
      return {
        ...stat,
        ino: stat.ino + 1,
        isFile: () => stat.isFile(),
        isSymbolicLink: () => stat.isSymbolicLink(),
      };
    };
    try {
      assert.throws(
        () => registry.load(),
        (error) => error.code === "ACTIVE_FLOW_REGISTRY_BUSY",
      );
    } finally {
      fs.lstatSync = originalLstat;
    }
    assert.equal(targetStats, 4);
    assert.deepEqual(fs.readFileSync(registryPath), before);
    assert.equal(fs.existsSync(ActiveFlowRegistry.lockPathFor(root)), false);
  });

  it("serializes finalize removal against a second flow add without losing non-target entries", () => {
    root = createTmpDir("active-flow-remove-add-race-");
    const registry = new ActiveFlowRegistry({ mainRoot: root });
    registry.add("441-target", "branch");
    registry.add("442-existing", "direct");
    const registryPath = path.join(root, ".sennel", ".active-flow");
    const second = new ActiveFlowRegistry({ mainRoot: root });
    const originalRename = fs.renameSync;
    let nestedError = null;
    let interleaved = false;
    fs.renameSync = (from, to) => {
      if (!interleaved && path.resolve(String(to)) === registryPath) {
        interleaved = true;
        try {
          second.add("443-second", "worktree");
        } catch (error) {
          nestedError = error;
        }
      }
      return originalRename(from, to);
    };
    try {
      registry.remove("441-target");
    } finally {
      fs.renameSync = originalRename;
    }

    assert.equal(nestedError?.code, "ACTIVE_FLOW_REGISTRY_BUSY");
    assert.equal(nestedError?.lockStatus, "live");
    assert.equal(nestedError?.lockPath, nestedError?.cause?.lockPath);
    assert.deepEqual(nestedError?.owner, nestedError?.cause?.owner);
    second.add("443-second", "worktree");
    assert.deepEqual(registry.load(), [
      { specId: "442-existing", mode: "direct" },
      { specId: "443-second", mode: "worktree" },
    ]);
  });

  it("fails closed for a corrupt registry lock without registry mutation", () => {
    root = createTmpDir("active-flow-corrupt-lock-");
    const registry = new ActiveFlowRegistry({ mainRoot: root });
    registry.add("441-existing", "direct");
    const registryPath = path.join(root, ".sennel", ".active-flow");
    const before = fs.readFileSync(registryPath);
    const lockPath = ActiveFlowRegistry.lockPathFor(root);
    fs.writeFileSync(lockPath, "{malformed\n");

    assert.throws(
      () => registry.add("442-blocked", "branch"),
      (error) => error.code === "ACTIVE_FLOW_REGISTRY_LOCK_CORRUPT",
    );

    assert.deepEqual(fs.readFileSync(registryPath), before);
    assert.equal(fs.readFileSync(lockPath, "utf8"), "{malformed\n");
  });

  it("blocks actual second-process add, remove, and cleanStale while maintenance is active", () => {
    root = createTmpDir("active-flow-maintenance-process-");
    const registry = new ActiveFlowRegistry({ mainRoot: root });
    registry.add("441-existing", "direct");
    const registryPath = path.join(root, ".sennel", ".active-flow");
    const before = fs.readFileSync(registryPath);
    const maintenance = new RepositoryMaintenanceLock({ mainRoot: root });
    maintenance.acquire();
    try {
      for (const operation of ["add", "remove", "cleanStale"]) {
        const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
          import { ActiveFlowRegistry } from ${JSON.stringify(REGISTRY_MODULE)};
          const registry = new ActiveFlowRegistry({ mainRoot: process.env.REGISTRY_ROOT });
          try {
            if (process.env.REGISTRY_OPERATION === "add") registry.add("442-second", "branch");
            if (process.env.REGISTRY_OPERATION === "remove") registry.remove("441-existing");
            if (process.env.REGISTRY_OPERATION === "cleanStale") registry.cleanStale();
          } catch (error) {
            process.stdout.write(error.code || error.message);
            process.exitCode = 23;
          }
        `], {
          encoding: "utf8",
          env: { ...process.env, REGISTRY_ROOT: root, REGISTRY_OPERATION: operation },
        });
        assert.equal(child.status, 23, `${operation}: ${child.stderr}`);
        assert.equal(child.stdout, "REPOSITORY_MAINTENANCE_BUSY", operation);
        assert.deepEqual(fs.readFileSync(registryPath), before, operation);
      }
    } finally {
      maintenance.release();
    }
  });

  it("rejects non-literal and path-bearing spec IDs at add and load boundaries", () => {
    root = createTmpDir("active-flow-spec-id-");
    const invalid = [
      ".", "..", "441/slash", "441\\backslash", "441*glob", "441?glob",
      "441[glob", "441:ref", "441~ref", "441^ref", "441@{ref", "-leading",
      "a..b", "trailing.", "writer.lock",
    ];
    for (const [index, spec] of invalid.entries()) {
      const addRoot = path.join(root, `add-${index}`);
      fs.mkdirSync(addRoot);
      assert.throws(
        () => new ActiveFlowRegistry({ mainRoot: addRoot }).add(spec, "direct"),
        /entry\.spec|spec ID|invalid/i,
        `add ${JSON.stringify(spec)}`,
      );
      assert.equal(fs.existsSync(path.join(addRoot, ".sennel", ".active-flow")), false);

      const loadRoot = path.join(root, `load-${index}`);
      const registryPath = path.join(loadRoot, ".sennel", ".active-flow");
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      const bytes = `${JSON.stringify([{ spec, mode: "direct" }])}\n`;
      fs.writeFileSync(registryPath, bytes);
      assert.throws(
        () => new ActiveFlowRegistry({ mainRoot: loadRoot }).load(),
        /entry\.spec|spec ID|invalid/i,
        `load ${JSON.stringify(spec)}`,
      );
      assert.equal(fs.readFileSync(registryPath, "utf8"), bytes);
    }
  });

  it("rejects a glob-like stored spec before probing or mutating unrelated branches", () => {
    root = createTmpDir("active-flow-spec-glob-branch-");
    const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(git("init", "-q").status, 0);
    assert.equal(git("config", "user.email", "test@example.com").status, 0);
    assert.equal(git("config", "user.name", "Test User").status, 0);
    fs.writeFileSync(path.join(root, "tracked"), "initial\n");
    assert.equal(git("add", "tracked").status, 0);
    assert.equal(git("commit", "-qm", "initial").status, 0);
    assert.equal(git("branch", "feature-unrelated").status, 0);
    const registryPath = path.join(root, ".sennel", ".active-flow");
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const bytes = `${JSON.stringify([{ specId: "feature-*", mode: "branch" }])}\n`;
    fs.writeFileSync(registryPath, bytes);
    const branchesBefore = git("for-each-ref", "--format=%(refname):%(objectname)", "refs/heads").stdout;

    assert.throws(() => new ActiveFlowRegistry({ mainRoot: root }).cleanStale(), /spec ID|invalid/i);

    assert.equal(fs.readFileSync(registryPath, "utf8"), bytes);
    assert.equal(git("for-each-ref", "--format=%(refname):%(objectname)", "refs/heads").stdout, branchesBefore);
  });

  it("is idempotent only when an existing spec has the same mode", () => {
    root = createTmpDir("active-flow-mode-conflict-");
    const registry = new ActiveFlowRegistry({ mainRoot: root });
    registry.add("441-mode", "direct");
    const registryPath = path.join(root, ".sennel", ".active-flow");
    const before = fs.readFileSync(registryPath);

    registry.add("441-mode", "direct");
    assert.deepEqual(fs.readFileSync(registryPath), before);
    assert.throws(
      () => registry.add("441-mode", "branch"),
      (error) => error.code === "ACTIVE_FLOW_REGISTRY_MODE_CONFLICT",
    );
    assert.deepEqual(fs.readFileSync(registryPath), before);
  });

  it("fails closed on direct Flow lstat errors and non-real Version authorities", () => {
    root = createTmpDir("active-flow-direct-authority-");
    const specId = "441-direct";
    const registry = new ActiveFlowRegistry({ mainRoot: root });
    registry.add(specId, "direct");
    const registryPath = path.join(root, ".sennel", ".active-flow");
    const before = fs.readFileSync(registryPath);
    const flowPath = path.join(root, "specs", specId, "001", "flow.json");
    fs.mkdirSync(path.dirname(flowPath), { recursive: true });
    const originalLstat = fs.lstatSync;
    for (const code of ["EACCES", "EIO"]) {
      fs.lstatSync = (target, ...args) => {
        if (path.resolve(String(target)) === flowPath) {
          throw Object.assign(new Error(`direct authority ${code}`), { code });
        }
        return originalLstat(target, ...args);
      };
      try {
        assert.throws(() => registry.cleanStale(), (error) => error.code === code, code);
      } finally {
        fs.lstatSync = originalLstat;
      }
      assert.deepEqual(fs.readFileSync(registryPath), before, code);
    }

    const external = path.join(root, "external-flow.json");
    fs.writeFileSync(external, "{}\n");
    fs.symlinkSync(external, flowPath);
    assert.throws(() => registry.cleanStale(), /real non-hardlinked|authority/i);
    assert.deepEqual(fs.readFileSync(registryPath), before);
  });

  it("fails closed when worktree or branch Git probes fail", () => {
    root = createTmpDir("active-flow-git-probe-");
    const registryPath = path.join(root, ".sennel", ".active-flow");
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    for (const mode of ["worktree", "branch"]) {
      const specId = `441-${mode}`;
      const statePath = path.join(root, "specs", specId, "001", "flow.json");
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, "{}\n");
      const bytes = `${JSON.stringify([{ specId, mode }], null, 2)}\n`;
      fs.writeFileSync(registryPath, bytes);
      assert.throws(
        () => new ActiveFlowRegistry({ mainRoot: root }).cleanStale(),
        (error) => error.code === "ACTIVE_FLOW_REGISTRY_GIT_PROBE_FAILED",
        mode,
      );
      assert.equal(fs.readFileSync(registryPath, "utf8"), bytes, mode);
    }
  });
});
