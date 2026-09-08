import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import GetNextActionCommand from "../../src/flow/lib/get-next-action.js";
import RunClaimNextActionCommand from "../../src/flow/lib/run-claim-next-action.js";
import RunDispatchCommand from "../../src/flow/lib/run-dispatch.js";
import RunRepairTestReviewCommand from "../../src/flow/lib/run-repair-test-review.js";
import RunReviewCommand from "../../src/flow/lib/run-review.js";
import { CanonicalTestArtifactStore } from "../../src/flow/lib/canonical-test-artifacts.js";
import { sourceWorkerEffectJsonSchema } from "../../src/flow/lib/source-worker-effect-schema.js";
import { TaskStageArtifact } from "../../src/flow/lib/task-review-stage-artifacts.js";
import { findStepById } from "../../src/flow/lib/step-tree.js";
import {
  SourceMutationBaseline,
  SourceMutationManifest,
  SourceWorkerEffect,
  WorkerArtifactHandoffCoordinator,
} from "../../src/flow/lib/worker-artifact-handoff.js";
import { Agent } from "../../src/lib/agent.js";
import { Container } from "../../src/lib/container.js";
import { FlowManager } from "../../src/lib/flow-manager.js";
import { Logger } from "../../src/lib/log.js";
import { ProviderRegistry } from "../../src/lib/provider.js";
import { FLOW_COMMANDS } from "../../src/flow/registry.js";
import {
  FlowArtifactAttemptHistory,
  FlowArtifactAttemptRecord,
} from "../../src/lib/flow-artifact-contract.js";
import { CanonicalFlowFixture } from "../support/infrastructure/flow-setup.js";
import { commitAll, initGitRepo } from "../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";
import {
  validWorkerHandoffTaskSpec,
  workerArtifactJson,
} from "../support/infrastructure/worker-artifact.js";

const SENNEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/sennel.js");
const WORKER_ARTIFACT_HANDOFF_SCHEMA = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/flow/schemas/next-action/worker-artifact-handoff.schema.json",
);
const TEST_REVIEW_BATCH_BENCHMARK = Object.freeze({
  fileBytes: 227_523,
  fileLines: 5_299,
  findingCount: 13,
  currentProfileKey: "codex/gpt-5.6-luna-low",
  legacy: Object.freeze({
    sourceEpisode: "e8af190b-flow-query-api/001 test-review repair, confirmation orders 152-192",
    provider: "codex",
    profileKey: "codex/gpt-5.6-luna",
    recordedAt: "2026-09-01",
    successfulConfirmationOrders: Object.freeze([152, 154, 158, 160, 164, 166, 170, 174, 178, 182, 186, 188, 192]),
    workerCalls: 13,
    inputTokens: 1_930_914,
    durationMs: 6_721_893,
  }),
});

function fixedTestReviewBatchSource() {
  const header = [
    "// spec: R1",
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('R1: original assertion', () => { assert.equal(1, 1); });",
  ];
  const paddingCount = TEST_REVIEW_BATCH_BENCHMARK.fileLines - header.length;
  const prefixes = Array.from({ length: paddingCount }, (_, index) => (
    `// fixed benchmark padding ${String(index + 1).padStart(4, "0")} `
  ));
  const minimum = Buffer.byteLength(`${[...header, ...prefixes].join("\n")}\n`);
  const paddingBytes = TEST_REVIEW_BATCH_BENCHMARK.fileBytes - minimum;
  const width = Math.floor(paddingBytes / paddingCount);
  const remainder = paddingBytes % paddingCount;
  const lines = [...header, ...prefixes.map((prefix, index) => (
    `${prefix}${"x".repeat(width + (index < remainder ? 1 : 0))}`
  ))];
  const source = Buffer.from(`${lines.join("\n")}\n`, "utf8");
  assert.equal(source.length, TEST_REVIEW_BATCH_BENCHMARK.fileBytes);
  assert.equal(source.toString("utf8").match(/\n/g)?.length, TEST_REVIEW_BATCH_BENCHMARK.fileLines);
  return source;
}

function attemptHistoryBytes(nodeId, logicalKey, payload) {
  return Buffer.from(`${JSON.stringify(new FlowArtifactAttemptHistory([
    new FlowArtifactAttemptRecord({
      attempt: 1,
      payload: {
        nodeId,
        outcome: "completed",
        result: { result: "ok" },
        artifact: { logicalKey, payload },
      },
    }),
  ]).toJSON(), null, 2)}\n`, "utf8");
}

function publishAttemptArtifact(flowManager, specId, nodeId, logicalKey, payload) {
  flowManager.publishArtifacts({
    specId,
    nodeId,
    artifactWrites: [{
      logicalKey,
      mediaType: "application/json",
      bytes: attemptHistoryBytes(nodeId, logicalKey, payload),
    }],
  });
}

function installSennelWrapper(executionRoot) {
  const binDir = path.join(executionRoot, ".test-bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "sennel"), [
    "#!/bin/sh",
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(SENNEL)} "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  return binDir;
}

function realCodexAgent({ mainRoot, executionRoot, flowManager, profileKey = "codex/gpt-5.6-sol-medium" }) {
  return new Agent({
    config: {
      agent: {
        default: profileKey,
        timeout: 240,
        retryCount: 0,
      },
    },
    paths: { root: executionRoot, agentWorkDir: path.join(executionRoot, ".tmp") },
    registry: new ProviderRegistry(),
    logger: new Logger({ logDir: path.join(executionRoot, ".tmp", "logs"), enabled: false }),
    flowManager,
  });
}

