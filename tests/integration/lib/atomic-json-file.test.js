import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { AtomicJsonFile } from "../../../src/lib/atomic-json-file.js";

describe("AtomicJsonFile", () => {
  it("reports an unconfirmed publication after rename without deleting the committed file", () => {
    const root = createTmpDir("atomic-json-durability-");
    const file = path.join(root, "state.json");
    fs.writeFileSync(file, '{"value":"before"}\n');
    try {
      assert.throws(
        () => new AtomicJsonFile(file, { faultInjector({ phase }) {
          if (phase === "before-json-readback") throw new Error("readback failed");
        } }).write({ value: "after" }),
        (error) => error.code === "ATOMIC_JSON_PUBLICATION_UNCERTAIN" && error.committed === true,
      );
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { value: "after" });
      assert.deepEqual(fs.readdirSync(root), ["state.json"]);
    } finally {
      removeTmpDir(root);
    }
  });

  it("reports cleanup failures together with the primary pre-commit failure", () => {
    const root = createTmpDir("atomic-json-cleanup-");
    const file = path.join(root, "state.json");
    fs.writeFileSync(file, '{"value":"before"}\n');
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = (target) => {
      if (path.basename(target).endsWith(".tmp")) throw new Error("temp cleanup failed");
      return originalUnlink(target);
    };
    try {
      assert.throws(
        () => new AtomicJsonFile(file, {
          faultInjector(event) {
            if (event.phase === "before-json-rename") throw new Error("rename precondition failed");
          },
        }).write({ value: "after" }),
        (error) => (
          error instanceof AggregateError
          && error.errors.some((item) => /rename precondition failed/.test(item.message))
          && error.errors.some((item) => /temp cleanup failed/.test(item.message))
        ),
      );
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { value: "before" });
    } finally {
      fs.unlinkSync = originalUnlink;
      for (const entry of fs.readdirSync(root)) {
        if (entry !== "state.json") originalUnlink(path.join(root, entry));
      }
      removeTmpDir(root);
    }
  });
});
