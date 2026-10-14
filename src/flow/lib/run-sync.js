/**
 * src/flow/lib/run-sync.js
 *
 * FlowCommand: sync — sync documentation: build -> review -> add -> commit.
 * requiresFlow: false (can run independently).
 */

import { PKG_DIR } from "../../lib/cli.js";
import { runManagedCmdAsync, assertOk } from "../../lib/process.js";
import { RuntimeChildExecution } from "../../lib/runtime-package.js";
import { runGit } from "../../lib/git-helpers.js";
import { FlowCommand } from "./base-command.js";
import { withFlowProcessRuntime } from "./process-runtime-admission.js";
import path from "path";
import { PRODUCT } from "../../lib/product.js";

export class RunSyncCommand extends FlowCommand {
  constructor({ runCommand = runManagedCmdAsync, git = runGit } = {}) {
    super({ requiresFlow: false });
    this.runCommand = runCommand;
    this.git = git;
  }

  async execute(ctx) {
    return withFlowProcessRuntime(ctx, () => this.#executeAdmitted(ctx), { commandId: "sync" });
  }

  async #executeAdmitted(ctx) {
    const { root } = ctx;
    const dryRun = ctx.dryRun || false;

    const docsScript = path.join(PKG_DIR, "docs.js");

    // Step 1: build
    const buildRes = await RuntimeChildExecution.runAsync(docsScript, ["build"], { cwd: root }, this.runCommand);
    const buildOutput = (buildRes.stdout || "").trim();

    if (!buildRes.ok) {
      throw new Error(
        ["docs build failed",
          ...(buildRes.stderr ? [buildRes.stderr.trim()] : []),
          ...(buildOutput ? [buildOutput] : []),
        ].join("\n"),
      );
    }

    // Step 2: review
    const reviewRes = await RuntimeChildExecution.runAsync(docsScript, ["review"], { cwd: root }, this.runCommand);
    const reviewOutput = (reviewRes.stdout || "").trim();

    if (!reviewRes.ok) {
      throw new Error(
        ["docs review failed",
          ...(reviewRes.stderr ? [reviewRes.stderr.trim()] : []),
          ...(reviewOutput ? [reviewOutput] : []),
        ].join("\n"),
      );
    }

    if (dryRun) {
      return {
        result: "dry-run",
        changed: [],
        artifacts: { buildOutput, reviewResult: reviewOutput },
      };
    }

    // Step 3: git add (ignore errors for missing files)
    this.git(["add", "docs/", "AGENTS.md", "CLAUDE.md", "README.md", `${PRODUCT.managedPath("output")}/`], { cwd: root });

    // Collect changed files
    let changed = [];
    const diffRes = this.git(["diff", "--cached", "--name-only"], { cwd: root });
    if (diffRes.ok) {
      const diff = diffRes.stdout.trim();
      changed = diff ? diff.split("\n").filter(Boolean) : [];
    }

    // Step 4: commit (skip if nothing to commit)
    if (changed.length > 0) {
      const commitRes = this.git(["commit", "-m", "docs: sync documentation"], { cwd: root });
      if (!commitRes.ok && !/nothing to commit/i.test(commitRes.stderr || commitRes.stdout)) {
        assertOk(commitRes, "git commit failed");
      }
    }

    return {
      result: changed.length > 0 ? "ok" : "skipped",
      changed,
      artifacts: { buildOutput, reviewResult: reviewOutput },
    };
  }
}

export default RunSyncCommand;