function realAgentTestConfig() {
  return {
    lang: "en",
    type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" },
    agent: {
      // Keep agent selection in normal project configuration. Test runners can
      // select any installed profile without this scenario naming a provider
      // or model at the invocation boundary.
      useProfile: process.env.SENNEL_AGENT_TEST_PROFILE || "codex-only",
      timeout: 240,
      retryCount: 1,
    },
  };
}

function configuredRealAgent({ executionRoot, flowManager, config }) {
  return new Agent({
    config,
    paths: { root: executionRoot, agentWorkDir: path.join(executionRoot, ".tmp") },
    registry: new ProviderRegistry(config.agent?.providers),
    logger: new Logger({ logDir: path.join(executionRoot, ".tmp", "logs"), enabled: false }),
    flowManager,
  });
}

function flowCommandContainer({ root, flowManager, config, agent }) {
  const value = new Container();
  value.register("paths", { root, agentWorkDir: path.join(root, ".tmp") });
  value.register("mainRoot", root);
  value.register("config", config);
  value.register("inWorktree", false);
  value.register("flowManager", flowManager);
  value.register("agent", agent);
  return value;
}

function taskStageOnly(nextStep) {
  const nextAction = new GetNextActionCommand();
  return {
    async run(container, input) {
      const action = await nextAction.run(container, input);
      const boundAction = { ...action, binding: input.expectBinding };
      return action.step === nextStep
        ? boundAction
        : {
            ...boundAction,
            taskId: null,
            step: null,
            action: "completed",
            instructions: null,
            context: null,
            output_schema: null,
            requires_approval: false,
            directive: { kind: "completed", terminal: true, requiresUserAction: false },
          };
    },
  };
}

async function runTaskReview({ container, context }) {
  const command = new RunReviewCommand();
  command.container = container;
  const result = await command.execute(context);
  assert.notEqual(result.ok, false, JSON.stringify(result, null, 2));
  await FLOW_COMMANDS.run.review.post(context, result);
  return result;
}

function specWorkerAction() {
  return {
    taskId: null,
    step: "spec",
    action: "write-spec",
    instructions: {
      key: "plan.spec",
      content: [
        "Write the declared spec.json handoff payload with exactly this JSON document:",
        JSON.stringify(validWorkerHandoffTaskSpec()),
        "Run the exact sealCommand once after writing it.",
      ].join(" "),
    },
    context: { workerArtifactHandoff: { required: true } },
    output_schema: JSON.parse(fs.readFileSync(WORKER_ARTIFACT_HANDOFF_SCHEMA, "utf8")),
    requires_approval: false,
    maxAttempts: 1,
    directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "write-spec" },
  };
}

function testReviewRepairWorkerAction() {
  return {
    taskId: null,
    step: "test",
    action: "repair-tests",
    instructions: {
      key: "plan.test",
      content: [
        "Read the worker handoff request and its testReviewRepair batch.",
        "Edit only the batch allowed test paths beneath the declared spec-tests payload root.",
        "Apply every finding's required unique repair marker exactly once, then run the exact sealCommand from the request once.",
      ].join(" "),
    },
    context: { workerArtifactHandoff: { required: true } },
    output_schema: JSON.parse(fs.readFileSync(WORKER_ARTIFACT_HANDOFF_SCHEMA, "utf8")),
    requires_approval: false,
    maxAttempts: 1,
    directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "repair-tests" },
  };
}

function sourceWorkerAction() {
  return {
    taskId: null,
    step: "implement",
    action: "implement-source",
    instructions: {
      key: "plan.implement",
      content: [
        "Run `sennel flow get context docs/context.md --raw` exactly once and require it to succeed.",
        "Then replace product.js with exactly `export const value = 2;` followed by a newline.",
        "Run `npm run lint` and require it to succeed.",
        "Do not modify any other source file.",
        "The product.js change satisfies both R1 and R2. Return the structured source effect with version 1, stepId implement, completionStatus done, and exactly two file claim groups: requirementId R1 with normalized project-relative product.js in paths, and requirementId R2 with that same product.js path in paths. A shared path belongs to every relevant requirement group. Set issues empty and overview, triage, repair, noChangeReason null.",
      ].join(" "),
    },
    context: { workerArtifactHandoff: { required: true } },
    output_schema: sourceWorkerEffectJsonSchema("implement"),
    requires_approval: false,
    maxAttempts: 1,
    directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "implement-source" },
  };
}

function draftHandoffPayload(goal) {
  return {
    devType: "feature",
    goal,
    analysis: {
      problem: "The worker must hand repaired draft bytes to the canonical parent publisher.",
      proposedApproach: "Exercise the guarded worker artifact handoff.",
      validation: "Read the canonical draft after the parent publishes the sealed bytes.",
    },
    decisionMap: {
      knownFacts: [],
      decisionPoints: [],
      resolvedByProjectRules: [],
      requiresUserJudgment: [],
      deferredToSpec: [],
    },
    questionLedger: {
      revision: 0,
      questions: [],
      publication: "real-agent-worker-handoff",
      evidenceDigest: "a".repeat(64),
    },
  };
}

