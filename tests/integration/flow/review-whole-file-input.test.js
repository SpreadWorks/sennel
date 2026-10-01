import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ReviewTextPromptPlan } from "../../../src/flow/lib/review-text-prompt-plan.js";
import { PromptBatchExecutor, PromptLogicalFootprint, PromptExecutionBudget, ResolvedAgentInvocationProjection } from "../../../src/lib/prompt-batching.js";
import { AgentFileInputFailure } from "../../../src/lib/agent-file-input-failure.js";
import { AgentResponseProtocolFailure } from "../../../src/lib/agent-response-protocol.js";
import { adaptJsonSchemaForProvider } from "../../../src/lib/provider-schema.js";
import { validateSchema } from "../../../src/lib/schema-validate.js";
import { synthesizeReviewFindings, classifyReviewCommandError, buildDraftReviewSynthesisPrompt, parseCompleteDraftReviewProposals } from "../../../src/flow/commands/review.js";

function fixture(t, text) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "review-whole-file-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const request = { systemPrompt: "review entire authority", userPrompt: text, jsonSchema: null, fmtFallback: null };
  const plan = ReviewTextPromptPlan.create({ request, maxChars: 6_000, projectRoot });
  t.after(() => plan.dispose());
  return { plan, request };
}
const body = `HEAD mode=serial\n${'日本語 "escaped" \\ 😀\n'.repeat(8_000)}TAIL mode=parallel`;
const parse = (raw) => JSON.parse(raw).findings;

async function execute(plan, callAgent) {
  return new PromptBatchExecutor().executeCompletions({ plan: plan.corePlan, callAgent,
    protocolPolicy: plan.protocolPolicy(parse),
    responseContract: { parse, itemCount: (value) => value.length } });
}

test("large Unicode review input reaches one provider request as complete exact bytes", async (t) => {
  const { plan, request } = fixture(t, body);
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.corePlan.collection.elements.length, 1);
  assert.ok(PromptLogicalFootprint.measure(plan.batches[0].request).total <= 6_000);
  assert.equal(fs.readFileSync(plan.fileInput.filePath, "utf8"), request.userPrompt);
  assert.equal(plan.fileInput.reference.byteLength, Buffer.byteLength(body));
  let calls = 0;
  const result = await execute(plan, (request) => {
    calls += 1;
    assert.ok(request.userPrompt.includes(plan.fileInput.reference.absolutePath));
    assert.ok(!request.userPrompt.includes("canonical characters"));
    const full = fs.readFileSync(plan.fileInput.filePath, "utf8");
    return JSON.stringify({ findings: full.startsWith("HEAD mode=serial") && full.endsWith("TAIL mode=parallel") ? ["global contradiction"] : [] });
  });
  assert.equal(calls, 1);
  assert.deepEqual(result[0].response, ["global contradiction"]);
});

test("final global synthesis receives the same complete immutable file authority", async (t) => {
  const { plan } = fixture(t, body);
  let calls = 0;
  const findings = await synthesizeReviewFindings({ initialItems: [], authorityElements: plan.corePlan.collection.elements,
    toText: JSON.stringify, buildRequest: (texts, _context, refs) => buildDraftReviewSynthesisPrompt(texts, { key: "coverage" }, refs, plan.batches[0].request.userPrompt),
    parseResponse: parse, responseItems: (value) => value, emptyResponse: () => [], maxChars: 6_000,
    protocolPolicy: plan.protocolPolicy(parse), executionBudget: new PromptExecutionBudget(),
    callAgent: (request) => {
      calls += 1;
      assert.ok(request.userPrompt.includes(plan.fileInput.reference.absolutePath));
      assert.equal(fs.readFileSync(plan.fileInput.filePath, "utf8"), body);
      return JSON.stringify({ findings: ["head/tail contradiction"] });
    } });
  assert.equal(calls, 1);
  assert.deepEqual(findings, ["head/tail contradiction"]);
});

for (const size of ["inline", "whole-file"]) {
  test(`rejects incomplete ${size} Draft coverage synthesis instead of dropping valid map findings`, async (t) => {
    const { plan } = fixture(t, size === "inline" ? "Complete Draft authority" : body);
    const proposals = parseCompleteDraftReviewProposals("### 1. Missing validation\n**Classification:** blocking\n**Issue:** Missing validation.");
    const policy = plan.protocolPolicy(parseCompleteDraftReviewProposals);
    await assert.rejects(synthesizeReviewFindings({
      initialItems: proposals, authorityElements: plan.corePlan.collection.elements,
      toText: JSON.stringify,
      buildRequest: (texts, _context, refs) => buildDraftReviewSynthesisPrompt(texts, { key: "coverage" }, refs, plan.fileInput ? plan.batches[0].request.userPrompt : null),
      parseResponse: parseCompleteDraftReviewProposals, responseItems: (value) => value, emptyResponse: () => [],
      maxChars: 6_000, executionBudget: new PromptExecutionBudget(),
      ...(policy ? { protocolPolicy: policy } : {}),
      callAgent: () => "NO_PROPOSALS because the full input could not be evaluated",
    }), (error) => size === "whole-file"
      ? error.cause instanceof AgentResponseProtocolFailure
      : error.code === "PROMPT_BATCH_EXECUTION_INCOMPLETE" && error.cause?.code === "PROMPT_RESPONSE_INVALID");
    assert.equal(proposals.length, 1);
  });
}

