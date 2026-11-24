import { createHash } from "node:crypto";
import { SourceRepository } from "./source-repository.js";
import { OsAuditScope } from "./os-audit-scope.js";
import { OsIndependenceChecker } from "./os-independence-checker.js";
import { inspectInstructions } from "./os-instruction-checker.js";
import { StructureDiagnostic } from "./source-graph.js";

/** The reader and evidence consume the same bytes, including during edits. */
export class ObservedSourceRepository {
  #repository;
  #contents = new Map();
  constructor(repository) {
    this.#repository = repository;
    this.root = repository.root;
  }
  inventory(...args) { return this.#repository.inventory(...args); }
  list(...args) { return this.#repository.list(...args); }
  resolve(...args) { return this.#repository.resolve(...args); }
  observedFiles() { return [...this.#contents.keys()]; }
  read(file) {
    if (!this.#contents.has(file)) this.#contents.set(file, this.#repository.read(file));
    return this.#contents.get(file);
  }
}

export class SourceFileFingerprint {
  constructor(file, contents) {
    this.file = file;
    this.sha256 = createHash("sha256").update(contents).digest("hex");
    Object.freeze(this);
  }
}

export class SourceObservation {
  constructor(files) {
    if (!Array.isArray(files) || files.some((file) => !(file instanceof SourceFileFingerprint))) {
      throw new TypeError("source fingerprints required");
    }
    this.algorithm = "sha256";
    this.files = Object.freeze([...files]);
    const combined = createHash("sha256");
    for (const file of files) combined.update(JSON.stringify([file.file, file.sha256]) + "\n");
    this.digest = combined.digest("hex");
    Object.freeze(this);
  }
}

/** A rejected CLI invocation or unavailable audit is never a successful scan. */
export class OsAuditFailure {
  constructor(error) {
    this.ok = false;
    this.complete = false;
    this.source = null;
    this.scope = null;
    this.coverage = null;
    this.diagnostics = [new StructureDiagnostic("OS00", "package.json", null, ["package.json"], error.message, "incomplete")];
    this.exitCode = 2;
  }
}

/** One source observation, including files that could not be inspected. */
export class OsAuditReport {
  constructor(scope, check, instructions, source, diagnostics) {
    if (!(scope instanceof OsAuditScope) || !Array.isArray(diagnostics)) {
      throw new TypeError("audit scope and diagnostics required");
    }
    this.source = source;
    this.scope = scope;
    this.check = check;
    this.instructions = instructions;
    this.diagnostics = diagnostics;
  }

  get complete() { return !this.diagnostics.some((entry) => entry.classification === "incomplete"); }
  get ok() { return this.complete && this.diagnostics.length === 0; }
  get exitCode() { return this.ok ? 0 : this.complete ? 1 : 2; }

  toJSON() {
    return {
      source: this.source,
      scope: this.scope.coverage,
      coverage: { implementation: this.check.coverage, instructions: this.instructions.coverage },
      complete: this.complete,
      ok: this.ok,
      diagnostics: this.diagnostics,
      exitCode: this.exitCode,
    };
  }
}

/** Hash exactly the observed source, never evaluate it or launch its entrypoints. */
function sourceObservation(repository, scope, diagnostics) {
  const files = [];
  for (const file of [...new Set(["package.json", ...scope.files, ...scope.resources, ...repository.observedFiles()])].sort()) {
    try {
      const contents = repository.read(file);
      files.push(new SourceFileFingerprint(file, contents));
    } catch (error) {
      diagnostics.push(new StructureDiagnostic("OS00", file, null, [file],
        `Cannot fingerprint source: ${error.message}`, "incomplete"));
    }
  }
  return new SourceObservation(files);
}

/** Shared by the developer CLI and isolated repository integration tests. */
export function auditOsIndependence(repository) {
  repository = new ObservedSourceRepository(repository);
  const scope = new OsAuditScope(repository).discover();
  const check = new OsIndependenceChecker(repository, scope).check();
  const instructions = inspectInstructions(scope);
  const diagnostics = [...scope.diagnostics, ...check.diagnostics, ...instructions.diagnostics];
  const source = sourceObservation(repository, scope, diagnostics);
  return new OsAuditReport(scope, check, instructions, source, diagnostics);
}

export function auditOsIndependenceAt(root) {
  return auditOsIndependence(new SourceRepository(root));
}
