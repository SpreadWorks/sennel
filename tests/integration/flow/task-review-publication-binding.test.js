import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { container } from "../../../src/lib/container.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { TaskReviewExecutionIdentity } from "../../../src/flow/lib/task-review-execution-identity.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import {
  formatImplReviewJson,
  parseImplReviewFindings,
  runTaskReviewProtocol,
} from "../../../src/flow/commands/review.js";

class ReviewAgent {
  providerRetryPolicy() { return { retryCount: 0, retryDelayMs: 1, backoffFactor: 2 }; }
  async call() { return JSON.stringify({ blockingFindings: [], nonBlockingImprovements: [] }); }
}

function scenarioFor(t) {
  const scenario = new TaskReviewScenario(t);
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  return scenario;
}

async function executeReview(scenario) {
  const command = scenario.review(async (_command, _args, options) => {
    const previous = process.env.SENNEL_REVIEW_OUTPUT_DIR;
    process.env.SENNEL_REVIEW_OUTPUT_DIR = options.env.SENNEL_REVIEW_OUTPUT_DIR;
    try {
      const requirementIds = new Set(["R-1"]);
      const raw = await runTaskReviewProtocol({
        root: scenario.root,
        executionIdentity: TaskReviewExecutionIdentity.fromJSON(JSON.parse(options.env.SENNEL_REVIEW_TASK_EXECUTION_IDENTITY)),
        flowManager: scenario.manager,
        requirementIds,
        recurrenceHistory: [],
        sourcePaths: new Set(["README.md"]),
        agent: new ReviewAgent(),
        prompt: "Review the canonical Task",
        systemPrompt: "Return findings only",
      });
      const parsed = parseImplReviewFindings(raw, { requirementIds });
      fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "impl-review.json"), formatImplReviewJson({
        ...parsed,
        generatedAt: "2026-09-08T00:00:00.000Z",
        requirementIds,
      }));
      ReviewWorkUnit.fromEnvironment(options.env).seal();
      return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
    } finally {
      if (previous === undefined) delete process.env.SENNEL_REVIEW_OUTPUT_DIR;
      else process.env.SENNEL_REVIEW_OUTPUT_DIR = previous;
    }
  });
  return command.execute(scenario.context());
}

function taskReviewCatalog(scenario) {
  return scenario.manager.artifactCatalog(scenario.specId).artifacts
    .filter((entry) => entry.logicalKey === "task.review")
    .map((entry) => entry.toJSON());
}

function canonicalSpecPath(scenario) {
  const descriptor = scenario.manager.artifactCatalog(scenario.specId).artifacts
    .find((entry) => entry.logicalKey === "spec.record");
  assert.ok(descriptor, "fixture must have a canonical spec record");
  return path.join(scenario.manager.specLocation(scenario.specId).directory, descriptor.relativePath);
}

test("Task Review safely publishes the original parent binding and survives reload", async (t) => {
  const scenario = scenarioFor(t);
  const result = await executeReview(scenario);
  assert.notEqual(result.ok, false, JSON.stringify(result));
  await FLOW_COMMANDS.run.review.post(scenario.context(), result);
  scenario.reload();
  assert.equal(scenario.state().current?.at(-1), "T-1-gate");
  assert.equal(taskReviewCatalog(scenario).length, 1);
});

test("Task Review permits a metric-only canonical append before final publication", async (t) => {
  const scenario = scenarioFor(t);
  const result = await executeReview(scenario);
  scenario.manager.incrementMetric("impl", "review", { specId: scenario.specId });
  await FLOW_COMMANDS.run.review.post(scenario.context(), result);
  scenario.reload();
  assert.equal(scenario.state().current?.at(-1), "T-1-gate");
  assert.equal(taskReviewCatalog(scenario).length, 1);
});

test("Task Review refuses a legal non-metric canonical context append before publication", async (t) => {
  const scenario = scenarioFor(t);
  const result = await executeReview(scenario);
  scenario.manager.addNote("A later canonical context observation.", { specId: scenario.specId });
  const before = taskReviewCatalog(scenario);
  await assert.rejects(
    () => FLOW_COMMANDS.run.review.post(scenario.context(), result),
    /canonical|publication|stage/i,
  );
  assert.equal(scenario.state().current?.at(-1), "T-1-review");
  assert.deepEqual(taskReviewCatalog(scenario), before);
});

