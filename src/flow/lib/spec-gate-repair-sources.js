import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runGit } from "../../lib/git-helpers.js";
import { captureRegularFile } from "../../lib/regular-file-snapshot.js";
import { SpecGateRepairSource } from "./spec-gate-repair-values.js";
import { compareText } from "./text-order.js";
import { FlowArtifactCatalogSnapshotLimits } from "../../lib/flow-version.js";
import { WorkerArtifactHandoffError } from "./worker-artifact-handoff-error.js";

/** Distinct read, serialization and individual-artifact boundaries for exact capture. */
export class SpecGateRepairSourceCaptureBudget {
  #readBytes = 0;
  #serializedBytes = 0;
  constructor({ limits = new FlowArtifactCatalogSnapshotLimits(), maxReadBytes = limits.maxTotalArtifactBytes,
    maxSourceReadBytes = 2 * 1024 * 1024, maxSerializedBytes = limits.maxTotalArtifactBytes } = {}) {
    if (!(limits instanceof FlowArtifactCatalogSnapshotLimits)
      || [maxReadBytes, maxSourceReadBytes, maxSerializedBytes].some((limit) => !Number.isSafeInteger(limit) || limit < 0)) {
      throw new TypeError("Repair source capture requires bounded read and serialization limits");
    }
    this.maxReadBytes = maxReadBytes;
    this.maxSourceReadBytes = maxSourceReadBytes;
    this.maxSerializedBytes = maxSerializedBytes;
    this.maxArtifactBytes = limits.maxArtifactBytes;
    Object.freeze(this);
  }
  get readBytes() { return this.#readBytes; }
  get serializedBytes() { return this.#serializedBytes; }
  get remainingReadBytes() { return Math.max(0, this.maxReadBytes - this.#readBytes); }
  get nextReadLimit() { return Math.min(this.maxSourceReadBytes, this.maxArtifactBytes, this.remainingReadBytes); }
  #assertReadLength(byteLength) {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new RangeError("Repair source read consumption requires a non-negative safe integer");
    }
  }
  #assertReadLimit(byteLength) {
    if (byteLength > this.maxReadBytes) throw new RangeError("Repair source exceeds remaining capture budget");
  }
  consumeRead(byteLength) {
    this.#assertReadLength(byteLength);
    this.#assertReadLimit(this.#readBytes + byteLength);
    this.#readBytes += byteLength;
  }
  recordRead(byteLength) {
    this.#assertReadLength(byteLength);
    // Observed physical consumption cannot be rolled back even when it exceeds
    // its bound. Record it first, then stop further capture on overflow.
    this.#readBytes += byteLength;
    this.#assertReadLimit(this.#readBytes);
  }
  admitSource(source) { return source.byteLength <= this.maxArtifactBytes; }
  admitArtifact(bytes) { this.admitArtifacts([bytes]); return bytes; }
  admitArtifacts(artifacts) {
    if (!Array.isArray(artifacts) || artifacts.some((bytes) => !Buffer.isBuffer(bytes))) {
      throw new TypeError("Repair source publication requires exact Buffer bytes");
    }
    const byteLength = artifacts.reduce((total, bytes) => total + bytes.length, 0);
    if (artifacts.some((bytes) => bytes.length > this.maxArtifactBytes)
      || byteLength > this.maxSerializedBytes - this.#serializedBytes) {
      throw new WorkerArtifactHandoffError("invalid", "FLOW_SPEC_GATE_REPAIR_SNAPSHOT_LIMIT_EXCEEDED",
        "Repair source artifact exceeds its individual or aggregate serialization limit",
        { data: { failureKind: "step-admission", byteLength,
          serializedBytes: this.#serializedBytes, maxArtifactBytes: this.maxArtifactBytes,
          maxSerializedBytes: this.maxSerializedBytes } });
    }
    this.#serializedBytes += byteLength;
  }
}

/** Use existing catalog and regular-file readers; never execute a research worker. */
export function readSpecGateRepairSources({ flowManager, state, executionRoot, spec, captureBudget = new SpecGateRepairSourceCaptureBudget() }) {
  const sources = [];
  const addText = (id, origin, content, revision = createHash("sha256").update(content).digest("hex"), options = {}) => {
    const source = new SpecGateRepairSource({ id, origin, content, revision, ...options });
    if (!captureBudget.admitSource(source)) {
      throw new WorkerArtifactHandoffError("invalid", "FLOW_SPEC_GATE_REPAIR_SNAPSHOT_LIMIT_EXCEEDED",
        "Canonical repair source exceeds its individual artifact limit",
        { data: { failureKind: "step-admission", sourceId: source.id, byteLength: source.byteLength,
          maxArtifactBytes: captureBudget.maxArtifactBytes } });
    }
    sources.push(source);
  };
  addText("request", "flow.request", state.request ?? "");
  for (const logicalKey of ["issue.snapshot", "draft"]) {
    if (logicalKey === "issue.snapshot" && state.issue === null) continue;
    const artifact = flowManager.readArtifact({ specId: state.specId, logicalKey,
      consumerNodeId: "spec-gate-repair", optional: logicalKey === "draft", maxBytes: captureBudget.nextReadLimit,
      onRead: (byteLength) => captureBudget.recordRead(byteLength) });
    if (artifact !== null) {
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(artifact.bytes);
      addText(logicalKey, artifact.relativePath, content, artifact.descriptor.hash);
    }
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
    let snapshot;
    try {
      snapshot = captureRegularFile(absolute, { label: "repair captured evidence", maxBytes: captureBudget.nextReadLimit,
        onRead: (byteLength) => captureBudget.recordRead(byteLength) });
    } catch (error) {
      // The shared reader reports safe-file admission failures with its label;
      // filesystem refusal is evidence unavailability. Internal errors propagate.
      if (!["ENOENT", "EACCES", "EPERM", "EIO", "ELOOP", "ENOTDIR"].includes(error.code)
        && !error.message?.startsWith("repair captured evidence ")) throw error;
      addText(id, relative, "", "unavailable", { ...options, availability: "unavailable" });
      return;
    }
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot.bytes);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      addText(id, relative, "", "unavailable", { ...options, availability: "unavailable" });
      return;
    }
    addText(id, relative, content, snapshot.digest, options);
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
