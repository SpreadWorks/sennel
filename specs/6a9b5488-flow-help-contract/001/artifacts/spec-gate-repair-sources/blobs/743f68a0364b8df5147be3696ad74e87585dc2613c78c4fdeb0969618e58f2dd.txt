import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function exactObject(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has invalid fields`);
  }
  return value;
}

/**
 * A digest-bound document copied from the permanent artifact catalog into a
 * transient review work unit. The child receives this descriptor, never a
 * Version-root path to infer or reopen independently.
 */
export class CanonicalReviewInputDescriptor {
  constructor(value) {
    const source = exactObject(value, [
      "version", "logicalKey", "logicalPath", "sourcePath", "digest", "byteLength",
    ], "canonical review input descriptor");
    if (source.version !== 1) throw new Error("canonical review input descriptor version must be 1");
    this.version = 1;
    this.logicalKey = requiredText(source.logicalKey, "canonical review input logicalKey");
    this.logicalPath = requiredText(source.logicalPath, "canonical review input logicalPath");
    this.sourcePath = path.resolve(requiredText(source.sourcePath, "canonical review input sourcePath"));
    this.digest = requiredText(source.digest, "canonical review input digest").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(this.digest)) {
      throw new Error("canonical review input digest must be SHA-256");
    }
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0) {
      throw new Error("canonical review input byteLength must be a non-negative safe integer");
    }
    this.byteLength = source.byteLength;
    Object.freeze(this);
  }

  static fromEnvironment(serialized, {
    variable,
    logicalKey,
    logicalPath,
    workUnitDirectory,
    optional = false,
  } = {}) {
    if (serialized == null || String(serialized).trim() === "") {
      if (optional) return null;
      throw new Error(`${requiredText(variable, "canonical review input environment variable")} is required`);
    }
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw new Error(`${variable} must be JSON: ${error.message}`);
    }
    const descriptor = new CanonicalReviewInputDescriptor(parsed);
    descriptor.assertBinding({ logicalKey, logicalPath, workUnitDirectory });
    return descriptor;
  }

  assertBinding({ logicalKey, logicalPath, workUnitDirectory } = {}) {
    const expectedKey = requiredText(logicalKey, "canonical review input expected logicalKey");
    const expectedPath = requiredText(logicalPath, "canonical review input expected logicalPath");
    const directory = path.resolve(requiredText(workUnitDirectory, "canonical review work-unit directory"));
    if (this.logicalKey !== expectedKey || this.logicalPath !== expectedPath) {
      throw new Error(`canonical review input must bind ${expectedKey}/${expectedPath}`);
    }
    const expectedSourcePath = path.join(directory, "inputs", expectedPath);
    if (this.sourcePath !== expectedSourcePath) {
      throw new Error(`canonical review input source must be ${path.relative(directory, expectedSourcePath)}`);
    }
    return this;
  }

  readBytes() {
    const stat = fs.lstatSync(this.sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("canonical review input source must be a regular unlinked file");
    }
    const bytes = fs.readFileSync(this.sourcePath);
    if (bytes.length !== this.byteLength) {
      throw new Error("canonical review input byteLength does not match its source");
    }
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== this.digest) {
      throw new Error("canonical review input digest does not match its source");
    }
    return bytes;
  }

  readJsonObject() {
    let value;
    try {
      value = JSON.parse(this.readBytes().toString("utf8"));
    } catch (error) {
      throw new Error(`canonical review input ${this.logicalKey} must be JSON: ${error.message}`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`canonical review input ${this.logicalKey} must be an object`);
    }
    return value;
  }

  toJSON() {
    return {
      version: this.version,
      logicalKey: this.logicalKey,
      logicalPath: this.logicalPath,
      sourcePath: this.sourcePath,
      digest: this.digest,
      byteLength: this.byteLength,
    };
  }
}
