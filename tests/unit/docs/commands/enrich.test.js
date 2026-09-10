import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEnrichPrompt,
  parseEnrichResponse,
  mergeEnrichment,
  collectEntries,
  EnrichmentCheckpointCoordinator,
} from "../../../../src/docs/commands/enrich.js";
import { ConcurrentBatchResult } from "../../../../src/docs/lib/concurrency.js";

describe("collectEntries", () => {
  it("collects entries across categories with index and category", () => {
    const analysis = {
      analyzedAt: "2026-01-01",
      modules: {
        summary: { total: 2 },
        entries: [
          { file: "src/foo.js", name: "foo.js", lines: 100 },
          { file: "src/bar.js", name: "bar.js", lines: 50 },
        ],
      },
    };
    const entries = collectEntries(analysis);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].category, "modules");
    assert.equal(entries[0].index, 0);
    assert.equal(entries[0].file, "src/foo.js");
    assert.equal(entries[0].lines, 100);
    assert.equal(entries[0].enriched, false);
    assert.equal(entries[1].index, 1);
    assert.equal(entries[1].lines, 50);
  });

  it("marks entries with enrich metadata as enriched", () => {
    const analysis = {
      modules: {
        entries: [
          { file: "a.js", enrich: { processedAt: "2026-03-26T00:00:00.000Z", attempts: 1 } },
          { file: "b.js" },
        ],
      },
    };
    const entries = collectEntries(analysis);
    assert.equal(entries[0].enriched, true);
    assert.equal(entries[1].enriched, false);
  });

  it("does not mark entries with summary alone as enriched", () => {
    const analysis = {
      modules: {
        entries: [
          { file: "a.js", summary: "Already done" },
          { file: "b.js" },
        ],
      },
    };
    const entries = collectEntries(analysis);
    assert.equal(entries[0].enriched, false);
    assert.equal(entries[1].enriched, false);
  });

  it("defaults lines to 0 when not present", () => {
    const analysis = {
      modules: { entries: [{ file: "a.js" }] },
    };
    const entries = collectEntries(analysis);
    assert.equal(entries[0].lines, 0);
  });

  it("skips meta keys", () => {
    const analysis = {
      analyzedAt: "2026-01-01",
      enrichedAt: "2026-01-01",
      extras: { foo: "bar" },
      modules: {
        entries: [{ file: "a.js" }],
      },
    };
    const entries = collectEntries(analysis);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].category, "modules");
  });

  it("handles multiple categories", () => {
    const analysis = {
      modules: { entries: [{ file: "a.js" }] },
      controllers: { entries: [{ file: "b.js" }, { file: "c.js" }] },
    };
    const entries = collectEntries(analysis);
    assert.equal(entries.length, 3);
  });
});

describe("EnrichmentCheckpointCoordinator", () => {
  it("does not publish a successful prefix when a later batch fails", () => {
    const analysis = {
      modules: {
        entries: [
          { file: "src/first.js" },
          { file: "src/second.js" },
        ],
      },
    };
    const firstBatch = [{ category: "modules", index: 0, file: "src/first.js" }];
    const checkpoints = [];
    const results = new ConcurrentBatchResult([
      {
        value: {
          batch: firstBatch,
          enrichment: { modules: [{ index: 0, summary: "first", chapter: "overview" }] },
        },
        error: null,
      },
      { value: null, error: new Error("second batch failed") },
    ]);
    const coordinator = new EnrichmentCheckpointCoordinator({
      analysis,
      chapters: ["overview"],
      onCheckpoint(checkpoint) {
        checkpoints.push(structuredClone(checkpoint));
      },
    });

    assert.throws(() => coordinator.apply(results), /second batch failed/);
    assert.equal(checkpoints.length, 0);
    assert.equal(analysis.modules.entries[0].summary, undefined);
    assert.equal(analysis.modules.entries[0].enrich, undefined);
    assert.equal(analysis.modules.entries[1].enrich, undefined);
  });
});

