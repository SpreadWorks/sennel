import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LinearPromptBatchTopology,
  PromptBatchExecutor,
  PromptBatchPlan,
  PromptExecutionLimit,
  PromptInputBuilder,
  PromptRequestLimit,
} from "../../../../src/lib/prompt-batching.js";
import {
  DocumentationEnrichPromptEnvelope,
  DocumentationEnrichmentResponseContract,
  reduceDocumentationEnrichment,
} from "../../../../src/docs/lib/documentation-enrich-batching.js";
import { generateDocumentationDirectives } from "../../../../src/docs/lib/documentation-text-batching.js";
import { synthesizeProjectInstructions } from "../../../../src/docs/lib/documentation-agents-batching.js";
import { MarkdownPromptDocument } from "../../../../src/docs/lib/markdown-prompt-document.js";
import { DocumentationAnalysisPromptElement, documentationSourceRevision } from "../../../../src/docs/lib/prompt-elements.js";

describe("documentation prompt batching", () => {
  it("preserves complete coverage for a single oversized enrichment entry", () => {
    const source = `${"source-line\n".repeat(1800)}tail-evidence`;
    const envelope = new DocumentationEnrichPromptEnvelope({
      chapters: ["overview.md"],
      lang: "en",
      fmtFallback: '{"entries":[]}',
    });
    const limit = new PromptRequestLimit({ maxCharacters: 5000 });
    const builder = new PromptInputBuilder({ envelope, limit });
    builder.add(new DocumentationAnalysisPromptElement({
      id: "analysis:modules:0",
      sourceRevision: documentationSourceRevision(source),
      sequence: 0,
      category: "modules",
      index: 0,
      file: "src/giant.js",
      text: source,
    }));
    const collection = builder.build();
    const plan = PromptBatchPlan.create({ collection, envelope, limit, topology: new LinearPromptBatchTopology() });

    assert.ok(plan.batches.length > 1);
    assert.equal(plan.batches.flatMap((batch) => batch.payloadElements).map((element) => element.text).join(""), source);
    assert.ok(plan.batches.every((batch) => batch.footprint.total <= 5000));
  });

  it("rejects enrichment entries that do not satisfy the complete typed schema", () => {
    const element = new DocumentationAnalysisPromptElement({
      id: "analysis:modules:0",
      sourceRevision: documentationSourceRevision("source"),
      sequence: 0,
      category: "modules",
      index: 0,
      file: "src/module.js",
      text: "source",
    });
    const response = JSON.stringify({
      entries: [{
        elementId: element.id,
        category: "modules",
        index: 0,
        summary: "summary",
        detail: "detail",
        chapter: "overview",
        role: "unsupported-role",
        keywords: ["too-few"],
        app: null,
      }],
    });

    assert.throws(
      () => new DocumentationEnrichmentResponseContract().parse(response, { digest: "batch", payloadElements: [element] }),
      (error) => error.code === "PROMPT_RESPONSE_INVALID",
    );
  });

  it("semantically synthesizes conflicting oversized enrichment fragments without raw concatenation", async () => {
    const source = `${"implementation evidence\n".repeat(1300)}tail behavior`;
    const envelope = new DocumentationEnrichPromptEnvelope({
      chapters: ["overview.md"],
      lang: "en",
      fmtFallback: '{"entries":[]}',
    });
    const limit = new PromptRequestLimit({ maxCharacters: 3500 });
    const builder = new PromptInputBuilder({ envelope, limit });
    builder.add(new DocumentationAnalysisPromptElement({
      id: "analysis:modules:0",
      sourceRevision: documentationSourceRevision(source),
      sequence: 0,
      category: "modules",
      index: 0,
      file: "src/large-module.js",
      text: source,
    }));
    const collection = builder.build();
    const executionLimit = new PromptExecutionLimit({ maxRequestCharacters: 3500, concurrency: 2 });
    const plan = PromptBatchPlan.create({ collection, envelope, limit, topology: new LinearPromptBatchTopology(), executionLimit });
    const prompts = [];
    const agent = {
      async call(prompt, options) {
        prompts.push(prompt);
        if (options.jsonSchema?.properties?.entry) {
          return JSON.stringify({
            entry: {
              elementId: "analysis:modules:0",
              category: "modules",
              index: 0,
              summary: "coherent full summary",
              detail: "coherent detail covering early and tail behavior",
              chapter: "overview",
              role: "lib",
              keywords: ["module", "behavior", "implementation"],
              app: null,
            },
          });
        }
        const entries = plan.batches.find((candidate) => candidate.request.userPrompt === prompt).payloadElements.map((element) => ({
          elementId: element.id,
          category: element.category,
          index: element.index,
          summary: `conflicting fragment ${element.start}`,
          detail: `range-only detail ${element.start}:${element.end}`,
          chapter: "overview",
          role: element.start === 0 ? "controller" : "model",
          keywords: ["fragment", "range", "source"],
          app: null,
        }));
        return JSON.stringify({ entries });
      },
    };
    const executor = new PromptBatchExecutor({ executionLimit });
    executor.executionBudget.assertCanExecute(plan.batches.length + 1);
    executor.executionBudget.consumeSynthesisCalls(1);
    const callOptions = (request) => ({
      commandId: "docs.enrich",
      systemPrompt: request.systemPrompt,
      jsonSchema: request.jsonSchema,
      fmtFallback: request.fmtFallback,
    });
    const completions = await executor.executeCompletions({
      plan,
      responseContract: new DocumentationEnrichmentResponseContract(),
      callAgent: (request, batch, _retryIndex, _attemptContext, providerCallAdmission) => agent.call(request.userPrompt, {
        ...callOptions(request),
        batch,
        providerCallAdmission,
      }),
    });
    const enrichment = await reduceDocumentationEnrichment({
      completions,
      agent,
      executor,
      limit,
      executionLimit,
      lang: "en",
      callOptions,
    });

    assert.equal(enrichment.modules[0].summary, "coherent full summary");
    assert.equal(enrichment.modules[0].detail, "coherent detail covering early and tail behavior");
    assert.ok(!enrichment.modules[0].detail.includes("range-only detail"));
    assert.ok(prompts.some((prompt) => prompt.includes("tail behavior")));
  });

  it("processes the complete oversized text context and reduces exact directive results", async () => {
    const source = `${"alpha\n".repeat(2500)}tail-evidence`;
    const calls = [];
    const agent = {
      resolve: () => ({ provider: "fixture" }),
      async call(prompt, options) {
        calls.push({ prompt, options });
        return JSON.stringify({ d0: "generated" });
      },
    };
    const result = await generateDocumentationDirectives({
      cleanText: source,
      enrichedContext: "",
      analysisContext: {},
      textFills: [{ raw: '<!-- {{text({prompt: "describe"})}} -->', prompt: "describe", params: {} }],
      fileName: "oversized.md",
      systemPrompt: "Write docs.",
      lang: "en",
      agent,
      maxCharacters: 4000,
      concurrency: 2,
    });

    assert.ok(calls.length > 1);
    assert.ok(calls.some((call) => call.prompt.includes("tail-evidence")));
    assert.ok(calls.every(({ prompt, options }) => (
      prompt.length
      + String(options.systemPrompt || "").length
      + JSON.stringify(options.jsonSchema).length
      + String(options.fmtFallback || "").length
    ) <= 4000));
    assert.deepEqual(result, { d0: "generated" });
  });

  it("rejects missing directive IDs without producing a reduced result", async () => {
    const agent = { resolve: () => true, call: async () => "{}" };
    await assert.rejects(
      generateDocumentationDirectives({
        cleanText: "context",
        analysisContext: {},
        textFills: [{ raw: "directive", prompt: "describe", params: {} }],
        fileName: "missing.md",
        systemPrompt: "Write docs.",
        lang: "en",
        agent,
        maxCharacters: 4000,
      }),
      (error) => error.code === "PROMPT_BATCH_EXECUTION_INCOMPLETE"
        && error.details.causeCode === "PROMPT_RESPONSE_COVERAGE_INVALID",
    );
  });

  it("rejects blank directive text at the typed response boundary", async () => {
    const agent = { resolve: () => true, call: async () => '{"d0":"   "}' };
    await assert.rejects(
      generateDocumentationDirectives({
        cleanText: "complete source evidence",
        analysisContext: { modules: [{ name: "library" }] },
        textFills: [{ raw: "directive", prompt: "describe", params: {} }],
        fileName: "blank.md",
        systemPrompt: "Write docs.",
        lang: "en",
        agent,
        maxCharacters: 4000,
      }),
      (error) => error.code === "PROMPT_BATCH_EXECUTION_INCOMPLETE"
        && error.details.causeCode === "PROMPT_RESPONSE_INVALID",
    );
  });

  it("uses final-document semantics and preserves repository inspection for a fitting text request", async () => {
    const calls = [];
    const agent = {
      async call(prompt, options) {
        calls.push({ prompt, options });
        return '{"d0":"Verified project facts."}';
      },
    };
    await generateDocumentationDirectives({
      cleanText: "# Stack\n",
      analysisContext: {},
      textFills: [{ raw: "directive", prompt: "describe dependencies", params: {} }],
      fileName: "stack.md",
      systemPrompt: "Write docs.",
      lang: "en",
      agent,
      executionWorkDir: "/project",
      maxCharacters: 4000,
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].options.systemPrompt, /coherent final Markdown/);
    assert.match(calls[0].options.systemPrompt, /inspect current-project files/);
    assert.doesNotMatch(calls[0].options.systemPrompt, /Use only the supplied context ranges/);
    assert.equal(calls[0].options.executionWorkDir, "/project");
  });

  it("keeps many individually small directive scopes within a small configured limit", async () => {
    const calls = [];
    const directives = Array.from({ length: 12 }, (_, index) => ({
      raw: `directive-${index}`,
      prompt: `Write section ${index}`,
      params: { id: `section-${index}` },
    }));
    const agent = {
      async call(prompt, options) {
        calls.push({ prompt, options });
        return JSON.stringify(Object.fromEntries(options.jsonSchema.required.map((id) => [id, `result-${id}`])));
      },
    };

    const result = await generateDocumentationDirectives({
      cleanText: "small canonical context",
      enrichedContext: "small enriched context",
      analysisContext: {},
      textFills: directives,
      fileName: "many.md",
      systemPrompt: "Write docs.",
      lang: "en",
      agent,
      maxCharacters: 1200,
      concurrency: 2,
    });

    assert.equal(Object.keys(result).length, directives.length);
    assert.ok(calls.every(({ prompt, options }) => (
      prompt.length
      + String(options.systemPrompt || "").length
      + JSON.stringify(options.jsonSchema).length
      + String(options.fmtFallback || "").length
    ) <= 1200));
  });

  it("uses more than one semantic reduction level before final directive synthesis", async () => {
    const reductionPrompts = [];
    const agent = {
      async call(prompt, options) {
        const id = options.jsonSchema.required[0];
        if (options.systemPrompt.includes("Compress all supplied typed evidence")) {
          reductionPrompts.push(prompt);
          return JSON.stringify({ [id]: "R".repeat(150) });
        }
        if (options.systemPrompt.includes("Synthesize one coherent final Markdown section")) {
          return JSON.stringify({ [id]: "final section" });
        }
        return JSON.stringify({ [id]: "M".repeat(600) });
      },
    };

    const result = await generateDocumentationDirectives({
      cleanText: `${"evidence line\n".repeat(2200)}tail evidence`,
      enrichedContext: "",
      analysisContext: {},
      textFills: [{ raw: "directive", prompt: "describe all evidence", params: { id: "complete" } }],
      fileName: "reduction.md",
      systemPrompt: "Write docs.",
      lang: "en",
      agent,
      maxCharacters: 2000,
      concurrency: 2,
    });

    assert.equal(result.complete, "final section");
    assert.ok(reductionPrompts.some((prompt) => prompt.includes("Reduced evidence")), "a second reduction level should consume prior reduced evidence");
  });

  it("partitions Markdown without crossing heading, table, fence, or directive boundaries", () => {
    const content = [
      "# Heading",
      "",
      "Paragraph text.",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "```js",
      "const x = 1;",
      "```",
      '<!-- {{data("base.source.list")}} -->',
      "<!-- {{/data}} -->",
      "",
    ].join("\n");
    const document = new MarkdownPromptDocument({ id: "doc", content });

    assert.equal(document.elements.map((element) => element.text).join(""), content);
    assert.deepEqual(
      document.elements.filter((element) => !["blank", "paragraph"].includes(element.blockKind)).map((element) => element.blockKind),
      ["heading", "table", "code-fence", "directive", "directive"],
    );
  });

  it("maps oversized documentation context before one bounded PROJECT synthesis", async () => {
    const calls = [];
    const agent = {
      resolve: () => true,
      async call(prompt, options) {
        calls.push({ prompt, options });
        return options.jsonSchema ? '{"summary":"bounded facts"}' : "## Project\n\nUse bounded facts.";
      },
    };
    const result = await synthesizeProjectInstructions({
      contexts: [{ label: "Generated docs", text: `${"fact line\n".repeat(1800)}tail fact` }],
      rules: "Return only the PROJECT section.",
      agent,
      maxCharacters: 4000,
      concurrency: 2,
    });

    assert.equal(result, "## Project\n\nUse bounded facts.");
    assert.ok(calls.filter((call) => call.options.jsonSchema).length > 1);
    assert.equal(calls.filter((call) => !call.options.jsonSchema).length, 1);
    assert.ok(calls.every(({ prompt, options }) => (
      prompt.length
      + String(options.systemPrompt || "").length
      + JSON.stringify(options.jsonSchema).length
      + String(options.fmtFallback || "").length
    ) <= 4000));
  });
});
