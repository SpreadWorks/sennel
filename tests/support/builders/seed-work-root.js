import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export class SeedWorkRoot {
  constructor(seed, { prefix = "sennel-test-", parent = tmpdir() } = {}) {
    if (!existsSync(seed)) throw new Error(`immutable seed does not exist: ${seed}`);
    if (!prefix.startsWith("sennel-")) throw new Error("test root prefix must be namespaced");
    this.seed = seed;
    this.root = mkdtempSync(join(parent, prefix));
    cpSync(seed, this.root, { recursive: true, force: false, errorOnExist: true });
    if (this.root === this.seed) throw new Error("work root must differ from immutable seed");
  }

  cleanup() {
    rmSync(this.root, { recursive: true, force: true });
  }
}
