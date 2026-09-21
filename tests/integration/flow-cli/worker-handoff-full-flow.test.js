import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunFilterTaskReviewCommand from "../../../src/flow/lib/run-filter-task-review.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import RunClaimNextActionCommand from "../../../src/flow/lib/run-claim-next-action.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import {
  flowArtifactAuthorityForStep,
  WORKER_ARTIFACT_HANDOFF_STEPS,
  WORKER_SOURCE_HANDOFF_STEPS,
} from "../../../src/flow/lib/flow-artifact-authority.js";
import { deriveNextAction, findActiveNode } from "../../../src/flow/definition.js";
import {
  sealWorkerArtifactHandoff,
  WorkerArtifactHandoffCoordinator,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { sourceWorkerEffectJsonSchema } from "../../../src/flow/lib/source-worker-effect-schema.js";
import {
  DraftCompletionCatalogBinding,
  DraftCompletionFacts,
  DraftCompletionLineage,
  DraftCompletionSettlementApplication,
  StepConnectionReceipt,
} from "../../../src/flow/lib/draft-completion-connector.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import {
  FlowArtifactAttemptHistory,
  FlowArtifactAttemptRecord,
} from "../../../src/lib/flow-artifact-contract.js";
import { attachCanonicalCommandResultPublications } from "../../../src/flow/lib/canonical-command-result.js";
import { CanonicalSpecReview, SpecReviewDelta, mergeSpecReviewDelta } from "../../../src/flow/lib/spec-review-artifacts.js";
import {
  canonicalFixtureProducerResult,
  canonicalImplReviewArtifact,
  CanonicalFlowFixture,
  confirmCanonicalFixtureStep,
} from "../../support/infrastructure/flow-setup.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { validWorkerHandoffSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import {
  completeDraftWorkerThroughStep,
  prepareConditionalDraftWorkerThroughStep,
} from "../../support/infrastructure/draft-worker-step.js";

const TASK_IDS = Object.freeze(["T1", "T2"]);
const PREPARATION_LEAVES = new Set([
  "branch", "prepare-spec", "test-generate", "test-review", "test-repair", "test-gate",
]);
const USER_DECISION_LEAF = "acceptance-decision";
const TASK_REVIEW_FINDING_KEY = "task-repair-f1";
const TASK_REVIEW_FINDING_ID = "d".repeat(64);

function plannedTask(taskId) {
  return {
    id: taskId,
    title: `Task ${taskId}`,
    goal: "Exercise task effects.",
    acceptance: ["The task effect is recorded."],
    implementation_notes: "Exercise the command-owned fixture path.",
    test_strategy: "Run the focused full-flow fixture.",
    parent: null,
    origin: "plan",
    added_round: 0,
    status: "pending",
  };
}

function sourceEffect(stepId, paths) {
  const base = {
    version: 1,
    stepId,
    completionStatus: "done",
    issues: [],
    overview: null,
    triage: null,
    repair: null,
    noChangeReason: null,
  };
  if (stepId === "implement") {
    return {
      ...base,
    };
  }
  if (stepId === "impl-triage") {
    return {
      ...base,
      triage: { version: 1, dispositions: [{ findingKey: "F1", disposition: "apply", basis: "repair-required", rationale: "The reviewed source change must be applied." }] },
    };
  }
  if (stepId === "impl-repair") {
    return {
      ...base,
      repair: {
        version: 1,
        findings: [{ findingKey: "F1", paths: ["src/repair.js"] }],
        summary: "Applied the reviewed implementation correction.",
        recurrenceResolutions: [],
      },
    };
  }
  if (stepId === "task-impl") {
    return {
      ...base,
      overview: { modules: ["Task implementation module."], data_flow: [], decisions: [] },
    };
  }
  if (stepId === "task-repair") {
    return {
      ...base,
      repair: {
        version: 1,
        findings: [{ findingKey: TASK_REVIEW_FINDING_KEY, paths }],
        summary: "Applied the deterministic Task repair.",
        recurrenceResolutions: [],
      },
    };
  }
  throw new Error(`unexpected source step: ${stepId}`);
}

function payloadPath(request, logicalName) {
  const payload = request.payloads.find((entry) => entry.logicalName === logicalName);
  assert.notEqual(payload, undefined, logicalName);
  return payload.payloadPath;
}

function inputDocument(request, name) {
  return request.inputs.find((entry) => entry.name === name)?.document ?? null;
}

function repairValueDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function emptyQuestionLedgerDraft(goal = "full flow") {
  return {
    devType: "feature",
    goal,
    analysis: { problem: "Exercise the full flow.", proposedApproach: "Publish canonical artifacts.", validation: "Complete every deterministic step." },
    decisionMap: { knownFacts: [], decisionPoints: [], resolvedByProjectRules: [], requiresUserJudgment: [], deferredToSpec: [] },
    questionLedger: { revision: 0, publication: "fixture", evidenceDigest: "a".repeat(64), questions: [] },
  };
}

