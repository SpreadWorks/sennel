import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { estimateRelevantFiles, materializeForgeInputReference } from "../../../../src/docs/commands/forge.js";
import { createTmpDir, removeTmpDir } from "../../../support/builders/tmp-dir.js";

let tmp;
afterEach(() => {
  if (tmp) removeTmpDir(tmp);
  tmp = null;
});

describe("estimateRelevantFiles", () => {
  const allFiles = [
    "docs/overview.md",
    "docs/cli_commands.md",
    "docs/configuration.md",
    "docs/internal_design.md",
  ];

  it("returns matching files when spec mentions chapter keywords", () => {
    const specText = "## Scope\n- Update CLI commands to add new flag\n- Fix configuration validation";
    const result = estimateRelevantFiles(specText, allFiles);
    assert.ok(result.includes("docs/cli_commands.md"));
    assert.ok(result.includes("docs/configuration.md"));
    assert.ok(!result.includes("docs/internal_design.md"));
  });

  it("returns empty array when no keywords match", () => {
    const specText = "## Scope\n- Fix a very specific bug in parser";
    const result = estimateRelevantFiles(specText, allFiles);
    // "overview" matches because "overview" is a common word that might appear,
    // but the spec text here doesn't contain any chapter keywords
    assert.equal(result.length, 0);
  });

  it("returns empty array for empty spec text", () => {
    assert.deepEqual(estimateRelevantFiles("", allFiles), []);
    assert.deepEqual(estimateRelevantFiles(null, allFiles), []);
  });

  it("is case-insensitive", () => {
    const specText = "Update the OVERVIEW section and CLI COMMANDS";
    const result = estimateRelevantFiles(specText, allFiles);
    assert.ok(result.includes("docs/overview.md"));
    assert.ok(result.includes("docs/cli_commands.md"));
  });

  it("returns all files if all match (no filtering benefit)", () => {
    const specText = "overview cli commands configuration internal design";
    const result = estimateRelevantFiles(specText, allFiles);
    assert.equal(result.length, allFiles.length);
  });
});

describe("materializeForgeInputReference", () => {
  it("stores a giant request byte-for-byte behind a digest-only prompt reference", () => {
    tmp = createTmpDir();
    const request = `${"requested behavior\n".repeat(9000)}tail request`;
    const input = {
      request,
      specification: null,
      analysis: "complete analysis",
      previousReviewFeedback: null,
      round: 1,
      maxRuns: 3,
    };

    const reference = materializeForgeInputReference(tmp, {}, input);
    const stored = fs.readFileSync(path.join(tmp, reference.path), "utf8");
    const parsed = JSON.parse(stored);

    assert.equal(parsed.request, request);
    assert.ok(parsed.request.endsWith("tail request"));
    assert.equal(reference.byteLength, Buffer.byteLength(stored));
    assert.ok(reference.toPromptText().includes(reference.digest));
    assert.ok(!reference.toPromptText().includes("requested behavior"));
  });
});
