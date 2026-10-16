import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  ReviewProtocolContract,
  ReviewProtocolController,
  ReviewProtocolEffectEvidence,
  ReviewProtocolFailure,
  ReviewProtocolRetryPolicy,
  ReviewProtocolTransportRetryPolicy,
} from "../../../src/flow/lib/review-protocol.js";
import {
  runTaskReviewProtocol,
  TaskReviewSourceEffectObserver,
} from "../../../src/flow/commands/review.js";
import { TaskReviewExecutionIdentity } from "../../../src/flow/lib/task-review-execution-identity.js";
import { Agent, AgentRuntimeDirectorySet } from "../../../src/lib/agent.js";
import { TemporaryRateLimitFailure } from "../../../src/lib/agent-failure.js";
import { container } from "../../../src/lib/container.js";
import { Logger } from "../../../src/lib/log.js";
import { PRODUCT } from "../../../src/lib/product.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { SourceExecutionObservationAppends } from "../../../src/flow/lib/source-execution-observation-appends.js";
import { SourceMutationManifest } from "../../../src/flow/lib/worker-artifact-handoff.js";

function contract() {
  return new ReviewProtocolContract({
    phase: "task-review",
    parse(raw) {
      const value = JSON.parse(raw);
      if ((value.priorRepairInsufficiency === null) !== (value.repairStrategy === null)) {
        throw new Error("recurrence explanation and repair strategy must be supplied together");
      }
      return value;
    },
  });
}

function taskReviewExecution({ taskId = "T-1", attemptId = "task-review-attempt", sequence = 1, reviewAttempt = 1 } = {}) {
  return new TaskReviewExecutionIdentity({
    taskId,
    attempt: { id: attemptId, nodeId: `${taskId}-review`, sequence },
    reviewAttempt,
  });
}

class SourceObserver {
  constructor() {
    this.generation = 0;
  }
  capture(attempt) { return Object.freeze({ attempt: attempt.number, generation: this.generation }); }
  hasEffect(before, after) { return before.generation !== after.generation; }
  describe(before, after) {
    return new ReviewProtocolEffectEvidence({
      observer: "test-source",
      detail: Object.freeze({ attempt: before.attempt, before: before.generation, after: after.generation }),
    });
  }
  effect() { this.generation += 1; }
}