function action(stepId) {
  if (stepId == null) {
    return {
      taskId: null,
      step: null,
      action: "completed",
      instructions: null,
      context: null,
      output_schema: null,
      requires_approval: false,
      directive: { kind: "completed", terminal: true, requiresUserAction: false },
    };
  }
  const instruction = stepId === "draft-questions-triage"
    ? [
        "Use only the immutable handoff input snapshots.",
        "Write the declared draft-questions-triage.json payload with exactly this JSON shape:",
        '{"version":1,"phase":"draft-questions-triage","sourceReview":"draft-review-questions.json",',
        '"summary":"Apply the parent publication repair.","items":[{"title":"Publish through the parent",',
        '"target":"goal","decision":"apply","rationale":"The review target is valid.",',
        '"evidence":"The parent owns canonical publication.","allowedFieldPaths":["goal"],"requiredFieldPaths":["goal"]}]}',
        "Do not rename or omit items. Then seal the handoff exactly once.",
      ].join(" ")
    : [
        "Use only the immutable handoff input snapshots and write the declared payload.",
        "Write the declared draft-questions-repair.json payload with exactly this JSON shape:",
        '"version":1,"baseRevision":"sha256:<exact inputRevision>","operations":[{"title":"Publish through the parent",',
        '"target":"goal","kind":"replace-value","path":"goal",',
        '"expectedDigest":"634747b65b9a50fcc3d49a71b10763c810dd2a8f88b9446acdd99f4e1012cea9","replacement":"Parent publication is canonical.",',
        '"reason":"The parent publishes the derived canonical draft."}]}',
        "Use the exact inputRevision from the handoff request for baseRevision. Do not rename or omit items. Then seal the handoff exactly once.",
      ].join(" ");
  return {
    taskId: null,
    step: stepId,
    action: "write-draft",
    instructions: {
      key: `plan.${stepId}`,
      content: instruction,
    },
    context: { workerArtifactHandoff: { required: true } },
    output_schema: {},
    requires_approval: false,
    maxAttempts: 1,
    directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "write-draft" },
  };
}

