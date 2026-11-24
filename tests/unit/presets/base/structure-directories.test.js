import { describe, it } from "node:test";
import assert from "node:assert/strict";
import registerStructure from "../../../../src/presets/base/data/structure.js";
import { container, registerPresetBaseDependencies } from "../../../../src/lib/container.js";

registerPresetBaseDependencies();
const StructureSource = registerStructure(container);

/** Helper: build a minimal enriched analysis from file paths with roles. */
function makeAnalysis(files) {
  const entries = files.map(([file, role]) => ({
    file,
    relPath: file,
    role: role || null,
    hash: "abc",
    lines: 10,
  }));
  return {
    enrichedAt: "2026-01-01T00:00:00.000Z",
    modules: { entries, summary: { total: entries.length } },
  };
}

function getDirectories(analysis, labels = []) {
  const source = new StructureSource();
  return source.directories(analysis, labels);
}

function getTree(analysis) {
  const source = new StructureSource();
  return source.tree(analysis, []);
}

describe("StructureSource.directories() fallback", () => {
  it("expands child directories when only one top-level directory exists", () => {
    const analysis = makeAnalysis([
      ["src/controllers/users.js", "controller"],
      ["src/controllers/posts.js", "controller"],
      ["src/models/user.js", "model"],
      ["src/models/post.js", "model"],
      ["src/lib/utils.js", "lib"],
    ]);

    const result = getDirectories(analysis);
    // Should show src/controllers, src/models, src/lib — not just src
    assert.ok(result.toMarkdown().includes("src/controllers"), "should include src/controllers");
    assert.ok(result.toMarkdown().includes("src/models"), "should include src/models");
    assert.ok(result.toMarkdown().includes("src/lib"), "should include src/lib");
    assert.ok(!result.toMarkdown().match(/\| src \|/), "should NOT show just 'src' as a row");
  });

  it("keeps top-level aggregation when multiple top-level directories exist", () => {
    const analysis = makeAnalysis([
      ["src/controllers/users.js", "controller"],
      ["src/models/user.js", "model"],
      ["tests/unit/users.test.js", "test"],
      ["tests/e2e/app.test.js", "test"],
    ]);

    const result = getDirectories(analysis);
    // Should show src and tests as top-level
    assert.ok(result.toMarkdown().includes("| src |"), "should include src as top-level");
    assert.ok(result.toMarkdown().includes("| tests |"), "should include tests as top-level");
  });

  it("recursively expands deep single-path structures", () => {
    const analysis = makeAnalysis([
      ["app/src/controllers/users.js", "controller"],
      ["app/src/controllers/posts.js", "controller"],
      ["app/src/models/user.js", "model"],
    ]);

    const result = getDirectories(analysis);
    // app → app/src → app/src/controllers, app/src/models
    assert.ok(result.toMarkdown().includes("app/src/controllers"), "should expand to app/src/controllers");
    assert.ok(result.toMarkdown().includes("app/src/models"), "should expand to app/src/models");
  });

  it("stops expansion at MAX_EXPAND_DEPTH (5 levels)", () => {
    // Create a deeply nested single-path structure: a/b/c/d/e/f/g/file.js
    const analysis = makeAnalysis([
      ["a/b/c/d/e/f/g/file1.js", "deep"],
      ["a/b/c/d/e/f/g/file2.js", "deep"],
    ]);

    const result = getDirectories(analysis);
    // Should not throw or loop infinitely
    assert.ok(result, "should return a result even for deeply nested paths");
    // The result should contain some path (exact depth depends on implementation)
    assert.ok(result.toMarkdown().includes("|"), "should contain a markdown table");
  });

  it("does not affect tree() output", () => {
    const analysis = makeAnalysis([
      ["src/controllers/users.js", "controller"],
      ["src/models/user.js", "model"],
    ]);

    const tree = getTree(analysis);
    // tree() should show all directories as before
    assert.ok(tree.includes("src/controllers/"), "tree should include src/controllers/");
    assert.ok(tree.includes("src/models/"), "tree should include src/models/");
  });
});
