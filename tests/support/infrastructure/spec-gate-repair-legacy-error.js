import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTmpDir, removeTmpDir } from "../builders/tmp-dir.js";
import { TestTemporaryRoot } from "../../test-temporary-root.js";
import { NativeExecutableInvocation } from "../../../src/lib/command-invocation.js";

/** Isolate the actual retired size predicate, never the canonical Error producer. */
export class LegacySpecGateRepairErrorSeed {
  constructor() {
    this.root = createTmpDir("spec-gate-repair-legacy-code-");
    try {
      const repository = fileURLToPath(new URL("../../../", import.meta.url));
      for (const relative of ["src", "tests/support", "tests/runner", "tests/test-environment.js", "tests/test-temporary-root.js", "package.json"]) {
        const destination = path.join(this.root, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.cpSync(path.join(repository, relative), destination, { recursive: true });
      }
      const operations = path.join(this.root, "src/flow/lib/spec-repair-operations.js");
      const source = fs.readFileSync(operations, "utf8");
      const anchor = "      for (let editIndex = 0; editIndex < edits.length; editIndex += 1) {";
      assert.equal(source.split(anchor).length, 2, "retired size predicate must attach to its real constructor");
      // Exact predicate from 2ba144ef64c3e3cf02367895e3da91e5a41791d6.
      // Only this isolated copy changes; the normal factory, Step and Store remain real.
      const predicate = "      if (stableBytes(input.edits) > 32 * 1024) {\n"
        + "        throw new Error(`spec-repair.operations[${index}].edits replacements are oversized`);\n      }\n"
        + anchor;
      fs.writeFileSync(operations, source.replace(anchor, predicate));
      this.temporaryRoot = TestTemporaryRoot.createOnRepository({ repositoryRoot: this.root });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  dispose() {
    try { this.temporaryRoot?.remove(); }
    finally { removeTmpDir(this.root); }
  }

  /** Return serialized identity only: old and corrected code have distinct class realms. */
  async create({ mode = "valid" } = {}) {
    const output = path.join(this.root, `legacy-error-${randomUUID()}.json`);
    try {
      const invocation = new NativeExecutableInvocation({ executable: process.execPath, args: [
        "--import", pathToFileURL(path.join(this.root, "src/sennel.js")).href,
        path.join(this.root, "tests/support/spec-gate-repair-legacy-worker.js"), mode, output,
      ], cwd: this.root, env: { ...process.env,
        SENNEL_WORK_ROOT: this.root, SENNEL_SOURCE_ROOT: this.root,
        SENNEL_TEST_TEMP_ROOT: this.temporaryRoot.path } });
      const result = spawnSync(invocation.executable, invocation.args, {
        ...invocation.processOptions(), shell: false, encoding: "utf8",
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      return JSON.parse(fs.readFileSync(output, "utf8"));
    } finally {
      fs.rmSync(output, { force: true });
    }
  }
}
