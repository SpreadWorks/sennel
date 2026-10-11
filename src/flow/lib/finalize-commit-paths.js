import path from "node:path";
import { FlowSpecLocation } from "../../lib/flow-workspace.js";
import { PRODUCT } from "../../lib/product.js";
import { runGit } from "../../lib/git-helpers.js";
import { assertOk } from "../../lib/process.js";

export const FINALIZE_DOCUMENTATION_PATHS = Object.freeze([
  "docs",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  PRODUCT.managedPath("output", "analysis.json"),
]);

export const FINALIZE_PRE_MERGE_DEFERRED_PATHS = Object.freeze([
  PRODUCT.managedPath("output", "analysis.json"),
]);

export class FinalizeCommitPathSet {
  constructor({ repositoryRoot, specRoot, specId }) {
    this.location = new FlowSpecLocation({ repositoryRoot, specRoot, specId });
    this.specDirectory = this.location.relativeDirectory;
    this.documentationPaths = FINALIZE_DOCUMENTATION_PATHS;
    Object.freeze(this);
  }

  get completionPaths() {
    return [this.specDirectory, ...this.documentationPaths];
  }

  get implementationExclusions() {
    return [this.location.relativeRoot, ...this.documentationPaths]
      .map((entry) => `:(exclude)${entry}${path.extname(entry) ? "" : "/**"}`);
  }

  resolveImplementationPaths({ root, sourceAuthorities }) {
    const owned = [...new Set(sourceAuthorities.filter((authority) => authority.settlement?.kind === "accepted")
      .flatMap((authority) => authority.event.sourceManifest.paths()))];
    const changed = runGit(["diff", "--name-only", "-z", "--", ".", ...this.implementationExclusions], { cwd: root });
    const untracked = runGit(["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...this.implementationExclusions], { cwd: root });
    assertOk(changed, "failed to inspect approved implementation changes");
    assertOk(untracked, "failed to inspect approved implementation additions");
    const outputs = [changed.stdout, untracked.stdout];
    if (owned.length > 0) {
      const staged = runGit(["diff", "HEAD", "--name-only", "-z", "--", ...owned, ...this.implementationExclusions], { cwd: root });
      assertOk(staged, "failed to inspect source-authorized staged implementation changes");
      outputs.push(staged.stdout);
    }
    return Object.freeze([...new Set(outputs.flatMap((output) => output.split("\0").filter(Boolean)))]);
  }
}