describe("real agent worker artifact handoff", { timeout: 480_000 }, () => {
  it("keeps a source handoff valid when a real worker reads context and checks its source", async () => {
    const temporaryRoot = createTmpDir("worker-handoff-agent-source-");
    const originalPath = process.env.PATH;
    try {
      const mainRoot = path.join(temporaryRoot, "main");
      const executionRoot = path.join(temporaryRoot, "execution");
      fs.mkdirSync(mainRoot, { recursive: true });
      initGitRepo(mainRoot);
      fs.mkdirSync(path.join(mainRoot, "docs"), { recursive: true });
      fs.writeFileSync(path.join(mainRoot, ".gitignore"), ".sennel/\n.test-bin/\n.tmp/\n");
      fs.writeFileSync(path.join(mainRoot, "docs", "context.md"), "# Context\n\nRead by the source worker.\n");
      fs.writeFileSync(path.join(mainRoot, "package.json"), `${JSON.stringify({
        scripts: { lint: "node --check product.js" },
      }, null, 2)}\n`);
      fs.writeFileSync(path.join(mainRoot, "product.js"), "export const value = 1;\n");
      commitAll(mainRoot, "source worker baseline");
      execFileSync(
        "git",
        ["-C", mainRoot, "worktree", "add", "-q", "-b", "feature/worker-handoff-agent-source", executionRoot],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      process.env.PATH = `${installSennelWrapper(executionRoot)}${path.delimiter}${originalPath}`;

      const specId = "507-worker-handoff-agent-source";
      const flowManager = new FlowManager({ root: executionRoot, mainRoot, inWorktree: true, specId });
      const fixture = new CanonicalFlowFixture({
        flowManager,
        specId,
        runId: "run-worker-handoff-agent-source",
        request: "Read canonical context and complete a source worker handoff.",
        execution: {
          mode: "worktree",
          baseBranch: "main",
          featureBranch: "feature/worker-handoff-agent-source",
        },
        specRecord: {
          goal: "Exercise source handoff observation advances",
          requirements: [
            { id: "R1", desc: "Update the exported value." },
            { id: "R2", desc: "Record the same source update for the related behavior." },
          ],
        },
      }).create().registerActive().activate("implement");
      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run() {
            return findStepById(flowManager.load().steps, "implement").status === "done"
              ? action(null)
              : sourceWorkerAction();
          },
        },
        agent: realCodexAgent({ mainRoot, executionRoot, flowManager }),
        repositoryFingerprint: () => "real-agent-source-handoff",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};

      const result = await dispatcher.execute({
        root: executionRoot,
        executionRoot,
        mainRoot,
        specId,
        flowManager,
        flowState: flowManager.load(),
        expectRunId: flowManager.load().runId,
        expectSpec: specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(result.dispatch?.boundary, "completed", JSON.stringify(result, null, 2));
      assert.equal(result.dispatch.dispatchCount, 1);
      const completed = flowManager.load();
      assert.equal(findStepById(completed.steps, "implement").status, "done");
      assert.equal(fs.readFileSync(path.join(executionRoot, "product.js"), "utf8"), "export const value = 2;\n");
      const fileMap = JSON.parse(flowManager.readArtifact({
        specId,
        logicalKey: "file.map",
        consumerNodeId: "impl-review",
      }).bytes.toString("utf8"));
      assert.deepEqual(fileMap, { R1: ["product.js"], R2: ["product.js"] });
      const contextMetrics = completed.metrics.filter((entry) => entry.counter === "docsRead");
      assert.equal(contextMetrics.length, 1);
      assert.equal(contextMetrics[0].phase, "impl");
      assert.equal(flowManager.activityLedger(specId).some((entry) => (
        entry.transition.operation === "record_metric"
        && entry.metric?.counter === "docsRead"
      )), true);
    } finally {
      process.env.PATH = originalPath;
      removeTmpDir(temporaryRoot);
    }
  });

  it("has a real Codex CLI worker hand off triage and repair to a downstream command", async () => {
    const mainRoot = createTmpDir("worker-handoff-agent-main-");
    const originalPath = process.env.PATH;
    try {
      const executionRoot = path.join(mainRoot, "execution");
      fs.mkdirSync(executionRoot, { recursive: true });
      initGitRepo(executionRoot);
      fs.writeFileSync(path.join(executionRoot, "README.md"), "worker handoff fixture\n");
      commitAll(executionRoot, "worker handoff fixture");
      const binDir = installSennelWrapper(executionRoot);
      process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

      const specId = "500-worker-handoff-agent";
      const flowManager = new FlowManager({ root: executionRoot, mainRoot, inWorktree: true, specId });
      const fixture = new CanonicalFlowFixture({
        flowManager,
        specId,
        runId: "run-worker-handoff-agent",
        request: "Exercise the real agent worker handoff.",
        execution: {
          mode: "worktree",
          baseBranch: "main",
          featureBranch: "feature/worker-handoff-agent",
        },
        specRecord: { goal: "Exercise the worker handoff", requirements: [] },
      }).create();
      const canonicalSpecDir = flowManager.specLocation(specId).directory;
      const draftBytes = Buffer.from(`${JSON.stringify(draftHandoffPayload("Repair the worker handoff."), null, 2)}\n`);
      fixture.activate("draft");
      flowManager.publishArtifacts({
        specId,
        nodeId: "draft",
        artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: draftBytes }],
      });
      fixture.settle("draft").activate("draft-questions-review");
      const draftRevision = {
        version: 1,
        runId: "run-worker-handoff-agent",
        specId,
        sourceStepId: "draft",
        digest: crypto.createHash("sha256").update(draftBytes).digest("hex"),
        byteLength: draftBytes.length,
        finalizedAt: "2026-08-14T00:00:00.000Z",
      };
      publishAttemptArtifact(flowManager, specId, "draft-questions-review", "draft.questions.review", {
        version: 2,
        phase: "draft-questions",
        sourceDraft: "draft.json",
        sourceDraftRevision: draftRevision,
        generatedAt: "2026-08-04T00:00:00.000Z",
        verdict: "ADVISORY",
        summary: "One repair is required.",
        blockingFindings: [],
        advisoryFindings: [],
        repairTargets: [{
          title: "Publish through the parent",
          target: "goal",
          rationale: "The worker cannot write canonical artifacts.",
          evidence: "The handoff contract assigns publication to the parent.",
          classification: "repair_target",
        }],
      });
      fixture.settle("draft-questions-review").activate("draft-questions-triage");
      const state = flowManager.load();
      const agent = realCodexAgent({ mainRoot, executionRoot, flowManager });
      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run() {
            const current = flowManager.load();
            if (findStepById(current.steps, "draft-questions-triage").status !== "done") {
              return action("draft-questions-triage");
            }
            const repair = findStepById(current.steps, "draft-questions-repair");
            if (repair.status === "pending") {
              flowManager.updateStepStatus({
                stepId: "draft-questions-repair",
                requestedStatus: "in_progress",
              });
            }
            if (repair.status !== "done") {
              return action("draft-questions-repair");
            }
            return action(null);
          },
        },
        agent,
        repositoryFingerprint: () => "real-agent-handoff",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};

      const result = await dispatcher.execute({
        root: executionRoot,
        executionRoot,
        mainRoot,
        specId,
        flowManager,
        flowState: flowManager.load(),
        expectRunId: state.runId,
        expectSpec: specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(result.dispatch?.boundary, "completed", JSON.stringify(result, null, 2));
      assert.equal(result.dispatch.dispatchCount, 2);
      const completed = flowManager.load();
      assert.equal(findStepById(completed.steps, "draft-questions-triage").status, "done");
      assert.equal(findStepById(completed.steps, "draft-questions-repair").status, "done");
      assert.equal(fs.existsSync(path.join(canonicalSpecDir, "draft-questions-triage.json")), false);
      assert.equal(fs.existsSync(path.join(canonicalSpecDir, "draft-questions-repair.json")), false);
      assert.equal(
        flowManager.artifactCatalog(specId).artifacts.some((entry) => entry.logicalKey === "draft.questions.triage"),
        true,
      );
      assert.equal(
        flowManager.artifactCatalog(specId).artifacts.some((entry) => entry.logicalKey === "draft.questions.repair"),
        true,
      );
      const downstream = await new GetNextActionCommand().execute({
        root: executionRoot,
        executionRoot,
        mainRoot,
        specId,
        flowManager,
        flowState: completed,
      });
      assert.equal(downstream.step, "draft-refine");
      assert.equal(downstream.context.workerArtifactHandoff.required, true);
      assert.equal(downstream.directive.actionId, "CLAIM_NEXT_ACTION");
      const claim = await new RunClaimNextActionCommand().execute({
        root: executionRoot,
        executionRoot,
        mainRoot,
        specId,
        flowManager,
        flowState: completed,
      });
      assert.equal(claim.ok, true, JSON.stringify(claim));
      const claimed = flowManager.load();
      assert.equal(claimed.currentNodeId, "draft-refine");
      assert.equal(flowManager.canonicalState(specId).attempt.failure, null);
      const downstreamRequest = new WorkerArtifactHandoffCoordinator().createRequest({
        ctx: { root: executionRoot, executionRoot, mainRoot, specId, flowManager },
        state: claimed,
        invocation: {
          id: "downstream-draft-refine",
          target: { digest: "e".repeat(64) },
          action: { digest: "d".repeat(64), nextAction: { step: downstream.step } },
        },
      });
      assert.deepEqual(
        downstreamRequest.inputs[0].document,
        draftHandoffPayload("Parent publication is canonical."),
      );
    } finally {
      process.env.PATH = originalPath;
      removeTmpDir(mainRoot);
    }
  });

  it("keeps Task review and triage read-only before a real repair and re-review", async () => {
    const root = createTmpDir("task-review-triage-repair-agent-");
    const originalPath = process.env.PATH;
    try {
      const config = realAgentTestConfig();
      const specId = "508-task-review-triage-repair-agent";
      const taskId = "T-1";
      const sourcePath = path.join(root, "status.js");
      fs.mkdirSync(path.join(root, ".sennel"), { recursive: true });
      fs.writeFileSync(path.join(root, ".sennel", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
      fs.writeFileSync(path.join(root, ".gitignore"), ".sennel/output/\n.tmp/\n.test-bin/\n");
      fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
      fs.writeFileSync(sourcePath, [
        "export function statusLabel(input) {",
        "  return input === \"ready\" ? \"ready\" : \"not-ready\";",
        "}",
        "",
      ].join("\n"));
      initGitRepo(root);
      commitAll(root, "Task review fixture baseline");
      process.env.PATH = `${installSennelWrapper(root)}${path.delimiter}${originalPath}`;

      const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      const fixture = new CanonicalFlowFixture({
        flowManager,
        specId,
        runId: "run-task-review-triage-repair-agent",
        request: "Repair the Task-owned status label behavior.",
        execution: { mode: "direct", baseBranch: "main", featureBranch: null },
        specRecord: {
          goal: "Keep status labels precise for the Task's mapped requirement.",
          requirements: [{
            id: "R-1",
            desc: "statusLabel must return ready for ready input and not-ready for every other input.",
            task_ids: [taskId],
          }],
        },
      }).create().addTask({
        id: taskId,
        title: "Correct status labels",
        goal: "Return the required status label for every input.",
        parent: null,
        origin: "plan",
        added_round: 0,
        status: "pending",
      }).registerActive().prepareTaskFrontier();
      flowManager.startTask(taskId, { specId });

      // Establish the real Task source lineage that Review, triage, and repair
      // consume. The deliberately incomplete implementation is the only seed;
      // no Review, triage, or repair artifact is preconstructed.
      const implementationBaseline = SourceMutationBaseline.capture({
        root,
        attempt: flowManager.canonicalState(specId).attempt,
      });
      fs.writeFileSync(sourcePath, [
        "export function statusLabel(input) {",
        "  return input === \"ready\" ? \"ready\" : \"unknown\";",
        "}",
        "",
      ].join("\n"));
      const implementationManifest = SourceMutationManifest.capture({ baseline: implementationBaseline });
      flowManager.confirmSourceWorkerHandoff({
        specId,
        mutationManifest: implementationManifest,
        handoffDigest: "a".repeat(64),
        effect: new SourceWorkerEffect({
          version: 1,
          stepId: "task-impl",
          completionStatus: "done",
          files: [{ requirementId: "R-1", mutationIds: implementationManifest.mutations.map((entry) => entry.mutationId) }],
          issues: [],
          overview: { modules: [], data_flow: [], decisions: [] },
          triage: null,
          repair: null,
          noChangeReason: null,
        }),
        result: {
          outcome: "passed",
          summary: "Task fixture implementation published through the source-handoff boundary.",
          confirmedAt: "2026-09-08T00:00:00.000Z",
          artifactRefs: [],
        },
      });
      flowManager.updateStepStatus({ stepId: `${taskId}-review`, requestedStatus: "in_progress" }, { specId });

      const agent = configuredRealAgent({ executionRoot: root, flowManager, config });
      const container = flowCommandContainer({ root, flowManager, config, agent });
      const context = () => ({
        root,
        mainRoot: root,
        executionRoot: root,
        specId,
        flowManager,
        flowState: flowManager.loadReadOnly(specId),
        config,
        skipConfirm: true,
      });

      const incompleteSource = fs.readFileSync(sourcePath, "utf8");
      const firstReview = await runTaskReview({ container, context: context() });
      assert.equal(firstReview.artifacts.verdict, "REJECTED");
      assert.equal(fs.readFileSync(sourcePath, "utf8"), incompleteSource, "Task Review must not edit Task source");
      const afterFirstReview = flowManager.canonicalState(specId);
      assert.equal(afterFirstReview.current.at(-1), `${taskId}-triage`);
      const firstReviewArtifact = new TaskStageArtifact({
        flowManager,
        state: flowManager.loadReadOnly(specId),
        taskId,
        role: "review",
      }).document;
      assert.equal(firstReviewArtifact.verdict, "REJECTED");
      assert.ok(firstReviewArtifact.blockingFindings.length > 0, JSON.stringify(firstReviewArtifact, null, 2));

      const triageDispatcher = new RunDispatchCommand({
        nextAction: taskStageOnly("task-triage"),
        agent,
      });
      triageDispatcher.container = container;
      const triageResult = await triageDispatcher.execute({
        ...context(),
        expectRunId: flowManager.loadReadOnly(specId).runId,
        expectSpec: specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
        flowCommandBoundary: true,
      });
      assert.equal(triageResult.dispatch?.boundary, "completed", JSON.stringify(triageResult, null, 2));
      assert.equal(triageResult.dispatch.dispatchCount, 1);
      assert.equal(fs.readFileSync(sourcePath, "utf8"), incompleteSource, "Task triage must not edit Task source");
      const afterTriage = flowManager.canonicalState(specId);
      assert.equal(afterTriage.current.at(-1), `${taskId}-repair`);
      const triageArtifact = new TaskStageArtifact({
        flowManager,
        state: flowManager.loadReadOnly(specId),
        taskId,
        role: "triage",
      }).document;
      const reviewedFindings = [
        ...firstReviewArtifact.blockingFindings,
        ...firstReviewArtifact.nonBlockingImprovements,
      ];
      const mustFixFindingKeys = reviewedFindings
        .filter((finding) => finding.disposition === "must-fix")
        .map((finding) => finding.findingKey)
        .sort();
      assert.equal(triageArtifact.dispositions.length, reviewedFindings.length);
      assert.deepEqual(
        triageArtifact.dispositions
          .filter((entry) => entry.disposition === "apply")
          .map((entry) => entry.findingKey)
          .sort(),
        mustFixFindingKeys,
      );
      assert.equal(
        triageArtifact.dispositions
          .filter((entry) => !mustFixFindingKeys.includes(entry.findingKey))
          .every((entry) => entry.disposition === "reject"),
        true,
        JSON.stringify(triageArtifact, null, 2),
      );

      const repairDispatcher = new RunDispatchCommand({
        nextAction: taskStageOnly("task-repair"),
        agent,
      });
      repairDispatcher.container = container;
      const repairResult = await repairDispatcher.execute({
        ...context(),
        expectRunId: flowManager.loadReadOnly(specId).runId,
        expectSpec: specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
        flowCommandBoundary: true,
      });
      assert.equal(repairResult.dispatch?.boundary, "completed", JSON.stringify(repairResult, null, 2));
      assert.equal(repairResult.dispatch.dispatchCount, 1);
      const repairedSource = fs.readFileSync(sourcePath, "utf8");
      assert.notEqual(repairedSource, incompleteSource, "only Task repair is permitted to change the source");
      const repairedModule = await import(`${pathToFileURL(sourcePath).href}?repair=${Date.now()}`);
      assert.equal(repairedModule.statusLabel("ready"), "ready");
      for (const input of ["waiting", "", null, undefined]) {
        assert.equal(repairedModule.statusLabel(input), "not-ready");
      }
      const afterRepair = flowManager.canonicalState(specId);
      assert.equal(afterRepair.current.at(-1), `${taskId}-review`);
      const repairArtifact = new TaskStageArtifact({
        flowManager,
        state: flowManager.loadReadOnly(specId),
        taskId,
        role: "repair",
      }).document;
      assert.deepEqual(
        repairArtifact.repair.findingMutations.map((entry) => entry.findingKey).sort(),
        mustFixFindingKeys,
      );
      assert.deepEqual(
        repairArtifact.reviewFindings.map((finding) => finding.findingKey).sort(),
        reviewedFindings.map((finding) => finding.findingKey).sort(),
      );

      const secondReview = await runTaskReview({ container, context: context() });
      assert.equal(["PASS", "ADVISORY"].includes(secondReview.artifacts.verdict), true, JSON.stringify(secondReview, null, 2));
      assert.equal(fs.readFileSync(sourcePath, "utf8"), repairedSource, "re-review must stay read-only after repair");
      const reloadedManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      const reloadedState = reloadedManager.loadReadOnly(specId);
      assert.equal(reloadedManager.canonicalState(specId).current.at(-1), `${taskId}-gate`);
      const reviewHistory = new TaskStageArtifact({
        flowManager: reloadedManager,
        state: reloadedState,
        taskId,
        role: "review",
      }).history;
      const reloadedTriage = new TaskStageArtifact({
        flowManager: reloadedManager,
        state: reloadedState,
        taskId,
        role: "triage",
      }).document;
      const reloadedRepair = new TaskStageArtifact({
        flowManager: reloadedManager,
        state: reloadedState,
        taskId,
        role: "repair",
      }).document;
      assert.equal(reviewHistory.attempts.length, 2, "both canonical Task Review episodes must remain in the persisted trace");
      assert.equal(reviewHistory.attempts[0].payload.verdict, "REJECTED");
      assert.deepEqual(reviewHistory.attempts[0].payload, firstReviewArtifact);
      assert.equal(reviewHistory.attempts[1].payload.verdict, secondReview.artifacts.verdict);
      assert.deepEqual(reloadedTriage, triageArtifact);
      assert.deepEqual(reloadedRepair, repairArtifact);
      const reviewCompletions = reloadedManager.activityLedger(specId).filter((activity) => (
        activity.nodeId === `${taskId}-review`
        && activity.transition?.operation === "advance_task_review_stage"
        && activity.transition.taskReviewStagePlan?.facts?.binding?.stage === "review"
      ));
      assert.equal(reviewCompletions.length, 2);
      for (const entry of reviewHistory.attempts) {
        const completion = reviewCompletions.find((activity) => (
          activity.transition.taskReviewStagePlan.facts.reviewResultCount === entry.attempt
        ));
        assert.ok(completion, `review history attempt ${entry.attempt} lacks its completion Activity`);
        assert.equal(completion.sequence, completion.transition.taskReviewStagePlan.facts.binding.attemptSequence);
        assert.equal(completion.attemptId, completion.transition.taskReviewStagePlan.facts.binding.attemptId);
      }
      assert.equal(new Set(reviewCompletions.map((activity) => activity.attemptId)).size, 2);
      assert.equal(
        reviewHistory.attempts[1].payload.blockingFindings.some((finding) => finding.disposition === "must-fix"),
        false,
      );
      assert.deepEqual(
        reloadedManager.taskMutationLineages({ specId, taskId }).map((lineage) => lineage.role),
        ["implementation", "repair"],
      );
    } finally {
      process.env.PATH = originalPath;
      removeTmpDir(root);
    }
  });

  it("measures real Codex CLI repair batches for the fixed large test-review fixture", async (t) => {
    const mainRoot = createTmpDir("worker-handoff-agent-test-review-main-");
    const originalPath = process.env.PATH;
    try {
      const executionRoot = path.join(mainRoot, "execution");
      fs.mkdirSync(executionRoot, { recursive: true });
      initGitRepo(executionRoot);
      fs.writeFileSync(path.join(executionRoot, "README.md"), "test review repair fixture\n");
      commitAll(executionRoot, "test review repair fixture");
      process.env.PATH = `${installSennelWrapper(executionRoot)}${path.delimiter}${originalPath}`;

      const specId = "503-worker-handoff-agent-test-review";
      const flowManager = new FlowManager({ root: executionRoot, mainRoot, inWorktree: true, specId });
      const fixture = new CanonicalFlowFixture({
        flowManager, specId, runId: "run-worker-handoff-agent-test-review",
        request: "Exercise a real scoped test review repair handoff.",
        execution: { mode: "worktree", baseBranch: "main", featureBranch: "feature/worker-handoff-agent-test-review" },
        specRecord: { goal: "Repair a reviewed test", requirements: [{ id: "R1", desc: "Preserve a test assertion." }] },
      }).create().registerActive();
      const original = fixedTestReviewBatchSource();
      fixture.activate("test");
      flowManager.publishArtifacts({
        specId, nodeId: "test", artifactWrites: [{
          logicalKey: "tests.source", parameters: { testPath: "requirement.test.js" },
          mediaType: "text/javascript", bytes: original,
        }],
      });
      fixture.settle("test").activate("test-review");
      const sourceRevision = new CanonicalTestArtifactStore({ flowManager, state: flowManager.load() })
        .testSourceRevision().toJSON();
      const findings = Array.from({ length: TEST_REVIEW_BATCH_BENCHMARK.findingCount }, (_, index) => {
        const ordinal = String(index + 1).padStart(2, "0");
        const marker = `// test-review-repair-${ordinal}`;
        return {
          findingId: `real-agent-finding-${ordinal}`,
          fingerprint: crypto.createHash("sha256").update(`real-agent-finding-${ordinal}`).digest("hex"),
          target: "requirement.test.js",
          requiredChange: `Add the exact unique marker ${marker} to the canonical test file.`,
          disposition: "must-fix",
          rationale: "The fixed benchmark requires every selected finding to be handled in its batch.",
        };
      });
      publishAttemptArtifact(flowManager, specId, "test-review", "test.review", {
        phase: "test", verdict: "REJECTED", blockingFindings: findings, advisoryFindings: [],
        sourceTestArtifactRevision: sourceRevision,
        canonicalEvidence: { disposition: "REJECTED", blockingFindings: findings, advisoryFindings: [], identity: { evidenceDigest: "d".repeat(64) } },
      });
      const context = { root: executionRoot, executionRoot, mainRoot, specId, flowManager, flowState: flowManager.load() };
      assert.equal(new RunRepairTestReviewCommand().execute(context).ok, true);
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() {
          return findStepById(flowManager.load().steps, "test").status === "done"
            ? action(null) : testReviewRepairWorkerAction();
        } },
        agent: realCodexAgent({
          mainRoot,
          executionRoot,
          flowManager,
          profileKey: TEST_REVIEW_BATCH_BENCHMARK.currentProfileKey,
        }),
        repositoryFingerprint: () => "real-agent-test-review-repair",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...context, flowState: flowManager.load(), expectRunId: flowManager.load().runId, expectSpec: specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      });
      assert.equal(result.dispatch?.boundary, "completed", JSON.stringify(result, null, 2));
      assert.equal(result.dispatch.dispatchCount, 2);
      const completed = flowManager.load();
      assert.equal(findStepById(completed.steps, "test").status, "done");
      const repaired = flowManager.readArtifact({
        specId, logicalKey: "tests.source", parameters: { testPath: "requirement.test.js" }, consumerNodeId: "test-review",
      }).bytes;
      assert.notDeepEqual(repaired, original);
      for (let index = 1; index <= TEST_REVIEW_BATCH_BENCHMARK.findingCount; index += 1) {
        assert.match(repaired.toString("utf8"), new RegExp(`// test-review-repair-${String(index).padStart(2, "0")}`));
      }
      assert.equal(flowManager.artifactCatalog(specId).artifacts.some((entry) => entry.logicalKey === "test.review.repair.progress"), true);
      const progress = JSON.parse(flowManager.readArtifact({
        specId, logicalKey: "test.review.repair.progress", consumerNodeId: "test",
      }).bytes);
      assert.deepEqual(progress.entries.map((entry) => entry.status), Array(13).fill("done"));
      const receiptGroups = new Map();
      for (const entry of progress.entries) {
        const group = receiptGroups.get(entry.handoff.batchId) ?? [];
        group.push(entry.findingId);
        receiptGroups.set(entry.handoff.batchId, group);
      }
      assert.deepEqual([...receiptGroups.values()].map((findingIds) => findingIds.length), [8, 5]);

      const activities = fs.readFileSync(flowManager.specLocation(specId).activitiesFile, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line));
      const agentMetrics = activities.filter((activity) => activity.metric?.phase === "test" && activity.metric.kind === "agent");
      assert.equal(agentMetrics.length, 2);
      assert.deepEqual([...new Set(agentMetrics.map((activity) => activity.metric.profileKey))], [TEST_REVIEW_BATCH_BENCHMARK.currentProfileKey]);
      assert.equal(agentMetrics.every((activity) => Number.isSafeInteger(activity.metric.tokens?.input)), true);
      const measured = {
        workerCalls: agentMetrics.reduce((total, activity) => total + activity.metric.callCount, 0),
        inputTokens: agentMetrics.reduce((total, activity) => total + activity.metric.tokens.input, 0),
        durationMs: agentMetrics.reduce((total, activity) => total + activity.metric.durationMs, 0),
      };
      const reductions = {
        workerCalls: 1 - measured.workerCalls / TEST_REVIEW_BATCH_BENCHMARK.legacy.workerCalls,
        inputTokens: 1 - measured.inputTokens / TEST_REVIEW_BATCH_BENCHMARK.legacy.inputTokens,
        duration: 1 - measured.durationMs / TEST_REVIEW_BATCH_BENCHMARK.legacy.durationMs,
      };
      t.diagnostic(JSON.stringify({ fixture: TEST_REVIEW_BATCH_BENCHMARK, measured, reductions }));
      assert.ok(reductions.workerCalls >= 0.4);
      assert.ok(reductions.inputTokens >= 0.4);
      assert.ok(reductions.duration >= 0.3);
    } finally {
      process.env.PATH = originalPath;
      removeTmpDir(mainRoot);
    }
  });

  it("has a real Codex spec worker seal and publish a canonical spec", async () => {
    const mainRoot = createTmpDir("worker-handoff-agent-spec-main-");
    const originalPath = process.env.PATH;
    try {
      const executionRoot = path.join(mainRoot, "execution");
      fs.mkdirSync(executionRoot, { recursive: true });
      initGitRepo(executionRoot);
      fs.writeFileSync(path.join(executionRoot, "README.md"), "spec worker handoff fixture\n");
      commitAll(executionRoot, "spec worker handoff fixture");
      const binDir = installSennelWrapper(executionRoot);
      process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

      const specId = "505-worker-handoff-agent-spec";
      const flowManager = new FlowManager({ root: executionRoot, mainRoot, inWorktree: true, specId });
      const fixture = new CanonicalFlowFixture({
        flowManager,
        specId,
        runId: "run-worker-handoff-agent-spec",
        request: "Exercise the real spec worker response schema and publication path.",
        execution: {
          mode: "worktree",
          baseBranch: "main",
          featureBranch: "feature/worker-handoff-agent-spec",
        },
        specRecord: { goal: "Exercise spec publication", requirements: [] },
      }).create();
      fixture.activate("draft");
      flowManager.publishArtifacts({
        specId,
        nodeId: "draft",
        artifactWrites: [{
          logicalKey: "draft",
          mediaType: "application/json",
          bytes: Buffer.from(workerArtifactJson(draftHandoffPayload(
            "Publish the canonical spec through the parent dispatcher.",
          ))),
        }],
      });
      fixture.settle("draft").activate("spec");
      const canonicalSpecDir = flowManager.specLocation(specId).directory;
      const state = flowManager.load();
      const currentAction = specWorkerAction();
      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run() {
            return findStepById(flowManager.load().steps, "spec").status === "done"
              ? action(null)
              : structuredClone(currentAction);
          },
        },
        agent: realCodexAgent({ mainRoot, executionRoot, flowManager }),
        repositoryFingerprint: () => "real-agent-spec-handoff",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};

      const result = await dispatcher.execute({
        root: executionRoot,
        executionRoot,
        mainRoot,
        specId,
        flowManager,
        flowState: flowManager.load(),
        expectRunId: state.runId,
        expectSpec: specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(result.dispatch?.boundary, "completed", JSON.stringify(result, null, 2));
      assert.equal(result.dispatch.dispatchCount, 1);
      const completed = flowManager.load();
      assert.equal(findStepById(completed.steps, "spec").status, "done");
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(canonicalSpecDir, "spec.json"), "utf8")),
        validWorkerHandoffTaskSpec(),
      );
      assert.equal(
        flowManager.artifactCatalog(specId).artifacts.some((entry) => entry.logicalKey === "spec.record"),
        true,
      );
    } finally {
      process.env.PATH = originalPath;
      removeTmpDir(mainRoot);
    }
  });
});
