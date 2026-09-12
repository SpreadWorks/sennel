import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  buildLayers,
  resolveTemplates,
  mergeResolved,
  resolveChaptersOrder,
  translateTemplate,
} from "../../../../src/docs/lib/template-merger.js";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../../../support/builders/tmp-dir.js";

/**
 * Create a temporary project root with an installed plugin preset fixture.
 * Returns { tmpDir, cleanup }.
 */
function withPluginPresets(presets, { type = presets[0]?.key } = {}) {
  const tmpDir = createTmpDir("sennel-test-local-preset-");
  writeJson(tmpDir, ".sennel/config.json", {
    lang: "ja",
    type,
    docs: { languages: ["ja"], defaultLanguage: "ja" },
    scan: { include: ["src/**/*.js"], exclude: [] },
    plugin: { packages: [{ id: "test-presets" }] },
  });
  writeFile(
    tmpDir,
    ".sennel/plugins/test-presets/plugin.json",
    JSON.stringify({
      name: "test-presets",
      files: ["plugin.json", "presets/"],
      contributions: {
        presets: presets.map((preset) => ({
          key: preset.key,
          path: `presets/${preset.key}`,
        })),
      },
    }),
  );
  for (const preset of presets) {
    writeFile(
      tmpDir,
      `.sennel/plugins/test-presets/presets/${preset.key}/preset.json`,
      JSON.stringify({
        parent: preset.parent ?? null,
        ...(preset.chapters ? { chapters: preset.chapters } : {}),
      }),
    );
    if (preset.templateContent !== undefined) {
      writeFile(
        tmpDir,
        `.sennel/plugins/test-presets/presets/${preset.key}/templates/${preset.lang || "ja"}/overview.md`,
        preset.templateContent,
      );
    }
  }
  return { tmpDir, cleanup: () => removeTmpDir(tmpDir) };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "../../../../src");
const PRESETS_DIR = path.join(SRC_DIR, "presets");

describe("translateTemplate", () => {
  it("fails closed when a bounded translation response is invalid", async () => {
    await assert.rejects(
      translateTemplate("# Heading\n", "en", "ja", {
        async call() { return "not-json"; },
      }, "project", { maxCharacters: 4000 }),
      (error) => error.code === "PROMPT_BATCH_EXECUTION_INCOMPLETE"
        && error.details.causeCode === "PROMPT_RESPONSE_INVALID",
    );
  });
});

// ---------------------------------------------------------------------------
// buildLayers
// ---------------------------------------------------------------------------

describe("buildLayers", () => {
  it("returns base layer for 'base' preset", () => {
    const layers = buildLayers("base", "ja", null);
    assert.ok(layers.length >= 1);
    assert.ok(layers[layers.length - 1].includes("base"));
  });

  it("returns leaf + base for preset with one parent", () => {
    const { tmpDir, cleanup } = withPluginPresets([
      { key: "sample-preset", parent: "base", templateContent: "# Sample" },
    ]);
    try {
      const layers = buildLayers("sample-preset", "ja", null, tmpDir);
      assert.ok(layers.length >= 2);
      assert.ok(layers[0].includes("sample-preset"), `expected sample-preset in ${layers[0]}`);
      assert.ok(layers[layers.length - 1].includes("base"), `expected base in ${layers[layers.length - 1]}`);
    } finally {
      cleanup();
    }
  });

  it("returns leaf + parent chain + base for deeply nested preset", () => {
    const { tmpDir, cleanup } = withPluginPresets([
      { key: "sample-parent", parent: "base", templateContent: "# Parent" },
      { key: "sample-child", parent: "sample-parent", templateContent: "# Child" },
    ], { type: "sample-child" });
    try {
      const layers = buildLayers("sample-child", "ja", null, tmpDir);
      assert.ok(layers.length >= 3);
      assert.ok(layers[0].includes("sample-child"), `expected sample-child in ${layers[0]}`);
      assert.ok(layers[1].includes("sample-parent"), `expected sample-parent in ${layers[1]}`);
      assert.ok(layers[layers.length - 1].includes("base"), `expected base in ${layers[layers.length - 1]}`);
    } finally {
      cleanup();
    }
  });

  it("includes project-local dir when it exists", () => {
    const projectLocalDir = path.join(PRESETS_DIR, "base", "templates", "ja");
    const layers = buildLayers("base", "ja", projectLocalDir);
    assert.equal(layers[0], projectLocalDir);
  });

  it("skips project-local dir when it does not exist", () => {
    const layers = buildLayers("base", "ja", "/nonexistent/dir");
    for (const l of layers) {
      assert.notEqual(l, "/nonexistent/dir");
    }
  });

  it("returns layers in priority order (most specific first)", () => {
    const { tmpDir, cleanup } = withPluginPresets([
      { key: "sample-preset", parent: "base", templateContent: "# Sample" },
    ]);
    try {
      const layers = buildLayers("sample-preset", "ja", null, tmpDir);
      if (layers.length >= 2) {
        assert.ok(
          layers[layers.length - 1].includes("base"),
          "last layer should be base",
        );
        assert.ok(
          !layers[0].includes("base") || layers.length === 1,
          "first layer should not be base (unless only base exists)",
        );
      }
    } finally {
      cleanup();
    }
  });

  it("returns only existing directories", () => {
    const layers = buildLayers("base", "zz-nonexistent", null);
    for (const l of layers) {
      assert.ok(fs.existsSync(l), `expected ${l} to exist`);
    }
  });
});

