/**
 * Contract tests for `flow get next-action` against the production V1 Store.
 *
 * These scenarios deliberately create a fresh `001` Version and reach each
 * worker frontier through typed Attempts.  A mutable legacy flow.json fixture
 * cannot establish a valid precondition for this command anymore.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  CanonicalNextActionScenario,
  draftDocumentWithPendingQuestions,
  makeFlowManager,
} from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import {
  deriveNextAction,
  getFlowDefinitionOrder,
  getTaskDefinitionOrder,
  resolveLifecycle,
  resolveDraftTransition,
  resolveReviewTransition,
} from "../../../src/flow/definition.js";
import {
  DraftQuestionFact,
  DraftTransitionFacts,
} from "../../../src/flow/lib/draft-transition-facts.js";
import { AwaitingUserAnswer, DraftQuestionLedger } from "../../../src/flow/lib/draft-question-ledger.js";
import { flattenSteps, findStepById } from "../../../src/flow/lib/step-tree.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import {
  ReviewDeferralEvidence,
  ReviewRepairEvidence,
  ReviewTransitionFacts,
} from "../../../src/flow/lib/review-transition-facts.js";
import { validateSchema } from "../../../src/lib/schema-validate.js";
import { sourceWorkerEffectJsonSchema } from "../../../src/flow/lib/source-worker-effect-schema.js";
import { PKG_DIR } from "../../../src/lib/cli.js";
import { resolveIncludes } from "../../../src/lib/include.js";
import { runtimeLogFileForContext } from "../../../src/lib/runtime-log.js";
import {
  FlowOutboxRecoveryClaim,
  FlowOutboxStore,
  finalizationOutboxIdentity,
} from "../../../src/flow/lib/flow-outbox.js";
import { outboxCommitMarker } from "../../../src/flow/lib/run-finalize.js";
import GetPromptCommand from "../../../src/flow/lib/get-prompt.js";

const CLI = path.join(process.cwd(), "src/sennel.js");
const SPEC_ID = "001-test";
const RUN_ID = "run-001-test";

function runCli(tmp, args) {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, SENNEL_WORK_ROOT: tmp },
    });
    return { envelope: JSON.parse(out), exitCode: 0 };
  } catch (error) {
    const stdout = error.stdout?.toString() || "";
    return { envelope: stdout ? JSON.parse(stdout) : null, exitCode: error.status || 1 };
  }
}

function taskDocument(id, { spec = null } = {}) {
  return {
    id,
    title: `Task ${id}`,
    goal: `Exercise the canonical next-action Task ${id}.`,
    parent: null,
    origin: "plan",
    added_round: 0,
    status: "pending",
    ...(spec === null ? {} : { spec }),
  };
}

function createScenario(tmp, {
  tasks = [],
  execution = { mode: "direct" },
  autoApprove = false,
} = {}) {
  return new CanonicalNextActionScenario({
    flowManager: makeFlowManager(tmp),
    specId: SPEC_ID,
    runId: RUN_ID,
    request: "Keep this canonical next-action request unchanged.",
    execution,
    autoApprove,
  }).create({ tasks });
}

function managerFor(scenario) {
  return scenario.flowManager;
}

function stateFor(scenario) {
  return managerFor(scenario).load(SPEC_ID);
}

function canonicalFlowFile(scenario) {
  return managerFor(scenario).specLocation(SPEC_ID).flowStateFile;
}

function failedFinalizationOutbox(scenario, stepId, failure) {
  const manager = managerFor(scenario);
  const identity = finalizationOutboxIdentity(stateFor(scenario), stepId);
  const outbox = new FlowOutboxStore(manager, { specId: SPEC_ID });
  outbox.beginCommand(identity);
  outbox.fail(identity, new Error(failure));
  return { identity, outbox };
}

function publishDraft(scenario, draft) {
  managerFor(scenario).publishArtifacts({
    specId: SPEC_ID,
    nodeId: "draft",
    artifactWrites: [{
      logicalKey: "draft",
      mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(draft, null, 2)}\n`, "utf8"),
    }],
  });
}

describe("flow get next-action", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("lets the definition own the manual and automatic draft boundary", () => {
    const digest = "a".repeat(64);
    const ledger = new DraftQuestionLedger({
      revision: 0, publication: "fixture", evidenceDigest: digest,
      questions: [new AwaitingUserAnswer({ id: "q1", question: "Which public contract should be selected?", category: "user-visible-behavior", revision: 0, provenance: { producer: "fixture" }, evidenceDigest: digest })],
    });
    const questionFacts = new DraftTransitionFacts({
      ledger,
      nextQuestion: new DraftQuestionFact({
        id: "q1",
        question: "Which public contract should be selected?",
        revision: 0,
      }),
    });
    const noQuestionFacts = new DraftTransitionFacts({ ledger: new DraftQuestionLedger({ revision: 0, publication: "fixture", evidenceDigest: digest, questions: [] }) });

    assert.equal(resolveDraftTransition({
      stepId: "draft-refine",
      flowState: { autoApprove: false },
      facts: questionFacts,
    }).operation, "await-user-answer");
    assert.equal(resolveDraftTransition({
      stepId: "draft-refine",
      flowState: { autoApprove: true },
      facts: questionFacts,
    }).operation, "execute-refine");
    assert.equal(resolveDraftTransition({
      stepId: "draft-refine",
      flowState: { autoApprove: false },
      facts: noQuestionFacts,
    }).operation, "execute-refine");
  });

  it("projects test-review retry exhaustion from definition-owned persisted facts", () => {
    const rejected = { phase: "test", counter: "reviewRetry", delta: 1 };
    const repair = resolveReviewTransition({
      stepId: "test-review",
      flowState: { metrics: [rejected, rejected, rejected, rejected], policy: { nonblocking: null } },
      facts: new ReviewTransitionFacts({
        scope: "flow",
        phase: "test",
        verdict: "REJECTED",
        repairEvidence: new ReviewRepairEvidence({ status: "available" }),
      }),
    });
    const blocked = resolveReviewTransition({
      stepId: "test-review",
      flowState: { metrics: [rejected, rejected, rejected, rejected, rejected], policy: { nonblocking: null } },
      facts: new ReviewTransitionFacts({ scope: "flow", phase: "test", verdict: "REJECTED" }),
    });

    assert.equal(repair.operation, "repair-test-review");
    assert.equal(blocked.operation, "blocked");
    assert.deepEqual(blocked.toJSON(), {
      operation: "blocked", phase: "test", attempts: 5, maxAttempts: 5,
    });
  });

  it("keeps exhausted flow Reviews active before draft/impl rejection routes leave Review", () => {
    const metric = (phase) => ({ phase, counter: "reviewRetry", delta: 1 });
    const cases = [
      { phase: "draft-questions", stepId: "draft-questions-review", previous: 0, retained: true },
      { phase: "draft-coverage", stepId: "draft-coverage-review", previous: 0, retained: true },
      { phase: "impl", stepId: "impl-review", previous: 2, retained: false },
      { phase: "impl", stepId: "impl-review", previous: 3, retained: true },
    ];
    for (const testCase of cases) {
      const actions = resolveLifecycle({
        event: "review:post",
        phase: testCase.phase.startsWith("draft-") ? "draft" : testCase.phase,
        currentStepId: testCase.stepId,
        flowState: {
          metrics: Array.from({ length: testCase.previous }, () => metric(testCase.phase)),
          policy: { nonblocking: null },
        },
        result: {
          artifacts: {
            phase: testCase.phase.startsWith("draft-") ? "draft" : testCase.phase,
            retryPhase: testCase.phase.startsWith("draft-") ? testCase.phase : undefined,
            verdict: "REJECTED",
          },
        },
      });
      const leavesReview = actions.some((action) => (
        action.constructor.name === "SetStepStatus"
        && action.step === testCase.stepId
        && action.status === "done"
      ));
      assert.equal(leavesReview, !testCase.retained, `${testCase.phase} previous=${testCase.previous}`);
      assert.equal(actions.filter((action) => action.constructor.name === "IncrementMetric").length, 1);
      assert.equal(
        actions.filter((action) => action.constructor.name === "PersistReviewResult").length,
        testCase.retained ? 1 : 0,
        `${testCase.phase} result persistence`,
      );
    }
  });

  it("always advances the Spec review funnel without semantic retry accounting", () => {
    for (const verdict of ["PASS", "ADVISORY", "REJECTED"]) {
      const actions = resolveLifecycle({
        event: "review:post", phase: "spec", currentStepId: "spec-review",
        flowState: { metrics: Array.from({ length: 8 }, () => ({ phase: "spec", counter: "reviewRetry", delta: 1 })), policy: { nonblocking: { enabled: true } } },
        result: { artifacts: { phase: "spec", verdict } },
      });
      assert.equal(actions.some((action) => action.constructor.name === "SetStepStatus" && action.step === "spec-review" && action.status === "done"), true);
      assert.equal(actions.some((action) => action.constructor.name === "SetStepStatus" && ["spec-triage", "spec-repair"].includes(action.step)), false);
      assert.equal(actions.some((action) => action.constructor.name === "IncrementMetric" && action.phase === "spec"), false);
      assert.equal(actions.some((action) => action.constructor.name === "PersistReviewResult"), false);
    }
  });

  it("lets definition select only acceptance-relevant semantic finding fingerprints", () => {
    const finding = (fingerprint, disposition, extra = {}) => ({
      findingId: `finding-${fingerprint[0]}`,
      fingerprint,
      summary: "Review finding",
      rationale: "The finding is tied to a required behavior.",
      evidenceRefs: ["src/example.js:1"],
      ...(disposition === null ? {} : { disposition }),
      ...extra,
    });
    const mustFix = finding("a".repeat(64), "must-fix");
    const deferred = finding("b".repeat(64), "deferred");
    const informational = finding("c".repeat(64), "informational");
    const facts = (blockingFindings, rawFindings = blockingFindings) => new ReviewTransitionFacts({
      scope: "flow",
      phase: "impl",
      verdict: "REJECTED",
      artifact: {
        phase: "impl",
        verdict: "REJECTED",
        blockingFindings: rawFindings,
        canonicalEvidence: {
          disposition: "REJECTED",
          blockingFindings,
          advisoryFindings: [],
          identity: { evidenceDigest: "e".repeat(64) },
        },
      },
    });
    const flowState = {
      metrics: Array.from({ length: 4 }, () => ({ phase: "impl", counter: "reviewRetry", delta: 1 })),
      policy: { nonblocking: null },
    };

    const canonicalWithoutRationale = [mustFix, informational, deferred]
      .map(({ rationale, ...finding }) => finding);
    const selected = resolveReviewTransition({
      stepId: "impl-review",
      flowState,
      facts: facts(canonicalWithoutRationale, [mustFix, informational, deferred]),
    });
    assert.equal(selected.operation, "defer");
    assert.deepEqual(selected.sourceFingerprints, [mustFix.fingerprint, deferred.fingerprint]);

    for (const blockedFacts of [
      facts([informational]),
      facts([{ ...mustFix, disposition: undefined }]),
      facts([{ ...mustFix, rationale: "" }]),
      facts([mustFix], [{ ...mustFix, disposition: "informational" }]),
      facts([{ ...mustFix, fingerprint: "malformed" }]),
      facts([mustFix], [{ ...mustFix, failureKind: "schema_error" }]),
    ]) {
      assert.equal(resolveReviewTransition({
        stepId: "impl-review",
        flowState,
        facts: blockedFacts,
      }).operation, "blocked");
    }
  });

  it("keeps tooling observations as definition-owned external stops", () => {
    const transition = resolveReviewTransition({
      stepId: "test-review",
      flowState: { metrics: [], policy: { nonblocking: null } },
      facts: new ReviewTransitionFacts({
        scope: "flow",
        phase: "test",
        toolingOutcome: { reason: "provider unavailable" },
      }),
    });
    assert.equal(transition.operation, "external-blocked");
  });

  it("returns the established worker envelope for a V1 Flow Step", () => {
    tmp = createTmpDir();
    const scenario = createScenario(tmp).atFlowStep("draft");

    const { envelope, exitCode } = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(exitCode, 0);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.type, "get");
    assert.equal(envelope.key, "next-action");
    const data = envelope.data;
    assert.deepEqual(Object.keys(data).slice(0, 7), [
      "taskId",
      "step",
      "action",
      "instructions",
      "context",
      "output_schema",
      "requires_approval",
    ]);
    assert.equal(data.taskId, null);
    assert.equal(data.step, "draft");
    assert.equal(data.action, "write-draft");
    const returnedBinding = FlowTargetBinding.deserialize(data.binding);
    assert.equal(returnedBinding.runId, RUN_ID);
    assert.equal(returnedBinding.specId, SPEC_ID);
    assert.equal(returnedBinding.authority.mainRoot, tmp);
    assert.equal(returnedBinding.authority.executionRoot, tmp);
    assert.deepEqual(data.directive, {
      kind: "execute_step",
      terminal: false,
      requiresUserAction: false,
      action: data.action,
    });
    assert.equal(stateFor(scenario).currentNodeId, "draft");
  });

  it("yields each manual draft question before starting the draft-refine worker", () => {
    tmp = createTmpDir();
    const scenario = createScenario(tmp).atFlowStep("draft");
    publishDraft(scenario, draftDocumentWithPendingQuestions());
    scenario.atFlowStep("draft-refine");
    const binding = FlowTargetBinding.capture({
      flowState: stateFor(scenario),
      mainRoot: tmp,
      authorityRoot: tmp,
    }).serialize();

    const first = runCli(tmp, ["flow", "get", "next-action", "--expect-binding", binding]);
    assert.equal(first.exitCode, 0);
    assert.equal(first.envelope.data.binding, binding);
    assert.deepEqual(first.envelope.data.directive, {
      kind: "await_draft_question",
      terminal: false,
      requiresUserAction: true,
      questionId: "q1",
      question: "Which public behavior should the command guarantee?",
      questionRevision: 0,
      reason: "Draft refinement requires an explicit user answer before its worker can run.",
    });

    const answered = runCli(tmp, [
      "flow", "set", "draft-answer", "q1",
      "--question-revision", "0",
      "--answer", "Return the stable public representation selected by the user.",
      "--why", "The user selected this behavior after comparing the public alternatives.",
      "--considered", "A repository-internal response shape was rejected.",
      "--expect-binding", binding,
    ]);
    assert.equal(answered.exitCode, 0);
    assert.equal(answered.envelope.data.status, "answered");
    assert.equal(answered.envelope.data.nextQuestionId, "q2");

    const second = runCli(tmp, ["flow", "get", "next-action", "--expect-binding", binding]);
    assert.equal(second.envelope.data.binding, binding);
    assert.equal(second.envelope.data.directive.kind, "await_draft_question");
    assert.equal(second.envelope.data.directive.questionId, "q2");

    const dropped = runCli(tmp, [
      "flow", "set", "draft-answer", "q2",
      "--question-revision", "0",
      "--drop",
      "--dropped-reason", "The project contract already fixes this compatibility boundary.",
      "--expect-binding", binding,
    ]);
    assert.equal(dropped.exitCode, 0);
    assert.equal(dropped.envelope.data.nextQuestionId, null);

    const ready = runCli(tmp, ["flow", "get", "next-action", "--expect-binding", binding]);
    assert.equal(ready.exitCode, 0);
    assert.equal(ready.envelope.data.binding, binding);
    assert.equal(ready.envelope.data.directive.kind, "execute_step");
    assert.equal(ready.envelope.data.step, "draft-refine");

    const stored = JSON.parse(managerFor(scenario).readArtifact({
      specId: SPEC_ID,
      logicalKey: "draft",
      consumerNodeId: "draft-refine",
    }).bytes.toString("utf8"));
    assert.deepEqual(stored.questionLedger.questions.map(({ id, state }) => ({ id, state })), [
      { id: "q1", state: "AnsweredQuestion" },
      { id: "q2", state: "DiscardedQuestion" },
    ]);
    assert.deepEqual(stored.decisionMap.requiresUserJudgment, []);
  });

  it("rejects an invalid persisted question schema before offering an unusable decision", () => {
    tmp = createTmpDir();
    const scenario = createScenario(tmp).atFlowStep("draft");
    const draft = draftDocumentWithPendingQuestions();
    draft.questionLedger.questions[0].priority = "must";
    assert.throws(
      () => publishDraft(scenario, draft),
      /draft publication is incomplete: questionLedger\.questions\[0\]: unknown field "priority"/,
    );

    const state = stateFor(scenario);
    assert.equal(state.currentNodeId, "draft");
    assert.equal(
      managerFor(scenario).artifactCatalog(SPEC_ID).artifacts.some((entry) => entry.logicalKey === "draft"),
      false,
    );
  });

  it("keeps autoApprove draft refinement inside the worker", () => {
    tmp = createTmpDir();
    const scenario = createScenario(tmp, { autoApprove: true }).atFlowStep("draft");
    publishDraft(scenario, draftDocumentWithPendingQuestions());
    scenario.atFlowStep("draft-refine");

    const { envelope, exitCode } = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(exitCode, 0);
    assert.equal(envelope.data.directive.kind, "execute_step");
    assert.equal(envelope.data.directive.requiresUserAction, false);
  });

  it("returns idle when no active V1 Flow exists", () => {
    tmp = createTmpDir();

    const { envelope, exitCode } = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(exitCode, 0);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.step, null);
    assert.equal(envelope.data.action, null);
    assert.equal(envelope.data.directive.kind, "idle");
  });

  it("resolves a Task worker action through its materialized Step identity", () => {
    tmp = createTmpDir();
    const scenario = createScenario(tmp, {
      tasks: [taskDocument("T-1", { spec: "tasks/T-1.md" })],
    }).atTaskStep("T-1", "task-impl");

    const { envelope, exitCode } = runCli(tmp, ["flow", "get", "next-action"]);
    const state = stateFor(scenario);

    assert.equal(exitCode, 0);
    assert.equal(envelope.data.taskId, "T-1");
    assert.equal(envelope.data.step, "task-impl");
    assert.equal(envelope.data.action, "run-impl");
    assert.deepEqual(envelope.data.output_schema, sourceWorkerEffectJsonSchema("task-impl"));
    assert.equal(envelope.data.context.paths.task_spec, "tasks/T-1.md");
    assert.equal(state.currentTaskId, "T-1");
    assert.equal(state.currentNodeId, "T-1-impl");
    assert.deepEqual(state.tasks[0].steps.map((step) => step.id), [
      "T-1-impl",
      "T-1-review",
      "T-1-triage",
      "T-1-repair",
      "T-1-gate",
    ]);
  });

  it("keeps the established Task worker envelope field order and context path", () => {
    tmp = createTmpDir();
    createScenario(tmp, {
      tasks: [taskDocument("T-1", { spec: "tasks/T-1.md" })],
    }).atTaskStep("T-1", "task-review");

    const { envelope, exitCode } = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(exitCode, 0);
    assert.deepEqual(Object.keys(envelope.data).slice(0, 7), [
      "taskId", "step", "action", "instructions", "context", "output_schema", "requires_approval",
    ]);
    assert.equal(envelope.data.taskId, "T-1");
    assert.equal(envelope.data.step, "task-review");
    assert.equal(envelope.data.context.paths.task_spec, "tasks/T-1.md");
  });

  it("rejects a mismatched exact target without changing the active Attempt", () => {
    tmp = createTmpDir();
    const scenario = createScenario(tmp).atFlowStep("draft");
    const before = fs.readFileSync(canonicalFlowFile(scenario));

    const { envelope, exitCode } = runCli(tmp, [
      "flow", "get", "next-action",
      "--expect-run-id", "other-run",
      "--expect-spec", SPEC_ID,
    ]);

    assert.equal(exitCode, 1);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.errors[0].code, "FLOW_TARGET_NOT_FOUND");
    assert.deepEqual(fs.readFileSync(canonicalFlowFile(scenario)), before);
    assert.equal(stateFor(scenario).currentNodeId, "draft");
  });

  it("projects a pending Task frontier read-only and claims it once through the explicit command", () => {
    tmp = createTmpDir();
    const scenario = createScenario(tmp, {
      tasks: [taskDocument("T-2")],
    }).beforeTask("T-2");
    const manager = managerFor(scenario);
    const before = manager.activityLedger(SPEC_ID).length;

    const first = runCli(tmp, ["flow", "get", "next-action"]);
    const projected = fs.readFileSync(canonicalFlowFile(scenario));
    const repeated = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(first.exitCode, 0);
    assert.equal(first.envelope.data.taskId, "T-2");
    assert.equal(first.envelope.data.step, "task-impl");
    assert.equal(first.envelope.data.directive.actionId, "CLAIM_NEXT_ACTION");
    assert.equal(stateFor(scenario).currentNodeId, null);
    assert.equal(manager.activityLedger(SPEC_ID).length, before);
    assert.equal(repeated.exitCode, 0);
    assert.equal(repeated.envelope.data.step, "task-impl");
    assert.equal(manager.activityLedger(SPEC_ID).length, before);
    assert.deepEqual(fs.readFileSync(canonicalFlowFile(scenario)), projected);

    const claimed = runCli(tmp, ["flow", "run", "claim-next-action"]);
    const afterClaim = manager.activityLedger(SPEC_ID);
    assert.equal(claimed.exitCode, 0);
    assert.equal(stateFor(scenario).currentNodeId, "T-2-impl");
    assert.equal(afterClaim.length, before + 1);
    assert.equal(afterClaim.at(-1).transition.operation, "start_attempt");
    const persisted = fs.readFileSync(canonicalFlowFile(scenario));
    const stale = runCli(tmp, ["flow", "run", "claim-next-action"]);
    assert.equal(stale.exitCode, 1);
    assert.equal(manager.activityLedger(SPEC_ID).length, afterClaim.length);
    assert.deepEqual(fs.readFileSync(canonicalFlowFile(scenario)), persisted);
  });

  it("claims a pending approval before exposing its semantic approval boundary", () => {
    tmp = createTmpDir();
    const scenario = createScenario(tmp).beforeFlowStep("approval");
    const manager = managerFor(scenario);
    const before = fs.readFileSync(canonicalFlowFile(scenario));
    const activityCount = manager.activityLedger(SPEC_ID).length;

    const first = runCli(tmp, ["flow", "get", "next-action"]);
    const repeated = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(first.exitCode, 0);
    assert.equal(first.envelope.data.step, "approval");
    assert.equal(first.envelope.data.requires_approval, false);
    assert.equal(first.envelope.data.auto_approval_choice_id, undefined);
    assert.equal(first.envelope.data.directive.actionId, "CLAIM_NEXT_ACTION");
    assert.equal(first.envelope.data.directive.actionPrompt, undefined);
    assert.equal(stateFor(scenario).currentNodeId, null);
    assert.equal(manager.activityLedger(SPEC_ID).length, activityCount);
    assert.deepEqual(fs.readFileSync(canonicalFlowFile(scenario)), before);
    assert.equal(repeated.exitCode, 0);
    assert.equal(repeated.envelope.data.directive.actionId, "CLAIM_NEXT_ACTION");

    const claimed = runCli(tmp, ["flow", "run", "claim-next-action"]);
    const active = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(claimed.exitCode, 0);
    assert.equal(stateFor(scenario).currentNodeId, "approval");
    assert.equal(manager.activityLedger(SPEC_ID).length, activityCount + 1);
    assert.equal(active.exitCode, 0);
    assert.equal(active.envelope.data.requires_approval, true);
    assert.equal(active.envelope.data.directive.kind, "execute_step");
    assert.equal(active.envelope.data.directive.requiresUserAction, true);
  });

  it("resolves auto approval only after claiming the pending approval Attempt", () => {
    tmp = createTmpDir();
    const scenario = createScenario(tmp, { autoApprove: true }).beforeFlowStep("approval");

    const pending = runCli(tmp, ["flow", "get", "next-action"]);
    assert.equal(pending.exitCode, 0);
    assert.equal(pending.envelope.data.requires_approval, false);
    assert.equal(pending.envelope.data.auto_approval_choice_id, undefined);
    assert.equal(pending.envelope.data.directive.actionId, "CLAIM_NEXT_ACTION");
    assert.equal(stateFor(scenario).currentNodeId, null);

    const claimed = runCli(tmp, ["flow", "run", "claim-next-action"]);
    const active = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(claimed.exitCode, 0);
    assert.equal(stateFor(scenario).currentNodeId, "approval");
    assert.equal(active.exitCode, 0);
    assert.equal(active.envelope.data.requires_approval, false);
    assert.equal(active.envelope.data.auto_approval_choice_id, undefined);
    assert.equal(active.envelope.data.directive.kind, "execute_step");
    assert.equal(active.envelope.data.directive.requiresUserAction, false);
  });

  it("does not attach finalize confirmation to its pending claim", () => {
    tmp = createTmpDir();
    const scenario = createScenario(tmp).beforeFlowStep("finalize-commit");

    const pending = runCli(tmp, ["flow", "get", "next-action"]);
    assert.equal(pending.exitCode, 0);
    assert.equal(pending.envelope.data.step, "finalize-commit");
    assert.equal(pending.envelope.data.requires_approval, false);
    assert.equal(pending.envelope.data.directive.actionId, "CLAIM_NEXT_ACTION");

    const claimed = runCli(tmp, ["flow", "run", "claim-next-action"]);
    const active = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(claimed.exitCode, 0);
    assert.equal(active.exitCode, 0);
    assert.equal(active.envelope.data.requires_approval, true);
    assert.equal(active.envelope.data.directive.kind, "execute_step");
  });

  it("does not treat Activity metrics as a mutable Task gate-attempt cache", () => {
    tmp = createTmpDir();
    const scenario = createScenario(tmp, { tasks: [taskDocument("T-1")] })
      .atTaskStep("T-1", "task-gate");
    const manager = managerFor(scenario);
    manager.appendMetric({
      phase: "task-impl",
      counter: "gateRetry",
      reset: true,
    }, { specId: SPEC_ID });

    const { envelope, exitCode } = runCli(tmp, ["flow", "get", "next-action"]);
    const state = stateFor(scenario);

    assert.equal(exitCode, 0);
    assert.equal(envelope.data.taskId, "T-1");
    assert.equal(envelope.data.step, "task-gate");
    assert.equal(envelope.data.halt, undefined);
    assert.equal(state.stepAttempts, undefined);
    assert.equal(state.metrics.at(-1).reset, true);
  });

  it("returns a Flow action when the typed cursor is not in a Task", () => {
    tmp = createTmpDir();
    const scenario = createScenario(tmp).atFlowStep("spec-gate");

    const { envelope, exitCode } = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(exitCode, 0);
    assert.equal(envelope.data.taskId, null);
    assert.equal(envelope.data.step, "spec-gate");
    assert.equal(stateFor(scenario).currentTaskId, null);
  });

  it("keeps dispatch approval token-bound while exposing acceptance risk as a tokenless user decision", () => {
    tmp = createTmpDir();
    const approval = createScenario(tmp).atFlowStep("approval");
    const approvalResult = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(approvalResult.exitCode, 0);
    assert.equal(approvalResult.envelope.data.requires_approval, true);
    assert.equal(stateFor(approval).policy.autoApprove, false);
    assert.equal(approvalResult.envelope.data.directive.kind, "execute_step");
    assert.equal(approvalResult.envelope.data.directive.requiresUserAction, true);
    const approvalChoices = approvalResult.envelope.data.directive.actionPrompt.choices;
    assert.deepEqual(
      approvalChoices.map((choice) => choice.actionId),
      [
        "APPROVE_SPECIFICATION",
        "REVIEW_SPECIFICATION_SUMMARY",
        "REVIEW_SPECIFICATION_FULL",
        "REQUEST_SPECIFICATION_CHANGES",
        "OTHER_APPROVAL_RESPONSE",
      ],
    );
    assert.deepEqual(
      approvalChoices.map((choice) => choice.label),
      [
        "Approve",
        "Review summary of the specification",
        "Review the full specification",
        "Request changes",
        "Other",
      ],
    );
    const approvalPrompt = new GetPromptCommand().execute({
      kind: "plan.approval",
      root: tmp,
      config: { lang: "en" },
      flowState: stateFor(approval),
    });
    assert.equal(
      approvalPrompt.description,
      approvalResult.envelope.data.directive.actionPrompt.question,
    );
    assert.equal(
      approvalPrompt.recommendation,
      approvalResult.envelope.data.directive.actionPrompt.recommendationReason,
    );
    assert.deepEqual(
      approvalPrompt.choices.map((choice) => choice.label),
      approvalChoices.map((choice) => choice.label),
    );
    assert.deepEqual(
      approvalPrompt.choices.map((choice) => choice.recommended),
      [false, true, false, false, false],
    );
    assert.match(approvalChoices[1].nextAction, /flow get artifact spec\.record --mode summary/);
    assert.match(approvalChoices[2].nextAction, /flow get artifact spec\.record --mode full/);
    assert.equal(approvalChoices[0].nextAction, null);
    assert.equal(approvalChoices[3].nextAction, null);
    assert.equal(approvalChoices[4].nextAction, null);
    const approvalBinding = FlowTargetBinding.capture({
      flowState: stateFor(approval),
      mainRoot: tmp,
      authorityRoot: tmp,
    }).serialize();
    for (const choice of approvalChoices.slice(1, 3)) {
      assert.match(choice.nextAction, new RegExp(`--expect-binding '${approvalBinding}'`));
      assert.doesNotMatch(choice.nextAction, /--approve/);
    }

    removeTmpDir(tmp);
    tmp = createTmpDir();
    const acceptance = createScenario(tmp).atFlowStep("acceptance-decision");
    const binding = FlowTargetBinding.capture({
      flowState: stateFor(acceptance),
      mainRoot: tmp,
      authorityRoot: tmp,
    }).serialize();
    const acceptanceResult = runCli(tmp, [
      "flow", "get", "next-action", "--expect-binding", binding,
    ]);
    const acceptanceData = acceptanceResult.envelope.data;

    assert.equal(acceptanceResult.exitCode, 0);
    assert.equal(acceptanceData.requires_approval, false);
    assert.equal(acceptanceData.directive.kind, "await_user_decision");
    assert.equal(acceptanceData.directive.requiresUserAction, true);
    assert.deepEqual(
      acceptanceData.directive.actionPrompt.choices.map((choice) => choice.actionId),
      [
        "ACCEPT_RISK_AND_CONTINUE",
        "ABORT_ACCEPTANCE",
        "REVIEW_ACCEPTANCE_SUMMARY",
        "REVIEW_ACCEPTANCE_FULL",
      ],
    );
    const choices = acceptanceData.directive.actionPrompt.choices;
    assert.deepEqual(
      choices.map((choice) => choice.label),
      [
        "Accept the risk and continue",
        "Abort",
        "Review summary of the acceptance review",
        "Review the full acceptance review",
      ],
    );
    assert.match(choices[2].nextAction, /flow get artifact acceptance\.review --mode summary/);
    assert.match(choices[3].nextAction, /flow get artifact acceptance\.review --mode full/);
    for (const choice of choices) {
      assert.match(choice.nextAction, new RegExp(`--expect-binding '${binding}'`));
      assert.doesNotMatch(choice.nextAction, /--approve/);
    }

    removeTmpDir(tmp);
    tmp = createTmpDir();
    const finalize = createScenario(tmp).atFlowStep("finalize-commit");
    const finalizeResult = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(finalizeResult.exitCode, 0);
    assert.equal(finalizeResult.envelope.data.requires_approval, true);
    assert.equal(stateFor(finalize).policy.autoApprove, false);
  });

  it("keeps every non-approval rule non-approval in the definition source", () => {
    for (const stepId of getFlowDefinitionOrder()) {
      const action = deriveNextAction({ scope: "flow", stepId });
      assert.ok(action, `flow.${stepId} has a definition action`);
      if (!["approval", "finalize-commit"].includes(stepId)) {
        assert.equal(action.requiresApproval, false, `flow.${stepId}`);
      }
    }
    for (const stepId of getTaskDefinitionOrder()) {
      const action = deriveNextAction({ scope: "task", stepId });
      assert.ok(action, `task.${stepId} has a definition action`);
      assert.equal(action.requiresApproval, false, `task.${stepId}`);
    }
  });

  it("keeps context descriptors path-only and resolves spec repair from V1", () => {
    tmp = createTmpDir();
    const scenario = createScenario(tmp).atFlowStep("spec-repair");

    const { envelope, exitCode } = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(exitCode, 0);
    assert.equal(envelope.data.step, "spec-repair");
    assert.equal(envelope.data.action, "write-spec");
    assert.equal(envelope.data.instructions.key, "plan.spec-repair");
    assert.deepEqual(envelope.data.context.paths, { specId: SPEC_ID });
    for (const value of Object.values(envelope.data.context.paths)) {
      assert.ok(typeof value === "string" && !value.includes("\n"));
    }
    assert.equal(stateFor(scenario).currentNodeId, "spec-repair");
  });

  it("resolves spec triage as a write-spec action with V1 context", () => {
    tmp = createTmpDir();
    const scenario = createScenario(tmp).atFlowStep("spec-triage");

    const { envelope, exitCode } = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(exitCode, 0);
    assert.equal(envelope.data.step, "spec-triage");
    assert.equal(envelope.data.action, "write-spec");
    assert.equal(envelope.data.instructions.key, "plan.spec-triage");
    assert.deepEqual(envelope.data.context.paths, { specId: SPEC_ID });
    assert.equal(stateFor(scenario).currentNodeId, "spec-triage");
  });

  it("returns context kinds as descriptors rather than resolved source contents", () => {
    tmp = createTmpDir();
    createScenario(tmp).atFlowStep("spec-repair");

    const { envelope, exitCode } = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(exitCode, 0);
    assert.ok(Array.isArray(envelope.data.context.kinds));
    assert.ok(envelope.data.context.kinds.every((kind) => typeof kind === "string"));
    assert.equal(Object.hasOwn(envelope.data.context, "contents"), false);
    assert.equal(Object.hasOwn(envelope.data.context, "source"), false);
  });

  it("returns an inline schema usable by the schema validator", () => {
    tmp = createTmpDir();
    createScenario(tmp).atFlowStep("spec-gate");

    const { envelope, exitCode } = runCli(tmp, ["flow", "get", "next-action"]);
    const schema = envelope.data.output_schema;

    assert.equal(exitCode, 0);
    assert.equal(typeof schema, "object");
    assert.equal(typeof schema.type, "string");
    assert.deepEqual(validateSchema({ verdict: "pass" }, schema), []);
    assert.notEqual(validateSchema({ verdict: 123 }, schema).length, 0);
  });

  it("retains instruction key and resolved prompt content for Flow and Task workers", () => {
    tmp = createTmpDir();
    createScenario(tmp).atFlowStep("draft");
    const flowResult = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(flowResult.exitCode, 0);
    assert.equal(flowResult.envelope.data.instructions.key, "plan.draft");
    assert.equal(typeof flowResult.envelope.data.instructions.content, "string");
    const parts = flowResult.envelope.data.instructions.key.split(".");
    const stepName = parts.pop();
    const promptPath = path.join(process.cwd(), "src", "flow", "prompts", ...parts, `${stepName}.md`);
    const prompt = resolveIncludes(fs.readFileSync(promptPath, "utf8"), {
      baseDir: path.dirname(promptPath),
      pkgDir: PKG_DIR,
      sourceFile: promptPath,
    });
    assert.ok(flowResult.envelope.data.instructions.content.endsWith(prompt));

    removeTmpDir(tmp);
    tmp = createTmpDir();
    createScenario(tmp, { tasks: [taskDocument("T-1", { spec: "tasks/T-1.md" })] })
      .atTaskStep("T-1", "task-impl");
    const taskResult = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(taskResult.exitCode, 0);
    assert.equal(taskResult.envelope.data.instructions.key, "task.task-impl");
    assert.equal(typeof taskResult.envelope.data.instructions.content, "string");
    assert.ok(taskResult.envelope.data.instructions.content.length > 0);
  });

  it("resolves every canonical Task leaf to its definition-owned worker action", () => {
    tmp = createTmpDir();
    for (const stepId of getTaskDefinitionOrder()) {
      const action = deriveNextAction({ scope: "task", stepId });
      assert.ok(action, `task.${stepId} has a definition action`);
      assert.equal(typeof action.action, "string");
      assert.ok(action.action.length > 0);
    }
  });

  it("recovers one durable finalization side effect through the V1 outbox ledger", () => {
    tmp = createTmpDir();
    initGitRepo(tmp);
    fs.writeFileSync(path.join(tmp, "README.md"), "baseline\n");
    commitAll(tmp, "test: baseline");
    const scenario = createScenario(tmp).atFlowStep("finalize-commit");
    const { identity, outbox } = failedFinalizationOutbox(
      scenario,
      "finalize-commit",
      "failed to stage durable test/report artifacts",
    );
    execFileSync("git", [
      "commit",
      "--allow-empty",
      "-m",
      "feat: implementation",
      "-m",
      outboxCommitMarker(identity.idempotencyKey),
    ], { cwd: tmp, stdio: "ignore" });

    const { envelope, exitCode } = runCli(tmp, ["flow", "get", "next-action"]);
    const status = outbox.status(identity);

    assert.equal(exitCode, 0);
    assert.equal(envelope.data.directive.kind, "execute_command");
    assert.equal(envelope.data.directive.actionId, "RECOVER_FINALIZE_COMMIT_OUTBOX");
    assert.match(envelope.data.directive.nextAction, /^sennel flow run recover-finalization /);
    assert.equal(status.status, "failed");
    assert.equal(status.exactRecoveryReceipt, null);
    assert.equal(managerFor(scenario).activityLedger(SPEC_ID).at(-1).transition.operation, "fail_outbox");
  });

  it("fails closed after an exact V1 finalization recovery is consumed", () => {
    tmp = createTmpDir();
    initGitRepo(tmp);
    fs.writeFileSync(path.join(tmp, "README.md"), "baseline\n");
    commitAll(tmp, "test: baseline");
    const scenario = createScenario(tmp).atFlowStep("finalize-commit");
    const { identity, outbox } = failedFinalizationOutbox(
      scenario,
      "finalize-commit",
      "first durable failure",
    );
    outbox.reopenFailedExact(new FlowOutboxRecoveryClaim({
      identity,
      attempt: 1,
      failure: "first durable failure",
    }));
    outbox.fail(identity, new Error("second durable failure"));
    execFileSync("git", [
      "commit",
      "--allow-empty",
      "-m",
      "feat: implementation",
      "-m",
      outboxCommitMarker(identity.idempotencyKey),
    ], { cwd: tmp, stdio: "ignore" });

    const { envelope, exitCode } = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(exitCode, 0);
    assert.equal(envelope.data.directive.kind, "blocked");
    assert.equal(envelope.data.directive.code, "FINALIZE_OUTBOX_RECOVERY_EXHAUSTED");
  });

  it("projects interrupted sync recovery without settling state", () => {
    tmp = createTmpDir();
    initGitRepo(tmp);
    fs.writeFileSync(path.join(tmp, "README.md"), "baseline\n");
    commitAll(tmp, "test: baseline");
    const scenario = createScenario(tmp).atFlowStep("finalize-sync");
    const manager = managerFor(scenario);
    const identity = finalizationOutboxIdentity(stateFor(scenario), "finalize-sync");
    const outbox = new FlowOutboxStore(manager, { specId: SPEC_ID });
    outbox.beginCommand(identity);
    const runtimeLog = runtimeLogFileForContext({ root: tmp, specId: SPEC_ID });
    fs.mkdirSync(path.dirname(runtimeLog.filePath), { recursive: true });
    fs.writeFileSync(runtimeLog.filePath, [
      '===== start runId=run-001-test sequence=1 attempt=1 command="flow run finalize-sync" startedAt="2026-07-28T00:00:00.000Z" exitCode="" endedAt="" =====',
      "[stderr] interrupted",
      "",
    ].join("\n"));

    const { envelope, exitCode } = runCli(tmp, ["flow", "get", "next-action"]);
    const status = outbox.status(identity);
    assert.equal(exitCode, 0);
    assert.equal(envelope.data.step, "finalize-sync");
    assert.equal(envelope.data.directive.actionId, "RECOVER_INTERRUPTED_FINALIZE_SYNC");
    assert.match(envelope.data.directive.nextAction, /^sennel flow run recover-finalization /);
    assert.equal(stateFor(scenario).currentNodeId, "finalize-sync");
    assert.equal(findStepById(stateFor(scenario).steps, "finalize-sync").status, "in_progress");
    assert.equal(status.status, "pending");
  });

  it("rejects legacy state creation rather than creating a root flow.json fallback", () => {
    tmp = createTmpDir();
    const manager = makeFlowManager(tmp);

    assert.throws(
      () => manager.createFresh({
        specId: SPEC_ID,
        runId: RUN_ID,
        steps: [],
        tasks: [],
      }),
      /request must be a string/,
    );
    const location = manager.specLocation(SPEC_ID);
    assert.equal(fs.existsSync(location.flowStateFile), false);
    assert.equal(fs.existsSync(path.join(location.specRoot, SPEC_ID, "flow.json")), false);
  });

  it("returns completed after every V1 leaf is confirmed", () => {
    tmp = createTmpDir();
    const scenario = createScenario(tmp).settleAll();

    const { envelope, exitCode } = runCli(tmp, ["flow", "get", "next-action"]);

    assert.equal(exitCode, 0);
    assert.equal(envelope.data.step, null);
    assert.equal(envelope.data.action, "completed");
    assert.equal(FlowTargetBinding.deserialize(envelope.data.binding).runId, RUN_ID);
    assert.ok(flattenSteps(stateFor(scenario).steps)
      .every((step) => ["done", "skipped"].includes(step.status)));
    assert.equal(findStepById(stateFor(scenario).steps, "finalize-cleanup").status, "done");
  });
});
