import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildImplReviewPrompt,
  mergeTaskReviewChunkResponses,
  TASK_REVIEW_PROMPT_CHAR_LIMIT,
} from "../../src/flow/commands/review.js";
import { PromptLogicalFootprint as ReviewPromptSize } from "../../src/lib/prompt-batching.js";
import {
  TaskReviewPromptChunk,
  TaskReviewPromptPlan,
  TaskReviewPromptPlanningFailure,
  TaskReviewSourceElement,
} from "../../src/flow/lib/task-review-prompt-plan.js";

function promptFactory({ taskContent = "Implement R1." } = {}) {
  const requirementIds = new Set(["R1"]);
  return ({ sourceText, chunkContext }) => buildImplReviewPrompt({
    requirementFileMap: { R1: ["src/task.js"] },
    requirementIds,
    diff: sourceText,
    touchedFiles: ["src/task.js"],
    taskSpec: { relPath: "tasks/T-9.md", content: taskContent },
    taskContext: {
      task: { id: "T-9", goal: "Implement R1." },
      requirements: [{ id: "R1", desc: "Provide the required behavior." }],
    },
    taskReviewAttempt: 1,
    taskReviewChunk: chunkContext,
  });
}

function exactSizedSource(targetChars) {
  const buildPrompt = promptFactory();
  const probe = "x";
  const measured = ReviewPromptSize.measure(buildPrompt({ sourceText: `## src/task.js\n${probe}`, chunkContext: null })).total;
  const content = "x".repeat(targetChars - measured + probe.length);
  const fullPrompt = buildPrompt({ sourceText: `## src/task.js\n${content}`, chunkContext: null });
  assert.equal(ReviewPromptSize.measure(fullPrompt).total, targetChars);
  return { buildPrompt, content, fullPrompt };
}

