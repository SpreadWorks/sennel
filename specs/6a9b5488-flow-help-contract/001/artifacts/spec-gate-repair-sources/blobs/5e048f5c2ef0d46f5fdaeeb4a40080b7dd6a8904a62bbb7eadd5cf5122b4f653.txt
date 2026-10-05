import fs from "node:fs";
import path from "node:path";

import { getSpecTestFiles } from "./test-headers.js";

const STATIC_IMPORT_RE = /(?:^|\n)\s*(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+(?:\*|\{[\s\S]*?\})\s+from\s+)(["'])([^"']+)\1/g;

function maskCommentsAndTemplates(source) {
  const chars = [...source];
  let state = "code";
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        state = "line-comment";
      } else if (char === "/" && next === "*") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        state = "block-comment";
      } else if (char === "`") {
        chars[index] = " ";
        state = "template";
      } else if (char === "'") {
        state = "single-quote";
      } else if (char === '"') {
        state = "double-quote";
      }
      continue;
    }
    if (state === "line-comment") {
      if (char === "\n") state = "code";
      else chars[index] = " ";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        state = "code";
      } else if (char !== "\n") {
        chars[index] = " ";
      }
      continue;
    }
    if (state === "template") {
      if (char === "\\" && next !== undefined) {
        chars[index] = " ";
        if (next !== "\n") chars[index + 1] = " ";
        index += 1;
      } else if (char === "`") {
        chars[index] = " ";
        state = "code";
      } else if (char !== "\n") {
        chars[index] = " ";
      }
      continue;
    }
    const quote = state === "single-quote" ? "'" : '"';
    if (char === "\\" && next !== undefined) index += 1;
    else if (char === quote) state = "code";
  }
  return chars.join("");
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function existingRegularFile(file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

class SpecTestStaticImport {
  constructor({ file, specifier, line }) {
    this.file = file;
    this.specifier = specifier;
    this.line = line;
    Object.freeze(this);
  }

  static fromSource(file, source) {
    const imports = [];
    const searchableSource = maskCommentsAndTemplates(source);
    STATIC_IMPORT_RE.lastIndex = 0;
    let match;
    while ((match = STATIC_IMPORT_RE.exec(searchableSource)) !== null) {
      const specifier = match[2];
      if (!specifier.startsWith(".")) continue;
      const statementStart = match.index + (match[0].startsWith("\n") ? 1 : 0);
      imports.push(new SpecTestStaticImport({
        file,
        specifier,
        line: source.slice(0, statementStart).split("\n").length,
      }));
    }
    return imports;
  }
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an invalid schema`);
  }
}

/** A single static test import which cannot resolve before implementation. */
export class SpecTestBootstrapIssue {
  constructor({ relativeTestFile, specifier, line, expectedPath }) {
    this.relativeTestFile = requiredText(relativeTestFile, "bootstrap issue relativeTestFile");
    this.specifier = requiredText(specifier, "bootstrap issue specifier");
    if (!Number.isInteger(line) || line < 1) {
      throw new Error("bootstrap issue line must be a positive integer");
    }
    this.line = line;
    this.expectedPath = requiredText(expectedPath, "bootstrap issue expectedPath");
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, ["relativeTestFile", "specifier", "line", "expectedPath"], "bootstrap issue");
    return new SpecTestBootstrapIssue(value);
  }

  toString() {
    return `${this.relativeTestFile}:${this.line} statically imports missing pre-implementation module ${this.specifier} (${this.expectedPath})`;
  }

  toJSON() {
    return {
      relativeTestFile: this.relativeTestFile,
      specifier: this.specifier,
      line: this.line,
      expectedPath: this.expectedPath,
    };
  }
}

export class SpecTestBootstrapValidation {
  constructor(issues) {
    if (!Array.isArray(issues) || issues.some((issue) => !(issue instanceof SpecTestBootstrapIssue))) {
      throw new Error("spec test bootstrap validation requires typed issues");
    }
    this.issues = Object.freeze([...issues]);
    Object.freeze(this);
  }

  get ok() {
    return this.issues.length === 0;
  }

  assertValid() {
    if (!this.ok) throw new SpecTestBootstrapValidationError(this);
  }
}

/**
 * Latest canonical observation of test bootstrap validity. A clean observation
 * deliberately replaces a prior deferred one, preventing stale imports from
 * being presented to Requirement review or Gate after a later repair.
 */
export class SpecTestBootstrapObservation {
  constructor({ actionDigest, inputDigest, inputRevision, handoffDigest, issues }) {
    this.version = 1;
    this.actionDigest = requiredDigest(actionDigest, "bootstrap observation actionDigest");
    this.inputDigest = requiredDigest(inputDigest, "bootstrap observation inputDigest");
    this.inputRevision = requiredDigest(inputRevision, "bootstrap observation inputRevision");
    this.handoffDigest = requiredDigest(handoffDigest, "bootstrap observation handoffDigest");
    if (!Array.isArray(issues) || issues.some((issue) => !(issue instanceof SpecTestBootstrapIssue))) {
      throw new Error("bootstrap observation requires typed issues");
    }
    this.issues = Object.freeze([...issues]);
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, ["version", "actionDigest", "inputDigest", "inputRevision", "handoffDigest", "issues"], "bootstrap observation");
    if (value.version !== 1 || !Array.isArray(value.issues)) {
      throw new Error("bootstrap observation has an invalid version or issues");
    }
    return new SpecTestBootstrapObservation({
      ...value,
      issues: value.issues.map((issue) => SpecTestBootstrapIssue.fromJSON(issue)),
    });
  }

  get deferred() {
    return this.issues.length > 0;
  }

  toJSON() {
    return {
      version: this.version,
      actionDigest: this.actionDigest,
      inputDigest: this.inputDigest,
      inputRevision: this.inputRevision,
      handoffDigest: this.handoffDigest,
      issues: this.issues.map((issue) => issue.toJSON()),
    };
  }
}

/** Read the typed, catalog-authorized observation for a downstream test step. */
export function readCanonicalSpecTestBootstrapObservation({ flowManager, specId, consumerNodeId }) {
  if (!flowManager || typeof flowManager.readArtifact !== "function") {
    throw new Error("bootstrap observation reader requires a canonical Flow manager");
  }
  const artifact = flowManager.readArtifact({
    specId,
    logicalKey: "test.bootstrap.observation",
    consumerNodeId: requiredText(consumerNodeId, "bootstrap observation consumerNodeId"),
    optional: true,
  });
  if (artifact === null) return null;
  let document;
  try {
    document = JSON.parse(artifact.bytes.toString("utf8"));
  } catch (cause) {
    throw new Error(`canonical bootstrap observation is malformed JSON: ${cause.message}`);
  }
  return SpecTestBootstrapObservation.fromJSON(document);
}

export class SpecTestBootstrapValidationError extends Error {
  constructor(validation) {
    if (!(validation instanceof SpecTestBootstrapValidation) || validation.ok) {
      throw new Error("spec test bootstrap validation error requires failing validation");
    }
    super(validation.issues.map((issue) => issue.toString()).join("; "));
    this.name = "SpecTestBootstrapValidationError";
    this.validation = validation;
  }
}

/**
 * Spec tests are published from a dispatcher handoff but execute from their
 * canonical base-side location. Static relative imports must therefore resolve
 * before implementation begins. Future modules belong behind a caught dynamic
 * import so their absence becomes an R-N assertion failure instead of aborting
 * the complete test file during module bootstrap.
 */
export class SpecTestBootstrapValidator {
  constructor({ payloadSpecDir, canonicalSpecDir, repositoryRoot, executionRoot }) {
    this.payloadSpecDir = path.resolve(payloadSpecDir);
    this.payloadTestsDir = path.join(this.payloadSpecDir, "tests");
    this.canonicalSpecDir = path.resolve(canonicalSpecDir);
    this.canonicalTestsDir = path.join(this.canonicalSpecDir, "tests");
    this.specRoot = path.dirname(this.canonicalSpecDir);
    this.repositoryRoot = path.resolve(repositoryRoot);
    this.executionRoot = path.resolve(executionRoot);
    Object.freeze(this);
  }

  expectedTarget(imported) {
    const relativeTestFile = path.relative(this.payloadTestsDir, imported.file);
    const canonicalTestFile = path.join(this.canonicalTestsDir, relativeTestFile);
    const specifierPath = imported.specifier.split(/[?#]/, 1)[0];
    const canonicalTarget = path.resolve(path.dirname(canonicalTestFile), specifierPath);
    if (isWithin(this.canonicalTestsDir, canonicalTarget)) {
      return path.join(this.payloadTestsDir, path.relative(this.canonicalTestsDir, canonicalTarget));
    }
    if (isWithin(this.specRoot, canonicalTarget)) return canonicalTarget;
    if (isWithin(this.repositoryRoot, canonicalTarget)) {
      return path.join(this.executionRoot, path.relative(this.repositoryRoot, canonicalTarget));
    }
    return canonicalTarget;
  }

  validate() {
    const issues = [];
    for (const file of getSpecTestFiles(this.payloadSpecDir)) {
      const source = fs.readFileSync(file, "utf8");
      for (const imported of SpecTestStaticImport.fromSource(file, source)) {
        const expectedPath = this.expectedTarget(imported);
        if (existingRegularFile(expectedPath)) continue;
        issues.push(new SpecTestBootstrapIssue({
          relativeTestFile: path.relative(this.payloadTestsDir, file),
          specifier: imported.specifier,
          line: imported.line,
          expectedPath: path.relative(this.executionRoot, expectedPath),
        }));
      }
    }
    return new SpecTestBootstrapValidation(issues);
  }
}
