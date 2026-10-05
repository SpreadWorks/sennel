import path from "node:path";
import { FlowSpecLocation } from "../../lib/flow-workspace.js";
import { PRODUCT } from "../../lib/product.js";

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
}
