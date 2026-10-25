import { RepositoryLockAuthority } from "../../lib/repository-control-lock.js";
import { ProcessLock } from "../../lib/process-lock.js";
import path from "node:path";
import { PRODUCT } from "../../lib/product.js";
import { FlowDispatchSession, flowDispatchDigest } from "./dispatch-invocation.js";

const DISPATCH_LOCK_KIND = "flow-dispatch";

function dispatchLockError(status, message, { lockPath, owner = null, cause } = {}) {
  const error = new Error(message, { cause });
  error.name = "FlowDispatchLockError";
  error.code = status === "busy"
    ? "FLOW_DISPATCH_BUSY"
    : `FLOW_DISPATCH_LOCK_${status.replace(/-/g, "_").toUpperCase()}`;
  error.lockStatus = status;
  error.lockPath = lockPath;
  error.owner = owner;
  return error;
}

export class FlowDispatchLease {
  static pathFor(mainRoot, runId) {
    return RepositoryLockAuthority.pathFor(mainRoot, { namespace: "flow-dispatch", identity: runId, fileName: "dispatch.lock" });
  }

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
    this.lock = new ProcessLock({
      location: new RepositoryLockAuthority(mainRoot, { errorFactory: dispatchLockError }).location({
        namespace: "flow-dispatch", identity: runId, fileName: "dispatch.lock",
        legacyPaths: [path.join(mainRoot, PRODUCT.managedPath(`.flow-dispatch-${flowDispatchDigest(runId).slice(0, 24)}.lock`))],
      }),
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
