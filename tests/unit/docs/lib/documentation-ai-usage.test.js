import assert from "node:assert/strict";
import { test } from "node:test";
import { createI18n } from "../../../../src/lib/i18n.js";
import { AgentProviderAttemptContext, AgentProviderAttemptRecord } from "../../../../src/lib/agent-provider-attempt.js";
import { DocumentationAiUsageReport } from "../../../../src/docs/lib/documentation-ai-execution.js";

function record(id, { usage = null, attemptIndex = 0, commandId = "docs.enrich", provider = "fixture", providerStarted = true, status = "completed" } = {}) {
  return new AgentProviderAttemptRecord({
    context: new AgentProviderAttemptContext({ attemptId: id, logicalInvocationId: "call", commandId,
      provider, profileKey: "standard", attemptIndex, maxAttempts: 3, inputCharacters: 100 }),
    usage, providerStarted, status,
  });
}

test("usage totals preserve measured zero, missing fields, retries and provider groups", () => {
  const report = new DocumentationAiUsageReport();
  report.add(record("first", { usage: { input_tokens: 20, output_tokens: 5, cache_read_tokens: 80, cache_creation_tokens: 0 } }));
  report.add(record("retry", { attemptIndex: 1, usage: { input_tokens: 30, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: null } }));
  report.add(record("failed", { status: "failed", commandId: "docs.translate", provider: "another" }));
  const result = report.toJSON();
  assert.equal(result.providerAttemptCount, 3);
  assert.equal(result.retryAttemptCount, 1);
  assert.equal(result.observedAttemptInputCharacters, 300);
  assert.deepEqual(result.tokens.input_tokens, { knownTotal: 50, unknownAttemptCount: 1, complete: false });
  assert.deepEqual(result.tokens.output_tokens, { knownTotal: 7, unknownAttemptCount: 1, complete: false });
  assert.deepEqual(result.tokens.cache_read_tokens, { knownTotal: 80, unknownAttemptCount: 1, complete: false });
  assert.deepEqual(result.tokens.cache_creation_tokens, { knownTotal: 0, unknownAttemptCount: 2, complete: false });
  assert.equal(result.groups.length, 2);
  assert.equal(result.stages.length, 2);
  assert.match(report.toText(createI18n("en", { domain: "messages" }), "completed"), /50 known \/ 1 unknown attempts/);
});

test("duplicate observations cannot double-count actual provider consumption", () => {
  const report = new DocumentationAiUsageReport();
  const observation = record("same", { usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 } });
  report.add(observation);
  report.add(observation);
  assert.equal(report.toJSON().providerAttemptCount, 1);
  assert.equal(report.toJSON().tokens.input_tokens.knownTotal, 10);
  assert.equal(report.toJSON().observationComplete, false);
});

test("not-started attempts and parent stage attribution remain distinct", () => {
  const report = new DocumentationAiUsageReport();
  report.add(record("not-started", { status: "failed", providerStarted: false }));
  report.add(record("readme-provider", { commandId: "docs.text", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } }), "docs.readme");
  const result = report.toJSON();
  assert.equal(result.notStartedAttemptCount, 1);
  assert.equal(result.providerAttemptCount, 1);
  assert.equal(result.stages[0].commandId, "docs.readme");
  assert.deepEqual(result.tokens.input_tokens, { knownTotal: 0, unknownAttemptCount: 0, complete: true });
});
