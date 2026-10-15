import { offlineGitHubScript } from "../../../support/fakes/github.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../../support/infrastructure/git-repo.js";

const SENNEL = path.join(process.cwd(), "src/sennel.js");

function config(command) {
  return {
    lang: "en",
    type: "sample-node-command",
    scan: { include: ["src/**/*.js"], exclude: [] },
    docs: { languages: ["en"], defaultLanguage: "en" },
    flow: {
      hooks: {
        PostWorktree: command,
      },
    },
  };
}

function setupProject(command) {
  const root = createTmpDir("sennel-post-worktree-e2e-");
  writeJson(root, ".sennel/config.json", config(command));
  writeJson(root, "package.json", { name: "post-worktree-e2e", version: "1.0.0", type: "module" });
  writeFile(root, "src/index.js", "export const value = 1;\n");
  writeFile(root, ".sennel/output/.gitkeep", "");
  initGitRepo(root);
  commitAll(root, "initial");
  return root;
}

function runPrepare(root, title = "post-worktree", extraArgs = []) {
  const result = spawnSync("node", [
    SENNEL,
    "flow",
    "prepare",
    "--title",
    title,
    "--worktree",
    "--request",
    "post worktree test",
    ...extraArgs,
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      SENNEL_WORK_ROOT: root,
      PATH: `${path.join(root, ".fixture-bin")}${path.delimiter}${process.env.PATH}`,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

describe("flow prepare PostWorktree hook", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("runs PostWorktree in the new worktree before spec files are written", () => {
    const command = [
      "node -e",
      "\"const fs=require('fs');",
      "fs.writeFileSync('post-worktree.marker', JSON.stringify({ cwd: process.cwd(), specs: fs.existsSync('specs') }))\"",
    ].join(" ");
    tmp = setupProject(command);

    const envelope = runPrepare(tmp);
    const worktreePath = envelope.data.artifacts.worktree;
    const marker = JSON.parse(fs.readFileSync(path.join(worktreePath, "post-worktree.marker"), "utf8"));

    assert.equal(marker.cwd, worktreePath);
    assert.equal(marker.specs, false);
    assert.ok(fs.existsSync(path.join(tmp, envelope.data.artifacts.specDir, "spec.json")));
    assert.equal(fs.existsSync(path.join(worktreePath, envelope.data.artifacts.specDir)), false);
  });

  it("continues prepare when PostWorktree exits non-zero", () => {
    tmp = setupProject("node -e \"process.stderr.write('expected hook failure'); process.exit(9)\"");

    const envelope = runPrepare(tmp, "post-worktree-failure");
    const specPath = path.join(tmp, envelope.data.artifacts.specDir, "spec.json");

    assert.equal(envelope.ok, true);
    assert.ok(fs.existsSync(specPath));
  });

  it("mirrors ignored plugin runtime into worktree before plugin prepare hooks are discovered", () => {
    tmp = setupProject("");
    writeFile(tmp, ".gitignore", ".sennel/*\n!.sennel/config.json\n!.sennel/output/\n");
    writeFile(tmp, ".fixture-bin/gh", offlineGitHubScript({ title: "Plugin fixture Issue", body: "Plugin fixture immutable Issue snapshot" }));
    fs.chmodSync(path.join(tmp, ".fixture-bin", "gh"), 0o755);
    writeJson(tmp, ".sennel/config.local.json", {
      plugin: {
        sources: [{ id: "workflow-src", type: "local", path: ".sennel/plugins/workflow" }],
        packages: [{
          id: "workflow",
          source: "workflow-src",
          commit: "0000000000000000000000000000000000000000",
        }],
      },
    });
    writeJson(tmp, ".sennel/plugins/workflow/plugin.json", {
      name: "workflow",
      files: ["plugin.json", "hooks/", "config.defaults.json"],
      contributions: {
        hooks: [{ path: "hooks/prepare.js" }],
        config: { defaults: "config.defaults.json" },
      },
    });
    writeJson(tmp, ".sennel/plugins/workflow/config.defaults.json", {
      plugin: {
        config: {
          workflow: { flowIntegration: "enable" },
        },
      },
    });
    writeFile(tmp, ".sennel/plugins/workflow/hooks/prepare.js", `
export default function register(api) {
  return class PrepareHook extends api.FlowCommandHook {
    static command = "prepare";
    static hook = "post";
    static failurePolicy = "required";
    async run(context) {
      await context.artifacts.writeJson("prepare-seen.json", {
        issue: context.flow.issue,
        snapshot: context.flow.plugins.flowCommandHooks.length,
        flowIntegration: context.config.flowIntegration
      });
      return context.envelope.ok("plugin-hook", "prepare", {});
    }
  };
}
`);
    commitAll(tmp, "plugin overlay");

    const envelope = runPrepare(tmp, "worktree-plugin-runtime", ["--issue", "123"]);
    const worktreePath = envelope.data.artifacts.worktree;
    const specDir = path.join(tmp, envelope.data.artifacts.specDir);
    const flow = JSON.parse(fs.readFileSync(path.join(specDir, "flow.json"), "utf8"));
    const catalog = JSON.parse(fs.readFileSync(path.join(specDir, "artifact-catalog.json"), "utf8"));
    const pluginDescriptor = catalog.artifacts.find((entry) => entry.logicalKey === "plugin.lifecycle.artifact");
    const artifact = JSON.parse(fs.readFileSync(path.join(specDir, "artifacts", "plugin-artifacts", "workflow", "prepare-seen.json"), "utf8"));

    assert.equal(fs.existsSync(path.join(worktreePath, ".sennel", "config.local.json")), true);
    assert.equal(fs.existsSync(path.join(worktreePath, ".sennel", "plugins", "workflow", "hooks", "prepare.js")), true);
    assert.equal(Object.hasOwn(flow, "plugins"), false);
    assert.equal(pluginDescriptor.relativePath, "artifacts/plugin-artifacts/workflow/prepare-seen.json");
    assert.equal(typeof pluginDescriptor.activityId, "string");
    assert.deepEqual(artifact, {
      issue: 123,
      snapshot: 1,
      flowIntegration: "enable",
    });
  });
});