describe("buildEnrichPrompt", () => {
  it("includes file list and chapter list", () => {
    const chapters = ["overview.md", "internal_design.md"];
    const batchEntries = [
      { category: "modules", index: 0, file: "src/foo.js" },
      { category: "modules", index: 1, file: "src/bar.js" },
    ];
    const prompt = buildEnrichPrompt(chapters, batchEntries);

    assert.ok(prompt.includes("src/foo.js"));
    assert.ok(prompt.includes("src/bar.js"));
    assert.ok(prompt.includes("overview"));
    assert.ok(prompt.includes("internal_design"));
    assert.ok(prompt.includes("Output format"));
    assert.ok(prompt.includes("\"entries\""));
    assert.ok(prompt.includes("category"));
    assert.ok(prompt.includes("JSON"));
  });

  it("includes category and index in file header", () => {
    const batchEntries = [
      { category: "modules", index: 5, file: "src/lib/config.js", essential: "import fs from 'fs';" },
    ];
    const prompt = buildEnrichPrompt(["overview.md"], batchEntries);
    assert.ok(prompt.includes("[modules:5]"));
    assert.ok(prompt.includes("src/lib/config.js"));
  });

  it("embeds essential source in prompt", () => {
    const batchEntries = [
      { category: "modules", index: 0, file: "src/a.js", essential: "export function foo() {\nreturn 1;" },
    ];
    const prompt = buildEnrichPrompt(["overview.md"], batchEntries);
    assert.ok(prompt.includes("export function foo()"));
    assert.ok(prompt.includes("return 1"));
    assert.ok(prompt.includes("Analyze"));
  });
});

describe("parseEnrichResponse", () => {
  it("parses clean JSON", () => {
    const json = JSON.stringify({ modules: [{ index: 0, summary: "test" }] });
    const result = parseEnrichResponse(json);
    assert.deepEqual(result, { modules: [{ index: 0, summary: "test" }] });
  });

  it("converts structured entries into grouped enrichment", () => {
    const json = JSON.stringify({
      entries: [{
        category: "modules",
        index: 0,
        summary: "test",
        detail: "detail",
        chapter: "overview",
        role: "lib",
        keywords: ["test"],
        app: null,
      }],
    });
    const result = parseEnrichResponse(json);
    assert.deepEqual(result, {
      modules: [{
        index: 0,
        summary: "test",
        detail: "detail",
        chapter: "overview",
        role: "lib",
        keywords: ["test"],
      }],
    });
  });

  it("strips markdown fences", () => {
    const wrapped = "```json\n" + JSON.stringify({ modules: [] }) + "\n```";
    const result = parseEnrichResponse(wrapped);
    assert.deepEqual(result, { modules: [] });
  });

  it("extracts JSON from surrounding text", () => {
    const text = "Here is the result:\n" + JSON.stringify({ modules: [{ index: 0 }] }) + "\nDone.";
    const result = parseEnrichResponse(text);
    assert.ok(result);
    assert.ok(Array.isArray(result.modules));
  });

  it("returns null for unparseable input", () => {
    assert.equal(parseEnrichResponse("not json at all"), null);
  });

  it("returns null for empty input", () => {
    assert.equal(parseEnrichResponse(""), null);
  });
});

