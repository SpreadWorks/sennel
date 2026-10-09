import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runGit } from "../../lib/git-helpers.js";

const GIT_OBJECT_ID_RE = /^[0-9a-f]{40,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export class ReportBindingError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ReportBindingError";
    this.code = code;
  }
}

function reportBindingInvalid(message) {
  return new ReportBindingError("REPORT_BINDING_INVALID", message);
}

function reportBindingStale(message) {
  return new ReportBindingError("REPORT_BINDING_STALE", message);
}

function normalizeSourceArtifact(root, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw reportBindingInvalid("source artifact must be an object");
  }
  if (typeof source.path !== "string" || source.path.trim() === "") {
    throw reportBindingInvalid("source artifact path is required");
  }
  if (!SHA256_RE.test(source.sha256 || "")) {
    throw reportBindingInvalid("source artifact sha256 must be a SHA-256 digest");
  }
  const absolutePath = path.resolve(root, source.path);
  const relativePath = path.relative(root, absolutePath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw reportBindingInvalid("source artifact path must be project-relative");
  }
  return {
    path: relativePath.split(path.sep).join("/"),
    sha256: source.sha256,
  };
}

function currentGitTarget(root) {
  const head = runGit(["rev-parse", "HEAD"], { cwd: root });
  const tree = runGit(["rev-parse", "HEAD^{tree}"], { cwd: root });
  if (!head.ok || !tree.ok) {
    throw reportBindingInvalid("current Git target is unavailable");
  }
  return { headOid: head.stdout.trim(), treeSha: tree.stdout.trim() };
}

export class ReportBinding {
  constructor({ headOid, treeSha, sourceArtifacts } = {}) {
    if (!GIT_OBJECT_ID_RE.test(headOid || "") || !GIT_OBJECT_ID_RE.test(treeSha || "")) {
      throw reportBindingInvalid("headOid and treeSha must be Git object IDs");
    }
    if (!Array.isArray(sourceArtifacts)) {
      throw reportBindingInvalid("sourceArtifacts must be an array");
    }
    this.headOid = headOid;
    this.treeSha = treeSha;
    this.sourceArtifacts = sourceArtifacts.map((source) => ({ ...source }));
  }

  toJSON() {
    return {
      headOid: this.headOid,
      treeSha: this.treeSha,
      sourceArtifacts: this.sourceArtifacts.map((source) => ({ ...source })),
    };
  }

  static fromSourcePaths({ root, artifactRoot = root, sourcePaths }) {
    const target = currentGitTarget(root);
    const sourceArtifacts = sourcePaths.map((sourcePath) => {
      const absolutePath = path.resolve(artifactRoot, sourcePath);
      const bytes = fs.readFileSync(absolutePath);
      return {
        path: path.relative(artifactRoot, absolutePath).split(path.sep).join("/"),
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      };
    });
    return new ReportBinding({ ...target, sourceArtifacts });
  }

  static validate(binding, { root, artifactRoot = root, current = null }) {
    const parsed = new ReportBinding(binding);
    const normalizedSources = parsed.sourceArtifacts.map((source) => normalizeSourceArtifact(artifactRoot, source));
    const sourcePaths = new Set();
    for (const source of normalizedSources) {
      if (sourcePaths.has(source.path)) throw reportBindingInvalid("source artifact paths must be unique");
      sourcePaths.add(source.path);
    }
    const target = current || currentGitTarget(root);
    if (target.headOid !== parsed.headOid || target.treeSha !== parsed.treeSha) {
      throw reportBindingStale("Git target has changed");
    }
    for (const source of normalizedSources) {
      let bytes;
      try {
        bytes = fs.readFileSync(path.resolve(artifactRoot, source.path));
      } catch {
        throw reportBindingStale(`source artifact is unavailable: ${source.path}`);
      }
      const currentSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      if (currentSha256 !== source.sha256) {
        throw reportBindingStale(`source artifact has changed: ${source.path}`);
      }
    }
    return new ReportBinding({ ...parsed, sourceArtifacts: normalizedSources });
  }
}
