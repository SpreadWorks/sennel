import { createTmpDir as createTestDirectory } from "../../support/builders/tmp-dir.js";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { ReportBinding } from "../../../src/flow/commands/report.js";
import { buildRepairFingerprint } from "../../../src/flow/lib/repair-fingerprint.js";

function createRepository(parent) {
  const root = path.join(parent, "execution");
  fs.mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "feature.js"), "export const value = 1;\n");
  execFileSync("git", ["-C", root, "add", "src/feature.js"]);
  execFileSync("git", ["-C", root, "commit", "-m", "initial"]);
  return root;
}

function createSharedSpec(parent) {
  const root = path.join(parent, "base");
  const specDir = path.join(root, "flow-artifacts", "specs", "001-boundary");
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, "spec.json"), `${JSON.stringify({
    goal: "verify shared artifacts",
    requirements: [],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(specDir, "report.json"), "{\"result\":\"ok\"}\n");
  return {
    root,
    specDir,
    specPath: "flow-artifacts/specs/001-boundary/spec.json",
  };
}

describe("shared spec artifact and execution root boundary", () => {
  let temporaryRoot;

  afterEach(() => {
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("binds report Git identity to executionRoot and source artifacts to the base root", () => {
    temporaryRoot = createTestDirectory("shared-spec-report-");
    const executionRoot = createRepository(temporaryRoot);
    const shared = createSharedSpec(temporaryRoot);
    const reportPath = path.join(shared.specDir, "report.json");

    const binding = ReportBinding.fromSourcePaths({
      root: executionRoot,
      artifactRoot: shared.root,
      sourcePaths: [reportPath],
    });

    assert.equal(
      binding.headOid,
      execFileSync("git", ["-C", executionRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    );
    assert.deepEqual(binding.sourceArtifacts.map((entry) => entry.path), [
      "flow-artifacts/specs/001-boundary/report.json",
    ]);
    assert.doesNotThrow(() => ReportBinding.validate(binding, {
      root: executionRoot,
      artifactRoot: shared.root,
    }));

    fs.writeFileSync(reportPath, "{\"result\":\"changed\"}\n");
    assert.throws(
      () => ReportBinding.validate(binding, { root: executionRoot, artifactRoot: shared.root }),
      /source artifact has changed/,
    );
  });

  it("fingerprints source changes from executionRoot while reading spec artifacts from the base root", () => {
    temporaryRoot = createTestDirectory("shared-spec-fingerprint-");
    const executionRoot = createRepository(temporaryRoot);
    const shared = createSharedSpec(temporaryRoot);

    const before = buildRepairFingerprint({
      root: executionRoot,
      artifactRoot: shared.root,
      specPath: shared.specPath,
    });
    fs.writeFileSync(path.join(executionRoot, "src", "feature.js"), "export const value = 2;\n");
    const after = buildRepairFingerprint({
      root: executionRoot,
      artifactRoot: shared.root,
      specPath: shared.specPath,
    });

    assert.notEqual(after.hash, before.hash);
    assert.equal(after.entries.some((entry) => entry.path === "src/feature.js"), true);
    assert.equal(after.entries.some((entry) => entry.path === shared.specPath), true);
  });
});