function writeArtifactPayload(stepId, request, specRepairAttempt = 1) {
  if (["draft", "draft-refine"].includes(stepId)) {
    fs.writeFileSync(payloadPath(request, "draft.json"), workerArtifactJson(inputDocument(request, "draft.json") ?? emptyQuestionLedgerDraft()));
    return;
  }
  if (stepId === "spec") {
    const spec = validWorkerHandoffSpec();
    fs.writeFileSync(payloadPath(request, "spec.json"), workerArtifactJson({
      ...spec,
      requirements: spec.requirements.map((requirement) => ({
        ...requirement,
        task_ids: [...TASK_IDS],
      })),
      tasks: TASK_IDS.map((taskId) => plannedTask(taskId)),
    }));
    return;
  }
  if (stepId === "test") {
    fs.writeFileSync(path.join(payloadPath(request, "spec-tests"), "full-flow.test.js"), [
      "// spec: R1",
      'import test from "node:test";',
      'test("R1: publishes the validated artifact", () => {});',
      "",
    ].join("\n"));
    return;
  }
  if (["draft-questions-triage", "draft-coverage-triage"].includes(stepId)) {
    const prefix = stepId.replace("-triage", "");
    fs.writeFileSync(payloadPath(request, `${stepId}.json`), workerArtifactJson({
      version: 1, phase: stepId,
      sourceReview: prefix === "draft-questions" ? "draft-review-questions.json" : "draft-review-coverage.json",
      summary: "No repair required.", items: [],
    }));
    return;
  }
  if (["draft-questions-repair", "draft-coverage-repair"].includes(stepId)) {
    fs.writeFileSync(payloadPath(request, `${stepId}.json`), workerArtifactJson(
      stepId === "draft-questions-repair"
        ? {}
        : { version: 1, baseRevision: `sha256:${request.inputRevision}`, operations: [] },
    ));
    return;
  }
  if (stepId === "spec-triage") {
    const requirementTarget = { entity: "requirement", id: "R1", field: "desc" };
    const current = new CanonicalSpecReview(inputDocument(request, "review.json"));
    fs.writeFileSync(payloadPath(request, "review.delta.json"), workerArtifactJson({
      version: 2, stage: "spec-triage", identity: current.identity.toJSON(), baseReviewDigest: current.digest, operations: [],
      findings: [{ findingId: "spec-review-blocking-1", disposition: "apply", evidence: "The requirement owns publication.", allowedTargets: [
        { target: requirementTarget, operationKinds: ["replace-entity-field"] },
        { target: { entity: "spec", field: "background" }, operationKinds: ["replace-field"] },
      ] }],
    }));
    return;
  }
  if (stepId === "spec-repair") {
    const target = specRepairAttempt === 1
      ? { entity: "requirement", id: "R1", field: "desc" }
      : { entity: "spec", field: "background" };
    const previous = specRepairAttempt === 1
      ? "Publish a validated artifact."
      : "The worker cannot write canonical Flow artifacts.";
    const current = new CanonicalSpecReview(inputDocument(request, "review.json"));
    fs.writeFileSync(payloadPath(request, "review.delta.json"), workerArtifactJson({
      version: 2, stage: "spec-repair", identity: current.identity.toJSON(), baseReviewDigest: current.digest, findings: [], scopeExpansions: [],
      operations: specRepairAttempt === 1
        ? [{ findingIds: ["spec-review-blocking-1"], kind: "replace-entity-field", target, expectedDigest: repairValueDigest(previous), replacement: "The requirement retains publication authority.", reason: "The requirement is explicit." }]
        : [{ findingIds: ["spec-review-blocking-1"], kind: "replace-field", target, expectedDigest: repairValueDigest(previous), replacement: "The background retains publication authority.", reason: "The remaining required target is explicit." }],
    }));
    return;
  }
  const name = `${stepId}.json`;
  fs.writeFileSync(payloadPath(request, name), workerArtifactJson({ version: 1, phase: stepId, items: [], summary: "Deterministic handoff." }));
}

function writeSourcePayload(stepId, request, executionRoot) {
  const changed = {
    implement: "src/implementation.js",
    "impl-repair": "src/repair.js",
    "task-impl": "src/task.js",
    "task-repair": "src/task.js",
  }[stepId];
  if (changed) {
    fs.mkdirSync(path.dirname(path.join(executionRoot, changed)), { recursive: true });
    fs.writeFileSync(path.join(executionRoot, changed), `// ${stepId}${request.taskId === null ? "" : ` ${request.taskId}`}\n`);
  }
  return { paths: changed === undefined ? [] : [changed], effect: sourceEffect(stepId, changed === undefined ? [] : [changed]) };
}

async function completeArtifactHandoff({ coordinator, ctx, stepId, invocationId, logicalName, payload }) {
  const actionDigest = crypto.createHash("sha256").update(`${invocationId}:action`).digest("hex");
  const targetDigest = crypto.createHash("sha256").update(`${invocationId}:target`).digest("hex");
  const request = coordinator.createRequest({
    ctx,
    state: ctx.flowManager.load(ctx.specId),
    invocation: {
      id: invocationId,
      target: { digest: targetDigest },
      action: { digest: actionDigest, nextAction: { step: stepId } },
    },
  });
  assert.ok(request, `${stepId} must create a handoff request`);
  fs.writeFileSync(request.payloadPath(logicalName), workerArtifactJson(payload));
  sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId });
  return { request, result: await completeDraftWorkerThroughStep({ coordinator, ctx, request }) };
}

function publishAttemptArtifact(flowManager, specId, nodeId, logicalKey, payload, histories) {
  const history = histories.get(logicalKey) ?? new FlowArtifactAttemptHistory();
  const next = history.append(new FlowArtifactAttemptRecord({
    attempt: history.sequence.next(),
    payload: { nodeId, outcome: "completed", result: { result: "ok" }, artifact: { logicalKey, payload } },
  }));
  histories.set(logicalKey, next);
  const bytes = Buffer.from(`${JSON.stringify(next.toJSON(), null, 2)}\n`);
  flowManager.publishArtifacts({ specId, nodeId, artifactWrites: [{ logicalKey, mediaType: "application/json", bytes }] });
}

