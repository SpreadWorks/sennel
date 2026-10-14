import { cpSync, existsSync, rmSync } from "node:fs";
import { createTmpDir } from "./tmp-dir.js";

export class SeedWorkRoot {
  constructor(seed, { prefix = "sennel-test-", parent } = {}) {
    if (!existsSync(seed)) throw new Error(`immutable seed does not exist: ${seed}`);
    if (!prefix.startsWith("sennel-")) throw new Error("test root prefix must be namespaced");
    this.seed = seed;
    this.root = createTmpDir(prefix, { parent });
    try {
      cpSync(seed, this.root, { recursive: true, force: false, errorOnExist: true });
    } catch (error) {
      this.cleanup();
      throw error;
    }
    if (this.root === this.seed) throw new Error("work root must differ from immutable seed");
  }

  cleanup() {
    rmSync(this.root, { recursive: true, force: true });
  }
}
