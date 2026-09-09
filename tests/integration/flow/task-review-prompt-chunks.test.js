import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { container } from "../../../src/lib/container.js";
import { TemporaryRateLimitFailure } from "../../../src/lib/agent-failure.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import FlowReviewCommand, { classifyReviewCommandError } from "../../../src/flow/commands/review.js";

const PASS = JSON.stringify({ blockingFindings: [], nonBlockingImprovements: [] });
// With the canonical fixture context, the original complete prompt is 174,488
// characters, matching the reported failure without copying live Flow evidence.
const SOURCE = Array.from({ length: 2400 }, (_, i) => `source-line-${String(i).padStart(4, "0")}: ${"x".repeat(55)}\n`).join("").slice(0, -10691);

class ChunkReviewAgent {
  constructor(respond = () => PASS) { this.calls = []; this.respond = respond; }
  resolve() { return { provider: "fixture", profile: "review" }; }
  providerRetryPolicy() { return { retryCount: 0, retryDelayMs: 1, backoffFactor: 2 }; }
  async call(prompt, options) {
    this.calls.push({ prompt, options });
    assert.ok(prompt.length + (options.systemPrompt?.length ?? 0) + (options.fmtFallback?.length ?? 0) <= 120000);
    return this.respond(this.calls.length, prompt);
  }
}

function scenarioFor(t, options = {}) {
  const scenario = new TaskReviewScenario(t, options);
  container.reset();
  container.register("root", scenario.root);
  container.register("mainRoot", scenario.root);
  container.register("flowManager", scenario.manager);
  container.register("config", { flow: { review: {} } });
  t.after(() => container.reset());
  return scenario;
}

