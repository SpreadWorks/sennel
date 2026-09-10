import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import {
  buildBatchPrompt,
  buildTextSystemPrompt,
  getEnrichedContext,
  getAnalysisContext,
} from "../../../../src/docs/lib/text-prompts.js";
import { createTmpDir, removeTmpDir, writeFile } from "../../../support/builders/tmp-dir.js";

// ---------------------------------------------------------------------------
// getEnrichedContext
// ---------------------------------------------------------------------------

describe("getEnrichedContext", () => {
  let tmp;

  it("returns null when analysis has no enrichedAt", () => {
    const analysis = {
      modules: {
        summary: { total: 1 },
        entries: [{ file: "src/a.js", summary: "does stuff" }],
      },
    };
    assert.equal(getEnrichedContext(analysis, "overview.md", "light"), null);
  });

  it("returns null when no entries match the chapter", () => {
    const analysis = {
      enrichedAt: "2026-01-01T00:00:00Z",
      modules: {
        summary: { total: 1 },
        entries: [{ file: "src/a.js", summary: "does stuff", chapter: "configuration" }],
      },
    };
    assert.equal(getEnrichedContext(analysis, "overview.md", "light"), null);
  });

  it("returns enriched context for matching chapter entries (light mode)", () => {
    const analysis = {
      enrichedAt: "2026-01-01T00:00:00Z",
      modules: {
        summary: { total: 2 },
        entries: [
          { file: "src/a.js", summary: "Module A summary", detail: "Module A detail", chapter: "overview", role: "lib" },
          { file: "src/b.js", summary: "Module B summary", detail: "Module B detail", chapter: "configuration", role: "config" },
        ],
      },
    };
    const result = getEnrichedContext(analysis, "overview.md", "light");
    assert.ok(result);
    assert.ok(result.includes("Module A summary"));
    assert.ok(result.includes("Module A detail"));
    assert.ok(!result.includes("Module B summary"), "should not include entries from other chapters");
    assert.ok(result.includes("1 entries for chapter: overview"));
  });

  it("uses the chapter filename without .md to match chapter", () => {
    const analysis = {
      enrichedAt: "2026-01-01T00:00:00Z",
      modules: {
        summary: { total: 1 },
        entries: [
          { file: "src/a.js", summary: "A summary", detail: "A detail", chapter: "cli_commands" },
        ],
      },
    };
    const result = getEnrichedContext(analysis, "cli_commands.md", "light");
    assert.ok(result);
    assert.ok(result.includes("A summary"));
  });

  it("does not include source code in light mode", () => {
    tmp = createTmpDir("enriched");
    writeFile(tmp, "src/a.js", "function hello() { return 1; }");
    const analysis = {
      enrichedAt: "2026-01-01T00:00:00Z",
      modules: {
        summary: { total: 1 },
        entries: [
          { file: "src/a.js", summary: "A summary", detail: "A detail", chapter: "overview" },
        ],
      },
    };
    const result = getEnrichedContext(analysis, "overview.md", "light", tmp);
    assert.ok(result);
    assert.ok(!result.includes("function hello()"), "light mode should not include source code");
    removeTmpDir(tmp);
  });

  it("includes source code in deep mode", () => {
    tmp = createTmpDir("enriched");
    writeFile(tmp, "src/a.js", "function hello() { return 1; }");
    const analysis = {
      enrichedAt: "2026-01-01T00:00:00Z",
      modules: {
        summary: { total: 1 },
        entries: [
          { file: "src/a.js", summary: "A summary", detail: "A detail", chapter: "overview" },
        ],
      },
    };
    const result = getEnrichedContext(analysis, "overview.md", "deep", tmp);
    assert.ok(result);
    assert.ok(result.includes("function hello()"), "deep mode should include source code");
    assert.ok(result.includes("A summary"));
    assert.ok(result.includes("A detail"));
    removeTmpDir(tmp);
  });

  it("preserves source code beyond the former 8000 character boundary", () => {
    tmp = createTmpDir("enriched");
    const longCode = "x".repeat(9000);
    writeFile(tmp, "src/big.js", longCode);
    const analysis = {
      enrichedAt: "2026-01-01T00:00:00Z",
      modules: {
        summary: { total: 1 },
        entries: [
          { file: "src/big.js", summary: "Big file", detail: "Lots of code", chapter: "overview" },
        ],
      },
    };
    const result = getEnrichedContext(analysis, "overview.md", "deep", tmp);
    assert.ok(result);
    assert.ok(result.includes(longCode));
    assert.ok(!result.includes("(truncated)"));
    removeTmpDir(tmp);
  });

  it("handles missing source file gracefully in deep mode", () => {
    tmp = createTmpDir("enriched");
    const analysis = {
      enrichedAt: "2026-01-01T00:00:00Z",
      modules: {
        summary: { total: 1 },
        entries: [
          { file: "src/missing.js", summary: "Missing", detail: "Not found", chapter: "overview" },
        ],
      },
    };
    const result = getEnrichedContext(analysis, "overview.md", "deep", tmp);
    assert.ok(result);
    assert.ok(result.includes("Missing"));
    assert.ok(!result.includes("```"), "should not include code block for missing file");
    removeTmpDir(tmp);
  });

  it("collects entries from multiple categories", () => {
    const analysis = {
      enrichedAt: "2026-01-01T00:00:00Z",
      controllers: {
        summary: { total: 1 },
        entries: [
          { file: "app/Controller/UsersController.php", summary: "Users controller", detail: "Handles users", chapter: "overview", role: "controller" },
        ],
      },
      models: {
        summary: { total: 1 },
        entries: [
          { file: "app/Model/User.php", summary: "User model", detail: "User data", chapter: "overview", role: "model" },
        ],
      },
    };
    const result = getEnrichedContext(analysis, "overview.md", "light");
    assert.ok(result);
    assert.ok(result.includes("Users controller"));
    assert.ok(result.includes("User model"));
    assert.ok(result.includes("2 entries for chapter: overview"));
  });

  it("skips meta keys (analyzedAt, extras, etc.)", () => {
    const analysis = {
      enrichedAt: "2026-01-01T00:00:00Z",
      analyzedAt: "2026-01-01T00:00:00Z",
      extras: { packageDeps: {} },
      modules: {
        summary: { total: 1 },
        entries: [
          { file: "src/a.js", summary: "A", detail: "Detail", chapter: "overview" },
        ],
      },
    };
    // Should not crash trying to iterate meta keys
    const result = getEnrichedContext(analysis, "overview.md", "light");
    assert.ok(result);
    assert.ok(result.includes("1 entries"));
  });
});

