import { createTmpDir as createTestDirectory } from "../../../support/builders/tmp-dir.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PromptBuilder } from "../../../../src/lib/prompt-builder.js";
import { AtomicPromptElement, PromptBatchPlan, PromptInputBuilder, PromptRequestEnvelope, PromptRequestLimit, PromptInvocationExecution } from "../../../../src/lib/prompt-batching.js";
import { AgentProviderAttemptContext, AgentProviderAttemptRecord } from "../../../../src/lib/agent-provider-attempt.js";
import { DocumentationAiExecutionSession, rethrowDocumentationAiStop } from "../../../../src/docs/lib/documentation-ai-execution.js";
import { DocumentationAgent } from "../../../../src/docs/lib/documentation-agent.js";

class FixtureEnvelope extends PromptRequestEnvelope {
  constructor() { super({ revision: "session-fixture" }); }
  build(elements) {
    const builder = new PromptBuilder();
    builder.setRole("Summarize the supplied source.");
    builder.addUserPrompt("Source", elements.map((element) => element.toPromptText()).join("\n"));
    return builder.build();
  }
}

function fixture(t, options = {}) {
  const root = createTestDirectory("sennel-docs-ai-session-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let text = "";
  const output = { isTTY: options.tty || false, write(value) { text += value; } };
  const session = new DocumentationAiExecutionSession({ root, commandId: "docs.build", config: { lang: "en", docs: { ai: { confirmationThresholdCharacters: options.threshold || 1 } } }, output,
    input: { isTTY: options.tty || false }, ...options });
  const agent = new DocumentationAgent({ call: async () => "ok" }, { session }).forCommand("docs.enrich");
  return { root, session, agent, text: () => text };
}

async function prepared(agent, text = "source") {
  const envelope = new FixtureEnvelope();
  const limit = new PromptRequestLimit({ maxCharacters: 10_000 });
  const builder = new PromptInputBuilder({ envelope, limit });
  builder.add(new AtomicPromptElement({ id: "source", sourceRevision: "revision", sequence: 0, text }));
  const executionLimit = agent.createExecutionLimit();
  const plan = PromptBatchPlan.create({ collection: builder.build(), envelope, limit, executionLimit });
  return agent.createExecutor({ executionLimit }).prepareExecution({ plan });
}

function attempt(preparation, attemptIndex, id = `attempt-${attemptIndex}`) {
  const item = preparation.invocations[0];
  const invocation = new PromptInvocationExecution({ preparedExecution: preparation, preparedInvocation: item, protocolAttemptIndex: 0,
    projection: item.projection, inputCharacters: item.inputCharacters });
  return new AgentProviderAttemptContext({ attemptId: id, logicalInvocationId: invocation.logicalInvocationId, commandId: "docs.enrich",
    provider: "fixture", profileKey: "standard", attemptIndex, maxAttempts: 3, inputCharacters: item.inputCharacters, invocation });
}

test("concurrent plans ask once and approved executions may exceed one million cumulative characters", async (t) => {
  let questions = 0;
  const f = fixture(t, { tty: true, ask: async () => { questions++; return true; } });
  const p = await prepared(f.agent, "x".repeat(9000));
  await Promise.all([f.session.admit(p, "docs.enrich"), f.session.admit(p, "docs.enrich")]);
  for (let index = 0; index < 120; index++) await f.session.admit(await prepared(f.agent, "x".repeat(9000)), "docs.enrich");
  assert.equal(questions, 1);
  assert.ok(f.session.plannedInputCharacters > 1_000_000);
  assert.equal(f.agent.createExecutionLimit().maxAggregateCharacters, null);
  const result = await f.session.finish();
  assert.equal(result.status, "completed");
  assert.equal(result.approvalMethod, "interactive");
});

test("noninteractive confirmation is required before any provider worker, and cancellation survives aggregate wrapping", async (t) => {
  const f = fixture(t);
  const p = await prepared(f.agent);
  let calls = 0;
  await assert.rejects(f.agent.createExecutor().executeCompletions({ plan: p.plan, responseContract: { parse: (value) => value },
    callAgent: async () => { calls++; return "result"; } }), { code: "DOCS_AI_CONFIRMATION_REQUIRED" });
  assert.equal(calls, 0);
  assert.throws(() => rethrowDocumentationAiStop(new AggregateError([new Error("wrapped")]), f.agent), { code: "DOCS_AI_CONFIRMATION_REQUIRED" });
  assert.match(f.session.stopError.message, /sennel docs build.*--yes/);
  assert.equal((await f.session.finish()).status, "confirmation-required");
});

test("denial is terminal and later plans cannot ask again or consume input", async (t) => {
  let questions = 0;
  const f = fixture(t, { tty: true, ask: async () => { questions++; return false; } });
  const p = await prepared(f.agent);
  await assert.rejects(f.session.admit(p, "docs.enrich"), { code: "DOCS_AI_CANCELLED" });
  await assert.rejects(f.session.admit(await prepared(new DocumentationAgent({ call: async () => "" })), "docs.text"), { code: "DOCS_AI_CANCELLED" });
  assert.equal(questions, 1);
  assert.equal((await f.session.finish()).status, "cancelled");
});

test("initial planned attempts count once and an additional transport retry crosses the confirmation threshold", async (t) => {
  let questions = 0;
  const f = fixture(t, { tty: true, threshold: 10_000, ask: async () => { questions++; return true; } });
  const p = await prepared(f.agent);
  f.session.threshold = p.inputCharacters * 2;
  await f.session.admit(p, "docs.enrich");
  await f.session.beforeProviderAttempt(attempt(p, 0));
  assert.equal(f.session.plannedInputCharacters, p.inputCharacters);
  assert.equal(questions, 0);
  await f.session.beforeProviderAttempt(attempt(p, 1));
  assert.equal(f.session.plannedInputCharacters, p.inputCharacters * 2);
  assert.equal(questions, 1);
  await f.session.beforeProviderAttempt(attempt(p, 2));
  assert.equal(questions, 1);
});

test("dry-run uses real preflight but never asks, starts a provider, or writes usage artifacts", async (t) => {
  const f = fixture(t, { dryRun: true, tty: true, ask: async () => { assert.fail("dry-run asked for consent"); } });
  const p = await prepared(f.agent);
  await f.session.admit(p, "docs.enrich");
  f.session.markUnknownPhase("docs.text");
  assert.equal(await f.session.finish(), null);
  assert.equal(fs.existsSync(path.join(f.root, ".sennel", "output")), false);
  assert.match(f.text(), /DRY-RUN docs.enrich/);
  assert.match(f.text(), /docs.text/);
  await assert.rejects(f.agent.call("unexpected", {}), /dry-run/);
});

test("one final persisted report covers actual usage and keeps source and prompt data out", async (t) => {
  const f = fixture(t, { yes: true });
  const p = await prepared(f.agent);
  await f.session.admit(p, "docs.readme");
  const context = attempt(p, 0);
  await f.session.beforeProviderAttempt(context);
  f.session.observe(new AgentProviderAttemptRecord({ context, providerStarted: true, status: "completed",
    usage: { input_tokens: 12, output_tokens: 4, cache_read_tokens: 10, cache_creation_tokens: null } }));
  f.session.markPartialError();
  f.session.markExternalCommand("do-not-save-secret-command");
  const first = await f.session.finish();
  assert.equal(await f.session.finish(), first);
  const files = fs.readdirSync(path.join(f.root, ".sennel", "output", "docs-ai-usage"));
  assert.equal(files.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, ".sennel", "output", "docs-ai-usage", files[0]), "utf8"));
  assert.equal(saved.status, "partial-error");
  assert.equal(saved.providerAttemptCount, 1);
  assert.equal(saved.stages[0].commandId, "docs.readme");
  assert.deepEqual(saved.tokens.cache_creation_tokens, { knownTotal: 0, unknownAttemptCount: 1, complete: false });
  assert.ok(!JSON.stringify(saved).includes("do-not-save-secret-command"));
  assert.equal((f.text().match(/AI usage:/g) || []).length, 1);
});

