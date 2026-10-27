import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { PluginConfigTransaction, PluginInstallation, PluginInstaller } from "../../../src/lib/plugin-installer.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../../support/builders/tmp-dir.js";

function containsError(error, expected) {
  if (error == null) return false;
  return error === expected || containsError(error.cause, expected)
    || (error instanceof AggregateError && error.errors.some((child) => containsError(child, expected)));
}

describe("plugin installer recovery boundaries", () => {
  let root;
  afterEach(() => root && removeTmpDir(root));

  function fixture(overrides = {}) {
    root = createTmpDir("plugin-installer-recovery-");
    writeJson(root, ".sennel/config.json", { version: "old", plugin: { sources: [], packages: [] } });
    writeFile(root, ".sennel/plugins/sample/version.txt", "old package\n");
    writeFile(root, ".sennel/plugins/sample/recovery.txt", "original recovery bytes\n");
    const configPath = path.join(root, ".sennel/config.json");
    const pluginsRoot = path.join(root, ".sennel/plugins");
    const destination = path.join(pluginsRoot, "sample");
    const configBefore = fs.readFileSync(configPath);
    const installation = new PluginInstallation({
      root,
      pluginId: "sample",
      stagePackage(staging) { writeFile(staging, "version.txt", "new package\n"); },
      validateStaging(staging) { assert.equal(fs.readFileSync(path.join(staging, "version.txt"), "utf8"), "new package\n"); },
      readInstalled(installed) { return fs.readFileSync(path.join(installed, "version.txt"), "utf8"); },
      configTransaction: new PluginConfigTransaction([{ filePath: configPath, value: { version: "new" } }]),
      ...overrides,
    });
    return { installation, configPath, configBefore, pluginsRoot, destination };
  }

  it("returns the installed readback once and removes its backup", () => {
    let readbacks = 0;
    const state = fixture({
      readInstalled(destination) {
        readbacks += 1;
        assert.deepEqual(JSON.parse(fs.readFileSync(state.configPath, "utf8")), { version: "new" });
        return fs.readFileSync(path.join(destination, "version.txt"), "utf8");
      },
    });
    assert.equal(new PluginInstaller().install(state.installation), "new package\n");
    assert.equal(readbacks, 1);
    assert.deepEqual(fs.readdirSync(state.pluginsRoot), ["sample"]);
  });

  it("restores package and config when installed readback fails", () => {
    const primary = new Error("installed readback failed");
    const state = fixture({ readInstalled() { throw primary; } });
    assert.throws(() => new PluginInstaller().install(state.installation), (error) => error === primary);
    assert.deepEqual(fs.readFileSync(state.configPath), state.configBefore);
    assert.equal(fs.readFileSync(path.join(state.destination, "version.txt"), "utf8"), "old package\n");
    assert.deepEqual(fs.readdirSync(state.pluginsRoot), ["sample"]);
  });

  it("preserves the primary failure when staging cleanup also fails", () => {
    const primary = new Error("partial package copy failed");
    const cleanup = Object.assign(new Error("staging removal denied"), { code: "EACCES" });
    const state = fixture({
      stagePackage(staging) {
        writeFile(staging, "version.txt", "partial copy\n");
        throw primary;
      },
    });
    const remove = fs.rmSync;
    fs.rmSync = (target, ...args) => {
      if (String(target).startsWith(path.join(state.pluginsRoot, ".sample.staging-"))) throw cleanup;
      return remove(target, ...args);
    };
    try {
      assert.throws(() => new PluginInstaller().install(state.installation), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, primary);
        assert.ok(containsError(error, cleanup));
        return true;
      });
    } finally { fs.rmSync = remove; }
    assert.deepEqual(fs.readFileSync(state.configPath), state.configBefore);
    assert.equal(fs.readFileSync(path.join(state.destination, "version.txt"), "utf8"), "old package\n");
    const staging = fs.readdirSync(state.pluginsRoot).find((name) => name.startsWith(".sample.staging-"));
    assert.equal(fs.readFileSync(path.join(state.pluginsRoot, staging, "version.txt"), "utf8"), "partial copy\n");
  });

  it("cleans an owned partial stage after an ordinary copy failure", () => {
    const primary = new Error("ordinary partial package copy failed");
    const state = fixture({
      stagePackage(staging) {
        writeFile(staging, "nested/partial.txt", "partial copy\n");
        throw primary;
      },
    });
    const packageBefore = fs.readdirSync(state.destination).map((name) => [name, fs.readFileSync(path.join(state.destination, name))]);
    assert.throws(() => new PluginInstaller().install(state.installation), (error) => error === primary);
    assert.deepEqual(fs.readFileSync(state.configPath), state.configBefore);
    assert.deepEqual(fs.readdirSync(state.destination).map((name) => [name, fs.readFileSync(path.join(state.destination, name))]), packageBefore);
    assert.deepEqual(fs.readdirSync(state.pluginsRoot), ["sample"]);
  });

  for (const boundary of ["stage root", "nested child"]) {
    it(`preserves the ${boundary} replacement after a ${boundary === "stage root" ? "direct" : "wrapped"} staging authority refusal`, () => {
      let replaced;
      let moved;
      let primary;
      const state = fixture({
        stagePackage(staging) {
          replaced = boundary === "stage root" ? staging : path.join(staging, "nested");
          moved = path.join(state.pluginsRoot, "retained-original-stage");
          writeFile(replaced, "owned.txt", "original stage bytes\n");
          const authority = RealDirectoryAuthority.resolve(replaced);
          fs.renameSync(replaced, moved);
          writeFile(replaced, "replacement.txt", "another owner's stage bytes\n");
          let refusal;
          assert.throws(() => authority.assertStable(), (error) => {
            refusal = error;
            return error.code === "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID";
          });
          primary = boundary === "stage root" ? refusal : new AggregateError([
            new Error("another copy failure"), new Error("copy lost its directory", { cause: refusal }),
          ], "copy failed with multiple causes");
          throw primary;
        },
      });
      const packageBefore = fs.readdirSync(state.destination).map((name) => [name, fs.readFileSync(path.join(state.destination, name))]);
      assert.throws(() => new PluginInstaller().install(state.installation), (error) => {
        assert.ok(containsError(error, primary));
        assert.equal(RealDirectoryAuthority.isAuthorityFailure(error), true);
        return true;
      });
      assert.deepEqual(fs.readFileSync(state.configPath), state.configBefore);
      assert.deepEqual(fs.readdirSync(state.destination).map((name) => [name, fs.readFileSync(path.join(state.destination, name))]), packageBefore);
      assert.equal(fs.readFileSync(path.join(moved, "owned.txt"), "utf8"), "original stage bytes\n");
      assert.equal(fs.existsSync(replaced), true, "known authority refusal must prevent deletion of the replacement");
      assert.equal(fs.readFileSync(path.join(replaced, "replacement.txt"), "utf8"), "another owner's stage bytes\n");
    });
  }

  it("rolls back a cleanup refusal before backup deletion starts", () => {
    const cleanup = new Error("backup cleanup refused");
    const state = fixture({
      faultInjector(event) {
        if (event.phase === "cleanup" && event.operation === "backup") throw cleanup;
      },
    });
    assert.throws(() => new PluginInstaller().install(state.installation), (error) => error === cleanup);
    assert.deepEqual(fs.readFileSync(state.configPath), state.configBefore);
    assert.equal(fs.readFileSync(path.join(state.destination, "version.txt"), "utf8"), "old package\n");
    assert.deepEqual(fs.readdirSync(state.pluginsRoot), ["sample"]);
  });

  it("retains the installed package and surviving backup after partial backup deletion", () => {
    const cleanup = Object.assign(new Error("backup deletion interrupted"), { code: "EACCES" });
    const state = fixture();
    const remove = fs.rmSync;
    fs.rmSync = (target, ...args) => {
      if (String(target).startsWith(path.join(state.pluginsRoot, ".sample.backup-"))) {
        fs.unlinkSync(path.join(target, "version.txt"));
        throw cleanup;
      }
      return remove(target, ...args);
    };
    try {
      assert.throws(() => new PluginInstaller().install(state.installation), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.ok(containsError(error, cleanup));
        assert.match(error.message, /rollback was incomplete/);
        return true;
      });
    } finally { fs.rmSync = remove; }
    assert.deepEqual(fs.readFileSync(state.configPath), state.configBefore);
    assert.equal(fs.readFileSync(path.join(state.destination, "version.txt"), "utf8"), "new package\n");
    const backup = fs.readdirSync(state.pluginsRoot).find((name) => name.startsWith(".sample.backup-"));
    assert.ok(backup, "the available original backup remains available for recovery");
    assert.equal(fs.readFileSync(path.join(state.pluginsRoot, backup, "recovery.txt"), "utf8"), "original recovery bytes\n");
  });

  it("retains the original backup and causes when removing the failed installation is denied", () => {
    const primary = new Error("installed readback failed");
    const cleanup = Object.assign(new Error("installed removal denied"), { code: "EPERM" });
    const state = fixture({ readInstalled() { throw primary; } });
    const remove = fs.rmSync;
    fs.rmSync = (target, ...args) => {
      if (target === state.destination) throw cleanup;
      return remove(target, ...args);
    };
    try {
      assert.throws(() => new PluginInstaller().install(state.installation), (error) => {
        assert.equal(error.cause, primary);
        assert.ok(containsError(error, cleanup));
        return true;
      });
    } finally { fs.rmSync = remove; }
    assert.deepEqual(fs.readFileSync(state.configPath), state.configBefore);
    assert.equal(fs.readFileSync(path.join(state.destination, "version.txt"), "utf8"), "new package\n");
    const backup = fs.readdirSync(state.pluginsRoot).find((name) => name.startsWith(".sample.backup-"));
    assert.equal(fs.readFileSync(path.join(state.pluginsRoot, backup, "version.txt"), "utf8"), "old package\n");
  });

  it("retains the original backup when its rollback rename is denied", () => {
    const primary = new Error("installed readback failed");
    const restore = Object.assign(new Error("backup restore denied"), { code: "EACCES" });
    const state = fixture({ readInstalled() { throw primary; } });
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (String(source).startsWith(path.join(state.pluginsRoot, ".sample.backup-"))) throw restore;
      return rename(source, target);
    };
    try {
      assert.throws(() => new PluginInstaller().install(state.installation), (error) => {
        assert.equal(error.cause, primary);
        assert.ok(containsError(error, restore));
        return true;
      });
    } finally { fs.renameSync = rename; }
    assert.deepEqual(fs.readFileSync(state.configPath), state.configBefore);
    assert.equal(fs.existsSync(state.destination), false);
    const backup = fs.readdirSync(state.pluginsRoot).find((name) => name.startsWith(".sample.backup-"));
    assert.equal(fs.readFileSync(path.join(state.pluginsRoot, backup, "version.txt"), "utf8"), "old package\n");
  });

  it("preserves a replacement destination and original backup when rollback loses package authority", () => {
    const primary = new Error("installed readback found a replacement");
    const state = fixture({
      readInstalled(destination) {
        fs.renameSync(destination, path.join(state.pluginsRoot, "retained-installation"));
        writeFile(destination, "replacement.txt", "another owner's package\n");
        throw primary;
      },
    });
    assert.throws(() => new PluginInstaller().install(state.installation), (error) => {
      assert.equal(error.cause, primary);
      assert.ok(error.errors.some((child) => child.cause?.code === "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID"));
      return true;
    });
    assert.deepEqual(fs.readFileSync(state.configPath), state.configBefore);
    assert.equal(fs.readFileSync(path.join(state.destination, "replacement.txt"), "utf8"), "another owner's package\n");
    assert.equal(fs.readFileSync(path.join(state.pluginsRoot, "retained-installation/version.txt"), "utf8"), "new package\n");
    const backup = fs.readdirSync(state.pluginsRoot).find((name) => name.startsWith(".sample.backup-"));
    assert.equal(fs.readFileSync(path.join(state.pluginsRoot, backup, "version.txt"), "utf8"), "old package\n");
  });

  for (const boundary of ["installed readback", "backup cleanup"]) {
    it(`refuses success and preserves both trees when ${boundary} replaces the installed directory`, () => {
      const replaceInstalled = () => {
        fs.renameSync(state.destination, path.join(state.pluginsRoot, "retained-installation"));
        writeFile(state.destination, "version.txt", "replacement package\n");
      };
      const state = fixture({
        readInstalled(destination) {
          if (boundary === "installed readback") replaceInstalled();
          return fs.readFileSync(path.join(destination, "version.txt"), "utf8");
        },
        faultInjector(event) {
          if (boundary === "backup cleanup" && event.phase === "cleanup" && event.operation === "backup") replaceInstalled();
        },
      });
      assert.throws(() => new PluginInstaller().install(state.installation), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause.code, "REAL_DIRECTORY_AUTHORITY_AUTHORITY_INVALID");
        return true;
      });
      assert.deepEqual(fs.readFileSync(state.configPath), state.configBefore);
      assert.equal(fs.readFileSync(path.join(state.destination, "version.txt"), "utf8"), "replacement package\n");
      assert.equal(fs.readFileSync(path.join(state.pluginsRoot, "retained-installation/version.txt"), "utf8"), "new package\n");
      const backup = fs.readdirSync(state.pluginsRoot).find((name) => name.startsWith(".sample.backup-"));
      assert.ok(backup);
      assert.equal(fs.readFileSync(path.join(state.pluginsRoot, backup, "version.txt"), "utf8"), "old package\n");
    });
  }

  it("retains available trees when swap succeeds but its identity readback fails", () => {
    const readback = Object.assign(new Error("swap identity readback denied"), { code: "EACCES" });
    const state = fixture();
    const rename = fs.renameSync;
    const lstat = fs.lstatSync;
    let swapped = false;
    fs.renameSync = (source, target) => {
      const result = rename(source, target);
      if (String(source).startsWith(path.join(state.pluginsRoot, ".sample.staging-"))) swapped = true;
      return result;
    };
    fs.lstatSync = (target, ...args) => {
      if (swapped && target === state.destination) {
        swapped = false;
        throw readback;
      }
      return lstat(target, ...args);
    };
    try {
      assert.throws(() => new PluginInstaller().install(state.installation), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause?.committedToVisibleName, true);
        assert.ok(containsError(error, readback));
        return true;
      });
    } finally { fs.renameSync = rename; fs.lstatSync = lstat; }
    assert.deepEqual(fs.readFileSync(state.configPath), state.configBefore);
    assert.equal(fs.readFileSync(path.join(state.destination, "version.txt"), "utf8"), "new package\n");
    const backup = fs.readdirSync(state.pluginsRoot).find((name) => name.startsWith(".sample.backup-"));
    assert.equal(fs.readFileSync(path.join(state.pluginsRoot, backup, "version.txt"), "utf8"), "old package\n");
  });

  it("preserves concurrently edited config and reports the rollback conflict", () => {
    const primary = new Error("installed readback failed");
    const editedBytes = Buffer.from('{"version":"concurrent edit"}\n');
    const state = fixture({
      readInstalled() {
        fs.writeFileSync(state.configPath, editedBytes);
        throw primary;
      },
    });
    assert.throws(() => new PluginInstaller().install(state.installation), (error) => {
      assert.equal(error.cause, primary);
      assert.ok(error.errors.some((child) => child.cause?.code === "PLUGIN_CONFIG_REVISION_CONFLICT"));
      return true;
    });
    assert.deepEqual(fs.readFileSync(state.configPath), editedBytes);
    assert.equal(fs.readFileSync(path.join(state.destination, "version.txt"), "utf8"), "old package\n");
    assert.deepEqual(fs.readdirSync(state.pluginsRoot), ["sample"]);
  });
});
