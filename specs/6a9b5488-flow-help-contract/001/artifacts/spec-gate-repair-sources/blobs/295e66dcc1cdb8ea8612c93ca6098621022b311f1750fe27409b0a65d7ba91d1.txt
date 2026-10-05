import { PRODUCT } from "./product.js";

export const FINALIZE_CLEANUP_DURABLE_AGENT_WORK_DIR = PRODUCT.managedPath("agent-work");

export class FinalizeCleanupRoute {
  constructor({ command = null } = {}) {
    if (command != null && typeof command !== "string") {
      throw new Error("finalize cleanup route command must be a string");
    }
    this.command = command;
    Object.freeze(this);
  }

  static fromCliArgs(argv = []) {
    if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")) {
      throw new Error("finalize cleanup CLI arguments must contain only strings");
    }
    if (argv[0] !== "flow" || argv[1] !== "run") {
      return new FinalizeCleanupRoute();
    }
    return new FinalizeCleanupRoute({ command: argv[2] ?? null });
  }

  static fromDispatch({ envelopeKey = null } = {}) {
    return new FinalizeCleanupRoute({ command: envelopeKey });
  }

  get removesManagedWorktree() {
    return this.command === "finalize-cleanup";
  }
}
