import { testTemporaryRoot } from "../../../test-environment.js";
import { createTmpDir as createTestDirectory } from "../../../support/builders/tmp-dir.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadDataSources } from "../../../../src/docs/lib/data-source-loader.js";

function makeTmpDir(prefix) {
  return createTestDirectory(prefix);
}

describe("loadDataSources (fail-fast on broken DataSource modules)", () => {
  let validDir;
  let brokenDir;

  before(() => {
    validDir = makeTmpDir("sennel-loader-valid-");
    fs.writeFileSync(
      path.join(validDir, "good.js"),
      `export default function register() {
         return class Good {
           list() { return null; }
         };
       }\n`,
    );

    brokenDir = makeTmpDir("sennel-loader-broken-");
    fs.writeFileSync(
      path.join(brokenDir, "good.js"),
      `export default function register() {
         return class Good {
           list() { return null; }
         };
       }\n`,
    );
    fs.writeFileSync(
      path.join(brokenDir, "broken.js"),
      "export default class Broken { /* unterminated block comment\n",
    );
  });

  after(() => {
    fs.rmSync(validDir, { recursive: true, force: true });
    fs.rmSync(brokenDir, { recursive: true, force: true });
  });

  it("loads all DataSources when every module is valid", async () => {
    const sources = await loadDataSources(validDir);
    assert.equal(sources.size, 1);
    assert.ok(sources.has("good"));
  });

  it("propagates errors when a DataSource module fails to import (fail-fast)", async () => {
    await assert.rejects(
      () => loadDataSources(brokenDir),
      (err) => {
        assert.ok(err instanceof Error, "should reject with an Error");
        const payload = `${err.message}\n${err.stack || ""}`;
        assert.ok(
          payload.includes("broken.js"),
          `error should reference the failing file, got: ${payload}`,
        );
        return true;
      },
    );
  });

  it("returns an empty map when the directory does not exist", async () => {
    const missing = path.join(testTemporaryRoot().path, `sennel-loader-missing-${Date.now()}`);
    const sources = await loadDataSources(missing);
    assert.equal(sources.size, 0);
  });
});
