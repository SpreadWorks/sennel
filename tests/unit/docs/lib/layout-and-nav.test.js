import { createTmpDir as createTestDirectory } from "../../../support/builders/tmp-dir.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { container, initContainer } from "../../../../src/lib/container.js";
import registerDocsSource from "../../../../src/data/docs.js";
import { parseBlocks } from "../../../../src/docs/lib/directive-parser.js";
import { mergeResolved } from "../../../../src/docs/lib/template-merger.js";

const NAV_FIXTURE_CHAPTERS = ["overview.md", "design.md", "dev.md"];

function setupDocsSource(t, chapters) {
  initContainer();
  const DocsSource = registerDocsSource(container);
  const ds = new DocsSource();
  const tmpDir = createTestDirectory("nav-test-");
  const docsDir = path.join(tmpDir, "docs");
  fs.mkdirSync(docsDir, { recursive: true });
  for (const chapter of chapters) {
    const title = path.basename(chapter, ".md");
    const chapterPath = path.join(docsDir, chapter);
    fs.mkdirSync(path.dirname(chapterPath), { recursive: true });
    fs.writeFileSync(chapterPath, `# ${title}\n`);
  }
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  ds.init({
    desc: () => "—",
    loadOverrides: () => ({}),
    root: tmpDir,
    docsDir,
    type: "base",
    configChapters: [...chapters],
  });
  return ds;
}

// ---------------------------------------------------------------------------
// parseBlocks — {%extends "name"%} syntax
// ---------------------------------------------------------------------------

describe('parseBlocks {%extends "name"%}', () => {
  it('parses {%extends "layout"%} with target name', () => {
    const text = [
      '<!-- {%extends "layout"%} -->',
      '<!-- {%block "content"%} -->',
      "chapter body",
      "<!-- {%/block%} -->",
    ].join("\n");
    const result = parseBlocks(text);
    assert.equal(result.extends, true);
    assert.equal(result.extendsTarget, "layout");
    assert.equal(result.blocks.size, 1);
    assert.deepEqual(result.blocks.get("content").content, ["chapter body"]);
  });

  it("parses plain {%extends%} without target", () => {
    const text = [
      "<!-- {%extends%} -->",
      '<!-- {%block "main"%} -->',
      "content",
      "<!-- {%/block%} -->",
    ].join("\n");
    const result = parseBlocks(text);
    assert.equal(result.extends, true);
    assert.equal(result.extendsTarget, null);
  });

  it('{%extends%} with hyphenated name', () => {
    const text = '<!-- {%extends "my-layout"%} -->\n<!-- {%block "content"%} -->\nx\n<!-- {%/block%} -->';
    const result = parseBlocks(text);
    assert.equal(result.extends, true);
    assert.equal(result.extendsTarget, "my-layout");
  });
});

// ---------------------------------------------------------------------------
// mergeResolved — layout applied to chapter content
// ---------------------------------------------------------------------------

describe("mergeResolved with layout", () => {
  it('merges chapter content into layout {%block "content"%}', () => {
    const layout = {
      path: "base/layout.md",
      content: [
        "HEADER",
        '<!-- {%block "content"%} -->',
        "default content",
        "<!-- {%/block%} -->",
        "FOOTER",
      ].join("\n"),
      extends: false,
    };
    const chapter = {
      path: "base/overview.md",
      content: [
        '<!-- {%extends "layout"%} -->',
        '<!-- {%block "content"%} -->',
        "# Overview",
        "Real chapter content",
        "<!-- {%/block%} -->",
      ].join("\n"),
      extends: true,
    };
    // mergeResolved processes sources in priority order (most specific first)
    // then merges base-to-child: layout is base, chapter overrides content block
    const result = mergeResolved([chapter, layout]);
    assert.ok(result.includes("HEADER"), "should include layout header");
    assert.ok(result.includes("FOOTER"), "should include layout footer");
    assert.ok(result.includes("# Overview"), "should include chapter content");
    assert.ok(result.includes("Real chapter content"), "should include chapter body");
    assert.ok(!result.includes("default content"), "should not include default content");
  });
});

// ---------------------------------------------------------------------------
// docs.nav — link generation (tested via DocsSource directly)
// ---------------------------------------------------------------------------

describe("docs.nav link generation", () => {
  it("returns null for single chapter", (t) => {
    const ds = setupDocsSource(t, ["overview.md"]);

    const result = ds.nav({}, ["docs/overview.md"]);
    assert.equal(result, null, "single chapter should return null");
  });

  it("returns next link only for first chapter", (t) => {
    const ds = setupDocsSource(t, NAV_FIXTURE_CHAPTERS);

    const result = ds.nav({}, ["docs/overview.md"]);
    assert.ok(result !== null, "should return nav for docs/overview.md");
    const markdown = result.toMarkdown();
    assert.ok(!markdown.includes("←"), "first chapter should not have prev link");
    assert.ok(markdown.includes("→"), "first chapter should have next link");
    assert.ok(markdown.includes("design.md"), "should link to second chapter");
  });

  it("returns prev link only for last chapter", (t) => {
    const ds = setupDocsSource(t, NAV_FIXTURE_CHAPTERS);

    const result = ds.nav({}, ["docs/dev.md"]);
    assert.ok(result !== null, "should return nav for docs/dev.md");
    const markdown = result.toMarkdown();
    assert.ok(markdown.includes("←"), "last chapter should have prev link");
    assert.ok(!markdown.includes("→"), "last chapter should not have next link");
    assert.ok(markdown.includes("design.md"), "should link to second chapter");
  });

  it("returns both links for middle chapter", (t) => {
    const ds = setupDocsSource(t, NAV_FIXTURE_CHAPTERS);

    const result = ds.nav({}, ["docs/design.md"]);
    assert.ok(result !== null, "should return nav for docs/design.md");
    const markdown = result.toMarkdown();
    assert.ok(markdown.includes("←"), "middle chapter should have prev link");
    assert.ok(markdown.includes("→"), "middle chapter should have next link");
    assert.ok(markdown.includes("overview.md"), "should link to first chapter");
    assert.ok(markdown.includes("dev.md"), "should link to third chapter");
  });
});
