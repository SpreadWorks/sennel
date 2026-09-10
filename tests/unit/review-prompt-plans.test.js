import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AtomicPromptElement,
  PromptExecutionBudget,
  PromptExecutionLimit,
  PromptLogicalFootprint,
} from "../../src/lib/prompt-batching.js";
import {
  DraftReviewCandidateReducer,
  synthesizeReviewFindings,
} from "../../src/flow/commands/review.js";
import {
  DraftSectionPromptElement,
  ReviewTextPromptPlan,
  SpecSectionPromptElement,
} from "../../src/flow/lib/review-text-prompt-plan.js";
import {
  TestCoveragePromptElement,
  TestRequirementPromptElement,
  TestReviewPromptPlan,
  TestSourcePromptElement,
  TestSourcePromptRange,
} from "../../src/flow/lib/test-review-prompt-plan.js";

describe("review prompt plans", () => {
  it("partitions canonical test sources with exact ordered coverage", () => {
    const content = "const assertion = true;\n".repeat(9_000);
    const buildPrompt = (files) => ({
      systemPrompt: "review tests",
      userPrompt: files.map((file) => `${file.source}\n${file.content}`).join("\n"),
      jsonSchema: { type: "object" },
      fmtFallback: "return json",
    });
    const plan = TestReviewPromptPlan.create({
      testFiles: [{ name: "large.test.js", source: "spec/tests/large.test.js", content }],
      buildPrompt,
      maxChars: 120_000,
    });

    assert.ok(plan.batches.length > 1);
    assert.ok(plan.batches.every((batch) => batch.payloadElements.every((entry) => entry instanceof TestSourcePromptRange)));
    const ranges = plan.batches.flatMap((batch) => batch.coverage);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges.at(-1).end, content.length);
    for (let index = 1; index < ranges.length; index += 1) assert.equal(ranges[index - 1].end, ranges[index].start);
  });

  it("scopes individually-fit requirements and coverage when their aggregate exceeds the configured limit", () => {
    const maxChars = 2_400;
    const testFiles = ["R-1", "R-2"].map((id, index) => ({
      name: `${id.toLowerCase()}.test.js`,
      source: `spec/tests/${id.toLowerCase()}.test.js`,
      content: `test ${id}\n${String(index).repeat(350)}`,
    }));
    const requirementEntries = ["R-1", "R-2"].map((id, index) => ({
      id,
      text: `${id}: ${String.fromCharCode(65 + index).repeat(1_250)}`,
    }));
    const coverageSummary = {
      specId: "scoped-review",
      requirements: requirementEntries.map((entry, index) => ({
        id: entry.id,
        status: "covered",
        files: [testFiles[index].source],
      })),
      files: testFiles.map((file, index) => ({
        file: file.source,
        requirementIds: [requirementEntries[index].id],
      })),
    };
    const buildPrompt = (files, authority = { requirements: "", coverage: {} }) => ({
      systemPrompt: "bounded test review",
      userPrompt: JSON.stringify({ files, authority }),
      jsonSchema: null,
      fmtFallback: null,
    });

    const aggregateRequest = buildPrompt(testFiles, {
      requirements: requirementEntries.map((entry) => entry.text).join("\n"),
      coverage: coverageSummary,
    });
    assert.ok(PromptLogicalFootprint.measure(aggregateRequest).total > maxChars);

    const plan = TestReviewPromptPlan.create({
      testFiles,
      requirementEntries,
      coverageSummary,
      buildPrompt,
      maxChars,
    });

    assert.ok(plan.batches.length > 1);
    assert.ok(plan.batches.every((batch) => PromptLogicalFootprint.measure(batch.request).total <= maxChars));
    for (const requirementId of ["R-1", "R-2"]) {
      assert.ok(plan.batches.some((batch) => batch.elements.some((element) => (
        element instanceof TestRequirementPromptElement && element.requirementId === requirementId
      ))));
      assert.ok(plan.batches.some((batch) => batch.elements.some((element) => (
        element instanceof TestCoveragePromptElement && element.requirementId === requirementId
      ))));
    }

    for (const file of testFiles) {
      const ranges = plan.batches
        .flatMap((batch) => batch.payloadElements)
        .filter((element) => element instanceof TestSourcePromptElement && element.source === file.source)
        .sort((left, right) => left.start - right.start);
      assert.ok(ranges.length > 0);
      assert.equal(ranges[0].start, 0);
      assert.equal(ranges.at(-1).end, file.content.length);
      assert.equal(ranges.map((range) => range.text).join(""), file.content);
      for (let index = 1; index < ranges.length; index += 1) {
        assert.equal(ranges[index - 1].end, ranges[index].start);
      }
    }
  });

  for (const [label, ElementClass] of [
    ["spec", SpecSectionPromptElement],
    ["draft", DraftSectionPromptElement],
  ]) {
    it(`partitions a ${label} review document and keeps every request bounded`, () => {
      const request = { systemPrompt: "review", userPrompt: "x".repeat(180_000), jsonSchema: null, fmtFallback: null };
      const plan = ReviewTextPromptPlan.create({ request, maxChars: 120_000, ElementClass, id: `${label}-document` });
      assert.ok(plan.batches.length > 1);
      assert.ok(plan.batches.every((batch) => PromptLogicalFootprint.measure(batch.request).total <= 120_000));
      const reconstructed = plan.batches.flatMap((batch) => batch.payloadElements).map((element) => element.text).join("");
      assert.equal(reconstructed, request.userPrompt);
    });
  }

  it("keeps Spec and Draft canonical review sources and partition leaves immutable", () => {
    for (const [label, ElementClass] of [
      ["Spec", SpecSectionPromptElement],
      ["Draft", DraftSectionPromptElement],
    ]) {
      const request = {
        systemPrompt: "review",
        userPrompt: "canonical original",
        jsonSchema: null,
        fmtFallback: null,
      };
      const source = new ElementClass({
        id: `${label}-canonical-source`, text: request.userPrompt, sourceLength: request.userPrompt.length,
      });
      const plan = ReviewTextPromptPlan.create({ request, maxChars: 1_000, ElementClass });
      const element = plan.corePlan.collection.elements[0];
      const partitionedPlan = ReviewTextPromptPlan.create({
        request: "x".repeat(2_500), maxChars: 1_000, ElementClass,
      });
      const leaf = partitionedPlan.corePlan.collection.elements[0];
      const digest = partitionedPlan.corePlan.collection.digest;
      const serialized = partitionedPlan.corePlan.collection.toJSON();
      const prompt = partitionedPlan.batches[0].request.userPrompt;

      for (const candidate of [source, element, leaf]) {
        assert.throws(() => { candidate.text = "mutated prompt text"; }, TypeError);
        assert.throws(() => { candidate.id = "mutated-id"; }, TypeError);
        assert.throws(() => { candidate.sourceRevision = "mutated-revision"; }, TypeError);
        assert.throws(() => { candidate.start = 1; }, TypeError);
      }

      assert.equal(source.text, "canonical original");
      assert.equal(element.text, "canonical original");
      assert.equal(plan.batches[0].request.userPrompt, "canonical original");
      assert.equal(partitionedPlan.corePlan.collection.digest, digest);
      assert.deepEqual(partitionedPlan.corePlan.collection.toJSON(), serialized);
      assert.equal(partitionedPlan.batches[0].request.userPrompt, prompt);
    }
  });

  it("snapshots nested review request values", () => {
    const schema = {
      type: "object",
      properties: { findings: { type: "array", items: { type: "string" } } },
      required: ["findings"],
    };
    const request = { systemPrompt: "review", userPrompt: "canonical original", jsonSchema: schema, fmtFallback: null };
    const plan = ReviewTextPromptPlan.create({ request, maxChars: 1_000 });
    const envelopeSchema = plan.corePlan.envelope.request.jsonSchema;
    const expectedSchema = structuredClone(schema);

    assert.throws(() => { envelopeSchema.properties.findings.type = "string"; }, TypeError);
    assert.throws(() => { envelopeSchema.required.push("unexpected"); }, TypeError);
    request.userPrompt = "mutated external request";
    schema.properties.findings.type = "string";
    schema.required.push("unexpected");

    assert.equal(plan.batches[0].request.userPrompt, "canonical original");
    assert.deepEqual(plan.corePlan.envelope.request.jsonSchema, expectedSchema);
    assert.deepEqual(plan.batches[0].request.jsonSchema, expectedSchema);
  });

  it("repeats Draft instructions while preserving semantic authority section identities", () => {
    const prefix = "Follow the final Draft Review contract.\n";
    const sections = ["\n## Request\n" + "r".repeat(80_000), "\n## Decisions\n" + "d".repeat(80_000)];
    const plan = ReviewTextPromptPlan.create({
      request: `${prefix}${sections.join("")}`,
      repeatedPrefix: prefix,
      sections,
      maxChars: 120_000,
      ElementClass: DraftSectionPromptElement,
      id: "draft-sections",
    });

    assert.ok(plan.batches.length > 1);
    assert.ok(plan.batches.every((batch) => batch.request.userPrompt.startsWith(prefix)));
    assert.deepEqual(plan.corePlan.collection.originalElements.map((element) => element.originId), [
      "draft-sections:section:0",
      "draft-sections:section:1",
    ]);
  });

  it("detects a relation that exists only across authoritative chunks with no local map findings", async () => {
    const authorityElements = [
      new AtomicPromptElement({
        id: "contract-a", sourceRevision: "revision-a", sequence: 0,
        text: `Contract A requires mode=serial.\n${"a".repeat(1_150)}`,
      }),
      new AtomicPromptElement({
        id: "contract-b", sourceRevision: "revision-b", sequence: 1,
        text: `Contract B requires mode=parallel.\n${"b".repeat(1_150)}`,
      }),
    ];
    const calls = [];
    let finalSourceRefs = [];
    const result = await synthesizeReviewFindings({
      initialItems: [],
      authorityElements,
      toText: JSON.stringify,
      buildRequest: (texts, _context, sourceRefs) => {
        finalSourceRefs = sourceRefs;
        return { systemPrompt: "final cross-check", userPrompt: texts.join("\n"), jsonSchema: null, fmtFallback: null };
      },
      parseResponse: JSON.parse,
      responseItems: (response) => response.findings,
      mergeResponses: (responses) => ({ findings: responses.flatMap((response) => response.findings) }),
      emptyResponse: () => ({ findings: [] }),
      maxChars: 2_000,
      executionBudget: new PromptExecutionBudget(new PromptExecutionLimit({
        maxRequestCharacters: 2_000,
        maxBatchCount: 8,
        maxProviderCallCount: 8,
        maxSynthesisCallCount: 8,
        maxAggregateCharacters: 20_000,
      })),
      callAgent: async (request) => {
        calls.push(request);
        if (/bounded review evidence reducer/.test(request.systemPrompt || "")) {
          if (request.userPrompt.includes("mode=serial")) return "Contract A requires mode=serial.";
          if (request.userPrompt.includes("mode=parallel")) return "Contract B requires mode=parallel.";
          throw new Error("summary request lost canonical authority");
        }
        assert.match(request.userPrompt, /mode=serial/);
        assert.match(request.userPrompt, /mode=parallel/);
        return JSON.stringify({ findings: ["conflicting execution modes"] });
      },
    });

    assert.deepEqual(result, { findings: ["conflicting execution modes"] });
    assert.equal(calls.filter((request) => /bounded review evidence reducer/.test(request.systemPrompt || "")).length, 2);
    assert.equal(calls.at(-1).systemPrompt, "final cross-check");
    assert.ok(finalSourceRefs.some((ref) => ref.includes('"elementId":"contract-a"')));
    assert.ok(finalSourceRefs.some((ref) => ref.includes('"elementId":"contract-b"')));
  });

  it("keeps a higher-impact Draft candidate beyond the old per-map artifact cutoff for global ranking", () => {
    const candidates = Array.from({ length: 25 }, (_, index) => ({
      title: index === 24 ? "highest-impact-late-candidate" : `candidate-${index}`,
      body: `decision evidence ${index}`,
      file: null,
    }));
    const reduced = new DraftReviewCandidateReducer().reduce([
      { response: candidates.slice(0, 12) },
      { response: candidates.slice(12) },
    ]);

    assert.equal(reduced.length, 25);
    assert.equal(reduced.at(-1).title, "highest-impact-late-candidate");
  });
});
