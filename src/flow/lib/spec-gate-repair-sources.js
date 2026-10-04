import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runGit } from "../../lib/git-helpers.js";
import { captureRegularFile } from "../../lib/regular-file-snapshot.js";
import { SpecGateRepairSource } from "./spec-gate-repair-values.js";
import { compareText } from "./text-order.js";

/** Use existing catalog and regular-file readers; never execute a research worker. */
export function readSpecGateRepairSources({ flowManager, state, executionRoot, spec }) {
  const sources = [];
  const addText = (id, origin, content, revision = createHash("sha256").update(content).digest("hex"), options = {}) => {
    sources.push(new SpecGateRepairSource({ id, origin, content, revision, ...options }));
  };
  addText("request", "flow.request", state.request ?? "");
  for (const logicalKey of ["issue.snapshot", "draft"]) {
    if (logicalKey === "issue.snapshot" && state.issue === null) continue;
    const artifact = flowManager.readArtifact({ specId: state.specId, logicalKey,
      consumerNodeId: "spec-gate-repair", optional: logicalKey === "draft" });
    if (artifact !== null) addText(logicalKey, artifact.relativePath,
      artifact.bytes.toString("utf8"), artifact.descriptor.hash);
  }
  const capture = (id, relative, options = {}) => {
    const absolute = path.resolve(executionRoot, relative);
    if (path.relative(executionRoot, absolute).startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Repair source path escapes the execution root");
    }
    if (!fs.existsSync(absolute)) {
      addText(id, relative, "", "missing", { ...options, availability: "missing" });
      return;
    }
    try {
      const snapshot = captureRegularFile(absolute, { label: "repair captured evidence", maxBytes: 2 * 1024 * 1024 });
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot.bytes);
      addText(id, relative, content, snapshot.digest, options);
    } catch {
      addText(id, relative, "", "unavailable", { ...options, availability: "unavailable" });
    }
  };
  if (fs.existsSync(path.join(executionRoot, "AGENTS.md"))) capture("project-rules", "AGENTS.md", { appliesTo: ["."] });
  // Inventory supplies real paths; do not infer paths from prose or execute its commands.
  const repository = runGit(["rev-parse", "--is-inside-work-tree"], { cwd: executionRoot });
  if (!repository.ok) {
    addText("source-inventory", "repository", "", "unavailable", { availability: "unavailable", required: false });
    return Object.freeze(sources);
  }
  const inventory = runGit(["ls-files", "-z", "--cached"], { cwd: executionRoot });
  if (!inventory.ok) throw new Error(`Cannot read repair source inventory: ${inventory.stderr}`);
  const tracked = [...new Set(inventory.stdout.toString().split("\0").filter(Boolean))].sort();
  const trackedPaths = new Set(tracked);
  if (trackedPaths.has("AGENTS.md") && !sources.some((source) => source.origin === "AGENTS.md")) {
    capture("project-rules", "AGENTS.md", { appliesTo: ["."] });
  }
  const references = [spec, ...sources.map((entry) => entry.content)];
  const referencedOrigins = SpecGateRepairSource.referencedOrigins(references, tracked.filter((relative) => relative !== "AGENTS.md"));
  const referenced = tracked.filter((relative) => referencedOrigins.has(relative));
  const scopedRules = new Map();
  for (const relative of referenced) {
    if (path.basename(relative) !== "AGENTS.md") capture(`source:${relative}`, relative, { required: false });
    let directory = path.dirname(relative);
    while (directory !== ".") {
      const rulePath = path.join(directory, "AGENTS.md");
      if (trackedPaths.has(rulePath) || fs.existsSync(path.join(executionRoot, rulePath))) {
        if (!scopedRules.has(rulePath)) scopedRules.set(rulePath, new Set());
        scopedRules.get(rulePath).add(directory);
      }
      directory = path.dirname(directory);
    }
  }
  for (const [relative, scopes] of [...scopedRules].sort(([a], [b]) => compareText(a, b))) {
    if (!sources.some((source) => source.origin === relative && source.required)) {
      capture(`project-rules:${relative}`, relative, { required: false, appliesTo: [...scopes] });
    }
  }
  return Object.freeze(sources);
}
