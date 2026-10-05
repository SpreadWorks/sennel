import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FileLock, FileLockWaitPolicy } from "./file-lock.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";
import { PRODUCT } from "./product.js";

const LOCK_KIND = "flow-handoff-authority";
const WAIT_INTERVAL_MS = 50;

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function lockError(status, message, { lockPath, cause } = {}) {
  const error = new Error(message, { cause });
  error.name = status === "timeout"
    ? "FlowHandoffAuthorityLeaseTimeoutError"
    : "FlowHandoffAuthorityLeaseError";
  error.code = status === "live"
    ? "FLOW_HANDOFF_AUTHORITY_BUSY"
    : status === "timeout"
      ? "FLOW_HANDOFF_AUTHORITY_WAIT_TIMEOUT"
      : `FLOW_HANDOFF_AUTHORITY_LOCK_${status.replace(/-/g, "_").toUpperCase()}`;
  error.lockPath = lockPath;
  return error;
}

/**
 * Handoff authority lease held while a parent dispatcher delegates work to an
 * untrusted worker. Scope follows the checkout identity: main-checkout
 * direct/branch work shares the repository lock, while each worktree path
 * remains independent even if its Flow run changes.
 */
export class FlowHandoffAuthorityLease {
  constructor({
    mainRoot,
    executionRoot,
    waitPolicy = new FileLockWaitPolicy({ timeoutMs: Infinity, intervalMs: WAIT_INTERVAL_MS }),
  } = {}) {
    this.mainRoot = fs.realpathSync(path.resolve(requiredText(mainRoot, "Flow handoff authority mainRoot")));
    this.executionRoot = fs.realpathSync(path.resolve(requiredText(executionRoot, "Flow handoff authority executionRoot")));
    if (!fs.statSync(this.mainRoot).isDirectory() || !fs.statSync(this.executionRoot).isDirectory()) {
      throw new Error("Flow handoff authority roots must be real directories");
    }
    this.scope = this.executionRoot === this.mainRoot ? "repository" : "worktree";
    this.scopeId = this.scope === "repository" ? "repository" : this.executionRoot;
    const root = new RealDirectoryAuthority(this.mainRoot, { errorFactory: lockError });
    const directory = new RealDirectoryAuthority(path.join(this.mainRoot, PRODUCT.managedDirName), {
      create: true,
      parentAuthority: root,
      errorFactory: lockError,
    });
    this.lock = new FileLock({
      directoryAuthority: directory,
      fileName: `.flow-handoff-${this.scope}-${digest(this.scopeId).slice(0, 24)}.lock`,
      kind: LOCK_KIND,
      authority: { scope: this.scope, scopeId: this.scopeId },
      errorFactory: lockError,
      waitPolicy,
    });
  }

  acquire() {
    return this.lock.acquire();
  }

  release() {
    this.lock.release();
  }
}
