import { RepositoryLockAuthority } from "./repository-control-lock.js";
import fs from "node:fs";
import crypto from "node:crypto";
import { PRODUCT } from "./product.js";
import path from "node:path";
import { FileLock } from "./file-lock.js";
import { RealDirectoryAuthority } from "./real-directory-authority.js";

const LOCK_KIND = "flow-handoff-authority";
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
  error.code = status === "busy"
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
  static pathFor({ mainRoot, executionRoot }) {
    const scope = executionRoot === mainRoot ? "repository" : "worktree";
    const scopeId = scope === "repository" ? "repository" : executionRoot;
    return RepositoryLockAuthority.pathFor(mainRoot, { namespace: "flow-handoff", identity: `${scope}:${scopeId}`, fileName: "handoff.lock" });
  }

  constructor({
    mainRoot,
    executionRoot,
    waitPolicy,
  } = {}) {
    this.mainRoot = fs.realpathSync(path.resolve(requiredText(mainRoot, "Flow handoff authority mainRoot")));
    this.executionRoot = fs.realpathSync(path.resolve(requiredText(executionRoot, "Flow handoff authority executionRoot")));
    new RealDirectoryAuthority(this.mainRoot).assertStable();
    new RealDirectoryAuthority(this.executionRoot).assertStable();
    this.scope = this.executionRoot === this.mainRoot ? "repository" : "worktree";
    this.scopeId = this.scope === "repository" ? "repository" : this.executionRoot;
    this.lock = new FileLock({
      location: new RepositoryLockAuthority(this.mainRoot, { errorFactory: lockError }).location({
        namespace: "flow-handoff", identity: `${this.scope}:${this.scopeId}`, fileName: "handoff.lock",
        legacyPaths: [path.join(this.mainRoot, PRODUCT.managedPath(`.flow-handoff-${this.scope}-${crypto.createHash("sha256").update(this.scopeId).digest("hex").slice(0, 24)}.lock`))],
      }),
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
