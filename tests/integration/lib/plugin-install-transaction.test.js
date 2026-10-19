import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  ensureOfficialPackage,
  installPlugin,
  planInstalledPluginUpdates,
  syncInstalledPlugins,
  updateInstalledPlugin,
} from "../../../src/lib/plugin-registry.js";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../../support/builders/tmp-dir.js";

function snapshotTree(root, rel = "") {
  const entries = [];
  for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
    const childRel = rel ? path.join(rel, name) : name;
    const stat = fs.lstatSync(path.join(root, childRel));
    if (stat.isDirectory()) {
      entries.push([`${childRel}/`, null]);
      entries.push(...snapshotTree(root, childRel));
    } else {
      entries.push([childRel, fs.readFileSync(path.join(root, childRel))]);
    }
  }
  return entries;
}

function setupProject(root, { pluginId = "sample-plugin", sourceId = "sample-source" } = {}) {
  const sourceRoot = path.join(root, "plugin-source");
  writeJson(sourceRoot, "plugin.json", {
    name: pluginId,
    type: "mixed",
    files: ["plugin.json", "lib/"],
    contributions: {},
  });
  writeFile(sourceRoot, "lib/version.txt", "new plugin\n");

  writeJson(root, ".sennel/config.json", {
    lang: "en",
    type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" },
    plugin: {
      sources: [{ id: sourceId, type: "local", path: sourceRoot }],
      packages: [{
        id: pluginId,
        source: sourceId,
        commit: "a".repeat(40),
      }],
    },
  });
  writeJson(root, ".sennel/config.local.json", {
    plugin: { sources: [], packages: [], config: { marker: "private" } },
  });
  writeJson(root, `.sennel/plugins/${pluginId}/plugin.json`, {
    name: pluginId,
    type: "mixed",
    files: ["plugin.json", "lib/"],
    contributions: {},
  });
  writeFile(root, `.sennel/plugins/${pluginId}/lib/version.txt`, "old plugin\n");

  return {
    publicConfig: path.join(root, ".sennel", "config.json"),
    localConfig: path.join(root, ".sennel", "config.local.json"),
    sourceRoot,
    installedRoot: path.join(root, ".sennel", "plugins", pluginId),
    pluginsRoot: path.join(root, ".sennel", "plugins"),
  };
}

