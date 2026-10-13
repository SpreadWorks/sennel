import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import RunSyncCommand from "../../../src/flow/lib/run-sync.js";
import RunFinalizeSyncCommand from "../../../src/flow/lib/run-finalize-sync.js";
import { runCmd } from "../../../src/lib/process.js";

const chapter = ["# Runtime documentation", "", "## Description", "Generated child documentation.", "", "## Details",
  ...Array.from({ length: 15 }, (_, index) => `Verified detail ${index}.`), ""].join("\n");
const config = { type: "base", lang: "en", docs: { languages: ["en"], defaultLanguage: "en" },
  chapters: [{ chapter: "overview.md", desc: "Runtime documentation" }], scan: { include: ["input.txt"], exclude: [] } };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-sync-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const templates = path.join(root, ".sennel/templates/en/docs");
  fs.mkdirSync(templates, { recursive: true });
  fs.writeFileSync(path.join(root, ".sennel/config.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(root, "input.txt"), "live target input\n");
  fs.writeFileSync(path.join(templates, "overview.md"), chapter);
  fs.writeFileSync(path.join(templates, "README.md"), '# Documentation\n\n<!-- {{data("base.docs.chapters", {labels: "Chapter|Description"})}} -->\n<!-- {{/data}} -->\n');
  // This test owns only process-local environment; the genuine child bootstrap
  // must supply its own proof without a host preload or worktree selection.
  for (const key of ["SENNEL_WORK_ROOT", "SENNEL_SOURCE_ROOT", "NODE_OPTIONS"]) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    delete process.env[key];
  }
  return root;
}

function assertArtifacts(root) {
  assert.equal(fs.readFileSync(path.join(root, "docs/overview.md"), "utf8"), chapter);
  const analysis = JSON.parse(fs.readFileSync(path.join(root, ".sennel/output/analysis.json"), "utf8"));
  assert.equal(typeof analysis.analyzedAt, "string");
  assert.match(fs.readFileSync(path.join(root, "README.md"), "utf8"), /\[Runtime documentation\]\(docs\/overview\.md\)/);
}

for (const dryRun of [false, true]) {
  test(`sync genuinely builds and reviews generated artifacts before ${dryRun ? "dry-run return" : "Git commit"}`, async (t) => {
    const root = fixture(t);
    const calls = [];
    const command = new RunSyncCommand({
      runCommand(command, args, options) {
        calls.push(args.at(-1));
        const result = runCmd(command, args, options);
        assert.equal(result.ok, true, result.stderr + result.stdout);
        return result;
      },
      git(args, options) {
        assert.equal(options.cwd, root);
        assertArtifacts(root);
        calls.push(args[0]);
        return { ok: true, stdout: args[0] === "diff" ? "docs/overview.md\nREADME.md\n" : "", stderr: "" };
      },
    });
    const result = await command.execute({ root, dryRun });
    assert.equal(result.result, dryRun ? "dry-run" : "ok");
    assert.deepEqual(result.changed, dryRun ? [] : ["docs/overview.md", "README.md"]);
    assert.match(result.artifacts.reviewResult, /PASSED/);
    assert.deepEqual(calls, dryRun ? ["build", "review"] : ["build", "review", "add", "diff", "commit"]);
    assertArtifacts(root);
  });
}

test("sync stops before Git and reports the actual review's invalid generated chapter", async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, ".sennel/templates/en/docs/overview.md"), "# Too short\n");
  const command = new RunSyncCommand({ git() { assert.fail("review failure must prevent Git writes"); } });
  await assert.rejects(command.execute({ root }), (error) => {
    assert.match(error.message, /docs review failed/);
    assert.match(error.message, /too short/);
    assert.doesNotMatch(error.message, /RUNTIME_UNPROVEN/);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(root, "docs/overview.md"), "utf8"), "# Too short\n");
});

test("finalize sync builds at resolved main root and preserves real child failure diagnostics", async (t) => {
  const root = fixture(t);
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree);
  process.env.SENNEL_WORK_ROOT = worktree;
  process.env.SENNEL_SOURCE_ROOT = worktree;
  const calls = [];
  let completed = false;
  const command = new RunFinalizeSyncCommand({
    hasCommit: () => completed,
    git(args, options) {
      assert.equal(options.cwd, root);
      calls.push(args[0]);
      return { ok: true, status: 0, stdout: args[0] === "diff" ? "docs/overview.md\n" : "", stderr: "" };
    },
  });
  const ctx = { root: worktree, flowState: { worktree: true },
    flowManager: { resolveWorktreePaths: () => ({ mainRepoPath: root }) } };
  const result = await command.executeEffect(ctx);
  assert.equal(result.status, "done");
  assert.equal(result.diagnostics[0].phase, "docs-build");
  assert.equal(result.diagnostics[0].exitCode, 0);
  assertArtifacts(root);
  assert.equal(fs.existsSync(path.join(worktree, "docs")), false);
  assert.deepEqual(calls, ["diff", "diff"]);

  fs.writeFileSync(path.join(root, ".sennel/config.json"), JSON.stringify({ ...config, type: "missing-runtime-preset" }));
  completed = true;
  assert.deepEqual(await command.executeEffect(ctx), { status: "done", resumed: true });
  assert.deepEqual(calls, ["diff", "diff"]);
  completed = false;
  await assert.rejects(command.executeEffect(ctx), (error) => {
    assert.equal(error.code, "FINALIZE_SYNC_FAILED");
    const [build, status] = error.data.diagnostics;
    assert.equal(build.phase, "docs-build");
    assert.equal(build.exitCode, 1);
    assert.match(build.stderr, /missing-runtime-preset/);
    assert.doesNotMatch(build.stderr, /RUNTIME_UNPROVEN/);
    assert.equal(status.phase, "git-status-after-failure");
    return true;
  });
  assert.deepEqual(calls, ["diff", "diff", "status"]);
});