describe("TaskReviewPromptPlan", () => {
  it("splits the 174488-character T-9 regression input with complete single-file coverage", () => {
    const { buildPrompt, content, fullPrompt } = exactSizedSource(174488);
    const plan = TaskReviewPromptPlan.create({
      sourceEntries: [{ path: "src/task.js", status: "present", content }],
      buildPrompt,
      maxChars: TASK_REVIEW_PROMPT_CHAR_LIMIT,
    });

    assert.equal(ReviewPromptSize.measure(fullPrompt).total, 174488);
    assert.ok(plan.chunks.length > 1);
    assert.ok(plan.chunks.every((chunk) => chunk.size.total <= TASK_REVIEW_PROMPT_CHAR_LIMIT));
    assert.equal(plan.chunks.flatMap((chunk) => chunk.segments).map((segment) => segment.content).join(""), content);
    assert.deepEqual(
      plan.chunks.flatMap((chunk) => chunk.segments).map((segment) => [segment.start, segment.end]),
      plan.chunks.flatMap((chunk) => chunk.segments).map((segment, index, all) => [
        index === 0 ? 0 : all[index - 1].end,
        segment.end,
      ]),
    );
  });

  it("keeps the existing prompt unchanged when the complete Task Review fits", () => {
    const buildPrompt = promptFactory();
    const sourceEntries = [{ path: "src/task.js", status: "present", content: "export const ready = true;" }];
    const expected = buildPrompt({ sourceText: "## src/task.js\nexport const ready = true;", chunkContext: null });
    const plan = TaskReviewPromptPlan.create({ sourceEntries, buildPrompt, maxChars: TASK_REVIEW_PROMPT_CHAR_LIMIT });

    assert.equal(plan.chunks.length, 1);
    assert.equal(plan.chunks[0].singleShot, true);
    assert.deepEqual(plan.chunks[0].prompt, expected);
  });

  it("keeps an exactly 120000-character complete prompt as one call", () => {
    const { buildPrompt, content } = exactSizedSource(TASK_REVIEW_PROMPT_CHAR_LIMIT);
    const plan = TaskReviewPromptPlan.create({
      sourceEntries: [{ path: "src/task.js", status: "present", content }],
      buildPrompt,
      maxChars: TASK_REVIEW_PROMPT_CHAR_LIMIT,
    });

    assert.equal(plan.chunks.length, 1);
    assert.equal(plan.chunks[0].singleShot, true);
    assert.equal(plan.chunks[0].size.total, TASK_REVIEW_PROMPT_CHAR_LIMIT);
  });

  it("covers present, empty, and deleted files exactly once and in canonical order", () => {
    const buildPrompt = promptFactory();
    const entries = [
      { path: "src/large.js", status: "present", content: "line of source\n".repeat(12000) },
      { path: "src/empty.js", status: "present", content: "" },
      { path: "src/deleted.js", status: "deleted" },
    ];
    const plan = TaskReviewPromptPlan.create({ sourceEntries: entries, buildPrompt, maxChars: TASK_REVIEW_PROMPT_CHAR_LIMIT });
    const segments = plan.chunks.flatMap((chunk) => chunk.segments);

    assert.deepEqual([...new Set(segments.map((segment) => segment.path))], entries.map((entry) => entry.path));
    assert.equal(segments.filter((segment) => segment.path === "src/empty.js").length, 1);
    assert.equal(segments.filter((segment) => segment.path === "src/deleted.js").length, 1);
    assert.equal(segments.find((segment) => segment.path === "src/deleted.js").status, "deleted");
    assert.equal(segments.filter((segment) => segment.path === "src/large.js").map((segment) => segment.content).join(""), entries[0].content);
  });

  it("does not bisect UTF-16 surrogate pairs in a huge unbroken line", () => {
    const buildPrompt = promptFactory();
    const content = "😀".repeat(90000);
    const plan = TaskReviewPromptPlan.create({
      sourceEntries: [{ path: "src/task.js", status: "present", content }],
      buildPrompt,
      maxChars: TASK_REVIEW_PROMPT_CHAR_LIMIT,
    });
    const segments = plan.chunks.flatMap((chunk) => chunk.segments);

    assert.ok(segments.length > 1);
    assert.equal(segments.map((segment) => segment.content).join(""), content);
    assert.ok(segments.every((segment) => !/^[\uDC00-\uDFFF]/.test(segment.content)));
    assert.ok(segments.every((segment) => !/[\uD800-\uDBFF]$/.test(segment.content)));
  });

  it("constructor rejects a typed plan that omits a canonical source element", () => {
    const buildPrompt = promptFactory();
    const first = new TaskReviewSourceElement({ path: "src/task.js", status: "present", content: "source" });
    const omitted = new TaskReviewSourceElement({ path: "src/omitted.js", status: "present", content: "missing" });
    const valid = TaskReviewPromptPlan.create({
      sourceEntries: [{ path: "src/task.js", status: "present", content: "source" }],
      buildPrompt,
      maxChars: TASK_REVIEW_PROMPT_CHAR_LIMIT,
    });

    assert.throws(
      () => new TaskReviewPromptPlan({
        chunks: valid.chunks,
        elements: [first, omitted],
        sourceLength: first.content.length + omitted.content.length,
        maxChars: TASK_REVIEW_PROMPT_CHAR_LIMIT,
      }),
      /omits source element: src\/omitted\.js/,
    );
  });

  it("rejects an indivisible fixed context with a named size breakdown", () => {
    const buildPrompt = promptFactory({ taskContent: "c".repeat(1000) });
    assert.throws(
      () => TaskReviewPromptPlan.create({
        sourceEntries: [{ path: "src/task.js", status: "present", content: "x" }],
        buildPrompt,
        maxChars: 100,
      }),
      (error) => {
        assert.ok(error instanceof TaskReviewPromptPlanningFailure);
        assert.equal(error.failureCode, "TASK_REVIEW_PROMPT_ELEMENT_TOO_LARGE");
        assert.equal(error.elementName, "fixed Task Review context");
        assert.ok(error.size.total > error.maxChars);
        assert.match(error.message, /systemPrompt=\d+, userPrompt=\d+, fmtFallback=\d+, total=\d+/);
        return true;
      },
    );
  });

  it("rejects chunk metadata without the rendered association between source files and ranges", () => {
    const { buildPrompt, content } = exactSizedSource(174488);
    const plan = TaskReviewPromptPlan.create({
      sourceEntries: [{ path: "src/task.js", status: "present", content }],
      buildPrompt,
      maxChars: TASK_REVIEW_PROMPT_CHAR_LIMIT,
    });
    const source = plan.chunks[0];
    assert.throws(
      () => new TaskReviewPromptChunk({
        index: source.index,
        segments: source.segments,
        prompt: {
          systemPrompt: "review",
          userPrompt: source.segments.map(segment => `${segment.path}\n${segment.content}`).join("\n"),
          fmtFallback: "json",
        },
        maxChars: TASK_REVIEW_PROMPT_CHAR_LIMIT,
      }),
      /does not contain its claimed source coverage/,
    );
  });

  it("deduplicates a repeated canonical finding and keeps its blocking disposition", () => {
    const base = {
      findingKey: "missing-behavior",
      title: "Missing behavior",
      failureMode: "spec_behavior_contradiction",
      file: "src/task.js",
      requirementId: "R1",
      issue: "The required behavior is absent.",
      suggestion: "Implement the required behavior.",
      rationale: "R1 requires it.",
    };
    const merged = JSON.parse(mergeTaskReviewChunkResponses([
      JSON.stringify({ blockingFindings: [], nonBlockingImprovements: [{ ...base, disposition: "informational" }] }),
      JSON.stringify({ blockingFindings: [{ ...base, disposition: "must-fix" }], nonBlockingImprovements: [] }),
    ], new Set(["R1"])));

    assert.equal(merged.blockingFindings.length, 1);
    assert.equal(merged.blockingFindings[0].disposition, "must-fix");
    assert.equal(merged.nonBlockingImprovements.length, 0);
  });

  it("preserves distinct canonical findings even when a provider reuses a slug", () => {
    const finding = {
      findingKey: "missing-behavior",
      title: "Missing behavior",
      failureMode: "spec_behavior_contradiction",
      requirementId: "R1",
      issue: "The required behavior is absent.",
      suggestion: "Implement the required behavior.",
      disposition: "must-fix",
      rationale: "R1 requires it.",
    };
    const merged = JSON.parse(mergeTaskReviewChunkResponses([
      JSON.stringify({ blockingFindings: [{ ...finding, file: "src/one.js" }], nonBlockingImprovements: [] }),
      JSON.stringify({ blockingFindings: [{ ...finding, file: "src/two.js" }], nonBlockingImprovements: [] }),
    ], new Set(["R1"])));

    assert.deepEqual(merged.blockingFindings.map((entry) => entry.file), ["src/one.js", "src/two.js"]);
  });
});