describe("text prompt grounding rules", () => {
  it("requires current-project source grounding and omits unsupported claims", () => {
    const cases = [
      {
        lang: "en",
        prompt: "Describe the overview.",
        rules: [
          /current project's analysis data and source files/,
          /declared dependency is not proof/,
          /omit the claim instead of inventing/,
        ],
      },
      {
        lang: "ja",
        prompt: "概要を説明してください。",
        rules: [
          /現在のプロジェクトの解析データとソースファイル/,
          /依存関係に宣言されているだけではソースコードで使用中とはみなさず/,
          /根拠がない、または不十分な内容はもっともらしく補わず省略すること/,
        ],
      },
    ];
    for (const { lang, prompt: directivePrompt, rules } of cases) {
      const prompts = [
        buildTextSystemPrompt(undefined, lang),
        buildBatchPrompt("overview.md", "", [{ prompt: directivePrompt, params: {} }], lang),
      ];
      for (const prompt of prompts) {
        for (const rule of rules) assert.match(prompt, rule);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// directive-parser: mode param (integration check)
// ---------------------------------------------------------------------------

import { parseDirectives } from "../../../../src/docs/lib/directive-parser.js";

describe("parseDirectives mode param", () => {
  it("parses mode=deep from {{text}} params", () => {
    const text = [
      '<!-- {{text({prompt: "Describe the architecture.", mode: "deep"})}} -->',
      "<!-- {{/text}} -->",
    ].join("\n");
    const result = parseDirectives(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].params.mode, "deep");
    assert.equal(result[0].prompt, "Describe the architecture.");
  });

  it("parses mode=light from {{text}} params", () => {
    const text = [
      '<!-- {{text({prompt: "Explain setup.", mode: "light"})}} -->',
      "<!-- {{/text}} -->",
    ].join("\n");
    const result = parseDirectives(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].params.mode, "light");
  });

  it("mode defaults to undefined when not specified", () => {
    const text = [
      '<!-- {{text({prompt: "Explain setup."})}} -->',
      "<!-- {{/text}} -->",
    ].join("\n");
    const result = parseDirectives(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].params.mode, undefined);
  });

  it("parses mode alongside other params", () => {
    const text = [
      '<!-- {{text({prompt: "Describe the architecture.", id: "arch", mode: "deep", maxLines: 10})}} -->',
      "<!-- {{/text}} -->",
    ].join("\n");
    const result = parseDirectives(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].params.mode, "deep");
    assert.equal(result[0].params.id, "arch");
    assert.equal(result[0].params.maxLines, 10);
  });
});
