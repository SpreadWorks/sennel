import path from "node:path";
import { PRODUCT } from "../../lib/product.js";
import { ProcessLock } from "../../lib/process-lock.js";
import { RealDirectoryAuthority } from "../../lib/real-directory-authority.js";
import { FlowDispatchSession, flowDispatchDigest } from "./dispatch-invocation.js";

const DISPATCH_LOCK_KIND = "flow-dispatch";

function dispatchLockError(status, message, { lockPath, owner = null, cause } = {}) {
  const error = new Error(message, { cause });
  error.name = "FlowDispatchLockError";
  error.code = status === "live"
    ? "FLOW_DISPATCH_BUSY"
    : `FLOW_DISPATCH_LOCK_${status.replace(/-/g, "_").toUpperCase()}`;
  error.lockStatus = status;
  error.lockPath = lockPath;
  error.owner = owner;
  return error;
}

export class FlowDispatchLease {
  constructor(session) {
    if (!(session instanceof FlowDispatchSession)) {
      throw new Error("FlowDispatchLease requires a FlowDispatchSession");
    }
    this.session = session;
    const { target } = session;
    const mainRoot = target.dispatchLockRoot;
    if (!mainRoot) {
      throw new Error("FlowDispatchLease target requires captured authority");
    }
    const { runId } = target;
    const root = new RealDirectoryAuthority(mainRoot, {
      errorFactory: dispatchLockError,
    });
    const directory = new RealDirectoryAuthority(path.join(mainRoot, PRODUCT.managedDirName), {
      create: true,
      parentAuthority: root,
      errorFactory: dispatchLockError,
    });
    this.lock = new ProcessLock({
      directoryAuthority: directory,
      fileName: `.flow-dispatch-${flowDispatchDigest(runId).slice(0, 24)}.lock`,
      kind: DISPATCH_LOCK_KIND,
      authority: {
        runId,
        targetDigest: target.digest,
      },
      errorFactory: dispatchLockError,
    });
  }

  acquire() {
    return this.lock.acquire();
  }

  release() {
    this.lock.release();
  }
}