describe("plugin install transaction", () => {
  let root;
  afterEach(() => root && removeTmpDir(root));

  for (const phase of ["copy", "validation", "rename", "config-commit"]) {
    it(`restores the old plugin and both configs after a ${phase} fault`, () => {
      root = createTmpDir(`plugin-${phase}-fault-`);
      const fixture = setupProject(root);
      const publicBefore = fs.readFileSync(fixture.publicConfig);
      const localBefore = fs.readFileSync(fixture.localConfig);
      const pluginBefore = snapshotTree(fixture.installedRoot);

      assert.throws(
        () => installPlugin(root, "sample-plugin", {
          faultInjector(event) {
            if (event.phase === phase) throw new Error(`${phase} fault`);
          },
        }),
        new RegExp(`${phase} fault`),
      );

      assert.deepEqual(fs.readFileSync(fixture.publicConfig), publicBefore);
      assert.deepEqual(fs.readFileSync(fixture.localConfig), localBefore);
      assert.deepEqual(snapshotTree(fixture.installedRoot), pluginBefore);
      assert.deepEqual(fs.readdirSync(fixture.pluginsRoot), ["sample-plugin"]);
    });
  }

  it("restores config after an atomic config write fails after the visible rename", () => {
    root = createTmpDir("plugin-config-visible-fault-");
    const fixture = setupProject(root);
    const publicBefore = fs.readFileSync(fixture.publicConfig);
    const localBefore = fs.readFileSync(fixture.localConfig);
    const pluginBefore = snapshotTree(fixture.installedRoot);

    assert.throws(
      () => installPlugin(root, "sample-plugin", {
        faultInjector(event) {
          if (event.phase === "before-json-readback") {
            throw new Error("config publication readback fault");
          }
        },
      }),
      (error) => error.code === "ATOMIC_JSON_PUBLICATION_UNCERTAIN"
        && /config publication readback fault/.test(error.cause?.message),
    );

    assert.deepEqual(fs.readFileSync(fixture.publicConfig), publicBefore);
    assert.deepEqual(fs.readFileSync(fixture.localConfig), localBefore);
    assert.deepEqual(snapshotTree(fixture.installedRoot), pluginBefore);
    assert.deepEqual(fs.readdirSync(fixture.pluginsRoot), ["sample-plugin"]);
  });

  it("restores the backup when the atomic swap rename fails", () => {
    root = createTmpDir("plugin-swap-rename-fault-");
    const fixture = setupProject(root);
    const publicBefore = fs.readFileSync(fixture.publicConfig);
    const localBefore = fs.readFileSync(fixture.localConfig);
    const pluginBefore = snapshotTree(fixture.installedRoot);

    assert.throws(
      () => installPlugin(root, "sample-plugin", {
        faultInjector(event) {
          if (event.phase === "rename" && event.operation === "swap") {
            throw new Error("swap rename fault");
          }
        },
      }),
      /swap rename fault/,
    );

    assert.deepEqual(fs.readFileSync(fixture.publicConfig), publicBefore);
    assert.deepEqual(fs.readFileSync(fixture.localConfig), localBefore);
    assert.deepEqual(snapshotTree(fixture.installedRoot), pluginBefore);
    assert.deepEqual(fs.readdirSync(fixture.pluginsRoot), ["sample-plugin"]);
  });

  for (const [name, invoke] of [
    ["single update", (project, faultInjector) => updateInstalledPlugin(project, "sample-plugin", { faultInjector })],
    ["bulk update", (project, faultInjector) => planInstalledPluginUpdates(project).apply(project, { faultInjector })],
    ["sync", (project, faultInjector) => syncInstalledPlugins(project, { faultInjector })],
  ]) {
    it(`routes ${name} through the transactional installer`, () => {
      root = createTmpDir(`plugin-${name.replaceAll(" ", "-")}-`);
      const fixture = setupProject(root);
      const before = fs.readFileSync(path.join(fixture.installedRoot, "lib/version.txt"));
      const faultInjector = (event) => {
        if (event.phase === "copy") throw new Error(`${name} staging fault`);
      };

      assert.throws(() => invoke(root, faultInjector), new RegExp(`${name} staging fault`));
      assert.deepEqual(fs.readFileSync(path.join(fixture.installedRoot, "lib/version.txt")), before);
      assert.deepEqual(fs.readdirSync(fixture.pluginsRoot), ["sample-plugin"]);
    });
  }

  it("routes official preset repair through the transactional installer", () => {
    root = createTmpDir("plugin-official-repair-");
    const fixture = setupProject(root, {
      pluginId: "official-presets",
      sourceId: "official-presets",
    });
    const before = fs.readFileSync(path.join(fixture.installedRoot, "lib/version.txt"));

    assert.throws(
      () => ensureOfficialPackage(root, {
        id: "official-presets",
        sourceRoot: fixture.sourceRoot,
        faultInjector(event) {
          if (event.phase === "copy") throw new Error("official staging fault");
        },
      }),
      /official staging fault/,
    );

    assert.deepEqual(fs.readFileSync(path.join(fixture.installedRoot, "lib/version.txt")), before);
    assert.deepEqual(fs.readdirSync(fixture.pluginsRoot), ["official-presets"]);
  });

  it("rolls back both config files when the second config commit fails", () => {
    root = createTmpDir("plugin-two-config-rollback-");
    const fixture = setupProject(root, {
      pluginId: "official-presets",
      sourceId: "official-presets",
    });
    writeJson(root, ".sennel/config.json", {
      lang: "en",
      type: "base",
      docs: { languages: ["en"], defaultLanguage: "en" },
      plugin: { sources: [], packages: [] },
    });
    writeJson(root, ".sennel/config.local.json", {
      plugin: {
        sources: [],
        packages: [{
          id: "official-presets",
          source: "official-presets",
          commit: "a".repeat(40),
        }],
      },
    });
    const publicBefore = fs.readFileSync(fixture.publicConfig);
    const localBefore = fs.readFileSync(fixture.localConfig);
    const pluginBefore = snapshotTree(fixture.installedRoot);
    let configCommits = 0;

    assert.throws(
      () => ensureOfficialPackage(root, {
        id: "official-presets",
        sourceRoot: fixture.sourceRoot,
        faultInjector(event) {
          if (event.phase === "config-commit" && ++configCommits === 2) {
            throw new Error("second config commit fault");
          }
        },
      }),
      /second config commit fault/,
    );

    assert.deepEqual(fs.readFileSync(fixture.publicConfig), publicBefore);
    assert.deepEqual(fs.readFileSync(fixture.localConfig), localBefore);
    assert.deepEqual(snapshotTree(fixture.installedRoot), pluginBefore);
    assert.deepEqual(fs.readdirSync(fixture.pluginsRoot), ["official-presets"]);
  });
});