describe("mergeEnrichment", () => {
  it("merges enrichment data into analysis entries", () => {
    const analysis = {
      analyzedAt: "2026-01-01",
      modules: {
        summary: { total: 2 },
        entries: [
          { file: "src/foo.js", name: "foo.js" },
          { file: "src/bar.js", name: "bar.js" },
        ],
      },
    };
    const enrichment = {
      modules: [
        { index: 0, summary: "Foo module", detail: "Does foo things", chapter: "internal_design", role: "lib" },
        { index: 1, summary: "Bar module", detail: "Does bar things", chapter: "overview", role: "cli" },
      ],
    };

    const result = mergeEnrichment(analysis, enrichment, {
      batchEntries: [{ category: "modules", index: 0 }, { category: "modules", index: 1 }],
      attemptsByKey: new Map([
        ["modules:0", 1],
        ["modules:1", 1],
      ]),
    });

    assert.equal(result.modules.entries[0].summary, "Foo module");
    assert.equal(result.modules.entries[0].detail, "Does foo things");
    assert.equal(result.modules.entries[0].chapter, "internal_design");
    assert.equal(result.modules.entries[0].role, "lib");
    assert.equal(result.modules.entries[0].file, "src/foo.js"); // original preserved
    assert.equal(result.modules.entries[0].enrich.attempts, 1);
    assert.ok(result.modules.entries[0].enrich.processedAt);
    assert.equal(result.modules.entries[1].summary, "Bar module");
    assert.ok(result.enrichedAt); // timestamp added
  });

  it("skips invalid indices", () => {
    const analysis = {
      analyzedAt: "2026-01-01",
      modules: {
        summary: { total: 1 },
        entries: [{ file: "a.js" }],
      },
    };
    const enrichment = {
      modules: [
        { index: 5, summary: "Out of range" },
        { index: -1, summary: "Negative" },
      ],
    };

    const result = mergeEnrichment(analysis, enrichment);
    assert.ok(!result.modules.entries[0].summary); // not modified
  });

  it("skips unknown categories", () => {
    const analysis = {
      analyzedAt: "2026-01-01",
      modules: {
        summary: { total: 1 },
        entries: [{ file: "a.js" }],
      },
    };
    const enrichment = {
      unknown_cat: [{ index: 0, summary: "test" }],
    };

    const result = mergeEnrichment(analysis, enrichment);
    assert.ok(!result.unknown_cat);
  });

  it("preserves existing fields when enrichment field is empty", () => {
    const analysis = {
      analyzedAt: "2026-01-01",
      modules: {
        summary: { total: 1 },
        entries: [{ file: "a.js", summary: "original" }],
      },
    };
    const enrichment = {
      modules: [{ index: 0, detail: "new detail" }],
    };

    const result = mergeEnrichment(analysis, enrichment, {
      batchEntries: [{ category: "modules", index: 0 }],
      attemptsByKey: new Map([["modules:0", 2]]),
    });
    assert.equal(result.modules.entries[0].summary, "original"); // preserved
    assert.equal(result.modules.entries[0].detail, "new detail"); // added
    assert.equal(result.modules.entries[0].enrich.attempts, 2);
  });

  it("marks entries as processed even when summary is missing and emits a warning", () => {
    const analysis = {
      analyzedAt: "2026-01-01",
      modules: {
        summary: { total: 1 },
        entries: [{ file: "a.js" }],
      },
    };
    const warnings = [];
    const enrichment = {
      modules: [{ index: 0, detail: "new detail" }],
    };

    const result = mergeEnrichment(analysis, enrichment, {
      batchEntries: [{ category: "modules", index: 0, file: "a.js" }],
      attemptsByKey: new Map([["modules:0", 3]]),
      onWarn: (msg) => warnings.push(msg),
    });

    assert.equal(result.modules.entries[0].detail, "new detail");
    assert.equal(result.modules.entries[0].enrich.attempts, 3);
    assert.ok(result.modules.entries[0].enrich.processedAt);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /a\.js/);
    assert.match(warnings[0], /modules/);
    assert.match(warnings[0], /index=0/);
  });

  it("does not mark entries as processed when they are missing from the AI response", () => {
    const analysis = {
      analyzedAt: "2026-01-01",
      modules: {
        summary: { total: 2 },
        entries: [{ file: "a.js" }, { file: "b.js" }],
      },
    };
    const enrichment = {
      modules: [{ index: 0, summary: "A summary" }],
    };

    const result = mergeEnrichment(analysis, enrichment, {
      batchEntries: [
        { category: "modules", index: 0, file: "a.js" },
        { category: "modules", index: 1, file: "b.js" },
      ],
      attemptsByKey: new Map([
        ["modules:0", 1],
        ["modules:1", 1],
      ]),
    });

    assert.ok(result.modules.entries[0].enrich);
    assert.equal(result.modules.entries[0].enrich.attempts, 1);
    assert.equal(result.modules.entries[1].enrich.processedAt, undefined);
    assert.equal(result.modules.entries[1].enrich.attempts, 1);
  });
});

// getRetryCount and enrichBatchWithRetry tests moved to tests/integration/lib/agent.test.js
// (retry logic is now in callAgentAsync)