async function commandArtifacts(stepId, flowManager, specId, implReviewRuns, histories, { executionRoot, taskReviewRuns }) {
  if (stepId === "task-review") {
    const taskId = flowManager.canonicalState(specId).current.at(-2);
    const reviewRun = (taskReviewRuns.get(taskId) ?? 0) + 1;
    taskReviewRuns.set(taskId, reviewRun);
    const blockingFindings = reviewRun === 1 ? [{
      findingKey: TASK_REVIEW_FINDING_KEY,
      fingerprint: TASK_REVIEW_FINDING_ID,
      findingId: TASK_REVIEW_FINDING_ID,
      title: "Repair the Task implementation",
      failureMode: "missing_requirement_behavior",
      file: "src/task.js",
      requirementId: "R1",
      issue: "The deterministic Task implementation needs its bounded repair.",
      suggestion: "Apply the Task repair before re-review.",
      disposition: "must-fix",
      rationale: "R1 requires the repaired Task behavior.",
    }] : [];
    const review = new RunReviewCommand({
      resolveTreeSha: () => "a".repeat(40),
      resolveTargetStateDigest: () => "b".repeat(64),
      runCommand(_command, _args, options) {
        fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "impl-review.json"), `${JSON.stringify({
          version: 1,
          phase: "impl",
          generatedAt: "2026-09-08T00:00:00.000Z",
          verdict: blockingFindings.length === 0 ? "PASS" : "REJECTED",
          summary: { blocking: blockingFindings.length, nonBlocking: 0, total: blockingFindings.length },
          blockingFindings,
          nonBlockingImprovements: [],
          excluded: { missingFile: 0, outOfScope: 0 },
        })}\n`);
        ReviewWorkUnit.fromEnvironment(options.env).seal();
        return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
      },
    });
    const ctx = {
      root: executionRoot,
      mainRoot: executionRoot,
      executionRoot,
      specId,
      flowManager,
      flowState: flowManager.load(specId),
      config: {},
    };
    const result = await review.execute(ctx);
    assert.notEqual(result.ok, false, JSON.stringify(result));
    await FLOW_COMMANDS.run.review.post(ctx, result);
    return result;
  }
  if (["draft-questions-review", "draft-coverage-review"].includes(stepId)) {
    const draft = flowManager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: stepId });
    const revision = {
      version: 1, runId: flowManager.load().runId, specId,
      sourceStepId: draft.descriptor.publicationStep,
      digest: crypto.createHash("sha256").update(draft.bytes).digest("hex"),
      byteLength: draft.bytes.length, finalizedAt: "2026-08-14T00:00:00.000Z",
    };
    publishAttemptArtifact(flowManager, specId, stepId,
      stepId === "draft-questions-review" ? "draft.questions.review" : "draft.coverage.review", {
        version: 2,
        phase: stepId === "draft-questions-review" ? "draft-questions" : "draft-coverage",
        sourceDraft: "draft.json", sourceDraftRevision: revision,
        generatedAt: "2026-08-14T00:00:00.000Z", verdict: "PASS", summary: "No findings.",
        blockingFindings: [], advisoryFindings: [], repairTargets: [],
      }, histories);
  }
  if (stepId === "spec-review") {
    const current = flowManager.readCurrentSpecReviewInput({ specId, consumerNodeId: "spec-review" });
    const delta = new SpecReviewDelta({
      version: 2, stage: "spec-review", identity: current.review.identity.toJSON(), baseReviewDigest: current.review.digest,
      findings: [{
        findingId: "spec-review-blocking-1", kind: "blocking", title: "Bind publication", target: "requirements[0]",
        body: "The publication authority must be bound to this Spec requirement.",
        issue: "The requirement needs the publication authority stated explicitly.",
        requiredChange: "Bind the requirement to the canonical publication authority.",
        whyBlocking: "Without the binding the worker handoff cannot prove ownership.",
      }], operations: [],
    });
    const next = mergeSpecReviewDelta({ review: current.review, delta });
    return attachCanonicalCommandResultPublications({
      result: "fixture spec review",
      artifacts: { phase: "spec", verdict: "REJECTED", canonicalVerdict: "REJECTED", proposalCount: 1 },
    }, [{
      logicalKey: "spec.review", parameters: { revision: String(current.revision).padStart(3, "0") },
      mediaType: "application/json", payload: next.toJSON(),
    }]);
  }
  if (stepId === "impl-review") {
    const finding = {
      findingKey: "F1",
      title: "Repair the implementation",
      failureMode: "missing_requirement_behavior",
      file: "src/implementation.js",
      requirementId: "R1",
      guardrailId: null,
      issue: "The first implementation review requires the deterministic repair.",
      suggestion: "Apply the cataloged implementation repair.",
      disposition: "must-fix",
      rationale: "R1 requires the repaired implementation behavior.",
    };
    const findings = implReviewRuns === 1
      ? [finding]
      : [];
    publishAttemptArtifact(flowManager, specId, stepId, "impl.review", canonicalImplReviewArtifact(
      flowManager.load(),
      {
      blockingFindings: findings,
      },
    ), histories);
  }
  return null;
}

function actionFor(route) {
  const derived = deriveNextAction({ scope: route.taskId === null ? "flow" : "task", stepId: route.stepId });
  assert.notEqual(derived, null, `${route.taskId ?? "flow"}.${route.stepId}`);
  if (route.stepId === "task-triage") {
    return {
      taskId: route.taskId,
      step: route.stepId,
      action: derived.action,
      instructions: { key: derived.instructionsKey, content: "Inspect and filter the canonical Task Review findings." },
      context: {}, output_schema: null, requires_approval: false,
      directive: {
        kind: "await_task_review_filter", terminal: false, requiresUserAction: false,
        command: "sennel flow run filter-task-review",
        binding: { taskId: route.taskId },
        findings: [{ findingId: TASK_REVIEW_FINDING_ID }],
      },
    };
  }
  if (route.stepId === USER_DECISION_LEAF) {
    return {
      taskId: null,
      step: route.stepId,
      action: derived.action,
      instructions: { key: derived.instructionsKey, content: "Await the explicit acceptance decision." },
      context: {}, output_schema: {}, requires_approval: false,
      directive: {
        kind: "await_user_decision", terminal: false, requiresUserAction: true,
        actionPrompt: {
          question: "Accept the verified implementation?",
          choices: [
            { actionId: "ACCEPT_FLOW", label: "Accept", stateTransition: "accept", impact: { retains: ["validated implementation"] } },
            { actionId: "REJECT_FLOW", label: "Reject", stateTransition: "reject", impact: { changes: ["implementation"] } },
          ],
          recommendedActionId: "ACCEPT_FLOW",
          recommendationReason: "The deterministic test fixture accepts the verified route.",
        },
        reason: "An explicit acceptance decision is required.",
      },
    };
  }
  return {
    taskId: route.taskId,
    step: route.stepId,
    action: derived.action,
    instructions: { key: derived.instructionsKey, content: `Execute ${route.stepId}.` },
    context: {},
    output_schema: WORKER_SOURCE_HANDOFF_STEPS.includes(route.stepId)
      ? sourceWorkerEffectJsonSchema(route.stepId)
      : {},
    requires_approval: derived.requiresApproval === true,
    ...(derived.autoApproveChoiceId ? { auto_approval_choice_id: derived.autoApproveChoiceId } : {}),
    directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: derived.action },
  };
}