test("report persistence failure does not discard observed usage or replace command status", async (t) => {
  const f = fixture(t, { yes: true });
  fs.mkdirSync(path.join(f.root, ".sennel"));
  fs.writeFileSync(path.join(f.root, ".sennel", "output"), "blocks-directory");
  const result = await f.session.finish();
  assert.equal(result.status, "completed");
  assert.match(f.text(), /Could not save the usage report/);
  assert.match(f.text(), /provider attempts=0/);
});

test("changed execution configuration requires fresh approval even after --yes", async (t) => {
  const f = fixture(t, { yes: true });
  const p = await prepared(f.agent);
  await f.session.admit(p, "docs.enrich");
  fs.mkdirSync(path.join(f.root, ".sennel"));
  fs.writeFileSync(path.join(f.root, ".sennel", "config.json"), "{}");
  await assert.rejects(f.session.beforeProviderAttempt(attempt(p, 0)), { code: "DOCS_AI_CONFIRMATION_REQUIRED" });
});

test("accepted external deletion becomes a new baseline, and recreation requires new approval", async (t) => {
  let questions = 0;
  const f = fixture(t, { tty: true, yes: true, ask: async () => { questions++; return true; } });
  const file = path.join(f.root, "queued.md");
  fs.writeFileSync(file, "source");
  f.session.registerInputs([file]);
  await f.session.admit(await prepared(f.agent), "docs.translate");
  fs.unlinkSync(file);
  await f.session.admit(await prepared(f.agent), "docs.translate");
  await f.session.admit(await prepared(f.agent), "docs.translate");
  assert.equal(questions, 1);
  fs.writeFileSync(file, "recreated");
  await f.session.admit(await prepared(f.agent), "docs.translate");
  assert.equal(questions, 2);
});

test("source bytes changed with restored mtime still require approval", async (t) => {
  const f = fixture(t, { yes: true });
  const file = path.join(f.root, "queued.md");
  fs.writeFileSync(file, "source");
  f.session.registerInputs([file]);
  const originalTime = fs.statSync(file).mtime;
  await f.session.admit(await prepared(f.agent), "docs.translate");
  fs.writeFileSync(file, "changed");
  fs.utimesSync(file, originalTime, originalTime);
  await assert.rejects(f.session.admit(await prepared(f.agent), "docs.translate"), { code: "DOCS_AI_CONFIRMATION_REQUIRED" });
});
