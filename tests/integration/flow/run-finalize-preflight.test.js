import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { assertGitWriteAccess } from "../../../src/flow/lib/run-finalize.js";

describe("run-finalize preflight", () => {
  it("assertGitWriteAccess succeeds when git dir is writable", async () => {
    const tmp = createTmpDir("finalize-preflight-ok-");
    try {
      await assertGitWriteAccess(tmp);
    } finally {
      removeTmpDir(tmp);
    }
  });

  it("assertGitWriteAccess preserves the refusal diagnostic when the filesystem denies its preflight stage", async (t) => {
    const tmp = createTmpDir("finalize-preflight-ro-");
    try {
      const denied = Object.assign(new Error("preflight write denied"), { code: "EACCES" });
      const open = fs.openSync;
      t.mock.method(fs, "openSync", (file, flags, ...args) => {
        if (path.dirname(file) === tmp && path.basename(file).includes("finalize-preflight")) throw denied;
        return open(file, flags, ...args);
      });
      await assert.rejects(
        assertGitWriteAccess(tmp),
        (err) => {
          assert.equal(err.code, "FINALIZE_PREFLIGHT_FAILED");
          assert.match(err.message, /preflight write denied/);
          assert.match(err.message, /Help:/);
          assert.match(err.message, /flow run finalize-commit --help/);
          return true;
        },
      );
      assert.deepEqual(fs.readdirSync(tmp), []);
    } finally {
      removeTmpDir(tmp);
    }
  });

  it("run-finalize execute uses preflight before step execution", () => {
    const file = path.join(process.cwd(), "src/flow/lib/run-finalize.js");
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /runFinalizePreflight\(root\)/);
  });
});
