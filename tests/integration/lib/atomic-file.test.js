import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { AtomicFile } from "../../../src/lib/atomic-file.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

describe("AtomicFile", () => {
  it("keeps the old visible bytes and removes temporary files for pre-commit faults", () => {
    for (const phase of ["before-file-temp-write", "before-file-fsync", "before-file-rename"]) {
      const root = createTmpDir(`atomic-file-${phase}-`);
      try {
        const file = path.join(root, "state.bin");
        fs.writeFileSync(file, "old-complete");

        assert.throws(
          () => new AtomicFile(file, {
            faultInjector(event) {
              if (event.phase === phase) throw new Error(`fault at ${phase}`);
            },
          }).write(Buffer.from("new-complete")),
          new RegExp(`fault at ${phase}`),
        );

        assert.equal(fs.readFileSync(file, "utf8"), "old-complete", phase);
        assert.deepEqual(fs.readdirSync(root), ["state.bin"], phase);
      } finally {
        removeTmpDir(root);
      }
    }
  });

  it("publishes complete bytes and reports unconfirmed publication after rename", () => {
    const root = createTmpDir("atomic-file-durability-");
    try {
      const file = path.join(root, "state.bin");
      fs.writeFileSync(file, "old-complete");

      assert.throws(
        () => new AtomicFile(file, {
          faultInjector(event) {
            if (event.phase === "before-file-readback") {
              throw new Error("readback fault");
            }
          },
        }).write(Buffer.from("new-complete")),
        (error) => error.code === "ATOMIC_FILE_PUBLICATION_UNCERTAIN" && error.committed === true,
      );

      assert.equal(fs.readFileSync(file, "utf8"), "new-complete");
      assert.deepEqual(fs.readdirSync(root), ["state.bin"]);
    } finally {
      removeTmpDir(root);
    }
  });

  it("runs the commit guard after before-rename injection without replacing concurrent bytes", () => {
    const root = createTmpDir("atomic-file-commit-guard-");
    try {
      const file = path.join(root, "state.bin");
      fs.writeFileSync(file, "old-complete");

      assert.throws(
        () => new AtomicFile(file, {
          faultInjector(event) {
            if (event.phase === "before-file-rename") {
              fs.writeFileSync(file, "concurrent-complete");
            }
          },
          commitGuard() {
            if (fs.readFileSync(file, "utf8") !== "old-complete") {
              throw new Error("visible file changed before commit");
            }
          },
        }).write(Buffer.from("new-complete")),
        /visible file changed before commit/,
      );

      assert.equal(fs.readFileSync(file, "utf8"), "concurrent-complete");
      assert.deepEqual(fs.readdirSync(root), ["state.bin"]);
    } finally {
      removeTmpDir(root);
    }
  });

  it("leaves either the old or new complete visible bytes across interrupted process boundaries", () => {
    const moduleUrl = pathToFileURL(path.resolve("src/lib/atomic-file.js")).href;
    for (const [phase, expected] of [
      ["before-file-rename", "old-complete"],
      ["before-file-readback", "new-complete"],
    ]) {
      const root = createTmpDir(`atomic-file-kill-${phase}-`);
      try {
        const file = path.join(root, "state.bin");
        fs.writeFileSync(file, "old-complete");
        const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
          import { AtomicFile } from ${JSON.stringify(moduleUrl)};
          new AtomicFile(${JSON.stringify(file)}, {
            faultInjector(event) {
              if (event.phase === ${JSON.stringify(phase)}) process.exit(71);
            },
          }).write(Buffer.from("new-complete"));
        `], { encoding: "utf8" });

        assert.equal(child.status, 71, child.stderr);
        assert.equal(fs.readFileSync(file, "utf8"), expected, phase);
      } finally {
        removeTmpDir(root);
      }
    }
  });
});
