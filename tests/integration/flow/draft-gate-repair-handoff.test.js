import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { describe, it } from "node:test";

import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import {
  DraftGateRepairAppliedResult,
  DraftGateRepairCarryForwardResult,
  DraftGateRepairWorkerRequiredResult,
  DraftRefineWorkerRequiredResult,
} from "../../../src/flow/engine/step-result.js";
import {
  GateObservationRepair,
  PlanGateRepairOutcomeDraft,
} from "../../../src/flow/lib/gate-observation-convergence.js";
import {
  DraftWorkerExecutionStepBinding,
  DraftWorkerStepBinding,
} from "../../../src/flow/engine/connectors/draft/draft-step-binding.js";
import {
  DraftWorkerExecutionBinding,
  DraftWorkerExecutionClaim,
  settleDraftStepResult,
} from "../../../src/flow/definition.js";
import { DraftService } from "../../../src/flow/services/draft-service.js";
import { DraftGateRepairStep } from "../../../src/flow/steps/draft/draft-gate-repair.js";
import { StepFactory } from "../../../src/flow/engine/step-factory.js";
import { DraftRepairConnector } from "../../../src/flow/engine/connectors/draft/draft-repair-connector.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { CanonicalDraftReviewSource } from "../../../src/flow/lib/canonical-review-artifacts.js";
import { findStepById } from "../../../src/flow/lib/step-tree.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { DraftGateRepairScenario } from "../../support/infrastructure/draft-gate-repair-scenario.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function observations() {
  return [{
    kind: "violation", failureMode: "guardrail-violation", requirementRef: "R-1",
    where: { file: "draft.json", locator: "goal" },
    observed: "The retained behavior must be explicit.", severity: "blocking", refs: ["R-1"],
  }, {
    kind: "violation", failureMode: "process-evidence-missing", requirementRef: "process:coverage",
    where: { file: "draft.json", locator: "analysis.proposedApproach" },
    observed: "The proposal must identify its retained behavior.", severity: "blocking", refs: ["process:coverage"],
  }];
}

function setup(specId, { selectRepair = true, draftDocument = null, compactDraft = false } = {}) {
  const root = createTmpDir("draft-gate-repair-handoff-");
  initGitRepo(root);
  fs.writeFileSync(`${root}/README.md`, "draft Gate repair boundary\n");
  commitAll(root, "draft Gate repair boundary");
  const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const fixture = new CanonicalFlowFixture({
    flowManager, specId, runId: `run-${specId}`, issue: 521,
    request: "Preserve retained behavior through a bounded Gate repair.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
  }).create().registerActive().activate("draft");
  const sourceDraft = draftDocument ?? canonicalDraftDocument({ goal: "Incomplete retained behavior", questions: [] });
  flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{
    logicalKey: "draft", mediaType: "application/json",
    bytes: Buffer.from(compactDraft ? JSON.stringify(sourceDraft) : `${JSON.stringify(sourceDraft, null, 2)}\n`),
  }] });
  if (!selectRepair) return { root, flowManager, fixture };
  fixture.activate("draft-gate");
  const scenario = new DraftGateRepairScenario({ flowManager, root, specId })
    .select({ observations: observations(), issueLogId: `issue-${specId}` });
  return { root, flowManager, fixture, scenario };
}

function seal(request, payload) {
  fs.writeFileSync(request.payloadPath("draft-gate-repair.json"), `${JSON.stringify(payload, null, 2)}\n`);
  sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
}

function catalogEntry(flowManager, specId, logicalKey) {
  return flowManager.artifactCatalog(specId).artifacts.find((entry) => entry.logicalKey === logicalKey) ?? null;
}

function assertNoRepairPublication(flowManager, specId, draftDigest) {
  assert.equal(catalogEntry(flowManager, specId, "draft.gate.repair"), null);
  assert.equal(catalogEntry(flowManager, specId, "plan.gate.repair.outcome"), null);
  const current = flowManager.readArtifact({
    specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair",
  });
  assert.equal(current.descriptor.hash, draftDigest);
}

