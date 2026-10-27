import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../support/infrastructure/git-repo.js";

const entrypoint = fileURLToPath(new URL("../../src/sennel.js", import.meta.url));

test("public plugin install completes with Git alone on PATH and reads the installed contribution", {
  skip: process.platform !== "linux" ? "Linux tool-isolation acceptance; other OS execution is recorded separately" : false,
}, (t) => {
  const root = createTmpDir("plugin-archive-cli-");
  t.after(() => removeTmpDir(root));
  const source = path.join(root, "source");
  const project = path.join(root, "project");
  const gitOnly = path.join(root, "git-only");
  fs.mkdirSync(source);
  fs.mkdirSync(project);
  fs.mkdirSync(gitOnly);
  const git = process.env.PATH.split(path.delimiter).map((directory) => path.join(directory, "git"))
    .find((candidate) => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return true; }
      catch { return false; }
    });
  assert.ok(git, "Git is the existing required tool");
  fs.symlinkSync(fs.realpathSync(git), path.join(gitOnly, "git"));
  assert.deepEqual(fs.readdirSync(gitOnly), ["git"]);
  writeJson(source, "plugin.json", {
    name: "archive-cli", files: ["plugin.json", "commands/"],
    contributions: { commands: [{ name: "archive-probe", path: "commands/probe.js" }] },
  });
  writeFile(source, "commands/probe.js", 'export default function register() { return { main() { return { ok: true, type: "probe", key: "installed", data: { value: "archive contribution" }, errors: [] }; } }; }\n');
  initGitRepo(source);
  commitAll(source, "Plugin archive CLI fixture");
  const expectedCommit = spawnSync(git, ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" });
  assert.equal(expectedCommit.status, 0, expectedCommit.stderr);
  writeJson(project, ".sennel/config.json", {
    lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" },
    plugin: { sources: [{ id: "source", type: "local", path: source }], packages: [] },
  });
  const env = { ...process.env, PATH: gitOnly, SENNEL_WORK_ROOT: project, SENNEL_SOURCE_ROOT: project };
  const install = spawnSync(process.execPath, [entrypoint, "plugin", "install", "archive-cli", "--no-upgrade", "--json"],
    { cwd: project, env, encoding: "utf8", timeout: 120000 });
  assert.equal(install.status, 0, install.stderr || install.error?.message || install.stdout);
  const result = JSON.parse(install.stdout);
  assert.equal(result.package.id, "archive-cli");
  assert.equal(result.package.commit, expectedCommit.stdout.trim());
  const config = JSON.parse(fs.readFileSync(path.join(project, ".sennel/config.json"), "utf8"));
  assert.equal(config.plugin.packages[0].commit, expectedCommit.stdout.trim());
  assert.equal(fs.readFileSync(path.join(project, ".sennel/plugins/archive-cli/commands/probe.js"), "utf8"),
    fs.readFileSync(path.join(source, "commands/probe.js"), "utf8"));
  const probe = spawnSync(process.execPath, [entrypoint, "archive-probe"],
    { cwd: project, env, encoding: "utf8", timeout: 120000 });
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message || probe.stdout);
  assert.deepEqual(JSON.parse(probe.stdout).data, { value: "archive contribution" });
  assert.equal(fs.existsSync(path.join(source, ".tmp")), false);
  assert.equal(fs.existsSync(path.join(source, ".sennel")), false);
});