describe("Task Review protocol", () => {
  it("keeps shared canonical observations outside a linked checkout from masking checkout source edits", async (t) => {
    const scenario = new TaskReviewScenario(t);
    const checkout = path.join(scenario.root, ".tmp", "linked-checkout");
    execFileSync("git", ["worktree", "add", "--detach", checkout, "HEAD"], { cwd: scenario.root, stdio: "ignore" });
    const outputVariable = PRODUCT.env("REVIEW_OUTPUT_DIR");
    const previousOutput = process.env[outputVariable];
    process.env[outputVariable] = path.join(checkout, ".tmp", "review-output");
    try {
      const observer = new TaskReviewSourceEffectObserver({ root: checkout, flowManager: scenario.manager, specId: scenario.specId,
        executionIdentity: TaskReviewExecutionIdentity.fromCanonicalState({ state: scenario.state(), taskId: scenario.taskId, reviewAttempt: 1 }) });
      const before = observer.capture({ number: 1 });
      const session = scenario.manager.prepareExecutionObservationSession({ specId: scenario.specId });
      session.append({ kind: "agent-started", entityId: "linked-checkout-observation", data: {} });
      const observed = observer.capture({ number: 1 });
      assert.equal(observer.hasEffect(before, observed), false);
      const manifest = (baseline) => scenario.manager.readCanonicalTransitionView({ specId: scenario.specId,
        read: (view) => SourceMutationManifest.capture({ baseline, executionObservations: new SourceExecutionObservationAppends(view, baseline.snapshot) }) });
      assert.deepEqual(manifest(before.baseline).paths(), []);
      fs.appendFileSync(path.join(checkout, "README.md"), "unexpected checkout source edit\n");
      session.append({ kind: "agent-response-ready", entityId: "linked-checkout-observation", data: {} });
      const changed = observer.capture({ number: 1 });
      assert.equal(observer.hasEffect(observed, changed), true);
      assert.deepEqual(observer.describe(observed, changed).detail.changedPaths, ["README.md"]);
      assert.deepEqual(manifest(observed.baseline).paths(), ["README.md"]);
    } finally {
      if (previousOutput === undefined) delete process.env[outputVariable];
      else process.env[outputVariable] = previousOutput;
    }
  });

  for (const changesSource of [false, true]) it(`real Agent observation appends ${changesSource ? "cannot hide a Task source edit" : "remain read-only Task Review input"}`, async (t) => {
    const scenario = new TaskReviewScenario(t);
    const outputVariable = PRODUCT.env("REVIEW_OUTPUT_DIR");
    const previousOutput = process.env[outputVariable];
    process.env[outputVariable] = path.join(scenario.root, ".tmp", "review-output");
    container.reset();
    container.register("root", scenario.root);
    const valid = JSON.stringify({ blockingFindings: [], nonBlockingImprovements: [] });
    const program = `${changesSource ? `require('node:fs').appendFileSync(${JSON.stringify(scenario.sourcePath)},'unexpected source edit\\n');` : ""}process.stdout.write(${JSON.stringify(valid)});`;
    const profile = { command: process.execPath, args: ["-e", program, "{{PROMPT}}"] };
    const config = { agent: { default: "test/observed", retryCount: 0, providers: { "test/observed": profile }, timeout: 10 } };
    const agent = new Agent({ config,
      paths: { root: scenario.root, agentWorkDir: path.join(scenario.root, ".tmp"), logDir: path.join(scenario.root, ".tmp", "logs") },
      registry: new ProviderRegistry(config.agent.providers), logger: new Logger({ enabled: false }), flowManager: scenario.manager });
    try {
      const result = runTaskReviewProtocol({ root: scenario.root, specId: scenario.specId,
        executionIdentity: TaskReviewExecutionIdentity.fromCanonicalState({ state: scenario.manager.canonicalState(scenario.specId), taskId: scenario.taskId, reviewAttempt: 1 }),
        flowManager: scenario.manager, requirementIds: new Set(["R-1"]), agent, prompt: "review the Task", systemPrompt: "return Review JSON" });
      if (changesSource) await assert.rejects(result, (error) => error instanceof ReviewProtocolFailure && error.kind === "effect_observed");
      else {
        try { assert.equal(await result, valid); }
        catch (error) { assert.fail(`${error.message}: ${JSON.stringify(error.effectEvidence)}`); }
      }
      const observations = await scenario.manager.readExecutionObservations({ specId: scenario.specId });
      assert.equal(observations.manifests.length, 1);
      assert.ok(observations.facts.length >= 4, "the real Agent must persist its enclosed provider observations");
    } finally {
      container.reset();
      if (previousOutput === undefined) delete process.env[outputVariable];
      else process.env[outputVariable] = previousOutput;
    }
  });

  it("round-trips the parent-issued Task Review execution identity", () => {
    const identity = taskReviewExecution({ taskId: "T-1", attemptId: "canonical-attempt", sequence: 2 });
    const restored = TaskReviewExecutionIdentity.fromJSON(identity.toJSON());

    assert.notEqual(restored, identity);
    assert.deepEqual(restored.toJSON(), {
      taskId: "T-1",
      attempt: { id: "canonical-attempt", nodeId: "T-1-review", sequence: 2 },
      reviewAttempt: 1,
    });
  });

  it("rejects malformed or mismatched Task Review execution identity input", () => {
    assert.throws(
      () => TaskReviewExecutionIdentity.fromJSON({
        taskId: "T-1",
        attempt: { id: "attempt", nodeId: "T-2-review", sequence: 1 },
        reviewAttempt: 1,
      }),
      /does not match its Task/,
    );
    assert.throws(
      () => TaskReviewExecutionIdentity.fromJSON({
        taskId: "T-1",
        attempt: { id: "attempt", nodeId: "T-1-review", sequence: 1, stale: true },
        reviewAttempt: 1,
      }),
      /Task Review execution Attempt has invalid fields/,
    );
    assert.throws(
      () => TaskReviewExecutionIdentity.fromJSON({
        taskId: "T-1",
        attempt: { id: "attempt", nodeId: "T-1-review" },
        reviewAttempt: 1,
      }),
      /Task Review execution Attempt has invalid fields/,
    );
  });

  it("replaces the original partial-pair cache through the Task adapter and reuses the accepted response", async () => {
    const root = createTmpDir("task-review-invalid-cache-");
    const outputDirectory = path.join(root, ".sennel", "review-work-unit-fixture");
    const countFile = path.join(root, ".tmp", "provider-count.txt");
    const outputVariable = PRODUCT.env("REVIEW_OUTPUT_DIR");
    const previousOutput = process.env[outputVariable];
    const invalid = JSON.stringify({
      blockingFindings: [{
        findingKey: "partial-recurrence",
        title: "Partial recurrence evidence",
        failureMode: "spec_behavior_contradiction",
        file: "src/task.js",
        requirementId: "R1",
        issue: "Only one recurrence field was supplied.",
        suggestion: "Supply the complete recurrence declaration.",
        disposition: "must-fix",
        rationale: "R1 requires exact recurrence evidence.",
        priorRepairInsufficiency: null,
        repairStrategy: "Use a distinct repair strategy.",
      }],
      nonBlockingImprovements: [],
    });
    const valid = JSON.stringify({ blockingFindings: [], nonBlockingImprovements: [] });
    try {
      initGitRepo(root);
      fs.writeFileSync(path.join(root, ".gitignore"), ".sennel/\n.tmp/\n");
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "task.js"), "export const task = true;\n");
      commitAll(root, "baseline");
      fs.mkdirSync(path.dirname(countFile), { recursive: true });
      fs.mkdirSync(outputDirectory, { recursive: true });
      process.env[outputVariable] = outputDirectory;
      container.reset();
      container.register("root", root);
      const provider = [
        "const fs=require('node:fs');",
        "const [countFile,invalid,valid]=process.argv.slice(1);",
        "const count=fs.existsSync(countFile)?Number(fs.readFileSync(countFile,'utf8'))+1:1;",
        "fs.writeFileSync(countFile,String(count));",
        "process.stdout.write(count<=2?invalid:valid);",
      ].join("");
      const profile = { command: process.execPath, args: ["-e", provider, countFile, invalid, valid, "{{PROMPT}}"] };
      const config = { agent: { default: "test/exec", providers: { "test/exec": profile }, timeout: 10 } };
      const flowManager = {
        resolveCurrentContext() { return { specId: "task-review-cache", taskId: "T-1", flowPhase: "impl" }; },
        loadActiveFlows() { return [{ specId: "task-review-cache" }]; },
        appendMetric() {},
        accumulateAgentMetrics() {},
      };
      const agent = new Agent({
        config,
        paths: { root, agentWorkDir: path.join(root, ".tmp") },
        registry: new ProviderRegistry(config.agent.providers),
        logger: new Logger({ logDir: path.join(root, ".tmp"), enabled: false }),
        flowManager,
      });
      const prompt = "review the current Task";
      const systemPrompt = "return the Task Review JSON";
      await agent.call(prompt, {
        commandId: "flow.impl.review.propose",
        systemPrompt,
        executionWorkDir: root,
        waitForProcessTree: true,
        retryCount: 0,
      });
      const options = {
        root,
        executionIdentity: taskReviewExecution(),
        flowManager,
        requirementIds: new Set(["R1"]),
        recurrenceHistory: [],
        agent,
        prompt,
        systemPrompt,
      };
      assert.equal(await runTaskReviewProtocol(options), valid);
      assert.equal(await runTaskReviewProtocol(options), valid);
      assert.equal(fs.readFileSync(countFile, "utf8"), "3", "the refresh replacement must be reused from cache");
    } finally {
      container.reset();
      if (previousOutput === undefined) delete process.env[outputVariable];
      else process.env[outputVariable] = previousOutput;
      removeTmpDir(root);
    }
  });

  it("settles canonical Agent metrics after observation so an invalid contract can retry", async () => {
    const root = createTmpDir("task-review-deferred-metric-");
    const outputDirectory = path.join(root, ".sennel", "review-work-unit");
    const countFile = path.join(root, ".tmp", "provider-count.txt");
    const metricFile = path.join(root, "canonical-metrics.txt");
    const outputVariable = PRODUCT.env("REVIEW_OUTPUT_DIR");
    const previousOutput = process.env[outputVariable];
    const invalid = JSON.stringify({
      blockingFindings: [{
        findingKey: "partial-recurrence", title: "Partial recurrence evidence", failureMode: "spec_behavior_contradiction",
        file: "src/task.js", requirementId: "R1", issue: "Only one recurrence field was supplied.",
        suggestion: "Supply the complete recurrence declaration.", disposition: "must-fix",
        rationale: "R1 requires exact recurrence evidence.", priorRepairInsufficiency: null,
        repairStrategy: "Use a distinct repair strategy.",
      }],
      nonBlockingImprovements: [],
    });
    const valid = JSON.stringify({ blockingFindings: [], nonBlockingImprovements: [] });
    try {
      initGitRepo(root);
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "task.js"), "export const task = true;\n");
      fs.writeFileSync(metricFile, "");
      commitAll(root, "baseline");
      fs.mkdirSync(path.dirname(countFile), { recursive: true });
      fs.mkdirSync(outputDirectory, { recursive: true });
      process.env[outputVariable] = outputDirectory;
      container.reset();
      container.register("root", root);
      const provider = [
        "const fs=require('node:fs');",
        "const [countFile,invalid,valid]=process.argv.slice(1);",
        "const count=fs.existsSync(countFile)?Number(fs.readFileSync(countFile,'utf8'))+1:1;",
        "fs.writeFileSync(countFile,String(count));process.stdout.write(count===1?invalid:valid);",
      ].join("");
      const profile = { command: process.execPath, args: ["-e", provider, countFile, invalid, valid, "{{PROMPT}}"] };
      const config = { agent: { default: "test/exec", retryCount: 0, providers: { "test/exec": profile }, timeout: 10 } };
      const flowManager = {
        resolveCurrentContext() { return { specId: "task-review-deferred-metric", taskId: "T-1", flowPhase: "impl" }; },
        loadActiveFlows() { return [{ specId: "task-review-deferred-metric" }]; },
        appendMetric() {},
        accumulateAgentMetrics() { fs.appendFileSync(metricFile, "metric\n"); },
      };
      const agent = new Agent({
        config,
        paths: { root, agentWorkDir: path.join(root, ".tmp"), logDir: path.join(root, ".logs") },
        registry: new ProviderRegistry(config.agent.providers),
        logger: new Logger({ logDir: path.join(root, ".logs"), enabled: false }),
        flowManager,
      });
      assert.equal(await runTaskReviewProtocol({
        root,
        executionIdentity: taskReviewExecution(),
        flowManager,
        requirementIds: new Set(["R1"]),
        recurrenceHistory: [],
        agent,
        prompt: "review the current Task",
        systemPrompt: "return the Task Review JSON",
      }), valid);
      assert.equal(fs.readFileSync(countFile, "utf8"), "2");
      assert.equal(fs.readFileSync(metricFile, "utf8"), "metric\nmetric\n");
    } finally {
      container.reset();
      if (previousOutput === undefined) delete process.env[outputVariable];
      else process.env[outputVariable] = previousOutput;
      removeTmpDir(root);
    }
  });

  it("rejects a partial recurrence pair, retries once fresh only when source is unchanged", async () => {
    const observer = new SourceObserver();
    const calls = [];
    const controller = new ReviewProtocolController({ contract: contract() });
    const result = await controller.execute({
      observer,
      callAgent: async (attempt) => {
        calls.push(attempt.cacheMode);
        return attempt.number === 1
          ? JSON.stringify({ priorRepairInsufficiency: null, repairStrategy: "new strategy" })
          : JSON.stringify({ priorRepairInsufficiency: null, repairStrategy: null });
      },
    });
    assert.equal(result.attempt.number, 2);
    assert.deepEqual(calls, ["default", "refresh"]);
  });

  it("preserves AgentFailure attempt metadata across Task-owned transport retries", async () => {
    const root = createTmpDir("task-review-transport-attempts-");
    const outputDirectory = path.join(root, ".sennel", "review-work-unit");
    const outputVariable = PRODUCT.env("REVIEW_OUTPUT_DIR");
    const previousOutput = process.env[outputVariable];
    const calls = [];
    try {
      initGitRepo(root);
      fs.writeFileSync(path.join(root, "tracked.txt"), "baseline\n");
      commitAll(root, "baseline");
      fs.mkdirSync(outputDirectory, { recursive: true });
      process.env[outputVariable] = outputDirectory;
      container.reset();
      container.register("root", root);
      const agent = {
        providerRetryPolicy() { return { retryCount: 1, retryDelayMs: 1, backoffFactor: 2 }; },
        async call(_prompt, options) {
          calls.push(options);
          throw new TemporaryRateLimitFailure({ message: "temporary provider failure" });
        },
      };
      await assert.rejects(
        runTaskReviewProtocol({
          root,
          executionIdentity: taskReviewExecution({ taskId: "task-1" }),
          flowManager: {
            resolveCurrentContext() { return { specId: "task-review-transport", taskId: "T-1", flowPhase: "impl" }; },
            accumulateAgentMetrics() {},
          },
          requirementIds: new Set(["R1"]),
          recurrenceHistory: [],
          agent,
          prompt: "review the Task",
          systemPrompt: "return JSON",
        }),
        (error) => error instanceof TemporaryRateLimitFailure
          && error.attemptCount === 2
          && error.maxAttempts === 2,
      );
      assert.equal(calls.length, 2);
      assert.deepEqual(calls.map((options) => options.cacheMode), ["default", "refresh"]);
      assert.deepEqual(calls.map((options) => options.retryCount), [0, 0]);
    } finally {
      container.reset();
      if (previousOutput === undefined) delete process.env[outputVariable];
      else process.env[outputVariable] = previousOutput;
      removeTmpDir(root);
    }
  });

  it("does not issue a second provider call after invalid output changed source", async () => {
    const observer = new SourceObserver();
    const controller = new ReviewProtocolController({ contract: contract() });
    let calls = 0;
    await assert.rejects(
      controller.execute({
        observer,
        callAgent: async () => {
          calls += 1;
          observer.effect();
          return JSON.stringify({ priorRepairInsufficiency: null, repairStrategy: "new strategy" });
        },
      }),
      (error) => error instanceof ReviewProtocolFailure && error.kind === "effect_observed",
    );
    assert.equal(calls, 1);
  });

  it("rejects a complete response after an observed source mutation", async () => {
    const observer = new SourceObserver();
    let calls = 0;
    await assert.rejects(
      new ReviewProtocolController({ contract: contract() }).execute({
        observer,
        callAgent: async () => {
          calls += 1;
          observer.effect();
          return JSON.stringify({ priorRepairInsufficiency: null, repairStrategy: null });
        },
      }),
      (error) => error instanceof ReviewProtocolFailure
        && error.kind === "effect_observed"
        && error.effectEvidence.observer === "test-source",
    );
    assert.equal(calls, 1);
  });

  it("captures source effects after a provider failure and does not retry it", async () => {
    const observer = new SourceObserver();
    const controller = new ReviewProtocolController({ contract: contract() });
    let calls = 0;
    await assert.rejects(
      controller.execute({
        observer,
        callAgent: async () => {
          calls += 1;
          observer.effect();
          throw new Error("provider timeout");
        },
      }),
      (error) => error instanceof ReviewProtocolFailure && error.kind === "effect_observed",
    );
    assert.equal(calls, 1);
  });

  it("retries retryable transport failures with separately observed invocations", async () => {
    const observer = new SourceObserver();
    const observed = [];
    const modes = [];
    let calls = 0;
    const controller = new ReviewProtocolController({
      contract: contract(),
      transportRetryPolicy: new ReviewProtocolTransportRetryPolicy({ retryCount: 1, retryDelayMs: 1 }),
    });
    const result = await controller.execute({
      observer: {
        capture(attempt) {
          observed.push(`capture:${attempt.number}.${attempt.transportNumber}`);
          return observer.capture(attempt);
        },
        hasEffect: observer.hasEffect.bind(observer),
        describe: observer.describe.bind(observer),
      },
      callAgent: async (attempt) => {
        calls += 1;
        modes.push(attempt.cacheMode);
        if (calls === 1) {
          const error = new Error("temporary provider failure");
          error.retryable = true;
          throw error;
        }
        assert.equal(attempt.transportNumber, 2);
        return JSON.stringify({ priorRepairInsufficiency: null, repairStrategy: null });
      },
    });
    assert.equal(result.attempt.number, 1);
    assert.equal(calls, 2);
    assert.deepEqual(modes, ["default", "refresh"]);
    assert.deepEqual(observed, ["capture:1.1", "capture:1.1", "capture:1.2", "capture:1.2"]);
  });

  it("does not transport-retry a non-retryable provider failure", async () => {
    let calls = 0;
    await assert.rejects(
      new ReviewProtocolController({
        contract: contract(),
        transportRetryPolicy: new ReviewProtocolTransportRetryPolicy({ retryCount: 1, retryDelayMs: 1 }),
      }).execute({
        observer: new SourceObserver(),
        callAgent: async () => {
          calls += 1;
          throw new Error("permanent provider failure");
        },
      }),
      /permanent provider failure/,
    );
    assert.equal(calls, 1);
  });

  it("turns two unchanged invalid responses into a typed tooling failure", async () => {
    const observer = new SourceObserver();
    const controller = new ReviewProtocolController({ contract: contract() });
    let calls = 0;
    await assert.rejects(
      controller.execute({
        observer,
        callAgent: async () => {
          calls += 1;
          return JSON.stringify({ priorRepairInsufficiency: null, repairStrategy: "new strategy" });
        },
      }),
      (error) => error instanceof ReviewProtocolFailure
        && error.kind === "contract_rejected"
        && error.attempt.number === 2,
    );
    assert.equal(calls, 2);
  });

  it("uses a phase-selected bounded retry policy instead of a fixed attempt count", async () => {
    const observer = new SourceObserver();
    const calls = [];
    const controller = new ReviewProtocolController({
      contract: contract(),
      retryPolicy: new ReviewProtocolRetryPolicy({ maxAttempts: 3 }),
    });
    const result = await controller.execute({
      observer,
      callAgent: async (attempt) => {
        calls.push(attempt.cacheMode);
        return attempt.number === 3
          ? JSON.stringify({ priorRepairInsufficiency: null, repairStrategy: null })
          : JSON.stringify({ priorRepairInsufficiency: null, repairStrategy: "new strategy" });
      },
    });
    assert.equal(result.attempt.number, 3);
    assert.deepEqual(calls, ["default", "refresh", "refresh"]);
  });

  it("turns one after-observation failure into one typed terminal failure", async () => {
    let captures = 0;
    const observer = {
      capture() {
        captures += 1;
        if (captures === 2) throw new Error("snapshot unavailable");
        return Object.freeze({ generation: 0 });
      },
      hasEffect() { return false; },
    };
    await assert.rejects(
      new ReviewProtocolController({ contract: contract() }).execute({
        observer,
        callAgent: async () => JSON.stringify({ priorRepairInsufficiency: null, repairStrategy: null }),
      }),
      (error) => error instanceof ReviewProtocolFailure
        && error.kind === "observation_unavailable"
        && error.effectEvidence.observer === "capture",
    );
    assert.equal(captures, 2);
  });

  it("does not call the provider when the before-observation is unavailable", async () => {
    let calls = 0;
    const observer = {
      capture() { throw new Error("baseline unavailable"); },
      hasEffect() { return false; },
    };
    await assert.rejects(
      new ReviewProtocolController({ contract: contract() }).execute({
        observer,
        callAgent: async () => {
          calls += 1;
          return JSON.stringify({ priorRepairInsufficiency: null, repairStrategy: null });
        },
      }),
      (error) => error instanceof ReviewProtocolFailure
        && error.kind === "observation_unavailable"
        && error.attempt.number === 1,
    );
    assert.equal(calls, 0);
  });

  it("turns an unavailable effect comparison into a typed terminal failure", async () => {
    let calls = 0;
    const observer = {
      capture() { return Object.freeze({ generation: 0 }); },
      hasEffect() { throw new Error("comparison unavailable"); },
    };
    await assert.rejects(
      new ReviewProtocolController({ contract: contract() }).execute({
        observer,
        callAgent: async () => {
          calls += 1;
          return JSON.stringify({ priorRepairInsufficiency: null, repairStrategy: "new strategy" });
        },
      }),
      (error) => error instanceof ReviewProtocolFailure
        && error.kind === "observation_unavailable"
        && error.effectEvidence.observer === "comparison",
    );
    assert.equal(calls, 1);
  });

  it("treats canonical spec changes as Task Review source effects", () => {
    const root = createTmpDir("task-review-source-effect-");
    const outputDirectory = path.join(root, ".sennel", "review-work-unit");
    const outputVariable = PRODUCT.env("REVIEW_OUTPUT_DIR");
    const previousOutput = process.env[outputVariable];
    try {
      initGitRepo(root);
      fs.writeFileSync(path.join(root, "baseline.txt"), "baseline\n");
      commitAll(root, "baseline");
      fs.mkdirSync(outputDirectory, { recursive: true });
      process.env[outputVariable] = outputDirectory;
      const observer = new TaskReviewSourceEffectObserver({
        root,
        executionIdentity: taskReviewExecution({ taskId: "task-1" }),
      });
      const before = observer.capture({ number: 1 });
      fs.mkdirSync(path.join(root, "specs", "task-1"), { recursive: true });
      fs.writeFileSync(path.join(root, "specs", "task-1", "canonical.json"), "{\"changed\":true}\n");
      const after = observer.capture({ number: 1 });
      assert.equal(observer.hasEffect(before, after), true);
      assert.deepEqual(observer.describe(before, after).detail.changedPaths, ["specs/task-1/canonical.json"]);
    } finally {
      if (previousOutput === undefined) delete process.env[outputVariable];
      else process.env[outputVariable] = previousOutput;
      removeTmpDir(root);
    }
  });

  it("ignores only Task Review runtime directories in both Git and filesystem observations", () => {
    const outputVariable = PRODUCT.env("REVIEW_OUTPUT_DIR");
    const previousOutput = process.env[outputVariable];
    const roots = [createTmpDir("task-review-observer-git-"), createTmpDir("task-review-observer-files-")];
    try {
      initGitRepo(roots[0]);
      fs.writeFileSync(path.join(roots[0], "tracked.txt"), "baseline\n");
      commitAll(roots[0], "baseline");
      for (const root of roots) {
        const outputDirectory = path.join(root, ".sennel", "review-work-unit");
        const agentWorkDirectory = path.join(root, "runtime-agent-work");
        const agentLogDirectory = path.join(root, "runtime-agent-logs");
        fs.mkdirSync(outputDirectory, { recursive: true });
        process.env[outputVariable] = outputDirectory;
        const observer = new TaskReviewSourceEffectObserver({
          root,
          executionIdentity: taskReviewExecution({ taskId: "task-1" }),
          agent: {
            runtimeDirectories: () => new AgentRuntimeDirectorySet({
              root,
              directories: [agentWorkDirectory, agentLogDirectory],
            }),
          },
        });
        const before = observer.capture({ number: 1, transportNumber: 1 });
        fs.writeFileSync(path.join(outputDirectory, "provider-output.json"), "{}\n");
        fs.mkdirSync(path.join(root, ".sennel", "agent-cache"), { recursive: true });
        fs.writeFileSync(path.join(root, ".sennel", "agent-cache", "task.json"), "{}\n");
        fs.mkdirSync(path.join(root, ".sennel", "review-execution-locks"), { recursive: true });
        fs.writeFileSync(path.join(root, ".sennel", "review-execution-locks", "task.lock"), "runtime\n");
        fs.mkdirSync(agentWorkDirectory, { recursive: true });
        fs.writeFileSync(path.join(agentWorkDirectory, "schema.json"), "{}\n");
        fs.mkdirSync(agentLogDirectory, { recursive: true });
        fs.writeFileSync(path.join(agentLogDirectory, "agent.jsonl"), "runtime\n");
        const after = observer.capture({ number: 1, transportNumber: 1 });
        assert.equal(observer.hasEffect(before, after), false, `${root} runtime output must be ignored`);
        fs.writeFileSync(path.join(root, "provider-source-change.txt"), "changed\n");
        const changed = observer.capture({ number: 1, transportNumber: 2 });
        assert.equal(observer.hasEffect(after, changed), true, `${root} source changes must remain observable`);
      }
    } finally {
      if (previousOutput === undefined) delete process.env[outputVariable];
      else process.env[outputVariable] = previousOutput;
      for (const root of roots) removeTmpDir(root);
    }
  });
});