test("Task Review refuses canonical spec drift at the final publication boundary", async (t) => {
  const scenario = scenarioFor(t);
  const result = await executeReview(scenario);
  const before = taskReviewCatalog(scenario);
  const confirm = scenario.manager.confirmTaskReviewResult.bind(scenario.manager);
  scenario.manager.confirmTaskReviewResult = (input) => {
    const specPath = canonicalSpecPath(scenario);
    const original = fs.readFileSync(specPath);
    const document = JSON.parse(original.toString("utf8"));
    document.title = `${document.title} publication drift`;
    fs.writeFileSync(specPath, `${JSON.stringify(document, null, 2)}\n`);
    try { return confirm(input); }
    finally { fs.writeFileSync(specPath, original); }
  };
  await assert.rejects(
    () => FLOW_COMMANDS.run.review.post(scenario.context(), result),
    /canonical|spec|publication|stage/i,
  );
  assert.equal(scenario.state().current?.at(-1), "T-1-review");
  assert.deepEqual(taskReviewCatalog(scenario), before);
});

test("a sealed Task Review reloads and publishes with its original observation binding", async (t) => {
  const scenario = scenarioFor(t);
  const first = await executeReview(scenario);
  assert.notEqual(first.ok, false, JSON.stringify(first));
  scenario.reload();
  const recovered = await scenario.review(() => {
    throw new Error("a sealed Task Review must be recovered without another worker");
  }).execute(scenario.context());
  assert.notEqual(recovered.ok, false, JSON.stringify(recovered));
  await FLOW_COMMANDS.run.review.post(scenario.context(), recovered);
  scenario.reload();
  assert.equal(scenario.state().current?.at(-1), "T-1-gate");
  assert.equal(taskReviewCatalog(scenario).length, 1);
});

test("Task Review refuses index drift after the producer result and before publication", async (t) => {
  const scenario = scenarioFor(t);
  const result = await executeReview(scenario);
  const before = taskReviewCatalog(scenario);
  const confirm = scenario.manager.confirmTaskReviewResult.bind(scenario.manager);
  scenario.manager.confirmTaskReviewResult = (input) => {
    execFileSync("git", ["add", "README.md"], { cwd: scenario.root, stdio: "pipe" });
    return confirm(input);
  };
  await assert.rejects(
    () => FLOW_COMMANDS.run.review.post(scenario.context(), result),
    /source|manifest|stage|publication/i,
  );
  assert.equal(scenario.state().current?.at(-1), "T-1-review");
  assert.deepEqual(taskReviewCatalog(scenario), before);
});

test("recovered Task Review refuses a replacement HEAD at the final publication boundary", async (t) => {
  const scenario = scenarioFor(t);
  const first = await executeReview(scenario);
  assert.notEqual(first.ok, false, JSON.stringify(first));
  scenario.reload();
  const recovered = await scenario.review(() => {
    throw new Error("a sealed Task Review must be recovered without another worker");
  }).execute(scenario.context());
  assert.notEqual(recovered.ok, false, JSON.stringify(recovered));
  const before = taskReviewCatalog(scenario);
  const confirm = scenario.manager.confirmTaskReviewResult.bind(scenario.manager);
  scenario.manager.confirmTaskReviewResult = (input) => {
    execFileSync("git", ["commit", "--allow-empty", "-m", "review publication drift"], { cwd: scenario.root, stdio: "pipe" });
    return confirm(input);
  };
  await assert.rejects(
    () => FLOW_COMMANDS.run.review.post(scenario.context(), recovered),
    /source|manifest|stage|publication/i,
  );
  assert.equal(scenario.state().current?.at(-1), "T-1-review");
  assert.deepEqual(taskReviewCatalog(scenario), before);
});

test("Task Review refuses an original result after its active Attempt is legally replaced", async (t) => {
  const scenario = scenarioFor(t);
  const result = await executeReview(scenario);
  scenario.manager.failCurrentAttempt({
    specId: scenario.specId,
    failure: {
      category: "tooling", retryKind: "tooling", retryable: true,
      code: "REVIEW_PROVIDER_UNAVAILABLE", message: "Replace the active fixture Attempt.",
    },
  });
  scenario.manager.retryCurrentAttempt({ specId: scenario.specId });
  const before = taskReviewCatalog(scenario);
  await assert.rejects(
    () => FLOW_COMMANDS.run.review.post(scenario.context(), result),
    /Attempt|binding|publication/i,
  );
  assert.equal(scenario.state().current?.at(-1), "T-1-review");
  assert.deepEqual(taskReviewCatalog(scenario), before);
});
