import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runGit } from "../../lib/git-helpers.js";
import { sanitizeGitRepositoryEnvironment } from "../../lib/git-repository-environment.js";
import {
  MAX_REVIEW_EVIDENCE_BYTES,
  REVIEW_EVIDENCE_VERSION,
  ReviewDisposition,
  ReviewEvidence,
  ReviewProvenance,
} from "./review-convergence.js";
import { RepairArtifactRegistry } from "./repair-state-identity.js";

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function reviewEvidenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function resolveCurrentReviewTreeSha(root, specPath = null) {
  const env = sanitizeGitRepositoryEnvironment();
  const tree = runGit(["rev-parse", "HEAD^{tree}"], { cwd: root, env });
  if (!tree.ok) {
    throw reviewEvidenceError(
      "REVIEW_TARGET_TREE_UNAVAILABLE",
      `failed to resolve current review target tree: ${tree.stderr.trim()}`,
    );
  }
  const registry = specPath == null ? null : new RepairArtifactRegistry(specPath);
  const diff = runGit([
    "diff",
    "--binary",
    "HEAD",
    ...(registry ? ["--", ".", ...registry.gitPathspecExcludes()] : []),
  ], { cwd: root, env });
  if (!diff.ok) {
    throw reviewEvidenceError(
      "REVIEW_TARGET_TREE_UNAVAILABLE",
      `failed to resolve current review target diff: ${diff.stderr.trim()}`,
    );
  }
  const treeSha = tree.stdout.trim().toLowerCase();
  if (diff.stdout === "") return treeSha;
  return crypto.createHash("sha1").update(treeSha).update("\0").update(diff.stdout).digest("hex");
}

function requireDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw reviewEvidenceError("REVIEW_EVIDENCE_INVALID", "review evidence must be a JSON object");
  }
  return value;
}

const REQUIRED_REVIEW_EVIDENCE_INPUT_FIELDS = Object.freeze([
  "version",
  "phase",
  "taskId",
  "treeSha",
  "provenance",
  "disposition",
  "blockingFindings",
  "advisoryFindings",
]);

export class ReviewEvidenceInput {
  constructor(input = {}) {
    const document = requireDocument(input);
    for (const field of REQUIRED_REVIEW_EVIDENCE_INPUT_FIELDS) {
      if (!Object.hasOwn(document, field)) {
        throw reviewEvidenceError("REVIEW_EVIDENCE_INVALID", `${field} is required`);
      }
    }
    if (Object.hasOwn(document, "identity") || Object.hasOwn(document, "evidenceDigest")) {
      throw reviewEvidenceError(
        "REVIEW_EVIDENCE_INVALID",
        "identity and evidenceDigest are computed by the CLI and cannot be supplied by a caller",
      );
    }
    try {
      if (document.version !== REVIEW_EVIDENCE_VERSION) {
        throw new Error(`version must be ${REVIEW_EVIDENCE_VERSION}`);
      }
      this.phase = document.phase;
      this.taskId = document.taskId;
      this.treeSha = document.treeSha;
      this.provenance = new ReviewProvenance(document.provenance);
      this.disposition = new ReviewDisposition({
        value: document.disposition,
        blockingFindings: document.blockingFindings,
        advisoryFindings: document.advisoryFindings,
      });
      this.evidence = new ReviewEvidence({
        version: document.version,
        phase: this.phase,
        taskId: this.taskId,
        treeSha: this.treeSha,
        targetStateDigest: document.targetStateDigest,
        provenance: this.provenance,
        disposition: this.disposition,
      });
    } catch (error) {
      if (error.code) throw error;
      throw reviewEvidenceError("REVIEW_EVIDENCE_INVALID", error.message);
    }
    Object.freeze(this);
  }

  static fromFile({ root, specDir, inputPath } = {}) {
    const resolvedRoot = path.resolve(root);
    const resolvedSpecDir = path.resolve(specDir);
    const resolvedInput = path.resolve(resolvedRoot, inputPath);
    if (!isInside(resolvedSpecDir, resolvedInput)) {
      throw reviewEvidenceError(
        "REVIEW_EVIDENCE_PATH_OUTSIDE_SPEC",
        "review evidence file must be inside the active spec directory",
      );
    }
    let stat;
    try {
      stat = fs.lstatSync(resolvedInput);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw reviewEvidenceError("REVIEW_EVIDENCE_FILE_INVALID", "review evidence file does not exist");
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw reviewEvidenceError("REVIEW_EVIDENCE_FILE_INVALID", "review evidence path must be a regular file");
    }
    if (!isInside(fs.realpathSync(resolvedSpecDir), fs.realpathSync(resolvedInput))) {
      throw reviewEvidenceError(
        "REVIEW_EVIDENCE_PATH_OUTSIDE_SPEC",
        "review evidence file must resolve inside the active spec directory",
      );
    }
    if (stat.size > MAX_REVIEW_EVIDENCE_BYTES) {
      throw reviewEvidenceError(
        "REVIEW_EVIDENCE_TOO_LARGE",
        `review evidence exceeds ${MAX_REVIEW_EVIDENCE_BYTES} bytes`,
      );
    }
    let document;
    try {
      document = JSON.parse(fs.readFileSync(resolvedInput, "utf8"));
    } catch (error) {
      throw reviewEvidenceError("REVIEW_EVIDENCE_INVALID", `review evidence JSON is invalid: ${error.message}`);
    }
    return new ReviewEvidenceInput(document);
  }

  validateTarget({ phase, taskId = null, treeSha, targetStateDigest = null } = {}) {
    if (this.phase !== phase) throw new Error(`review evidence phase target mismatch: ${this.phase} != ${phase}`);
    if (this.taskId !== (taskId ?? null)) {
      throw new Error(`review evidence task target mismatch: ${this.taskId} != ${taskId ?? null}`);
    }
    if (this.treeSha !== treeSha) {
      throw new Error(`review evidence tree target mismatch: ${this.treeSha} != ${treeSha}`);
    }
    if (targetStateDigest != null && this.evidence.targetStateDigest !== targetStateDigest) {
      throw new Error("review evidence state digest target mismatch");
    }
    return this;
  }

  toEvidence(target) {
    this.validateTarget(target);
    return this.evidence;
  }
}