for (const [name, mutate] of [["changed", (file) => fs.writeFileSync(file, "changed")], ["missing", (file) => fs.unlinkSync(file)]]) {
  test(`rejects ${name} immutable input before provider execution`, async (t) => {
    const { plan } = fixture(t, body);
    mutate(plan.fileInput.filePath);
    let calls = 0;
    await assert.rejects(execute(plan, () => { calls += 1; return '{"findings":[]}'; }),
      (error) => error.cause instanceof AgentResponseProtocolFailure && error.cause.data.failureMode === "local_input_failure");
    assert.equal(calls, 0);
  });
}

for (const [kind, mode] of [["file-read-failed", "file_read_failure"], ["context-limit", "context_limit"]]) {
  test(`stops ${kind} without converting unread review input into success`, async (t) => {
    const { plan } = fixture(t, body);
    let calls = 0;
    await assert.rejects(execute(plan, () => {
      calls += 1;
      return JSON.stringify({ evaluationUnavailable: { kind, reason: "complete input unavailable" } });
    }), (error) => {
      assert.ok(error.cause instanceof AgentResponseProtocolFailure);
      assert.equal(error.cause.data.failureMode, mode);
      const failure = classifyReviewCommandError(error, "spec");
      assert.equal(failure.failureCode, "REVIEW_FILE_EVALUATION_UNAVAILABLE");
      assert.equal(failure.classification, kind === "context-limit" ? "input_size_failure" : "provider_failure");
      assert.equal(failure.retryable, false);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("rejects a complete-looking response after provider changes referenced input", async (t) => {
  const { plan } = fixture(t, body);
  await assert.rejects(execute(plan, () => {
    fs.writeFileSync(plan.fileInput.filePath, "changed during evaluation");
    return '{"findings":[]}';
  }), (error) => error.cause instanceof AgentResponseProtocolFailure && error.cause.data.failureMode === "local_input_failure");
});

test("fitting Unicode characters use a full file when argv byte projection overflows", (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "review-byte-projection-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const text = "日本語".repeat(30_000);
  const request = { userPrompt: text };
  assert.ok(PromptLogicalFootprint.measure(request).total < 120_000);
  const projectInvocation = (request) => new ResolvedAgentInvocationProjection({
    providerKey: "fixture", profileKey: "fixture", command: "fixture",
    promptCharacterCount: request.userPrompt.length, systemPromptCharacterCount: 0, schemaCharacterCount: 0,
    finalArgs: [request.userPrompt], inlineArgvByteCount: Buffer.byteLength(request.userPrompt), schemaMode: "none", usesStdin: false });
  const plan = ReviewTextPromptPlan.create({ request, maxChars: 120_000, projectRoot, projectInvocation });
  t.after(() => plan.dispose());
  assert.equal(plan.batches.length, 1);
  assert.equal(fs.readFileSync(plan.fileInput.filePath, "utf8"), text);
  assert.ok(projectInvocation(plan.batches[0].request).fits(120_000));
});

test("file schema supports strict providers and rejects mixed success/unavailable outcomes", async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "review-file-schema-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const successSchema = { type: "object", additionalProperties: false, required: ["findings"],
    properties: { findings: { type: "array", items: { type: "string" } } } };
  const plan = ReviewTextPromptPlan.create({ request: { userPrompt: body, jsonSchema: successSchema }, maxChars: 6_000, projectRoot });
  t.after(() => plan.dispose());
  const schema = plan.batches[0].request.jsonSchema;
  const success = { reviewResponse: { findings: [] }, evaluationUnavailable: null };
  assert.deepEqual(validateSchema(success, schema), []);
  const providerSchema = adaptJsonSchemaForProvider("codex", schema);
  assert.equal(providerSchema.type, "object");
  assert.deepEqual(providerSchema.required.sort(), ["evaluationUnavailable", "reviewResponse"]);
  const completed = await execute(plan, () => JSON.stringify(success));
  assert.deepEqual(completed[0].response, []);
  for (const kind of ["file-read-failed", "context-limit", "evaluation-failed"]) {
    assert.deepEqual(validateSchema({ reviewResponse: null, evaluationUnavailable: { kind, reason: "complete input unavailable" } }, schema), []);
  }
  await assert.rejects(execute(plan, () => JSON.stringify({ reviewResponse: { findings: [] },
    evaluationUnavailable: { kind: "context-limit", reason: "incomplete" } })),
    (error) => error.cause instanceof AgentResponseProtocolFailure);
  await assert.rejects(execute(plan, () => JSON.stringify({ reviewResponse: null, evaluationUnavailable: null })),
    (error) => error.cause instanceof AgentResponseProtocolFailure);
  assert.ok(validateSchema({ reviewResponse: null, evaluationUnavailable: { kind: "unsupported", reason: "failure" } }, schema).length > 0);
});

test("materialization failure is a typed local stop before review execution", (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "review-file-materialize-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectRoot, ".sennel"), "blocked runtime directory");
  assert.throws(() => ReviewTextPromptPlan.create({ request: body, maxChars: 6_000, projectRoot }), (error) => {
    assert.ok(error instanceof AgentFileInputFailure);
    const failure = classifyReviewCommandError(error, "draft");
    assert.equal(failure.failureCode, "REVIEW_FILE_EVALUATION_UNAVAILABLE");
    assert.equal(failure.retryable, false);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(projectRoot, ".sennel"), "utf8"), "blocked runtime directory");
});
