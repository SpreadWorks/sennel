import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AtomicJsonFile } from "../../lib/atomic-json-file.js";
import { ProcessLock } from "../../lib/process-lock.js";
import { RealDirectoryAuthority } from "../../lib/real-directory-authority.js";
import { RepositoryFlowOperationLock } from "../../lib/repository-maintenance-lock.js";
import { PRODUCT } from "../../lib/product.js";

const DIRECTORY = PRODUCT.managedPath("flow-execution-locks");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A running command owns its marker; abort never reclaims another actor's marker. */
export class FlowCommandExecutionLease {
  constructor({ mainRoot, runId, specId, id = crypto.randomUUID() }) {
    if (!UUID.test(id)) throw new TypeError("command execution lease id must be a UUID");
    if (typeof runId !== "string" || !runId.trim() || typeof specId !== "string" || !specId.trim()) {
      throw new TypeError("command execution lease requires a run and Spec identity");
    }
    const directoryAuthority = new RealDirectoryAuthority(path.join(mainRoot, DIRECTORY), { create: true });
    this.lock = new ProcessLock({ directoryAuthority, fileName: `${id}.lock`,
      kind: "flow-command-execution", authority: { runId, specId } });
  }

  static get repositoryPrefix() { return `${DIRECTORY}/`; }

  static ownsRepositoryPath(filePath) { return filePath.startsWith(this.repositoryPrefix); }

  static open(ctx) {
    const mainRoot = ctx.mainRoot || ctx.root;
    const operation = new RepositoryFlowOperationLock({ mainRoot });
    operation.acquire();
    try {
      const state = ctx.flowManager.loadReadOnly(ctx.flowState.specId);
      if (state?.runId !== ctx.flowState.runId) throw new Error("Flow changed before command execution");
      const lease = new FlowCommandExecutionLease({ mainRoot, runId: state.runId, specId: state.specId });
      lease.lock.acquire();
      ctx.flowState = state;
      return lease;
    } finally { operation.release(); }
  }

  static forRun({ mainRoot, runId }) {
    const directory = path.join(mainRoot, DIRECTORY);
    let names;
    try { names = fs.readdirSync(directory); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const leases = [];
    for (const name of names.filter((entry) => entry.endsWith(".lock"))) {
      const bytes = new AtomicJsonFile(path.join(directory, name)).readBytes(null);
      if (bytes === null) continue;
      const owner = JSON.parse(bytes.toString("utf8"));
      const lease = new FlowCommandExecutionLease({ mainRoot, runId: owner.runId, specId: owner.specId,
        id: name.slice(0, -".lock".length) });
      if (lease.lock.inspect() !== null && owner.runId === runId) leases.push(lease);
    }
    return leases;
  }

  release() { this.lock.release(); }
}