// The actual parent prepares canonical inputs; only the child process and AI
// boundaries are faked. The command builds prompts, persists output, and seals.
function worker(agent, observe = () => {}) {
  return async (_command, args, options) => {
    const saved = new Map();
    for (const [key, value] of Object.entries(options.env)) {
      if (!key.startsWith("SENNEL_REVIEW_")) continue;
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
    container.register("agent", agent);
    try {
      await new FlowReviewCommand().execute({ _rawArgs: args.slice(1) });
      observe(options.env.SENNEL_REVIEW_OUTPUT_DIR, null);
      return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
    } catch (error) {
      observe(options.env.SENNEL_REVIEW_OUTPUT_DIR, error);
      const failure = classifyReviewCommandError(error, "impl");
      return { ok: false, status: 1, stdout: "", stderr: failure?.toMarkerLine() ?? error.stack, signal: null, killed: false };
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

function publications(scenario) {
  return scenario.manager.artifactCatalog(scenario.specId).artifacts.filter(entry => entry.logicalKey === "task.review");
}

test("oversized canonical Task source is fully reviewed before one published PASS survives reload", async t => {
  const scenario = scenarioFor(t, { implementationContent: SOURCE });
  const agent = new ChunkReviewAgent();
  const result = await scenario.review(worker(agent)).execute(scenario.context());
  assert.notEqual(result.ok, false, JSON.stringify(result));
  assert.ok(agent.calls.length > 1);
  t.diagnostic(`174488-character baseline input: chunk sizes ${agent.calls.map(({ prompt, options }) => prompt.length + options.systemPrompt.length + options.fmtFallback.length).join(", ")}`);
  for (const line of SOURCE.split("\n").filter(Boolean)) {
    assert.ok(agent.calls.some(call => call.prompt.includes(line)), `${line} must be reviewed`);
  }
  assert.equal(publications(scenario).length, 0, "worker completion alone must not publish");
  await FLOW_COMMANDS.run.review.post(scenario.context(), result);
  scenario.reload();
  assert.equal(publications(scenario).length, 1);
  assert.equal(scenario.state().current.at(-1), "T-1-gate");
  assert.equal(fs.readFileSync(scenario.sourcePath, "utf8"), SOURCE);
});

test("a later Task chunk protocol failure leaves no final artifact, seal, or canonical PASS", async t => {
  const scenario = scenarioFor(t, { implementationContent: SOURCE });
  const agent = new ChunkReviewAgent(call => call === 1 ? PASS : "[]");
  let observed = false;
  const result = await scenario.review(worker(agent, (directory, error) => {
    assert.equal(error?.name, "ReviewProtocolFailure");
    assert.equal(fs.existsSync(path.join(directory, "impl-review.json")), false);
    assert.equal(fs.existsSync(path.join(directory, "seal.json")), false);
    observed = true;
  })).execute(scenario.context());
  assert.equal(observed, true);
  assert.equal(result.ok, false);
  assert.equal(agent.calls.length, 3, "one success and two bounded invalid protocol responses");
  scenario.reload();
  assert.equal(publications(scenario).length, 0);
  assert.equal(scenario.state().attempt.failure.code, "TASK_REVIEW_PROTOCOL_INVALID_RESPONSE");
  assert.equal(scenario.state().current.at(-1), "T-1-review");
  assert.equal(fs.readFileSync(scenario.sourcePath, "utf8"), SOURCE);
});

test("Task chunk findings are merged and deduplicated before one rejected publication selects Triage", async t => {
  const scenario = scenarioFor(t, {
    implementationContent: SOURCE,
    additionalRequirements: [{ id: "R-2", desc: "Optionally explain the behavior.", priority: "should", task_ids: ["T-1"] }],
  });
  const finding = (findingKey, disposition) => ({
    findingKey, title: findingKey, failureMode: "spec_behavior_contradiction", file: "README.md", requirementId: disposition === "must-fix" ? "R-1" : "R-2",
    issue: `README.md source-line-0000 does not document ${findingKey}.`,
    suggestion: `Update README.md source-line-0000 to document ${findingKey}.`,
    disposition, rationale: disposition === "must-fix" ? "R-1 requires this behavior." : "This optional explanation improves readability.",
  });
  const blocker = finding("missing-behavior", "must-fix");
  const agent = new ChunkReviewAgent(call => JSON.stringify({
    blockingFindings: [blocker],
    nonBlockingImprovements: [finding(`optional-explanation-${call}`, "informational")],
  }));
  let document;
  const result = await scenario.review(worker(agent, (directory, error) => {
    assert.equal(error, null);
    document = JSON.parse(fs.readFileSync(path.join(directory, "impl-review.json"), "utf8"));
  })).execute(scenario.context());
  assert.notEqual(result.ok, false, JSON.stringify(result));
  assert.ok(agent.calls.length > 1);
  assert.equal(document.blockingFindings.length, 1);
  assert.equal(document.nonBlockingImprovements.length, agent.calls.length);
  assert.equal(document.verdict, "REJECTED");
  assert.equal(document.blockingFindings[0].repeatCount, 1, "duplicate chunk reports must not consume semantic recurrence budget");
  assert.equal(publications(scenario).length, 0);
  await FLOW_COMMANDS.run.review.post(scenario.context(), result);
  scenario.reload();
  assert.equal(publications(scenario).length, 1);
  assert.equal(scenario.state().current.at(-1), "T-1-triage");
});

test("no-change Task Review still uses one provider call and publishes only after parent confirmation", async t => {
  const scenario = scenarioFor(t, { noChange: true });
  const agent = new ChunkReviewAgent();
  const result = await scenario.review(worker(agent)).execute(scenario.context());
  assert.notEqual(result.ok, false, JSON.stringify(result));
  assert.equal(agent.calls.length, 1);
  assert.match(agent.calls[0].prompt, /Declared No-Change Reasons/);
  assert.equal(publications(scenario).length, 0);
  await FLOW_COMMANDS.run.review.post(scenario.context(), result);
  scenario.reload();
  assert.equal(publications(scenario).length, 1);
  assert.equal(scenario.state().current, null, "Definition completes an accepted no-change Task without Gate");
});

test("a canonical retry safely retires completed chunks of the failed Attempt and reviews the new Attempt fully", async t => {
  const scenario = scenarioFor(t, { implementationContent: SOURCE });
  const initialAttemptId = scenario.state().attempt.id;
  let oldDirectory;
  const stoppedAgent = new ChunkReviewAgent(call => {
    if (call === 2) throw new TemporaryRateLimitFailure({ message: "fixture rate limit" });
    return PASS;
  });
  const stopped = await scenario.review(worker(stoppedAgent, directory => { oldDirectory = directory; })).execute(scenario.context());
  assert.equal(stopped.ok, false, JSON.stringify(stopped));
  assert.equal(stoppedAgent.calls.length, 2);
  assert.equal(publications(scenario).length, 0);
  scenario.reload();
  assert.equal(scenario.state().failureDisposition().operation, "retry");
  assert.equal(fs.existsSync(oldDirectory), true);
  scenario.manager.retryCurrentAttempt({ specId: scenario.specId });
  scenario.reload();
  container.register("flowManager", scenario.manager);
  assert.notEqual(scenario.state().attempt.id, initialAttemptId);

  const retryAgent = new ChunkReviewAgent();
  const result = await scenario.review(worker(retryAgent)).execute(scenario.context());
  assert.notEqual(result.ok, false, JSON.stringify(result));
  assert.equal(fs.existsSync(oldDirectory), false);
  assert.ok(retryAgent.calls.length > 1, "a fresh Attempt must not trust incomplete old worker evidence");
  for (const line of SOURCE.split("\n").filter(Boolean)) {
    assert.ok(retryAgent.calls.some(call => call.prompt.includes(line)), `${line} must be reviewed after retry`);
  }
  await FLOW_COMMANDS.run.review.post(scenario.context(), result);
  scenario.reload();
  assert.equal(publications(scenario).length, 1);
  assert.equal(scenario.state().current.at(-1), "T-1-gate");
});
