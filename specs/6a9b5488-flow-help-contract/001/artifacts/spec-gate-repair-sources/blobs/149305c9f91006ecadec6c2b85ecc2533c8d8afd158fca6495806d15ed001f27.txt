import crypto from "node:crypto";
import path from "node:path";

export const MAX_UNTRUSTED_WORK_UNIT_FILE_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const TREE_SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function exactObject(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has invalid fields`);
  return value;
}

function requiredDigest(value, field) {
  const digest = requiredText(value, field).toLowerCase();
  if (!SHA256.test(digest)) throw new Error(`${field} must be a SHA-256 digest`);
  return digest;
}

function requiredTreeSha(value, field) {
  const treeSha = requiredText(value, field).toLowerCase();
  if (!TREE_SHA.test(treeSha)) throw new Error(`${field} must be a Git tree SHA`);
  return treeSha;
}

export function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function logicalPath(value, field) {
  const text = requiredText(value, field);
  if (path.posix.normalize(text) !== text || path.posix.isAbsolute(text) || text.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

export class ReviewWorkUnitTarget {
  constructor(value = {}) {
    const source = exactObject(value, ["treeSha", "targetStateDigest"], "review work unit target");
    this.treeSha = requiredTreeSha(source.treeSha, "review work unit target treeSha");
    this.targetStateDigest = requiredDigest(source.targetStateDigest, "review work unit target targetStateDigest");
    Object.freeze(this);
  }

  toJSON() { return { treeSha: this.treeSha, targetStateDigest: this.targetStateDigest }; }

  equals(other) {
    return other instanceof ReviewWorkUnitTarget
      && this.treeSha === other.treeSha
      && this.targetStateDigest === other.targetStateDigest;
  }
}

export class ReviewWorkUnitOutput {
  constructor(value = {}) {
    const source = exactObject(value, ["logicalKey", "basename", "mediaType"], "review work unit output");
    this.logicalKey = requiredText(source.logicalKey, "review work unit output logicalKey");
    this.basename = requiredText(source.basename, "review work unit output basename");
    if (this.basename !== path.basename(this.basename) || !this.basename.endsWith(".json")) {
      throw new Error("review work unit output basename must be a JSON basename");
    }
    this.mediaType = requiredText(source.mediaType, "review work unit output mediaType");
    Object.freeze(this);
  }

  toJSON() { return { logicalKey: this.logicalKey, basename: this.basename, mediaType: this.mediaType }; }

  equals(other) {
    return other instanceof ReviewWorkUnitOutput && stableJson(this.toJSON()) === stableJson(other.toJSON());
  }

  static forReview({ phase, taskId = null } = {}) {
    const reviewPhase = requiredText(phase, "review work unit review phase");
    const task = taskId === null ? null : requiredText(taskId, "review work unit review taskId");
    const values = {
      "draft-questions": ["draft.questions.review", "draft-review-questions.json"],
      "draft-coverage": ["draft.coverage.review", "draft-review-coverage.json"],
      // Spec review is a full-input-bound V2 delta.  The parent alone merges
      // it into the revision-scoped `spec.review` authority.
      spec: ["spec.review", "review.delta.json"],
      test: ["test.requirement.review", "requirement-test-review.json"],
      impl: [task === null ? "impl.review" : "task.review", "impl-review.json"],
    }[reviewPhase];
    if (!values) throw new Error("review work unit review phase is unsupported");
    return new ReviewWorkUnitOutput({ logicalKey: values[0], basename: values[1], mediaType: "application/json" });
  }
}

export class ReviewWorkUnitInput {
  constructor(value = {}) {
    const source = exactObject(value, ["logicalKey", "logicalPath", "relativePath", "digest", "byteLength", "mediaType"], "review work unit input");
    this.logicalKey = requiredText(source.logicalKey, "review work unit input logicalKey");
    this.logicalPath = logicalPath(source.logicalPath, "review work unit input logicalPath");
    this.relativePath = logicalPath(source.relativePath, "review work unit input relativePath");
    this.digest = requiredDigest(source.digest, "review work unit input digest");
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0) {
      throw new Error("review work unit input byteLength is invalid");
    }
    this.byteLength = source.byteLength;
    this.mediaType = requiredText(source.mediaType, "review work unit input mediaType");
    Object.freeze(this);
  }

  toJSON() {
    return {
      logicalKey: this.logicalKey,
      logicalPath: this.logicalPath,
      relativePath: this.relativePath,
      digest: this.digest,
      byteLength: this.byteLength,
      mediaType: this.mediaType,
    };
  }

}

/** Parent-authoritative, exact worker contract. */
export class ReviewWorkUnitManifest {
  constructor(value = {}) {
    const source = exactObject(value, [
      "version", "runId", "specId", "phase", "taskId", "nodeId", "attemptId", "target", "inputs", "output",
    ], "review work unit manifest");
    if (source.version !== 1) throw new Error("review work unit manifest version must be 1");
    this.version = 1;
    this.runId = requiredText(source.runId, "review work unit manifest runId");
    this.specId = requiredText(source.specId, "review work unit manifest specId");
    this.phase = requiredText(source.phase, "review work unit manifest phase");
    this.taskId = source.taskId === null ? null : requiredText(source.taskId, "review work unit manifest taskId");
    this.nodeId = requiredText(source.nodeId, "review work unit manifest nodeId");
    this.attemptId = requiredText(source.attemptId, "review work unit manifest attemptId");
    this.target = source.target instanceof ReviewWorkUnitTarget ? source.target : new ReviewWorkUnitTarget(source.target);
    if (!Array.isArray(source.inputs)) throw new Error("review work unit manifest inputs must be an array");
    this.inputs = Object.freeze(source.inputs.map((input) => input instanceof ReviewWorkUnitInput ? input : new ReviewWorkUnitInput(input)));
    this.output = source.output instanceof ReviewWorkUnitOutput ? source.output : new ReviewWorkUnitOutput(source.output);
    Object.freeze(this);
  }

  toJSON() {
    return {
      version: this.version,
      runId: this.runId,
      specId: this.specId,
      phase: this.phase,
      taskId: this.taskId,
      nodeId: this.nodeId,
      attemptId: this.attemptId,
      target: this.target.toJSON(),
      inputs: this.inputs.map((input) => input.toJSON()),
      output: this.output.toJSON(),
    };
  }

  get digest() { return digest(stableJson(this.toJSON())); }
  get inputDigest() { return digest(stableJson(this.inputs.map((input) => input.toJSON()))); }

  equals(other) {
    return other instanceof ReviewWorkUnitManifest && this.digest === other.digest;
  }

  assertBinding(expected) {
    if (!(expected instanceof ReviewWorkUnitManifest) || !this.equals(expected)) {
      throw new Error("review worker manifest does not match the parent Attempt contract");
    }
    return this;
  }
}

export class ReviewWorkUnitSealedOutput {
  constructor(value = {}) {
    const source = exactObject(value, ["digest", "byteLength"], "review work unit sealed output");
    this.digest = requiredDigest(source.digest, "review work unit sealed output digest");
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0 || source.byteLength > MAX_UNTRUSTED_WORK_UNIT_FILE_BYTES) {
      throw new Error("review work unit sealed output byteLength is invalid");
    }
    this.byteLength = source.byteLength;
    Object.freeze(this);
  }

  toJSON() { return { digest: this.digest, byteLength: this.byteLength }; }

  equals(other) {
    return other instanceof ReviewWorkUnitSealedOutput
      && this.digest === other.digest
      && this.byteLength === other.byteLength;
  }
}

/** Immutable proof that the declared worker output and inputs were observed. */
export class ReviewWorkUnitSeal {
  constructor(value = {}) {
    const source = exactObject(value, ["version", "manifestDigest", "runId", "specId", "nodeId", "attemptId", "target", "inputDigest", "output"], "review work unit seal");
    if (source.version !== 1) throw new Error("review work unit seal version must be 1");
    this.version = 1;
    this.manifestDigest = requiredDigest(source.manifestDigest, "review work unit seal manifestDigest");
    this.runId = requiredText(source.runId, "review work unit seal runId");
    this.specId = requiredText(source.specId, "review work unit seal specId");
    this.nodeId = requiredText(source.nodeId, "review work unit seal nodeId");
    this.attemptId = requiredText(source.attemptId, "review work unit seal attemptId");
    this.target = source.target instanceof ReviewWorkUnitTarget ? source.target : new ReviewWorkUnitTarget(source.target);
    this.inputDigest = requiredDigest(source.inputDigest, "review work unit seal inputDigest");
    this.output = source.output instanceof ReviewWorkUnitSealedOutput
      ? source.output
      : new ReviewWorkUnitSealedOutput(source.output);
    Object.freeze(this);
  }

  static forManifest(manifest, snapshot) {
    if (!(manifest instanceof ReviewWorkUnitManifest)) throw new Error("review work unit seal requires a manifest");
    return new ReviewWorkUnitSeal({
      version: 1,
      manifestDigest: manifest.digest,
      runId: manifest.runId,
      specId: manifest.specId,
      nodeId: manifest.nodeId,
      attemptId: manifest.attemptId,
      target: manifest.target.toJSON(),
      inputDigest: manifest.inputDigest,
      output: new ReviewWorkUnitSealedOutput({ digest: snapshot.digest, byteLength: snapshot.byteLength }),
    });
  }

  toJSON() {
    return {
      version: this.version,
      manifestDigest: this.manifestDigest,
      runId: this.runId,
      specId: this.specId,
      nodeId: this.nodeId,
      attemptId: this.attemptId,
      target: this.target.toJSON(),
      inputDigest: this.inputDigest,
      output: this.output.toJSON(),
    };
  }

  assertManifest(manifest) {
    if (!(manifest instanceof ReviewWorkUnitManifest)
      || this.manifestDigest !== manifest.digest
      || this.runId !== manifest.runId
      || this.specId !== manifest.specId
      || this.nodeId !== manifest.nodeId
      || this.attemptId !== manifest.attemptId
      || !this.target.equals(manifest.target)
      || this.inputDigest !== manifest.inputDigest) {
      throw new Error("review work unit seal does not match its Attempt contract");
    }
    return this;
  }
}

/** Typed durable receipt for the exact sealed worker output. */
export class ReviewWorkUnitOutputReceipt {
  constructor(value = {}) {
    const source = exactObject(value, ["digest", "byteLength", "mediaType"], "review work unit output receipt");
    this.digest = requiredDigest(source.digest, "review work unit output receipt digest");
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0 || source.byteLength > MAX_UNTRUSTED_WORK_UNIT_FILE_BYTES) {
      throw new Error("review work unit output receipt byteLength is invalid");
    }
    this.byteLength = source.byteLength;
    this.mediaType = requiredText(source.mediaType, "review work unit output receipt mediaType");
    Object.freeze(this);
  }

  toJSON() { return { digest: this.digest, byteLength: this.byteLength, mediaType: this.mediaType }; }

  equals(other) {
    return other instanceof ReviewWorkUnitOutputReceipt && stableJson(this.toJSON()) === stableJson(other.toJSON());
  }
}

/** A parent-created execution work unit whose manifest is the child contract. */
