import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { FlowManager } from "../../src/lib/flow-manager.js";
import SetInitCommand from "../../src/flow/lib/set-init.js";
import RunPrepareSpecCommand from "../../src/flow/lib/run-prepare-spec.js";
import { fixtureRepository } from "./infrastructure/flow-dispatch-scenario.js";
import { commitAll } from "./infrastructure/git-repo.js";
import { removeTmpDir } from "./builders/tmp-dir.js";
import { PrepareProcess } from "./infrastructure/prepare-process.js";

const cliPath = fileURLToPath(new URL("../../src/sennel.js", import.meta.url));

/** An owned Git repository; every Flow fact is produced by the public commands. */
export class PrepareArtifactScenario {
  static create(t, options = {}) {
    const root = fixtureRepository("prepare-artifact-scenario-");
    t.after(() => removeTmpDir(root));
    return new PrepareArtifactScenario(root, options);
  }

  constructor(root, { mode = "no-branch", issue = null,
    request = "Keep the exact request.\nSecond line: 日本語 and `quoted` text." } = {}) {
    assert.ok(["branch", "worktree", "no-branch"].includes(mode));
    this.root = root;
    this.executionRoot = root;
    this.mode = mode;
    this.issue = issue;
    this.request = request;
    this.issueBody = "Immutable Issue snapshot: retain this exact requirement.";
    this.config = { lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" },
      agent: { default: "fixture", providers: { fixture: {
        command: process.execPath, args: [path.join(root, ".fixture-bin", "agent.mjs")],
      } } } };
    fs.mkdirSync(path.join(root, ".sennel"), { recursive: true });
    fs.mkdirSync(path.join(root, ".fixture-bin"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sennel", "config.json"), JSON.stringify(this.config));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "prepare-scenario", type: "module" }));
    fs.writeFileSync(path.join(root, ".gitignore"), "/.tmp/\n/.fixture-bin/\n/specs/\n/.sennel/*\n!/.sennel/config.json\n");
    fs.writeFileSync(path.join(root, ".fixture-bin", "gh"), [
      `#!${process.execPath}`,
      `process.stdout.write(${JSON.stringify(JSON.stringify({ title: "Offline Issue", body: this.issueBody, labels: [], state: "OPEN" }))});`,
    ].join("\n"), { mode: 0o755 });
    fs.writeFileSync(path.join(root, ".fixture-bin", "agent.mjs"), [
      'import fs from "node:fs";',
      `fs.appendFileSync(${JSON.stringify(path.join(root, ".tmp", "unexpected-agent-calls"))}, "called\\n");`,
      'process.stderr.write("Unexpected worker invocation in a preparation refusal scenario");',
      'process.exit(19);',
    ].join("\n"));
    commitAll(root, "Prepare scenario seed");
    this.baseOid = this.git(["rev-parse", "HEAD"]).trim();
    this.flowManager = this.reload();
  }

  git(args, root = this.root) {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }

  /** Real plugin seed, shared by required-hook success and failure scenarios. */
  installPreparePlugin({ fail = false, observeInvocation = false } = {}) {
    const pluginRoot = path.join(this.root, ".sennel", "plugins", "prepare-observer");
    fs.mkdirSync(path.join(pluginRoot, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(this.root, ".sennel", "config.local.json"), JSON.stringify({ plugin: {
      sources: [{ id: "prepare-observer", type: "local", path: ".sennel/plugins/prepare-observer" }],
      packages: [{ id: "prepare-observer", source: "prepare-observer", commit: "0".repeat(40) }],
    } }));
    fs.writeFileSync(path.join(pluginRoot, "plugin.json"), JSON.stringify({
      name: "prepare-observer", files: ["plugin.json", "hooks/"],
      contributions: { hooks: [{ path: "hooks/prepare.js" }] },
    }));
    fs.writeFileSync(path.join(pluginRoot, "hooks", "prepare.js"), [
      ...(observeInvocation ? ['import fs from "node:fs";'] : []),
      "export default function register(api) { return class PrepareObserverHook extends api.FlowCommandHook {",
      'static command = "prepare"; static hook = "post"; static failurePolicy = "required";',
      fail ? 'async run() { throw new Error("required preparation hook unavailable"); }' : [
        "async run(context) {",
        ...(observeInvocation ? [
          `fs.writeFileSync(${JSON.stringify(this.preparePluginInvocationPath)}, JSON.stringify({ projectRoot: context.project.root, flow: context.flow }));`,
        ] : []),
        'await context.artifacts.writeJson("prepare-seen.json", {',
        "runId: context.flow.runId, specId: context.flow.specId, issue: context.flow.issue ?? null,",
        "request: context.flow.request, hookCount: context.flow.plugins.flowCommandHooks.length });",
        'return context.envelope.ok("plugin-hook", "prepare", {});',
        "}",
      ].join("\n"),
      "}; }",
    ].join("\n"));
  }

  get preparePluginInvocationPath() {
    return path.join(this.root, ".tmp", "prepare-plugin-invocation.json");
  }

  environment(root = this.executionRoot) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("SENNEL_")) delete env[key];
    return { ...env, PATH: `${path.join(this.root, ".fixture-bin")}${path.delimiter}${env.PATH}`,
      SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root };
  }

  async withEnvironment(action) {
    const prior = { ...process.env };
    const scoped = this.environment();
    for (const key of Object.keys(process.env)) if (!(key in scoped)) delete process.env[key];
    Object.assign(process.env, scoped);
    try { return await action(); }
    finally {
      for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
      Object.assign(process.env, prior);
    }
  }

  cli(args, root = this.executionRoot) {
    const result = spawnSync(process.execPath, [cliPath, "flow", ...args], {
      cwd: root, encoding: "utf8", env: this.environment(root), timeout: 30_000,
    });
    const text = result.stdout?.trim() ?? "";
    return { ...result, envelope: text.startsWith("{") ? JSON.parse(text) : null };
  }

  expectSuccess(result) {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.envelope?.ok, true, result.stdout);
    return result.envelope.data;
  }

