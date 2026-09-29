import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runGit } from "../../lib/git-helpers.js";
import { captureRegularFile } from "../../lib/regular-file-snapshot.js";
import { SpecGateRepairSource } from "./spec-gate-repair-values.js";

/** Use existing catalog and regular-file readers; never execute a research worker. */
export function readSpecGateRepairSources({ flowManager, state, executionRoot, spec }) {
  const sources = [];
  const addText = (id, origin, content, revision = createHash("sha256").update(content).digest("hex")) => {
    sources.push(new SpecGateRepairSource({ id, origin, content, revision }));
  };
  addText("request", "flow.request", state.request ?? "");
  for (const logicalKey of ["issue.snapshot", "draft"]) {
    if (logicalKey === "issue.snapshot" && state.issue === null) continue;
    const artifact = flowManager.readArtifact({ specId: state.specId, logicalKey,
      consumerNodeId: "spec-gate-repair", optional: logicalKey === "draft" });
    if (artifact !== null) addText(logicalKey, artifact.relativePath,
      artifact.bytes.toString("utf8"), artifact.descriptor.hash);
  }
  const rulesPath = path.join(executionRoot, "AGENTS.md");
  if (fs.existsSync(rulesPath)) {
    const rules = captureRegularFile(rulesPath, { label: "repair project rules", maxBytes: 2 * 1024 * 1024 });
    addText("project-rules", "AGENTS.md", rules.text(), rules.digest);
  }
  // Inventory supplies real paths; do not infer paths from prose or execute its commands.
  const repository = runGit(["rev-parse", "--is-inside-work-tree"], { cwd: executionRoot });
  if (!repository.ok) {
    addText("source-inventory", "repository", "Source inventory unavailable: execution root is not a Git worktree.");
    return Object.freeze(sources);
  }
  const inventory = runGit(["ls-files", "-z", "--cached"], { cwd: executionRoot });
  if (!inventory.ok) throw new Error(`Cannot read repair source inventory: ${inventory.stderr}`);
  const references = `${JSON.stringify(spec)}\n${sources.map((entry) => entry.content).join("\n")}`;
  for (const relative of [...new Set(inventory.stdout.toString().split("\0").filter(Boolean))].sort()) {
    if (relative === "AGENTS.md" || !references.includes(relative)) continue;
    const absolute = path.resolve(executionRoot, relative);
    if (path.relative(executionRoot, absolute).startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Repair source path escapes the execution root");
    }
    if (!fs.existsSync(absolute)) {
      addText(`source:${relative}`, relative, "Referenced tracked file is absent from the current working tree.");
      continue;
    }
    const snapshot = captureRegularFile(absolute, { label: "repair referenced source", maxBytes: 2 * 1024 * 1024 });
    addText(`source:${relative}`, relative, snapshot.text(), snapshot.digest);
  }
  return Object.freeze(sources);
}