describe("dedicated draft Gate repair handoff", () => {
  it("checkpoints and claims Gate repair before request materialization", async () => {
    const value = setup("521-gate-repair-execution-claim");
    try {
      const state = value.flowManager.loadReadOnly(value.scenario.specId);
      const invocation = {
        id: "draft-gate-repair-execution-claim",
        target: { digest: "b".repeat(64) },
        action: { digest: "a".repeat(64), nextAction: { step: "draft-gate-repair" } },
      };
      const request = value.scenario.coordinator.createRequest({
        ctx: value.scenario.ctx,
        state,
        invocation,
        deferPreparation: true,
      });
      assert.equal(fs.existsSync(request.requestPath), false);
      const binding = new DraftWorkerExecutionStepBinding({
        flowManager: value.flowManager,
        specId: value.scenario.specId,
        stepId: "draft-gate-repair",
      });
      const executionBinding = new DraftWorkerExecutionBinding({
        executionGeneration: 0,
        inputDigest: request.inputDigest,
        inputRevision: request.inputRevision,
      });
      let executionResult;
      let executionSettlement;
      const service = new DraftService({
        flowManager: value.flowManager,
        binding,
        executionCheckpointer(stepResult, settlement, selectedBinding) {
          executionResult = stepResult;
          executionSettlement = settlement;
          return value.flowManager.checkpointDraftStepExecution({
            binding: selectedBinding,
            stepResult,
            settlement,
            executionBinding,
          });
        },
      });
      const result = await new StepFactory()
        .provide(DraftService, service)
        .create(DraftGateRepairStep)
        .execute();
      assert.equal(result.kind, "draft-gate-repair-worker-required");
      value.flowManager.claimDraftStepExecution({
        binding,
        stepResult: executionResult,
        settlement: executionSettlement,
        executionBinding,
        executionClaim: new DraftWorkerExecutionClaim({
          dispatchInvocationId: request.dispatchInvocationId,
          generatedAt: request.generatedAt,
          actionDigest: request.actionDigest,
          requestDigest: request.requestDigest,
        }),
      });
      assert.equal(fs.existsSync(request.requestPath), false);
      request.prepare();
      assert.equal(fs.existsSync(request.requestPath), true);
      assert.equal(value.flowManager.draftStepExecutionState({ binding }).lifecycle.phase, "claimed");
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("rejects publication with a different persisted execution selection before mutation", () => {
    const value = setup("521-gate-repair-execution-selection-mismatch");
    try {
      const request = value.scenario.createRequest();
      seal(request, value.scenario.replacement("goal", "Retain the complete behavior explicitly."));
      const preparation = value.scenario.coordinator.prepareDraftWorker({
        ctx: value.scenario.ctx,
        request,
      });
      const binding = new DraftWorkerExecutionStepBinding({
        flowManager: value.flowManager,
        specId: value.scenario.specId,
        stepId: "draft-gate-repair",
      });
      const mismatchedResult = new DraftRefineWorkerRequiredResult();
      const before = {
        state: value.flowManager.canonicalState(value.scenario.specId).toJSON(),
        activities: value.flowManager.activityLedger(value.scenario.specId),
        catalog: value.flowManager.artifactCatalog(value.scenario.specId).toJSON(),
      };

      assert.throws(
        () => value.scenario.coordinator.publishDraftWorker({
          ctx: value.scenario.ctx,
          request,
          preparation,
          stepResult: mismatchedResult,
          settlement: settleDraftStepResult(mismatchedResult.stepId, mismatchedResult),
          binding,
        }),
        (error) => error.code === "FLOW_DRAFT_EXECUTION_SELECTION_MISMATCH",
      );
      assert.deepEqual(value.flowManager.canonicalState(value.scenario.specId).toJSON(), before.state);
      assert.deepEqual(value.flowManager.activityLedger(value.scenario.specId), before.activities);
      assert.deepEqual(value.flowManager.artifactCatalog(value.scenario.specId).toJSON(), before.catalog);
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("admits only the selected repair and publishes the bounded delta, audit, and outcome atomically", () => {
    const value = setup("521-gate-repair-applied");
    try {
      const request = value.scenario.createRequest();
      assert.deepEqual(request.inputs.map((entry) => entry.name), [
        "draft.json", "plan-gate-repair.json", "gate-observation-recurrence.json",
      ]);
      assert.deepEqual(request.payloads.map(({ rule }) => rule.logicalName), ["draft-gate-repair.json"]);
      const authority = request.inputs.find((entry) => entry.name === "plan-gate-repair.json").document;
      assert.match(authority.sourceIssueLogId, /^draft-gate-result-[a-f0-9]{64}$/);
      assert.equal(authority.sourceEntryDigest.length, 64);
      assert.equal(authority.connector.resultLogicalKey, "draft.gate");
      assert.equal(authority.connector.catalogFingerprint.length, 64);
      assert.equal(authority.observations.length, 2);
      assert.equal(authority.observationFingerprints.length, 2);

      const applied = value.scenario.apply(value.scenario.replacement(
        "goal", "Retain the complete behavior explicitly.",
      ));
      assert.equal(applied.source.goal, "Retain the complete behavior explicitly.");
      const audit = value.flowManager.readArtifact({
        specId: value.scenario.specId, logicalKey: "draft.gate.repair", consumerNodeId: "draft-coverage-review",
      });
      const draft = value.flowManager.readArtifact({
        specId: value.scenario.specId, logicalKey: "draft", consumerNodeId: "draft-coverage-review",
      });
      const outcomeEntry = catalogEntry(value.flowManager, value.scenario.specId, "plan.gate.repair.outcome");
      const repairId = outcomeEntry.relativePath.match(/plan-gate-repairs\/([^/]+)\/outcome\.json$/)?.[1];
      const outcome = value.flowManager.readArtifact({
        specId: value.scenario.specId, logicalKey: "plan.gate.repair.outcome",
        parameters: { repairId }, consumerNodeId: "draft-gate-repair",
      });
      assert.equal(JSON.parse(audit.bytes).report.outputEvidenceDigest, draft.descriptor.hash);
      assert.equal(JSON.parse(outcome.bytes).report.outputEvidenceDigest, draft.descriptor.hash);
      assert.equal(JSON.parse(outcome.bytes).disposition, "applied");
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("rejects an outcome bound to a different repair record before Result settlement", () => {
    const value = setup("521-gate-repair-outcome-binding");
    try {
      const request = value.scenario.createRequest();
      seal(request, value.scenario.replacement("goal", "Retain the exact repair binding."));
      const preparation = value.scenario.coordinator.prepareDraftWorker({
        ctx: value.scenario.ctx,
        request,
      });
      const binding = new DraftWorkerStepBinding({ request });
      const executionResult = new DraftGateRepairWorkerRequiredResult();
      value.scenario.coordinator.publishDraftWorker({
        ctx: value.scenario.ctx,
        request,
        preparation,
        stepResult: executionResult,
        settlement: settleDraftStepResult(executionResult.stepId, executionResult),
        binding,
      });
      const validOutcome = preparation.planGateRepairOutcome;
      const mismatchedOutcome = new PlanGateRepairOutcomeDraft({
        repair: new GateObservationRepair({
          ...validOutcome.repair.toJSON(),
          recordFingerprint: "f".repeat(64),
        }),
        disposition: validOutcome.disposition,
        report: validOutcome.report,
      });
      const before = {
        state: value.flowManager.canonicalState(value.scenario.specId).toJSON(),
        activities: value.flowManager.activityLedger(value.scenario.specId),
        catalog: value.flowManager.artifactCatalog(value.scenario.specId).toJSON(),
      };
      const terminalResult = new DraftGateRepairAppliedResult();

      assert.throws(() => value.flowManager.settleDraftStepResult({
        binding,
        stepResult: terminalResult,
        settlement: settleDraftStepResult(terminalResult.stepId, terminalResult),
        planGateRepairOutcome: mismatchedOutcome,
      }), /does not match its canonical repair binding/);
      assert.deepEqual(value.flowManager.canonicalState(value.scenario.specId).toJSON(), before.state);
      assert.deepEqual(value.flowManager.activityLedger(value.scenario.specId), before.activities);
      assert.deepEqual(value.flowManager.artifactCatalog(value.scenario.specId).toJSON(), before.catalog);
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("publishes Gate repair through its exact worker binding instead of a review-repair Connector", async () => {
    const value = setup("521-gate-repair-dispatch-step");
    try {
      const request = value.scenario.createRequest();
      seal(request, value.scenario.replacement(
        "goal",
        "Retain the complete behavior explicitly through the dispatcher Step.",
      ));
      const preparation = value.scenario.coordinator.prepareDraftWorker({
        ctx: value.scenario.ctx,
        request,
      });

      const completed = await new RunDispatchCommand({ handoffCoordinator: value.scenario.coordinator })
        .runDraftWorkerStep(
          value.scenario.ctx,
          request,
          { Connector: DraftRepairConnector, StepClass: DraftGateRepairStep },
          preparation,
        );

      assert.equal(completed.completed, true);
      assert.equal(completed.stepResult.kind, "draft-gate-repair-applied");
      assert.equal(findStepById(value.flowManager.load().steps, "draft-gate-repair").status, "done");
      assert.equal(catalogEntry(value.flowManager, value.scenario.specId, "draft.gate.repair") !== null, true);
      const source = new CanonicalDraftReviewSource({
        flowManager: value.flowManager,
        state: value.flowManager.loadReadOnly(value.scenario.specId),
        phase: "draft-coverage",
      });
      assert.equal(source.sourceNodeId, "draft-gate-repair");
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("selects and persists CarryForward through the dispatcher Step when the worker makes no progress", async () => {
    const value = setup("521-gate-repair-dispatch-no-progress");
    try {
      const request = value.scenario.createRequest();
      const payload = value.scenario.replacement("goal", "Incomplete retained behavior");
      payload.operations = [];
      seal(request, payload);
      const preparation = value.scenario.coordinator.prepareDraftWorker({
        ctx: value.scenario.ctx,
        request,
      });

      const completed = await new RunDispatchCommand({ handoffCoordinator: value.scenario.coordinator })
        .runDraftWorkerStep(
          value.scenario.ctx,
          request,
          { Connector: DraftRepairConnector, StepClass: DraftGateRepairStep },
          preparation,
        );

      assert.equal(completed.completed, true);
      assert.equal(completed.stepResult.kind, "draft-gate-repair-carry-forward");
      assert.equal(findStepById(value.flowManager.load().steps, "draft-gate-repair").status, "done");
      assert.equal(value.flowManager.canonicalState(value.scenario.specId).nextAction().nodeId, "draft-coverage-review");
      assert.equal(catalogEntry(value.flowManager, value.scenario.specId, "draft.gate.repair"), null);
      assert.equal(catalogEntry(value.flowManager, value.scenario.specId, "flow.findings"), null);
      const outcomeEntry = catalogEntry(value.flowManager, value.scenario.specId, "plan.gate.repair.outcome");
      const repairId = outcomeEntry.relativePath.match(/plan-gate-repairs\/([^/]+)\/outcome\.json$/)?.[1];
      const outcome = value.flowManager.readArtifact({
        specId: value.scenario.specId,
        logicalKey: "plan.gate.repair.outcome",
        parameters: { repairId },
        consumerNodeId: "system",
      });
      assert.equal(JSON.parse(outcome.bytes).disposition, "rejected-no-progress");
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("persists an accepted post-worker integrity Error through the normal Draft committer", async () => {
    const value = setup("521-gate-repair-dispatch-error");
    try {
      const request = value.scenario.createRequest();
      seal(request, value.scenario.replacement("goal", "Retain the exact repair binding."));
      const preparation = value.scenario.coordinator.prepareDraftWorker({
        ctx: value.scenario.ctx,
        request,
      });
      const binding = new DraftWorkerStepBinding({ request });
      const executionResult = new DraftGateRepairWorkerRequiredResult();
      value.scenario.coordinator.publishDraftWorker({
        ctx: value.scenario.ctx,
        request,
        preparation,
        stepResult: executionResult,
        settlement: settleDraftStepResult(executionResult.stepId, executionResult),
        binding,
      });
      const terminalBinding = new DraftWorkerExecutionStepBinding({
        flowManager: value.flowManager,
        specId: value.scenario.specId,
        stepId: "draft-gate-repair",
      });
      const integrityError = Object.assign(new Error("accepted repair outcome failed its semantic integrity check"), {
        code: "DRAFT_GATE_REPAIR_INTEGRITY",
      });
      const service = new DraftService({
        flowManager: value.flowManager,
        binding: terminalBinding,
        workerFacts: { planGateRepairOutcome: integrityError },
        workerExecutor: () => {
          throw new Error("Error Result must use the worker error committer");
        },
        workerErrorCommitter: (stepResult, settlement, workerBinding) => ({
          error: null,
          ...value.scenario.coordinator.completePublishedDraftWorker({
            ctx: value.scenario.ctx,
            request,
            preparation,
            stepResult,
            settlement,
            binding: workerBinding,
          }),
        }),
      });

      const result = await new StepFactory()
        .provide(DraftService, service)
        .create(DraftGateRepairStep)
        .execute();

      assert.equal(result.kind, "draft-gate-repair-error");
      assert.equal(result.error.code, "DRAFT_GATE_REPAIR_INTEGRITY");
      const state = value.flowManager.canonicalState(value.scenario.specId);
      assert.equal(state.current.at(-1), "draft-gate-repair");
      assert.equal(state.attempt.failure.category, "step-result-error");
      assert.equal(state.attempt.failure.code, "DRAFT_GATE_REPAIR_INTEGRITY");
      const failure = value.flowManager.activityLedger(value.scenario.specId).at(-1);
      assert.equal(failure.transition.operation, "fail_attempt");
      assert.equal(failure.result.stepResult.kind, "draft-gate-repair-error");
      assert.equal(failure.result.draftSettlementReceipt.settlementKind, "failure");
      assert.equal(catalogEntry(value.flowManager, value.scenario.specId, "plan.gate.repair.outcome"), null);
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("rejects direct request creation without a Definition-selected repair before any side effect", () => {
    const value = setup("521-gate-repair-no-plan", { selectRepair: false });
    try {
      const beforeActivities = value.flowManager.activityLedger(value.fixture.specId).length;
      const beforeFiles = fs.readdirSync(value.root, { recursive: true }).map(String).sort();
      const scenario = new DraftGateRepairScenario({
        flowManager: value.flowManager, root: value.root, specId: value.fixture.specId,
      });
      assert.throws(() => scenario.coordinator.createRequest({
        ctx: scenario.ctx,
        state: value.flowManager.loadReadOnly(value.fixture.specId),
        invocation: {
          id: "unselected-draft-gate-repair", target: { digest: "b".repeat(64) },
          action: { digest: "a".repeat(64), nextAction: { step: "draft-gate-repair" } },
        },
      }), (error) => error.code === "FLOW_WORKER_ACTION_NOT_SELECTED");
      assert.equal(value.flowManager.activityLedger(value.fixture.specId).length, beforeActivities);
      assert.deepEqual(fs.readdirSync(value.root, { recursive: true }).map(String).sort(), beforeFiles);
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("persists semantic no-progress across a canonical reload", () => {
    const value = setup("521-gate-repair-no-progress");
    try {
      const request = value.scenario.createRequest();
      const payload = value.scenario.replacement("goal", "Incomplete retained behavior");
      payload.operations = [];
      seal(request, payload);
      const preparation = value.scenario.coordinator.prepareDraftWorker({
        ctx: value.scenario.ctx,
        request,
      });
      const binding = new DraftWorkerStepBinding({ request });
      const stepResult = new DraftGateRepairCarryForwardResult();
      const result = value.scenario.coordinator.commitDraftWorker({
        ctx: value.scenario.ctx,
        request,
        preparation,
        stepResult,
        settlement: settleDraftStepResult(stepResult.stepId, stepResult),
        binding,
      });
      assert.equal(result.stepResult.kind, "draft-gate-repair-carry-forward");
      const terminal = value.flowManager.canonicalState(value.scenario.specId)
        .findNode("draft-gate-repair").result.draftSettlementReceipt;
      assert.equal(result.receipt.id, terminal.id);
      assert.equal(result.receipt.publicationDigest, terminal.publicationDigest);
      assert.equal(catalogEntry(value.flowManager, value.scenario.specId, "draft.gate.repair"), null);
      const outcomeEntry = catalogEntry(value.flowManager, value.scenario.specId, "plan.gate.repair.outcome");
      assert.notEqual(outcomeEntry, null);
      const reloaded = new FlowManager({
        root: value.root, mainRoot: value.root, inWorktree: false, specId: value.scenario.specId,
      });
      const reloadedEntry = catalogEntry(reloaded, value.scenario.specId, "plan.gate.repair.outcome");
      const repairId = reloadedEntry.relativePath.match(/plan-gate-repairs\/([^/]+)\/outcome\.json$/)?.[1];
      const persisted = reloaded.readArtifact({
        specId: value.scenario.specId, logicalKey: "plan.gate.repair.outcome",
        parameters: { repairId }, consumerNodeId: "system",
      });
      assert.equal(JSON.parse(persisted.bytes).disposition, "rejected-no-progress");
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("replays a no-progress terminal handoff after cleanup interruption without reopening its Step", () => {
    const value = setup("521-gate-repair-no-progress-replay");
    try {
      const request = value.scenario.createRequest();
      const payload = value.scenario.replacement("goal", "Incomplete retained behavior");
      payload.operations = [];
      seal(request, payload);
      const preparation = value.scenario.coordinator.prepareDraftWorker({
        ctx: value.scenario.ctx,
        request,
      });
      const binding = new DraftWorkerStepBinding({ request });
      const stepResult = new DraftGateRepairCarryForwardResult();
      const settlement = settleDraftStepResult(stepResult.stepId, stepResult);
      const interrupted = new WorkerArtifactHandoffCoordinator({
        faultInjector({ phase }) {
          if (phase === "before-worker-handoff-cleanup-rename") throw new Error("retain terminal handoff");
        },
      });
      assert.throws(
        () => interrupted.commitDraftWorker({
          ctx: value.scenario.ctx,
          request,
          preparation,
          binding,
          stepResult,
          settlement,
        }),
        (error) => error.code === "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED",
      );
      const persisted = value.flowManager.canonicalState(value.scenario.specId)
        .findNode("draft-gate-repair").result.draftSettlementReceipt;
      const replay = value.scenario.coordinator.commitDraftWorker({
        ctx: value.scenario.ctx,
        request,
        preparation,
        binding,
        stepResult,
        settlement,
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.receipt.id, persisted.id);
      assert.equal(value.flowManager.canonicalState(value.scenario.specId)
        .findNode("draft-gate-repair").status, "done");
      assert.equal(fs.existsSync(request.directory), false);
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("rejects malformed or unauthorized batches without partial draft, audit, or outcome publication", () => {
    const variants = [
      ["wrong base revision", (payload) => { payload.baseRevision = `sha256:${"f".repeat(64)}`; }],
      ["foreign fingerprint", (payload) => { payload.report.results[0].fingerprint = "f".repeat(64); }],
      ["duplicate fingerprint", (payload) => { payload.report.results[1].fingerprint = payload.report.results[0].fingerprint; }],
      ["missing observation result", (payload) => { payload.report.results.pop(); }],
      ["missing target", (payload) => { payload.operations[0].path = "analysis.missing"; payload.operations[0].expectedDigest = "f".repeat(64); }],
      ["stale target digest", (payload) => { payload.operations[0].expectedDigest = "f".repeat(64); }],
      ["duplicate target", (payload) => { payload.operations.push(structuredClone(payload.operations[0])); }],
      ["overlapping targets", (payload, request) => {
        const draft = request.inputs.find((entry) => entry.name === "draft.json").document;
        payload.operations[0].path = "analysis";
        payload.operations[0].expectedDigest = digest(draft.analysis);
        payload.operations[0].replacement = { ...draft.analysis, problem: "Parent replacement" };
        payload.operations.push({
          ...structuredClone(payload.operations[0]),
          path: "analysis.problem",
          expectedDigest: digest(draft.analysis.problem),
          replacement: "Child replacement",
        });
      }],
      ["question authority", (payload, request) => {
        const draft = request.inputs.find((entry) => entry.name === "draft.json").document;
        payload.operations[0].path = "questionLedger";
        payload.operations[0].expectedDigest = digest(draft.questionLedger);
        payload.operations[0].replacement = structuredClone(draft.questionLedger);
      }],
      ["oversized replacement", (payload) => { payload.operations[0].replacement = "x".repeat((32 * 1024) + 1); }],
      ["invalid lifecycle", (payload, request) => {
        const draft = request.inputs.find((entry) => entry.name === "draft.json").document;
        payload.operations[0].path = "analysis";
        payload.operations[0].expectedDigest = digest(draft.analysis);
        payload.operations[0].replacement = null;
      }],
      ["unknown full draft field", (payload, request) => {
        payload.draft = request.inputs.find((entry) => entry.name === "draft.json").document;
      }],
      ["missing report strategy", (payload) => { payload.report.results[0].strategy = ""; }],
    ];
    for (const [name, mutate] of variants) {
      const value = setup(`521-invalid-${name.replaceAll(" ", "-")}`);
      try {
        const request = value.scenario.createRequest();
        const draftBefore = value.flowManager.readArtifact({
          specId: value.scenario.specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair",
        }).descriptor.hash;
        const payload = value.scenario.replacement("goal", "Retain the complete behavior explicitly.");
        mutate(payload, request);
        seal(request, payload);
        assert.throws(
          () => value.scenario.coordinator.prepareDraftWorker({ ctx: value.scenario.ctx, request }),
          (error) => ["FLOW_ARTIFACT_HANDOFF_INVALID", "FLOW_ARTIFACT_HANDOFF_STALE", "FLOW_PLAN_GATE_REPAIR_REPORT_INVALID", "FLOW_DRAFT_GATE_REPAIR_INVALID"].includes(error.code),
          name,
        );
        assert.equal(findStepById(value.flowManager.loadReadOnly(value.scenario.specId).steps, "draft-gate-repair").status, "in_progress", name);
        assertNoRepairPublication(value.flowManager, value.scenario.specId, draftBefore);
      } finally {
        removeTmpDir(value.root);
      }
    }
  });

  it("rejects an output whose actual canonical serialization exceeds the byte limit", () => {
    const source = canonicalDraftDocument({ goal: "Incomplete retained behavior", questions: [] });
    source.decisionMap.knownFacts = Array.from({ length: 260_000 }, () => "x");
    assert.ok(Buffer.byteLength(JSON.stringify(source)) < 2 * 1024 * 1024);
    assert.ok(Buffer.byteLength(`${JSON.stringify(source, null, 2)}\n`) > 2 * 1024 * 1024);
    const value = setup("521-gate-repair-pretty-size", { draftDocument: source, compactDraft: true });
    try {
      const request = value.scenario.createRequest();
      const draftBefore = value.flowManager.readArtifact({
        specId: value.scenario.specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair",
      }).descriptor.hash;
      seal(request, value.scenario.replacement("goal", "Retain the complete behavior explicitly."));
      assert.throws(
        () => value.scenario.coordinator.prepareDraftWorker({ ctx: value.scenario.ctx, request }),
        (error) => ["FLOW_ARTIFACT_HANDOFF_INVALID", "FLOW_PLAN_GATE_REPAIR_REPORT_INVALID", "FLOW_DRAFT_GATE_REPAIR_INVALID"].includes(error.code),
      );
      assert.equal(findStepById(value.flowManager.loadReadOnly(value.scenario.specId).steps, "draft-gate-repair").status, "in_progress");
      assertNoRepairPublication(value.flowManager, value.scenario.specId, draftBefore);
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("rejects a sealed request after the canonical draft revision changes", () => {
    const value = setup("521-gate-repair-stale-revision");
    try {
      const request = value.scenario.createRequest();
      const payload = value.scenario.replacement("goal", "Retain the complete behavior explicitly.");
      seal(request, payload);
      const replacement = canonicalDraftDocument({ goal: "A concurrent canonical revision", questions: [] });
      value.flowManager.publishArtifacts({
        specId: value.scenario.specId, nodeId: "draft-gate-repair", artifactWrites: [{
          logicalKey: "draft", mediaType: "application/json",
          bytes: Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`),
        }],
      });
      const concurrent = value.flowManager.readArtifact({
        specId: value.scenario.specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair",
      }).descriptor.hash;
      assert.throws(
        () => value.scenario.coordinator.prepareDraftWorker({ ctx: value.scenario.ctx, request }),
        (error) => error.code === "FLOW_ARTIFACT_HANDOFF_STALE",
      );
      assertNoRepairPublication(value.flowManager, value.scenario.specId, concurrent);
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("rejects a sealed request after its exact source issue evidence changes", () => {
    const value = setup("521-gate-repair-stale-evidence");
    try {
      const request = value.scenario.createRequest();
      seal(request, value.scenario.replacement("goal", "Retain the complete behavior explicitly."));
      const preparation = value.scenario.coordinator.prepareDraftWorker({
        ctx: value.scenario.ctx,
        request,
      });
      const source = value.flowManager.readArtifact({
        specId: value.scenario.specId, logicalKey: "issue.log", consumerNodeId: "draft-gate-repair",
      });
      const changed = JSON.parse(source.bytes);
      changed.entries[0].observations[0].observed = "Concurrent evidence no longer matches the selected repair.";
      value.flowManager.publishArtifacts({
        specId: value.scenario.specId, nodeId: "draft-gate-repair", artifactWrites: [{
          logicalKey: "issue.log", mediaType: "application/json",
          bytes: Buffer.from(`${JSON.stringify(changed, null, 2)}\n`),
        }],
      });
      const draftBefore = value.flowManager.readArtifact({
        specId: value.scenario.specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair",
      }).descriptor.hash;
      const before = {
        state: value.flowManager.canonicalState(value.scenario.specId).toJSON(),
        activities: value.flowManager.activityLedger(value.scenario.specId),
        catalog: value.flowManager.artifactCatalog(value.scenario.specId).toJSON(),
      };
      const binding = new DraftWorkerExecutionStepBinding({
        flowManager: value.flowManager,
        specId: value.scenario.specId,
        stepId: "draft-gate-repair",
      });
      const executionIdentity = value.flowManager.draftStepExecutionState({ binding }).executionIdentity();
      assert.throws(
        () => value.scenario.coordinator.publishDraftWorker({
          ctx: value.scenario.ctx,
          request,
          preparation,
          stepResult: executionIdentity.stepResult,
          settlement: executionIdentity.settlement,
          binding,
        }),
        /canonical plan gate repair source evidence changed or is missing/,
      );
      assert.deepEqual(value.flowManager.canonicalState(value.scenario.specId).toJSON(), before.state);
      assert.deepEqual(value.flowManager.activityLedger(value.scenario.specId), before.activities);
      assert.deepEqual(value.flowManager.artifactCatalog(value.scenario.specId).toJSON(), before.catalog);
      assertNoRepairPublication(value.flowManager, value.scenario.specId, draftBefore);
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("rejects a recurring observation report without prior-repair insufficiency", () => {
    const value = setup("521-gate-repair-recurrence");
    try {
      value.scenario.createRequest();
      value.scenario.apply(value.scenario.replacement(
        "goal", "Retain the complete behavior explicitly.",
        { strategy: "State the retained behavior in the goal" },
      ));
      value.fixture
        .settle("draft-coverage-review")
        .settle("draft-coverage-triage")
        .settle("draft-coverage-repair")
        .activate("draft-gate");
      const recurring = new DraftGateRepairScenario({
        flowManager: value.flowManager, root: value.root, specId: value.scenario.specId,
      }).select({ observations: observations(), issueLogId: "issue-521-gate-repair-recurrence-second" });
      const request = recurring.createRequest();
      const payload = recurring.replacement(
        "analysis.proposedApproach", "Check each retained behavior against its canonical evidence.",
        { strategy: "Trace each retained behavior to canonical evidence" },
      );
      assert.equal(payload.report.results.every((entry) => entry.priorRepairInsufficiency !== null), true);
      payload.report.results[0].priorRepairInsufficiency = null;
      const beforeCatalog = value.flowManager.artifactCatalog(value.scenario.specId);
      const before = {
        draft: value.flowManager.readArtifact({
          specId: value.scenario.specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair",
        }).descriptor.hash,
        audits: beforeCatalog.artifacts.filter((entry) => entry.logicalKey === "draft.gate.repair").length,
        outcomes: beforeCatalog.artifacts.filter((entry) => entry.logicalKey === "plan.gate.repair.outcome").length,
      };
      seal(request, payload);
      assert.throws(
        () => recurring.coordinator.prepareDraftWorker({ ctx: recurring.ctx, request }),
        (error) => error.code === "FLOW_ARTIFACT_HANDOFF_INVALID" || error.code === "FLOW_DRAFT_STEP_RESULT_REQUIRED",
      );
      const afterCatalog = value.flowManager.artifactCatalog(value.scenario.specId);
      assert.equal(value.flowManager.readArtifact({
        specId: value.scenario.specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair",
      }).descriptor.hash, before.draft);
      assert.equal(afterCatalog.artifacts.filter((entry) => entry.logicalKey === "draft.gate.repair").length, before.audits);
      assert.equal(afterCatalog.artifacts.filter((entry) => entry.logicalKey === "plan.gate.repair.outcome").length, before.outcomes);
    } finally {
      removeTmpDir(value.root);
    }
  });
});