  async initialize({ cli = false } = {}) {
    const args = ["set", "init", "--request", this.request];
    if (this.issue !== null) args.push("--issue", String(this.issue));
    const result = cli ? this.expectSuccess(this.cli(args))
      : await this.withEnvironment(() => new SetInitCommand().execute({
        root: this.root, mainRoot: this.root, flowManager: this.flowManager,
        request: this.request, issue: this.issue,
      }));
    assert.equal(typeof result.runId, "string", JSON.stringify(result));
    this.runId = result.runId;
    return result;
  }

  async prepare({ cli = false, ...overrides } = {}) {
    let result;
    if (cli) {
      const args = ["prepare", "--title", "prepare-artifact", "--base", "main", "--run-id", this.runId];
      if (this.mode !== "branch") args.push(`--${this.mode}`);
      result = this.expectSuccess(this.cli(args));
    } else {
      result = await this.withEnvironment(() => new RunPrepareSpecCommand().execute({
        flowManager: this.flowManager, ...this.prepareInput(overrides),
      }));
    }
    if (result.result === "ok") {
      this.specId = result.specId;
      this.executionRoot = result.worktreePath ?? overrides.executionRoot ?? this.root;
      this.prepared = result;
    }
    return result;
  }

  prepareInput(overrides = {}) {
    return { root: this.root, mainRoot: this.root, executionRoot: this.root,
      config: this.config, title: "prepare-artifact", base: "main", runId: this.runId,
      noBranch: this.mode === "no-branch", worktree: this.mode === "worktree", ...overrides };
  }

  interruptAfterWorktreeAdd() {
    return new PrepareProcess({ input: this.prepareInput(),
      environment: this.environment(this.root) }).interruptAfterWorktreeAdd();
  }

  reload() {
    this.flowManager = new FlowManager({ root: this.executionRoot, mainRoot: this.root,
      inWorktree: this.executionRoot !== this.root, ...(this.specId && { specId: this.specId }) });
    return this.flowManager;
  }

  context() {
    const manager = this.flowManager;
    return { root: this.executionRoot, mainRoot: this.root, executionRoot: this.executionRoot,
      specId: this.specId, flowManager: manager, config: this.config,
      flowState: manager.loadReadOnly(this.specId) };
  }
}
