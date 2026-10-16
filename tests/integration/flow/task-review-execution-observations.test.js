import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Agent } from "../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { Container, container } from "../../../src/lib/container.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { TaskReviewExecutionIdentity } from "../../../src/flow/lib/task-review-execution-identity.js";
import { TaskStageArtifact } from "../../../src/flow/lib/task-review-stage-artifacts.js";
import { ReviewWorkUnit, REVIEW_WORK_UNIT_MANIFEST_ENV } from "../../../src/flow/lib/review-work-unit.js";
import { FlowExecutionContractRefusal } from "../../../src/flow/lib/flow-execution-contract.js";
import { runTaskReviewProtocol, parseImplReviewFindings, formatImplReviewJson } from "../../../src/flow/commands/review.js";

// Real Agent/provider observations cross both the child protocol and the
// parent's sealed Review promotion and canonical publication boundaries.
test("Task Review publishes an actual observed Agent response without admitting its observation facts as Task source", async (t) => {
  const scenario = new TaskReviewScenario(t);
  const valid = JSON.stringify({ blockingFindings: [], nonBlockingImprovements: [] });
  const profile = { command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(valid)})`, "{{PROMPT}}"] };
  const config = { agent: { default: "test/observed", retryCount: 0, providers: { "test/observed": profile }, timeout: 20 } };
  const agent = new Agent({ config, flowManager: scenario.manager,
    paths: { root: scenario.root, agentWorkDir: path.join(scenario.root, ".tmp"), logDir: path.join(scenario.root, ".tmp", "logs") },
    registry: new ProviderRegistry(config.agent.providers), logger: new Logger({ enabled: false }) });
  const localContainer = new Container();
  localContainer.register("agent", agent);
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  const source = fs.readFileSync(scenario.sourcePath, "utf8");
  const command = scenario.review(async (_program, _args, options) => {
    const previous = process.env.SENNEL_REVIEW_OUTPUT_DIR;
    const previousManifest = process.env[REVIEW_WORK_UNIT_MANIFEST_ENV];
    process.env.SENNEL_REVIEW_OUTPUT_DIR = options.env.SENNEL_REVIEW_OUTPUT_DIR;
    process.env[REVIEW_WORK_UNIT_MANIFEST_ENV] = options.env[REVIEW_WORK_UNIT_MANIFEST_ENV];
    try {
      const identity = TaskReviewExecutionIdentity.fromJSON(JSON.parse(options.env.SENNEL_REVIEW_TASK_EXECUTION_IDENTITY));
      const protocol = { root: scenario.root, executionIdentity: identity,
        flowManager: new FlowManager({ root: scenario.root, mainRoot: scenario.root, inWorktree: false }),
        requirementIds: new Set(["R-1"]), agent, prompt: "review Task source", systemPrompt: "Return Review JSON" };
      const beforeRejections = scenario.manager.artifactCatalog(scenario.specId).hash;
      for (const override of [
        { specId: "foreign-spec" },
        { executionIdentity: new TaskReviewExecutionIdentity({ ...identity.toJSON(), attempt: { ...identity.attempt.toJSON(), id: "foreign-attempt" } }) },
        { executionIdentity: new TaskReviewExecutionIdentity({ taskId: "foreign-task", reviewAttempt: 1,
          attempt: { ...identity.attempt.toJSON(), nodeId: "foreign-task-review" } }) },
      ]) await assert.rejects(runTaskReviewProtocol({ ...protocol, ...override }), FlowExecutionContractRefusal);
      assert.equal(scenario.manager.artifactCatalog(scenario.specId).hash, beforeRejections);
      const raw = await runTaskReviewProtocol(protocol);
      const findings = parseImplReviewFindings(raw, { requirementIds: new Set(["R-1"]) });
      fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "impl-review.json"),
        formatImplReviewJson({ ...findings, generatedAt: new Date().toISOString(), requirementIds: new Set(["R-1"]) }));
      ReviewWorkUnit.fromEnvironment(options.env).seal();
      return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
    } finally {
      if (previous === undefined) delete process.env.SENNEL_REVIEW_OUTPUT_DIR;
      else process.env.SENNEL_REVIEW_OUTPUT_DIR = previous;
      if (previousManifest === undefined) delete process.env[REVIEW_WORK_UNIT_MANIFEST_ENV];
      else process.env[REVIEW_WORK_UNIT_MANIFEST_ENV] = previousManifest;
    }
  });
  command.container = localContainer;
  const result = await command.execute(scenario.context());
  assert.notEqual(result.ok, false, JSON.stringify(result));
  await FLOW_COMMANDS.run.review.post(scenario.context(), result);
  const manager = new FlowManager({ root: scenario.root, mainRoot: scenario.root, inWorktree: false });
  const state = manager.loadReadOnly(scenario.specId);
  const review = new TaskStageArtifact({ flowManager: manager, state, taskId: scenario.taskId, role: "review" }).document;
  assert.equal(review.verdict, "PASS");
  assert.equal(fs.readFileSync(scenario.sourcePath, "utf8"), source);
  const observations = await manager.readExecutionObservations({ specId: scenario.specId });
  assert.ok(observations.facts.length >= 4);
  assert.equal(manager.taskMutationLineages({ specId: scenario.specId, taskId: scenario.taskId }).length, 1);
});
