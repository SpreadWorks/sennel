import { cpSync, existsSync, rmSync } from "node:fs";
import { createTmpDir } from "./tmp-dir.js";
import { performance } from "node:perf_hooks";

/** Optional test diagnostics, kept outside all canonical artifacts. */
export function observeSeedTiming(event, elapsedMs) {
  if (process.env.SENNEL_TEST_SEED_TIMING === "1") {
    process.stdout.write(`[sennel-test-seed] ${JSON.stringify({ event, elapsedMs })}\n`);
  }
}

/** Register the owning file hook immediately; lazy producers only add cleanup. */
export class SeedCleanupScope {
  constructor(registerAfter, mock) {
    this.mock = mock;
    this.cleanups = [];
    registerAfter(() => this.cleanup());
  }

  after(cleanup) { this.cleanups.push(cleanup); }

  async cleanup() {
    const failures = [];
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try { await cleanup(); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "seed owner cleanup failed");
  }
}

export class SeedWorkRoot {
  constructor(seed, { prefix = "sennel-test-", parent, copy = cpSync } = {}) {
    if (!existsSync(seed)) throw new Error(`immutable seed does not exist: ${seed}`);
    if (!prefix.startsWith("sennel-")) throw new Error("test root prefix must be namespaced");
    this.seed = seed;
    this.root = createTmpDir(prefix, { parent });
    const started = performance.now();
    try {
      copy(seed, this.root, { recursive: true, force: false, errorOnExist: true });
    } catch (error) {
      this.cleanup();
      throw error;
    }
    this.copyDurationMs = performance.now() - started;
    observeSeedTiming("copy", this.copyDurationMs);
    if (this.root === this.seed) throw new Error("work root must differ from immutable seed");
  }

  cleanup() {
    const started = performance.now();
    rmSync(this.root, { recursive: true, force: true });
    this.cleanupDurationMs = performance.now() - started;
    observeSeedTiming("root-cleanup", this.cleanupDurationMs);
  }
}