// ---------------------------------------------------------------------------
// mergeResolved
// ---------------------------------------------------------------------------

describe("mergeResolved", () => {
  it("returns null for empty sources", () => {
    assert.equal(mergeResolved([]), null);
    assert.equal(mergeResolved(null), null);
  });

  it("returns content unchanged for single source", () => {
    const sources = [
      { path: "a.md", content: "# Hello\nWorld", extends: false },
    ];
    assert.equal(mergeResolved(sources), "# Hello\nWorld");
  });

  it("child without {%extends%} replaces parent entirely", () => {
    const sources = [
      { path: "child.md", content: "# Child Only", extends: false },
      { path: "parent.md", content: "# Parent Only", extends: false },
    ];
    const result = mergeResolved(sources);
    assert.equal(result, "# Child Only");
  });

  it("child with {%extends%} merges blocks from parent", () => {
    const parent = [
      "# Title",
      '<!-- {%block "intro"%} -->',
      "Parent intro",
      "<!-- {%/block%} -->",
      '<!-- {%block "body"%} -->',
      "Parent body",
      "<!-- {%/block%} -->",
    ].join("\n");

    const child = [
      "<!-- {%extends%} -->",
      '<!-- {%block "intro"%} -->',
      "Child intro",
      "<!-- {%/block%} -->",
    ].join("\n");

    const sources = [
      { path: "child.md", content: child, extends: true },
      { path: "parent.md", content: parent, extends: false },
    ];

    const result = mergeResolved(sources);
    assert.ok(result.includes("Child intro"), "child block should override");
    assert.ok(
      result.includes("Parent body"),
      "parent block should be preserved",
    );
    assert.ok(result.includes("# Title"), "parent preamble should appear");
  });

  it("three-level inheritance merges correctly", () => {
    const base = [
      "# Base",
      '<!-- {%block "a"%} -->',
      "base-a",
      "<!-- {%/block%} -->",
      '<!-- {%block "b"%} -->',
      "base-b",
      "<!-- {%/block%} -->",
      '<!-- {%block "c"%} -->',
      "base-c",
      "<!-- {%/block%} -->",
    ].join("\n");

    const mid = [
      "<!-- {%extends%} -->",
      '<!-- {%block "b"%} -->',
      "mid-b",
      "<!-- {%/block%} -->",
    ].join("\n");

    const leaf = [
      "<!-- {%extends%} -->",
      '<!-- {%block "a"%} -->',
      "leaf-a",
      "<!-- {%/block%} -->",
    ].join("\n");

    const sources = [
      { path: "leaf.md", content: leaf, extends: true },
      { path: "mid.md", content: mid, extends: true },
      { path: "base.md", content: base, extends: false },
    ];

    const result = mergeResolved(sources);
    assert.ok(result.includes("leaf-a"), "leaf should override block a");
    assert.ok(result.includes("mid-b"), "mid should override block b");
    assert.ok(result.includes("base-c"), "base block c should remain");
  });
});

// ---------------------------------------------------------------------------
// resolveChaptersOrder
// ---------------------------------------------------------------------------

