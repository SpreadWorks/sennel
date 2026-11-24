import { PRODUCT } from "../../lib/product.js";
import { RepositoryLockAuthority } from "../../lib/repository-control-lock.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AtomicJsonFile } from "../../lib/atomic-json-file.js";
import { ProcessLock } from "../../lib/process-lock.js";

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function leaseError(status, message, { lockPath, owner = null, cause } = {}) {
  const error = new Error(message, { cause });
  error.name = "ReviewExecutionLeaseError";
  error.code = status === "busy" ? "REVIEW_EXECUTION_BUSY" : `REVIEW_EXECUTION_LOCK_${status.replace(/-/g, "_").toUpperCase()}`;
  error.lockStatus = status;
  error.lockPath = lockPath;
  error.owner = owner;
  return error;
}

/** One provider admission for one canonical review Attempt. */
function lockLocation(mainRoot, fileName) {
  return new RepositoryLockAuthority(mainRoot, { errorFactory: leaseError }).location({
    namespace: "review-execution", identity: "leases", fileName,
    legacyDirectories: [path.join(mainRoot, PRODUCT.managedPath("review-execution-locks"))],
  });
}

export class ReviewExecutionLease {
  /** Resolve existing owners without reclaiming an interrupted Review. */
  static forRun({ mainRoot, runId }) {
    const location = lockLocation(mainRoot, "index.lock");
    location.resolve();
    const directory = location.directory;
    let names;
    try { names = fs.readdirSync(directory); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const leases = [];
    for (const name of names.filter((entry) => entry.endsWith(".lock"))) {
      const file = path.join(directory, name);
      const bytes = new AtomicJsonFile(file).readBytes(null);
      if (bytes === null) continue;
      const owner = JSON.parse(bytes.toString("utf8"));
      requiredText(owner.runId, "Review owner runId");
      const lease = new ReviewExecutionLease({ mainRoot, runId: owner.runId,
        nodeId: owner.nodeId, attemptId: owner.attemptId });
      if (lease.lock.lockPath !== file) throw new Error("Review owner does not match its lock location");
      if (lease.lock.inspect() !== null && owner.runId === runId) leases.push(lease);
    }
    return leases;
  }

  constructor({ mainRoot, runId, nodeId, attemptId } = {}) {
    const rootPath = requiredText(mainRoot, "review execution lease mainRoot");
    const identity = [runId, nodeId, attemptId].map((value, index) => requiredText(value, `review execution lease identity[${index}]`)).join("\0");
    this.lock = new ProcessLock({
      location: lockLocation(rootPath, `.review-execution-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24)}.lock`),
      kind: "review-execution",
      authority: { runId, nodeId, attemptId },
      errorFactory: leaseError,
    });
    Object.freeze(this);
  }

  acquire() {
    return this.lock.acquire();
  }
  release() { this.lock.release(); }
}
