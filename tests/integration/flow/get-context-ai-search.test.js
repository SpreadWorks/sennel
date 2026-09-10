import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectAllKeywords, buildKeywordSelectionPrompt, fallbackSearch, contextSearch } from "../../../src/flow/lib/get-context.js";
import { container } from "../../../src/lib/container.js";
import { PromptLogicalFootprint } from "../../../src/lib/prompt-batching.js";

const SAMPLE_ANALYSIS = {
  _meta: { version: 1 },
  controllers: {
    entries: [
      { file: "src/auth.js", keywords: ["auth", "認証", "login"], summary: "Auth handler" },
      { file: "src/user.js", keywords: ["user", "ユーザー", "profile"], summary: "User manager" },
    ],
  },
  models: {
    entries: [
      { file: "src/db.js", keywords: ["database", "DB", "データベース"], summary: "DB connection" },
      { file: "src/old.js", summary: "Legacy module" }, // no keywords
    ],
  },
};

const SAMPLE_ENTRIES = [
  { file: "src/auth.js", keywords: ["auth", "認証", "login"], summary: "Auth handler", detail: "Auth detail" },
  { file: "src/user.js", keywords: ["user", "ユーザー", "profile"], summary: "User manager", detail: "User detail" },
  { file: "src/db.js", keywords: ["database", "DB", "データベース"], summary: "DB connection", detail: "DB detail" },
  { file: "src/old.js", summary: "Legacy module", detail: "Legacy detail" },
];

describe("collectAllKeywords", () => {
  it("examines keywords beyond the old 2,000-item cutoff across bounded AI calls", async () => {
    const keywords = Array.from({ length: 2100 }, (_, index) => `${String(index).padStart(4, "0")}-${"x".repeat(60)}`);
    const entries = keywords.map((keyword, index) => ({ file: `src/${index}.js`, keywords: [keyword] }));
    const analysis = { modules: { entries } };
    const originalGet = container.get.bind(container);
    const seen = [];
    let calls = 0;
    container.get = (key) => key !== "agent" ? originalGet(key) : {
      resolve: () => true,
      call: async (userPrompt, options) => {
        calls += 1;
        assert.ok(PromptLogicalFootprint.measure({ userPrompt, ...options }).total <= 120000);
        const batch = userPrompt.split("## Available keywords\n")[1].split(", ");
        seen.push(...batch);
        return JSON.stringify({ keywords: batch.filter((keyword) => keyword === keywords.at(-1)) });
      },
    };
    try {
      const results = await contextSearch(entries, analysis, "semantic query", ".", "ai");
      assert.deepEqual(results.map((entry) => entry.file), ["src/2099.js"]);
      assert.deepEqual(seen, keywords);
      assert.ok(calls > 1);
    } finally {
      container.get = originalGet;
    }
  });

  it("collects unique keywords from all entries", () => {
    const keywords = collectAllKeywords(SAMPLE_ANALYSIS);
    assert.ok(keywords.includes("auth"));
    assert.ok(keywords.includes("認証"));
    assert.ok(keywords.includes("database"));
    assert.ok(keywords.includes("ユーザー"));
  });

  it("deduplicates keywords", () => {
    const keywords = collectAllKeywords(SAMPLE_ANALYSIS);
    const unique = new Set(keywords);
    assert.equal(keywords.length, unique.size);
  });

  it("skips _meta and non-object categories", () => {
    const keywords = collectAllKeywords(SAMPLE_ANALYSIS);
    assert.ok(!keywords.includes("version"));
  });

  it("skips entries without keywords", () => {
    const keywords = collectAllKeywords(SAMPLE_ANALYSIS);
    // "Legacy module" has no keywords, so nothing from it should appear
    assert.ok(!keywords.includes("Legacy"));
  });

  it("returns empty array for empty analysis", () => {
    assert.deepEqual(collectAllKeywords({}), []);
  });
});

describe("buildKeywordSelectionPrompt", () => {
  it("includes the query text", () => {
    const prompt = buildKeywordSelectionPrompt(["auth", "login"], "認証のバグ");
    assert.ok(prompt.includes("認証のバグ"));
  });

  it("includes keywords list", () => {
    const prompt = buildKeywordSelectionPrompt(["auth", "login", "database"], "auth bug");
    assert.ok(prompt.includes("auth"));
    assert.ok(prompt.includes("login"));
    assert.ok(prompt.includes("database"));
  });

  it("returns a non-empty string", () => {
    const prompt = buildKeywordSelectionPrompt(["a", "b"], "test");
    assert.ok(prompt.length > 0);
  });

  it("asks for an object root response", () => {
    const prompt = buildKeywordSelectionPrompt(["auth", "login"], "auth bug");
    assert.match(prompt, /keywords array/);
    assert.match(prompt, /\{"keywords":\[/);
  });
});

describe("fallbackSearch", () => {
  it("splits query by space and does OR search", () => {
    const results = fallbackSearch(SAMPLE_ENTRIES, "auth database");
    assert.equal(results.length, 2);
    const files = results.map((r) => r.file);
    assert.ok(files.includes("src/auth.js"));
    assert.ok(files.includes("src/db.js"));
  });

  it("is case-insensitive", () => {
    const results = fallbackSearch(SAMPLE_ENTRIES, "AUTH");
    assert.equal(results.length, 1);
    assert.equal(results[0].file, "src/auth.js");
  });

  it("matches Japanese keywords", () => {
    const results = fallbackSearch(SAMPLE_ENTRIES, "認証");
    assert.equal(results.length, 1);
    assert.equal(results[0].file, "src/auth.js");
  });

  it("returns empty for no matches", () => {
    const results = fallbackSearch(SAMPLE_ENTRIES, "nonexistent");
    assert.equal(results.length, 0);
  });

  it("skips entries without keywords", () => {
    const results = fallbackSearch(SAMPLE_ENTRIES, "Legacy");
    assert.equal(results.length, 0);
  });

  it("deduplicates results when multiple keywords match same entry", () => {
    const results = fallbackSearch(SAMPLE_ENTRIES, "auth login");
    assert.equal(results.length, 1); // both match src/auth.js but only once
  });
});