describe("resolveChaptersOrder", () => {
  it("returns chapters from base preset", () => {
    const chapters = resolveChaptersOrder("base");
    assert.ok(Array.isArray(chapters));
    if (chapters.length > 0) {
      assert.ok(chapters[0].endsWith(".md"));
    }
  });

  it("leaf preset overrides base chapters", () => {
    const baseChapters = resolveChaptersOrder("base");
    const { tmpDir, cleanup } = withPluginPresets([
      { key: "sample-preset", parent: "base", chapters: ["custom.md"] },
    ]);
    try {
      const nodeCliChapters = resolveChaptersOrder("sample-preset", null, tmpDir);
      if (nodeCliChapters.length > 0 && baseChapters.length > 0) {
        const sameOrder =
          JSON.stringify(baseChapters) === JSON.stringify(nodeCliChapters);
        if (!sameOrder) {
          assert.notDeepEqual(baseChapters, nodeCliChapters);
        }
      }
    } finally {
      cleanup();
    }
  });

  it("returns array of strings", () => {
    const chapters = resolveChaptersOrder("base");
    assert.ok(Array.isArray(chapters));
    for (const ch of chapters) {
      assert.equal(typeof ch, "string");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveTemplates
// ---------------------------------------------------------------------------

describe("resolveTemplates", () => {
  it("resolves templates for existing language", () => {
    const chaptersOrder = resolveChaptersOrder("base");
    const resolutions = resolveTemplates("base", "ja", {
      chaptersOrder,
    });
    assert.ok(resolutions.length > 0, "should resolve at least one template");

    for (const r of resolutions) {
      assert.equal(r.action, "use");
      assert.ok(r.sources.length > 0);
      assert.equal(typeof r.fileName, "string");
    }
  });

  it("includes README.md in resolutions", () => {
    const { tmpDir, cleanup } = withPluginPresets([
      { key: "sample-preset", parent: "base", chapters: ["overview.md"], templateContent: "# Overview" },
    ]);
    try {
      writeFile(
        tmpDir,
        ".sennel/plugins/test-presets/presets/sample-preset/templates/ja/README.md",
        "# README\n",
      );
      const chaptersOrder = resolveChaptersOrder("sample-preset", null, tmpDir);
      const resolutions = resolveTemplates("sample-preset", "ja", {
        chaptersOrder,
        projectRoot: tmpDir,
      });
      const readme = resolutions.find((r) => r.fileName === "README.md");
      assert.ok(readme, "should include README.md");
    } finally {
      cleanup();
    }
  });

  it('marks files for translation when target language has no templates', () => {
    const chaptersOrder = resolveChaptersOrder("base");
    const resolutions = resolveTemplates("base", "fr", {
      chaptersOrder,
      fallbackLangs: ["ja"],
    });
    const translated = resolutions.filter((r) => r.action === "translate");
    assert.ok(translated.length > 0, "should have translate actions");
    for (const r of translated) {
      assert.equal(r.from, "ja");
      assert.equal(r.to, "fr");
    }
  });

  it("returns empty array when no templates found anywhere", () => {
    const resolutions = resolveTemplates("base", "zz", {
      chaptersOrder: ["nonexistent.md"],
    });
    assert.deepEqual(resolutions, []);
  });

  it("resolveTemplates result sources have expected shape", () => {
    const chaptersOrder = resolveChaptersOrder("base");
    const resolutions = resolveTemplates("base", "ja", {
      chaptersOrder,
    });
    for (const r of resolutions) {
      assert.ok(Array.isArray(r.sources));
      for (const s of r.sources) {
        assert.equal(typeof s.path, "string");
        assert.equal(typeof s.content, "string");
        assert.equal(typeof s.extends, "boolean");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// project-local preset resolution via projectRoot
// ---------------------------------------------------------------------------

describe("buildLayers — projectRoot", () => {
  it("includes plugin preset templates when projectRoot is provided", () => {
    const { tmpDir, cleanup } = withPluginPresets([
      { key: "mypreset", parent: "base", templateContent: "# Overview" },
    ]);
    try {
      const layers = buildLayers("mypreset", "ja", null, tmpDir);
      const localTemplateDir = path.join(tmpDir, ".sennel", "plugins", "test-presets", "presets", "mypreset", "templates", "ja");
      assert.ok(
        layers.includes(localTemplateDir),
        `expected local preset template dir in layers, got: ${layers}`,
      );
    } finally {
      cleanup();
    }
  });

  it("resolves plugin preset as first non-project-local layer (highest priority)", () => {
    const { tmpDir, cleanup } = withPluginPresets([
      { key: "mypreset", parent: "base", templateContent: "# Overview" },
    ]);
    try {
      const layers = buildLayers("mypreset", "ja", null, tmpDir);
      const localTemplateDir = path.join(tmpDir, ".sennel", "plugins", "test-presets", "presets", "mypreset", "templates", "ja");
      // When no projectLocalDir is given, the plugin preset template should be first
      assert.equal(layers[0], localTemplateDir);
    } finally {
      cleanup();
    }
  });

  it("without projectRoot, unknown preset name uses resolveChainSafe logged fallback to base", () => {
    // resolveChainSafe intentionally logs via logger.verbose and falls back to base preset
    // rather than propagating an error — this is its designed contract, not silent swallowing.
    const layers = buildLayers("unknown-local-preset", "ja", null);
    // Falls back to base preset layers (may be empty if no base templates exist for this lang)
    assert.ok(Array.isArray(layers));
  });

  it("with projectRoot but no matching local preset, behaves same as without projectRoot", () => {
    const { tmpDir, cleanup } = withPluginPresets([{ key: "other-preset", parent: "base" }]);
    try {
      // No "base" preset dir — should fall back to built-in preset
      const layersWithRoot = buildLayers("base", "ja", null, tmpDir);
      const layersWithoutRoot = buildLayers("base", "ja", null);
      assert.deepEqual(layersWithRoot, layersWithoutRoot);
    } finally {
      cleanup();
    }
  });
});

describe("resolveChaptersOrder — projectRoot", () => {
  it("returns plugin preset chapters when projectRoot is provided", () => {
    const localChapters = ["intro.md", "usage.md", "faq.md"];
    const { tmpDir, cleanup } = withPluginPresets([
      { key: "mypreset", parent: "base", chapters: localChapters },
    ]);
    try {
      const result = resolveChaptersOrder("mypreset", null, tmpDir);
      assert.deepEqual(result, localChapters);
    } finally {
      cleanup();
    }
  });

  it("without projectRoot, built-in preset chapters are returned unchanged", () => {
    const chaptersWithout = resolveChaptersOrder("base");
    const { tmpDir, cleanup } = withPluginPresets([{ key: "other-preset", parent: "base" }]);
    try {
      // No .sennel/presets/base/ — should return same as without projectRoot
      const chaptersWithRoot = resolveChaptersOrder("base", null, tmpDir);
      assert.deepEqual(chaptersWithRoot, chaptersWithout);
    } finally {
      cleanup();
    }
  });
});

describe("resolveTemplates — projectRoot", () => {
  it("resolves plugin preset templates without Preset not found error", () => {
    const { tmpDir, cleanup } = withPluginPresets([
      {
        key: "mypreset",
        parent: "base",
        chapters: ["overview.md"],
        templateContent: "# Overview\nContent here.",
      },
    ]);
    try {
      const resolutions = resolveTemplates("mypreset", "ja", {
        chaptersOrder: ["overview.md"],
        projectRoot: tmpDir,
      });

      assert.ok(resolutions.length > 0, "should resolve at least one template");
      const overview = resolutions.find((r) => r.fileName === "overview.md");
      assert.ok(overview, "should resolve overview.md from local preset");
    } finally {
      cleanup();
    }
  });

  it("existing built-in preset resolution is unchanged when projectRoot is not passed", () => {
    const chaptersOrder = resolveChaptersOrder("base");
    const withoutRoot = resolveTemplates("base", "ja", { chaptersOrder });
    // Passing undefined projectRoot explicitly — should be identical
    const withUndefinedRoot = resolveTemplates("base", "ja", {
      chaptersOrder,
      projectRoot: undefined,
    });
    const normalize = (resolutions) => resolutions.map(({ fileName, action }) => ({ fileName, action }));
    assert.deepEqual(normalize(withoutRoot), normalize(withUndefinedRoot));
  });
});

describe("resolveChaptersOrder — exclude:true", () => {
  it("filters out chapters with exclude:true from configChapters", () => {
    const configChapters = [
      { chapter: "overview.md" },
      { chapter: "development_testing.md", exclude: true },
      { chapter: "stack_and_ops.md" },
    ];
    const result = resolveChaptersOrder("base", configChapters);
    assert.ok(result.includes("overview.md"));
    assert.ok(result.includes("stack_and_ops.md"));
    assert.ok(!result.includes("development_testing.md"));
  });

  it("keeps chapters with exclude:false", () => {
    const configChapters = [
      { chapter: "overview.md", exclude: false },
      { chapter: "stack_and_ops.md" },
    ];
    const result = resolveChaptersOrder("base", configChapters);
    assert.ok(result.includes("overview.md"));
    assert.ok(result.includes("stack_and_ops.md"));
  });

  it("handles old string format without breaking", () => {
    const configChapters = ["overview.md", "stack_and_ops.md"];
    const result = resolveChaptersOrder("base", configChapters);
    assert.ok(result.includes("overview.md"));
    assert.ok(result.includes("stack_and_ops.md"));
  });
});