describe("deterministic full Flow worker handoff", () => {
  it("routes artifacts and source effects to workers, and commands/approval to the parent", async () => {
    const temporaryRoot = createTmpDir("worker-handoff-full-");
    try {
      const mainRoot = path.join(temporaryRoot, "main");
      const executionRoot = path.join(temporaryRoot, "execution");
      fs.mkdirSync(mainRoot, { recursive: true });
      fs.mkdirSync(executionRoot, { recursive: true });
      initGitRepo(executionRoot);
      fs.writeFileSync(path.join(executionRoot, "README.md"), "fixture\n");
      commitAll(executionRoot, "fixture baseline");
      const specId = "500-worker-handoff-full-flow";
      const flowManager = new FlowManager({ root: executionRoot, mainRoot, inWorktree: true, specId });
      const fixture = new CanonicalFlowFixture({
        flowManager, specId, runId: "run-worker-handoff-full-flow",
        execution: { mode: "worktree", baseBranch: "main", featureBranch: "feature/worker-handoff-full-flow" },
      }).create().activate("draft");
      const binding = FlowTargetBinding.capture({
        flowState: fixture.state(),
        mainRoot,
        authorityRoot: executionRoot,
        worktreePath: executionRoot,
      }).serialize();
      const guardedAction = (entry) => ({ ...actionFor(entry), binding });

      const staticRoute = fixture.leaves().map((step) => step.id).filter((id) => !PREPARATION_LEAVES.has(id));
      const taskRoute = TASK_IDS.flatMap((taskId) => (
        ["task-impl", "task-review", "task-triage", "task-repair", "task-review", "task-gate"].map((stepId) => ({ stepId, taskId }))
      ));
      const implementationIndex = staticRoute.indexOf("implement");
      const initialImplementation = staticRoute.slice(implementationIndex);
      const repairIndex = initialImplementation.indexOf("impl-repair");
      const firstImplGate = initialImplementation.indexOf("impl-gate");
      const route = [
        ...staticRoute.slice(0, implementationIndex + 1).map((stepId) => ({ stepId, taskId: null })),
        ...taskRoute,
        ...initialImplementation.slice(1, repairIndex + 1).map((stepId) => ({ stepId, taskId: null })),
        ...["test-execute", "test-result-review", "impl-review", "impl-gate"].map((stepId) => ({ stepId, taskId: null })),
        ...initialImplementation.slice(firstImplGate + 1).map((stepId) => ({ stepId, taskId: null })),
      ];
      let position = 0;
      const workerSteps = [];
      const parentCommands = [];
      let handoffCount = 0;
      let specRepairCalls = 0;
      let rejectedRepairSnapshot = null;
      let implReviewRuns = 0;
      const taskReviewRuns = new Map();
      const taskMutationPaths = [];
      const commandArtifactHistories = new Map();
      const conditionallySkippedWorkerSteps = new Set(["draft-refine", "draft-gate-repair"]);
      // Keep every durable preparation/start/recovery boundary on the real
      // coordinator; only the fixture's scripted route cursor is observed.
      class FullFlowHandoffCoordinator extends WorkerArtifactHandoffCoordinator {
        createRequest(input) {
          this.request = super.createRequest(input);
          return this.request;
        }
        reconcile(input) {
          const result = super.reconcile(input);
          advance(route[position]);
          return result;
        }
      }
      const coordinator = new FullFlowHandoffCoordinator();
      const commandPublishedPrimaryArtifact = new Set([
        "draft-questions-review",
        "draft-coverage-review",
        "spec-review",
        "impl-review",
      ]);

      const routeNodeId = (entry) => entry.taskId === null ? entry.stepId : `${entry.taskId}-${entry.stepId.slice("task-".length)}`;
      const activate = (entry) => {
        const state = flowManager.load();
        const nodeId = routeNodeId(entry);
        if (state.currentNodeId === nodeId) return;
        if (entry.taskId !== null && entry.stepId === "task-impl") flowManager.startTask(entry.taskId, { specId });
        else flowManager.updateStepStatus({ stepId: nodeId, requestedStatus: "in_progress" }, { specId });
      };
      const advance = (entry, suppliedCommandResult = null) => {
        const nodeId = routeNodeId(entry);
        const active = flowManager.load();
        const current = active.currentNodeId;
        if (entry.stepId === "impl-review" && implReviewRuns === 2) {
          // A passing flow-level implementation review takes the definition's
          // fixed no-finding route: triage and repair complete without a
          // worker, then impl-gate becomes the active command leaf.
          flowManager.updateStepStatus({ stepId: nodeId, requestedStatus: "done" }, { specId });
          flowManager.updateStepStatus({ stepId: "impl-triage", requestedStatus: "done" }, { specId });
          flowManager.updateStepStatus({ stepId: "impl-repair", requestedStatus: "done" }, { specId });
          position += 1;
          if (position < route.length) activate(route[position]);
          return;
        }
        if (current === nodeId) {
          if (entry.stepId === "task-gate" || entry.stepId === "impl-gate") {
            confirmCanonicalFixtureStep(flowManager, specId, nodeId);
          } else {
            const canonicalCommandResult = suppliedCommandResult ?? (commandPublishedPrimaryArtifact.has(entry.stepId)
              ? null
              : canonicalFixtureProducerResult(active, nodeId, { flowManager, specId }));
            flowManager.updateStepStatus(
              { stepId: nodeId, requestedStatus: "done" },
              { specId, ...(canonicalCommandResult === null ? {} : { canonicalCommandResult }) },
            );
          }
        } else {
          // Worker-handoff confirmation is itself the canonical Attempt
          // transition, so it has already completed this leaf before the
          // test advances its deterministic route cursor.
          assert.notEqual(current, nodeId, `${nodeId} must not remain active after handoff confirmation`);
        }
        position += 1;
        if (position < route.length && !conditionallySkippedWorkerSteps.has(route[position].stepId)) {
          activate(route[position]);
        }
      };

      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run() {
            let entry = route[position];
            while (entry && conditionallySkippedWorkerSteps.has(entry.stepId)) {
              confirmCanonicalFixtureStep(flowManager, specId, routeNodeId(entry));
              position += 1;
              entry = route[position];
            }
            if (!entry) return { taskId: null, step: null, action: "completed", instructions: null, context: null, output_schema: null, requires_approval: false, binding, directive: { kind: "completed", terminal: true, requiresUserAction: false } };
            const nodeId = routeNodeId(entry);
            if (flowManager.load().currentNodeId !== nodeId && entry.stepId === "approval") {
              // The parent continuation already confirmed the approval Attempt.
              position += 1;
              activate(route[position]);
              return guardedAction(route[position]);
            }
            activate(entry);
            return guardedAction(entry);
          },
        },
        agent: {
          async call(_prompt, options) {
            const invocation = JSON.parse(options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION);
            const action = JSON.parse(fs.readFileSync(invocation.actionFilePath, "utf8"));
            const stepId = action.step;
            const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
            assert.equal(typeof requestPath, "string", `${stepId} must have a sealed handoff request`);
            const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
            if (stepId === "spec-repair") {
              if (specRepairCalls === 0) {
                rejectedRepairSnapshot = flowManager.readCanonicalTransitionSnapshot(specId).toJSON();
              } else {
                assert.deepEqual(
                  flowManager.readCanonicalTransitionSnapshot(specId).toJSON(),
                  rejectedRepairSnapshot,
                  "a rejected correction must not change spec, Flow, activities, catalog, step, or semantic retry state",
                );
              }
            }
            if (stepId === "task-impl") {
              const current = flowManager.load();
              assert.deepEqual(
                findActiveNode(current),
                { scope: "task", taskId: request.taskId, stepId: `${request.taskId}-impl` },
                JSON.stringify({ currentNodeId: current.currentNodeId, currentTaskId: current.currentTaskId }, null, 2),
              );
            }
            workerSteps.push(stepId);
            handoffCount += 1;
            try {
              if (WORKER_SOURCE_HANDOFF_STEPS.includes(stepId)) {
                const pending = flowManager.sourceHandoffAuthorities({ specId, unsettledOnly: true });
                assert.equal(pending.length, 1, "worker start must have exactly one unsettled canonical checkpoint");
                const authority = pending[0];
                assert.equal(authority.checkpoint.identity.dispatchInvocationId, request.dispatchInvocationId);
                assert.equal(authority.checkpoint.digest, request.sourceHandoffCheckpointDigest);
                assert.equal(authority.event.kind, "start-intent", "worker must start after durable request binding");
                assert.equal(authority.event.requestDigest, coordinator.request.requestDigest);
                assert.equal(authority.settlement, null);
                const { paths, effect } = writeSourcePayload(stepId, request, executionRoot);
                if (stepId === "task-impl") {
                  taskMutationPaths.push({ taskId: request.taskId, paths });
                }
                return workerArtifactJson(effect);
              }
              writeArtifactPayload(stepId, request, stepId === "spec-repair" ? ++specRepairCalls : 1);
              sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
            } catch (error) {
              throw new Error(`${stepId} worker fixture failed: ${error.message}`, { cause: error });
            }
          },
        },
        commandRunner: async ({ command }) => {
          const entry = route[position];
          assert.equal(entry.stepId, command.commandName === "review" ? entry.stepId : entry.stepId);
          parentCommands.push(entry.stepId);
          if (entry.stepId === "impl-review") implReviewRuns += 1;
          const commandResult = await commandArtifacts(entry.stepId, flowManager, specId, implReviewRuns, commandArtifactHistories, {
            executionRoot,
            taskReviewRuns,
          });
          advance(entry, commandResult);
          return command.commandName === "finalize-cleanup"
            ? { ok: true, data: { status: "done", assurance: { completed: true } }, errors: [] }
            : { ok: true, data: {}, errors: [] };
        },
        repositoryFingerprint: () => `full-flow-${position}`,
        maxDispatches: 64,
        leaseFactory: () => ({ acquire() {}, release() {} }),
        handoffCoordinator: coordinator,
      });
      dispatcher.container = {};
      const baseCtx = {
        root: executionRoot, executionRoot, mainRoot, specId, flowManager,
        flowState: flowManager.load(), expectBinding: binding,
        _envelopeType: "run", _envelopeKey: "dispatch",
      };

      const beforeApproval = await dispatcher.execute(baseCtx);
      assert.equal(beforeApproval.dispatch?.boundary, "approval_required", JSON.stringify(beforeApproval, null, 2));
      assert.equal(beforeApproval.dispatch.binding, binding);
      assert.equal(workerSteps.includes("approval"), false);
      let afterApproval = await dispatcher.execute({ ...baseCtx, approve: beforeApproval.dispatch.approvalToken });
      let hostBoundaryDispatchCount = 0;
      while (afterApproval.dispatch?.boundary === "host_action") {
        hostBoundaryDispatchCount += afterApproval.dispatch.dispatchCount;
        parentCommands.push("task-triage");
        const projected = await new GetNextActionCommand().execute({
          ...baseCtx, flowState: flowManager.loadReadOnly(specId),
        });
        const filter = projected.context.taskReviewFilter;
        const filtered = new RunFilterTaskReviewCommand().execute({
          ...baseCtx,
          flowState: flowManager.loadReadOnly(specId),
          exclusions: "[]",
          expectAttemptId: filter.attemptId,
          expectReviewDigest: filter.reviewDigest,
          expectSourceFingerprint: filter.sourceFingerprint,
          expectCatalogFingerprint: filter.catalogFingerprint,
        });
        assert.equal(filtered.ok, true, JSON.stringify(filtered));
        position += 1;
        afterApproval = await dispatcher.execute({ ...baseCtx, flowState: flowManager.loadReadOnly(specId) });
      }
      assert.equal(afterApproval.dispatch?.boundary, "await_user_decision", JSON.stringify({ afterApproval, workerSteps, parentCommands, position }, null, 2));
      assert.equal(afterApproval.dispatch.binding, binding);
      assert.equal(workerSteps.includes(USER_DECISION_LEAF), false);
      advance(route[position]); // Explicit user decision is outside dispatcher/worker ownership.
      const beforeFinalize = await dispatcher.execute(baseCtx);
      assert.equal(beforeFinalize.dispatch?.boundary, "approval_required", JSON.stringify(beforeFinalize));
      assert.equal(beforeFinalize.dispatch.binding, binding);
      const completed = await dispatcher.execute({ ...baseCtx, approve: beforeFinalize.dispatch.approvalToken });

      const artifactWorkers = workerSteps.filter((stepId) => WORKER_ARTIFACT_HANDOFF_STEPS.includes(stepId));
      const sourceWorkers = workerSteps.filter((stepId) => WORKER_SOURCE_HANDOFF_STEPS.includes(stepId));
      const routedArtifactWorkers = WORKER_ARTIFACT_HANDOFF_STEPS
        .filter((stepId) => !PREPARATION_LEAVES.has(stepId) && !conditionallySkippedWorkerSteps.has(stepId));
      assert.equal(completed.dispatch?.boundary, "completed", JSON.stringify(completed));
      assert.deepEqual(new Set(artifactWorkers), new Set(routedArtifactWorkers));
      assert.deepEqual(new Set(sourceWorkers), new Set(WORKER_SOURCE_HANDOFF_STEPS));
      const sourceAuthorities = flowManager.sourceHandoffAuthorities({ specId, unsettledOnly: false });
      assert.equal(sourceAuthorities.length, sourceWorkers.length);
      assert.equal(new Set(sourceAuthorities.map((authority) => authority.checkpoint.digest)).size, sourceWorkers.length);
      for (const authority of sourceAuthorities) {
        assert.equal(authority.settlement.kind, "accepted");
        assert.equal(authority.settlement.checkpointDigest, authority.checkpoint.digest);
        assert.equal(authority.settlement.eventDigest, authority.event.digest);
      }
      assert.equal(specRepairCalls, 1, "one valid repair delta is confirmed without a correction loop");
      assert.equal(
        handoffCount,
        route.filter((entry) => (
          WORKER_ARTIFACT_HANDOFF_STEPS.includes(entry.stepId)
          || WORKER_SOURCE_HANDOFF_STEPS.includes(entry.stepId)
        ) && !conditionallySkippedWorkerSteps.has(entry.stepId)).length,
      );
      assert.deepEqual(taskMutationPaths, [
        { taskId: "T1", paths: ["src/task.js"] },
        { taskId: "T2", paths: ["src/task.js"] },
      ]);
      assert.equal(workerSteps.some((stepId) => flowArtifactAuthorityForStep(stepId)?.category === "command"), false);
      assert.equal(parentCommands.every((stepId) => flowArtifactAuthorityForStep(stepId)?.category === "command"), true);
      assert.equal(
        parentCommands.length,
        route.filter((entry) => flowArtifactAuthorityForStep(entry.stepId)?.category === "command").length,
        "every command-owned route leaf must execute once, including the repaired implementation cycle",
      );
      assert.deepEqual(
        new Set(parentCommands),
        new Set(route.filter((entry) => flowArtifactAuthorityForStep(entry.stepId)?.category === "command").map((entry) => entry.stepId)),
      );
      assert.equal(parentCommands.includes("branch"), false);
      assert.equal(parentCommands.includes("prepare-spec"), false);
      assert.equal(parentCommands.includes("draft-gate"), true, "the completed draft must be connected to draft-gate");
      assert.equal(workerSteps.includes("spec"), true, "the accepted draft-gate must start the spec worker");
      const completionReceipt = flowManager.activityLedger(specId)
        .find((activity) => activity.transition.stepConnectionReceipt?.kind === "draft-completion");
      assert.ok(completionReceipt, "the full flow must persist the connector receipt");
      assert.equal(completionReceipt.transition.stepConnectionReceipt.targetStepId, "draft-gate");
      assert.equal(completionReceipt.transition.stepConnectionReceipt.draftOutput.digest.length, 64);
      const typedReceipt = StepConnectionReceipt.fromJSON(JSON.parse(JSON.stringify(completionReceipt.transition.stepConnectionReceipt)));
      assert.ok(typedReceipt.lineage instanceof DraftCompletionLineage);
      for (const slot of ["questionsReview", "questionsRefine", "coverageReview", "coverageTriage", "coverageRepair", "canonicalDraft"]) {
        assert.ok(typedReceipt.lineage[slot] instanceof DraftCompletionCatalogBinding, `${slot} must bind its canonical publication`);
      }
      assert.equal(implReviewRuns, 2, "impl-repair must restart the test/review route");
      assert.equal(position, route.length);
      assert.equal(
        beforeApproval.dispatch.dispatchCount
          + afterApproval.dispatch.dispatchCount
          + hostBoundaryDispatchCount
          + beforeFinalize.dispatch.dispatchCount
          + completed.dispatch.dispatchCount,
        handoffCount + parentCommands.filter((stepId) => stepId !== "task-triage").length + 1,
        "dispatch count must include each worker/parent action and the parent Spec-approval continuation, but not host/user-boundary prompts",
      );
      const repairPublication = flowManager.activityLedger(specId).find((activity) => (
        activity.reviewPublication?.stage === "spec-repair"
      ));
      assert.ok(repairPublication, "spec-repair confirmation must retain its revision-scoped Activity fact");
      const repairReview = JSON.parse(flowManager.readArtifact({
        specId, logicalKey: "spec.review",
        parameters: { revision: String(repairPublication.reviewPublication.identity.revision).padStart(3, "0") },
        consumerNodeId: "spec-gate",
      }).bytes.toString("utf8"));
      const repairAudit = repairReview.audit.at(-1);
      assert.equal(repairAudit.stage, "spec-repair");
      assert.equal(repairAudit.acceptedOperations.length, 1);
      assert.deepEqual(repairAudit.appliedFindings, ["spec-review-blocking-1"]);
      const repairedSpec = JSON.parse(flowManager.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "approval" }).bytes.toString("utf8"));
      assert.equal(repairedSpec.requirements.find((requirement) => requirement.id === "R1").desc, "The requirement retains publication authority.");
      assert.equal(repairedSpec.background, "The worker cannot write canonical Flow artifacts.");
      const draftRepairAudit = JSON.parse(flowManager.readArtifact({
        specId,
        logicalKey: "draft.questions.repair",
        consumerNodeId: "draft-refine",
      }).bytes.toString("utf8"));
      const canonicalDraft = JSON.parse(flowManager.readArtifact({
        specId,
        logicalKey: "draft",
        consumerNodeId: "draft-gate",
      }).bytes.toString("utf8"));
      assert.deepEqual(draftRepairAudit.audit.envelopeErrors, [
        "draft repair version is invalid",
        "draft repair baseRevision is invalid",
        "draft repair operations are invalid",
      ]);
      assert.equal(draftRepairAudit.acceptedOperations.length, 0);
      assert.equal(canonicalDraft.goal, "full flow");
      assert.equal(canonicalDraft.analysis.problem, "Exercise the full flow.");
    } finally {
      removeTmpDir(temporaryRoot);
    }
  });

  it("runs Draft entry, a repair loop, reload, and terminal Spec connection through production APIs", async () => {
    const temporaryRoot = createTmpDir("worker-handoff-draft-coverage-repair-");
    try {
      const repository = temporaryRoot;
      const specId = "715f-worker-handoff-draft-coverage-repair";
      let flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false, specId });
      const fixture = new CanonicalFlowFixture({
        flowManager,
        specId,
        runId: "run-worker-handoff-draft-coverage-repair",
        autoApprove: true,
      });
      fixture.create().registerActive().activate("draft");

      const candidateQuestion = {
        state: "CandidateQuestion",
        id: "q1",
        question: "Which validation behavior must the Draft retain?",
        category: "user-visible-behavior",
        revision: 0,
        provenance: { producer: "production-scenario" },
        evidenceDigest: "a".repeat(64),
      };
      const emptyDraft = emptyQuestionLedgerDraft("draft coverage repair");
      const sourceDraft = {
        ...emptyDraft,
        decisionMap: { ...emptyDraft.decisionMap, requiresUserJudgment: [candidateQuestion.id] },
        questionLedger: { ...emptyDraft.questionLedger, questions: [candidateQuestion] },
      };
      class InterruptAfterPublicationCoordinator extends WorkerArtifactHandoffCoordinator {
        interrupted = false;

        completePublishedDraftWorker(input) {
          if (!this.interrupted) {
            this.interrupted = true;
            throw new Error("simulated interruption after conditional publication");
          }
          return super.completePublishedDraftWorker(input);
        }
      }
      const coordinator = new InterruptAfterPublicationCoordinator();
      const ctx = {
        root: repository,
        mainRoot: repository,
        executionRoot: repository,
        specId,
        flowManager,
      };
      const runDraftReview = async (manager, phase, { verdict, summary, repairTargets = [] }) => {
        const command = new RunReviewCommand({
          resolveTreeSha: () => "a".repeat(40),
          resolveTargetStateDigest: () => "b".repeat(64),
          runCommand(_command, _args, options) {
            const worker = ReviewWorkUnit.fromEnvironment(options.env);
            const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
            fs.writeFileSync(path.join(worker.root, worker.manifestDocument.output.basename), `${JSON.stringify({
              version: 2,
              phase,
              sourceDraft: "draft.json",
              sourceDraftRevision: source.revision,
              generatedAt: "2026-09-20T00:00:00.000Z",
              verdict,
              summary,
              blockingFindings: [],
              advisoryFindings: [],
              repairTargets,
            }, null, 2)}\n`);
            worker.seal();
            return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
          },
        });
        const reviewCtx = {
          ...ctx,
          flowManager: manager,
          phase: "draft",
          flowState: manager.loadReadOnly(specId),
          config: {},
        };
        const commandResult = await command.execute(reviewCtx);
        assert.equal(commandResult.result, "ok", JSON.stringify(commandResult));
        assert.equal(commandResult.artifacts.phase, phase);
        await FLOW_COMMANDS.run.review.post(reviewCtx, commandResult);
      };

      await completeArtifactHandoff({
        coordinator,
        ctx,
        stepId: "draft",
        invocationId: "draft-production-entry",
        logicalName: "draft.json",
        payload: sourceDraft,
      });
      assert.equal(flowManager.canonicalState(specId).nextAction().nodeId, "draft-questions-review");
      flowManager.beginNextAction(specId);
      await runDraftReview(flowManager, "draft-questions", {
        verdict: "PASS",
        summary: "No question-review finding remains.",
      });
      assert.equal(
        flowManager.canonicalState(specId).nextAction().operation,
        "start",
        JSON.stringify(flowManager.loadReadOnly(specId), null, 2),
      );
      flowManager.beginNextAction(specId);
      const refineState = flowManager.loadReadOnly(specId);
      const refine = await prepareConditionalDraftWorkerThroughStep({
        coordinator,
        ctx,
        state: refineState,
        invocation: {
          id: "draft-production-refine",
          target: { digest: "5".repeat(64) },
          action: { digest: "6".repeat(64), nextAction: { step: "draft-refine" } },
        },
      });
      assert.notEqual(refine.request, null);
      assert.equal(
        flowManager.draftStepExecutionState({
          binding: {
            runId: flowManager.canonicalState(specId).runId,
            specId,
            stepId: "draft-refine",
            attempt: flowManager.canonicalState(specId).attempt,
          },
        }).lifecycle.phase,
        "claimed",
      );
      fs.writeFileSync(refine.request.payloadPath("draft.json"), workerArtifactJson(emptyDraft));
      sealWorkerArtifactHandoff({
        requestPath: refine.request.requestPath,
        invocationId: refine.request.dispatchInvocationId,
      });
      await assert.rejects(
        () => completeDraftWorkerThroughStep({ coordinator, ctx, request: refine.request }),
        /simulated interruption after conditional publication/,
      );
      flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false, specId });
      ctx.flowManager = flowManager;
      const publicationBinding = {
        runId: flowManager.canonicalState(specId).runId,
        specId,
        stepId: "draft-refine",
        attempt: flowManager.canonicalState(specId).attempt,
      };
      assert.equal(flowManager.draftStepExecutionState({ binding: publicationBinding }).lifecycle.phase, "publication");
      const recoveredRefine = await completeDraftWorkerThroughStep({
        coordinator,
        ctx,
        request: refine.request,
      });
      assert.equal(recoveredRefine.stepResult.kind, "draft-refine-completed");
      assert.deepEqual(
        flowManager.activityLedger(specId)
          .filter((activity) => activity.nodeId === "draft-refine")
          .map((activity) => activity.result?.draftSettlementReceipt?.executionLifecycle?.phase)
          .filter((phase) => phase !== undefined),
        ["checkpoint", "claimed", "publication", "terminal"],
      );
      flowManager.beginNextAction(specId);
      const reviewFinding = {
        title: "Clarify validation coverage",
        target: "analysis.validation",
        rationale: "The validation statement must describe the repaired coverage.",
        evidence: "The current validation statement omits the repaired coverage behavior.",
        classification: "repair_target",
      };
      await runDraftReview(flowManager, "draft-coverage", {
        verdict: "ADVISORY",
        summary: "One coverage repair is required.",
        repairTargets: [reviewFinding],
      });
      assert.equal(flowManager.canonicalState(specId).nextAction().nodeId, "draft-coverage-triage");
      flowManager.beginNextAction(specId);
      const triage = {
        version: 1,
        phase: "draft-coverage-triage",
        sourceReview: "draft-review-coverage.json",
        summary: "Apply the coverage repair.",
        items: [{
          ...reviewFinding,
          decision: "apply",
          allowedFieldPaths: ["analysis.validation"],
          requiredFieldPaths: ["analysis.validation"],
        }],
      };
      await completeArtifactHandoff({
        coordinator,
        ctx,
        stepId: "draft-coverage-triage",
        invocationId: "draft-coverage-repair-triage",
        logicalName: "draft-coverage-triage.json",
        payload: triage,
      });

      assert.equal(flowManager.canonicalState(specId).nextAction().nodeId, "draft-coverage-repair");
      flowManager.beginNextAction(specId);
      const repairHandoff = coordinator.createRequest({
        ctx,
        state: flowManager.load(specId),
        invocation: {
          id: "draft-coverage-repair-worker",
          target: { digest: "1".repeat(64) },
          action: { digest: "2".repeat(64), nextAction: { step: "draft-coverage-repair" } },
        },
      });
      const expectedDigest = repairValueDigest(sourceDraft.analysis.validation);
      const repairedValue = "Complete the repaired coverage behavior.";
      fs.writeFileSync(repairHandoff.payloadPath("draft-coverage-repair.json"), workerArtifactJson({
        version: 1,
        baseRevision: `sha256:${repairHandoff.inputRevision}`,
        operations: [
          {
            title: reviewFinding.title,
            target: reviewFinding.target,
            kind: "replace-value",
            path: "analysis.validation",
            expectedDigest,
            replacement: repairedValue,
            reason: "The permitted validation field now covers the repaired behavior.",
          },
          {
            title: "Unrelated operation",
            target: "unrelated finding",
            kind: "replace-value",
            path: "analysis.problem",
            expectedDigest: repairValueDigest(sourceDraft.analysis.problem),
            replacement: "This unrelated field must remain unchanged.",
            reason: "This proposal is outside the triage permission.",
          },
        ],
      }));
      sealWorkerArtifactHandoff({
        requestPath: repairHandoff.requestPath,
        invocationId: "draft-coverage-repair-worker",
      });
      const repaired = await completeDraftWorkerThroughStep({ coordinator, ctx, request: repairHandoff });

      assert.equal(repaired.completed, true);
      const repairAudit = JSON.parse(flowManager.readArtifact({
        specId,
        logicalKey: "draft.coverage.repair",
        consumerNodeId: "draft-gate",
      }).bytes.toString("utf8"));
      const completedDraftArtifact = flowManager.readArtifact({
        specId,
        logicalKey: "draft",
        consumerNodeId: "draft-gate",
      });
      const completedDraft = JSON.parse(completedDraftArtifact.bytes.toString("utf8"));
      assert.equal(repairAudit.acceptedOperations.length, 1);
      assert.equal(repairAudit.acceptedOperations[0].kind, "replace-value");
      assert.equal(repairAudit.acceptedOperations[0].path, "analysis.validation");
      assert.equal(repairAudit.discardedOperations.length, 1);
      assert.equal(repairAudit.discardedOperations[0].reason, "unauthorized operation");
      assert.equal(completedDraft.analysis.validation, repairedValue);
      assert.equal(Object.hasOwn(completedDraft, "approval"), false);

      const repairDescriptor = flowManager.readArtifact({
        specId,
        logicalKey: "draft.coverage.repair",
        consumerNodeId: "draft-gate",
      }).descriptor;
      const completionActivity = flowManager.activityLedger(specId)
        .find((activity) => activity.id === repairDescriptor.activityId);
      assert.ok(completionActivity);
      assert.equal(repairDescriptor.activityId, completedDraftArtifact.descriptor.activityId);
      assert.equal(completedDraftArtifact.descriptor.activityId, completionActivity.id);
      assert.equal(completionActivity.transition.operation, "confirm_attempt");
      assert.equal(repaired.stepResult.kind, "draft-coverage-repair-changed");
      assert.equal(repaired.settlementReceipt.targetStepId, "draft-coverage-review");
      assert.equal(flowManager.canonicalState(specId).nextAction().nodeId, "draft-coverage-review");

      const activityCount = flowManager.activityLedger(specId).length;
      const reloaded = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false, specId });
      const durableReceipt = reloaded.activityLedger(specId).findLast((activity) => (
        activity.result?.draftSettlementReceipt?.id === repaired.settlementReceipt.id
      ))?.result.draftSettlementReceipt ?? null;
      assert.equal(durableReceipt?.id, repaired.settlementReceipt.id);
      assert.equal(reloaded.activityLedger(specId).length, activityCount);
      assert.equal(
        reloaded.activityLedger(specId).filter((activity) => activity.transition.stepConnectionReceipt?.kind === "draft-completion").length,
        0,
      );

      ctx.flowManager = reloaded;
      reloaded.beginNextAction(specId);
      await runDraftReview(reloaded, "draft-coverage", {
        verdict: "ADVISORY",
        summary: "The repaired Draft retains one already-resolved coverage target.",
        repairTargets: [reviewFinding],
      });
      reloaded.beginNextAction(specId);
      await completeArtifactHandoff({
        coordinator,
        ctx,
        stepId: "draft-coverage-triage",
        invocationId: "draft-coverage-unchanged-triage",
        logicalName: "draft-coverage-triage.json",
        payload: {
          ...triage,
          summary: "The coverage target is already resolved by the prior repair.",
          items: triage.items.map((item) => ({ ...item, decision: "already_resolved" })),
        },
      });
      reloaded.beginNextAction(specId);
      const unchangedHandoff = coordinator.createRequest({
        ctx,
        state: reloaded.load(specId),
        invocation: {
          id: "draft-coverage-unchanged-repair",
          target: { digest: "7".repeat(64) },
          action: { digest: "8".repeat(64), nextAction: { step: "draft-coverage-repair" } },
        },
      });
      fs.writeFileSync(unchangedHandoff.payloadPath("draft-coverage-repair.json"), workerArtifactJson({
        version: 1,
        baseRevision: `sha256:${unchangedHandoff.inputRevision}`,
        operations: [],
      }));
      sealWorkerArtifactHandoff({
        requestPath: unchangedHandoff.requestPath,
        invocationId: unchangedHandoff.dispatchInvocationId,
      });
      let sealedFacts = null;
      let handoffApplication = null;
      let storeApplication = null;
      const prepareDraftWorker = coordinator.prepareDraftWorker.bind(coordinator);
      coordinator.prepareDraftWorker = (input) => {
        const preparation = prepareDraftWorker(input);
        if (input.request === unchangedHandoff) {
          sealedFacts = preparation.facts.draftCompletionFacts;
          assert.ok(sealedFacts instanceof DraftCompletionFacts);
        }
        return preparation;
      };
      const commitDraftWorker = coordinator.commitDraftWorker.bind(coordinator);
      coordinator.commitDraftWorker = (input) => {
        if (input.request === unchangedHandoff) {
          handoffApplication = input.draftCompletionApplication;
          assert.ok(handoffApplication instanceof DraftCompletionSettlementApplication);
          assert.equal(handoffApplication.facts, sealedFacts);
        }
        return commitDraftWorker(input);
      };
      const settleDraftStepResult = reloaded.settleDraftStepResult.bind(reloaded);
      reloaded.settleDraftStepResult = (input) => {
        if (input.binding?.stepId === "draft-coverage-repair") {
          storeApplication = input.draftCompletionApplication;
        }
        return settleDraftStepResult(input);
      };
      const unchanged = await completeDraftWorkerThroughStep({
        coordinator, ctx, request: unchangedHandoff,
      });
      assert.equal(unchanged.stepResult.kind, "draft-coverage-repair-unchanged");
      assert.equal(storeApplication, handoffApplication);
      assert.ok(storeApplication instanceof DraftCompletionSettlementApplication);
      assert.equal(reloaded.canonicalState(specId).nextAction().nodeId, "draft-gate");
      reloaded.beginNextAction(specId);
      const gateResult = new CanonicalGatePromotion({
        state: reloaded.canonicalState(specId),
        phase: "draft",
        nodeId: "draft-gate",
      }).promote({ result: "pass", artifacts: { phase: "draft", evaluations: [] } });
      await FLOW_COMMANDS.run.gate.post({
        ...ctx,
        flowManager: reloaded,
        flowState: reloaded.loadReadOnly(specId),
        phase: "draft",
      }, gateResult);
      const specAction = await new GetNextActionCommand().execute({
        ...ctx,
        flowManager: reloaded,
        flowState: reloaded.loadReadOnly(specId),
        config: {},
      });
      assert.equal(specAction.step, "spec");
      assert.equal(specAction.directive.actionId, "CLAIM_NEXT_ACTION");
      const claimedSpec = await new RunClaimNextActionCommand().execute({
        ...ctx,
        flowManager: reloaded,
        flowState: reloaded.loadReadOnly(specId),
        config: {},
      });
      assert.equal(claimedSpec.ok, true, JSON.stringify(claimedSpec));
      const specRequest = coordinator.createRequest({
        ctx: { ...ctx, flowManager: reloaded },
        state: reloaded.loadReadOnly(specId),
        invocation: {
          id: "draft-production-spec-connection",
          target: { digest: "3".repeat(64) },
          action: { digest: "4".repeat(64), nextAction: { step: "spec" } },
        },
        deferPreparation: true,
      });
      const draftInput = specRequest.inputs.find((entry) => entry.name === "draft.json");
      assert.equal(draftInput.document.analysis.validation, repairedValue);
      assert.equal(
        reloaded.activityLedger(specId).filter((activity) => (
          activity.result?.draftSettlementReceipt?.targetStepId === "spec"
        )).length,
        1,
      );
    } finally {
      removeTmpDir(temporaryRoot);
    }
  });
});
