import crypto from "node:crypto";
import path from "node:path";
import { PRODUCT } from "../../lib/product.js";
import { ProcessLock } from "../../lib/process-lock.js";
import { RealDirectoryAuthority } from "../../lib/real-directory-authority.js";

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function leaseError(status, message, { lockPath, owner = null, cause } = {}) {
  const error = new Error(message, { cause });
  error.name = "ReviewExecutionLeaseError";
  error.code = status === "live" ? "REVIEW_EXECUTION_BUSY" : `REVIEW_EXECUTION_LOCK_${status.replace(/-/g, "_").toUpperCase()}`;
  error.lockStatus = status;
  error.lockPath = lockPath;
  error.owner = owner;
  return error;
}

/** One provider admission for one canonical review Attempt. */
export class ReviewExecutionLease {
  constructor({ mainRoot, runId, nodeId, attemptId } = {}) {
    const rootPath = requiredText(mainRoot, "review execution lease mainRoot");
    const identity = [runId, nodeId, attemptId].map((value, index) => requiredText(value, `review execution lease identity[${index}]`)).join("\0");
    const root = new RealDirectoryAuthority(rootPath, { errorFactory: leaseError });
    const managedDirectory = new RealDirectoryAuthority(path.join(rootPath, PRODUCT.managedDirName), {
      create: true,
      parentAuthority: root,
      errorFactory: leaseError,
    });
    // Keep process-only admission state in its own directory. Source-effect
    // baselines may safely exclude this narrow runtime surface without hiding
    // canonical receipts or provider-written repository files.
    const directory = new RealDirectoryAuthority(path.join(managedDirectory.directory, "review-execution-locks"), {
      create: true,
      parentAuthority: managedDirectory,
      errorFactory: leaseError,
    });
    this.managedDirectory = managedDirectory;
    this.lock = new ProcessLock({
      directoryAuthority: directory,
      fileName: `.review-execution-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24)}.lock`,
      kind: "review-execution",
      authority: { runId, nodeId, attemptId },
      errorFactory: leaseError,
    });
    Object.freeze(this);
  }

  acquire() {
    this.managedDirectory.ensure();
    return this.lock.acquire();
  }
  release() { this.lock.release(); }
}
