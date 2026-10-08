import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { RequirementTestPhaseScenario } from "./requirement-test-phase-scenario.js";
import RunFilterTaskReviewCommand from "../../src/flow/lib/run-filter-task-review.js";
import RunRetroCommand from "../../src/flow/lib/run-retro.js";
import { FLOW_COMMANDS } from "../../src/flow/registry.js";
import { CanonicalTestArtifactStore } from "../../src/flow/lib/canonical-test-artifacts.js";
import { StepResult } from "../../src/flow/engine/step-result.js";
import { TaskStepIdentity } from "../../src/flow/lib/task-step-identity.js";
import { assertImplPhaseResult, assertImplPhaseSettlementRoundtrip } from "./assertions/impl-phase-result.js";
import { DraftStepSettlementReceipt, TaskStageApplication } from "../../src/flow/definition.js";
import { ImplPhasePublicationObserver } from "./infrastructure/impl-phase-publication-observer.js";

export function implementationFinding({ taskId = null, key = "missing-behavior" } = {}) {
  return { findingKey: key, title: "Required behavior is missing", failureMode: "spec_behavior_contradiction",
    file: taskId ? `src/task-${taskId}.js` : "src/implementation.js", requirementId: "R1",
    issue: "A required behavior branch is missing.", suggestion: "Implement the missing branch.",
    disposition: "must-fix", rationale: "R1 requires the branch." };
}

function assertPhaseResults(scenario, nodeIds, terminal) {
  const state = scenario.manager.canonicalState(scenario.specId);
  const activities = scenario.manager.activityLedger(scenario.specId);
  for (const nodeId of nodeIds) {
    const node = state.findNode(nodeId);
    const all = activities.filter((entry) => entry.nodeId === nodeId && entry.result?.stepResult);
    assert.ok(all.length, `IMPL_PHASE_RESULT_MISSING: ${nodeId} production must persist concrete StepResult with its canonical publication and settlement receipt`);
    const results = all.filter((entry) => terminal
      ? entry.sequence === node.attemptSequence
        && (state.current?.at(-1) !== nodeId || entry.attemptId === state.attempt?.id)
        && ["target-connection", "failure"].includes(entry.result.draftSettlementReceipt?.settlementKind)
      : entry.result.draftSettlementReceipt?.settlementKind === "execution"
        && entry.attemptId === state.attempt?.id && entry.sequence === state.attempt?.sequence);
    assert.ok(results.length, terminal
      ? `IMPL_PHASE_TERMINAL_RESULT_MISSING: ${nodeId} completion cannot borrow a claim/checkpoint Result`
      : `IMPL_PHASE_CLAIM_RESULT_MISSING: ${nodeId} must save its actual nonterminal execution request`);
    const activity = results.at(-1);
    const fixedId = TaskStepIdentity.fromStateNode(state, nodeId)?.definitionId ?? nodeId;
    const stored = activity.result.stepResult;
    const result = StepResult.fromStored(fixedId, stored instanceof StepResult ? stored.toJSON() : stored);
    assertImplPhaseResult(result);
    const settlement = assertImplPhaseSettlementRoundtrip(result);
    const receipt = activity.result.draftSettlementReceipt;
    DraftStepSettlementReceipt.assertStored(receipt, { result, settlement, binding: {
      runId: state.runId, specId: state.specId, stepId: fixedId,
      attempt: { id: activity.attemptId, sequence: activity.sequence },
    } });
    const completionReference = node.status === "skipped" && node.result?.stepResult === null
      ? node.result.artifactRefs.find((entry) => entry.kind === "source-step-settlement") : null;
    if (completionReference) {
      assert.equal(node.result.outcome, "skipped");
      assert.equal(node.result.artifactRefs.length, 1);
      const source = activities.find((entry) => entry.result?.draftSettlementReceipt?.id === completionReference.id);
      assert.ok(source, "an unexecuted completion must reference its actual source receipt");
      const sourceFixedId = TaskStepIdentity.fromStateNode(state, source.nodeId)?.definitionId ?? source.nodeId;
      const sourceStored = source.result.stepResult;
      const sourceResult = StepResult.fromStored(sourceFixedId,
        sourceStored instanceof StepResult ? sourceStored.toJSON() : sourceStored);
      const sourceSettlement = assertImplPhaseSettlementRoundtrip(sourceResult);
      assert.ok(state.definition.contractForNode(node).authorizesUnexecutedCompletion(sourceResult));
      const completion = sourceSettlement.effects.unexecutedStepCompletions.find((entry) => entry.stepId === nodeId);
      assert.ok(completion, "the source's Result-only settlement must select this unexecuted recipient");
      assert.equal(node.attemptSequence, completion.attemptSequence);
      assert.equal(node.result.summary, completion.reason);
      assert.equal(node.result.confirmedAt, source.result.confirmedAt);
      assert.equal(node.result.draftSettlementReceipt, null);
      assert.equal(state.findNode(source.nodeId).status, "done");
      assert.equal(state.findNode(source.nodeId).result.outcome, "passed");
      assert.equal(state.findNode(source.nodeId).result.draftSettlementReceipt.id, completionReference.id);
      assert.ok(activity.confirmationOrder < source.confirmationOrder);
      assert.ok(activities.every((entry) => entry.nodeId !== nodeId || entry.confirmationOrder < source.confirmationOrder),
        "the source-linked completion must not fabricate a subsequent child Activity or Attempt");
      const sourceAuthentication = scenario.publicationObserver.authenticate(scenario.manager, source, sourceResult, sourceSettlement);
      const recipient = sourceAuthentication.afterState.findNode(nodeId);
      assert.equal(recipient.status, "skipped");
      assert.equal(recipient.attemptSequence, completion.attemptSequence);
      assert.equal(recipient.result.stepResult, null);
      assert.equal(recipient.result.draftSettlementReceipt, null);
      assert.deepEqual(recipient.result.toJSON(), node.result.toJSON());
    } else if (["done", "skipped"].includes(node.status)) {
      assert.ok(node.result?.stepResult, "the completed canonical NodeResult must own its terminal Result");
      assert.deepEqual(node.result.stepResult.toJSON(), result.toJSON());
      assert.equal(node.result.draftSettlementReceipt.id, receipt.id);
      assert.equal(node.attemptSequence, activity.sequence);
    }
    assert.ok(scenario.publicationObserver, "phase Results require actual observed saving inputs");
    const authenticated = scenario.publicationObserver.authenticate(scenario.manager, activity, result, settlement);
    assert.equal(authenticated.receipt.id, receipt.id);
    assert.equal(authenticated.receipt.publicationDigest, receipt.publicationDigest);
    if (terminal && settlement.kind === "target-connection") {
      const source = authenticated.afterState.findNode(nodeId);
      if (settlement.effects.resetStepIds.includes(nodeId)) {
        // A Task repair's selected Review loop invalidates the repair node in
        // this same transition. Its terminal proof belongs to the Activity;
        // keeping a completed NodeResult would contradict the declared reset.
        assert.ok(settlement.application instanceof TaskStageApplication);
        const plan = settlement.application.transition;
        assert.ok(plan.effects.some((effect) => effect.stepId === nodeId && effect.status === "invalidated"));
        assert.ok(plan.matches(authenticated.activity.transition.taskReviewStagePlan));
        assert.equal(source.status, "invalidated");
        assert.equal(source.result, null);
        assert.equal(source.attemptSequence, activity.sequence);
        assert.equal(authenticated.activity.attemptId, activity.attemptId);
        assert.equal(authenticated.activity.sequence, activity.sequence);
        assert.deepEqual(authenticated.activity.result.stepResult.toJSON(), result.toJSON());
        assert.equal(authenticated.activity.result.draftSettlementReceipt.id, receipt.id);
        assert.equal(authenticated.afterState.attempt.nodeId, plan.targetStepId);
        assert.notEqual(authenticated.afterState.attempt.id, activity.attemptId);
      } else {
        assert.ok(source.result?.stepResult, "the exact completion transition must save its own NodeResult");
        assert.deepEqual(source.result.stepResult.toJSON(), result.toJSON());
        assert.equal(source.result.draftSettlementReceipt.id, receipt.id);
      }
    } else if (settlement.kind === "failure") {
      assert.equal(authenticated.afterState.attempt.id, activity.attemptId);
      assert.ok(authenticated.afterState.attempt.failure, "the exact Error receipt must preserve its active failed Attempt");
    }
    if (settlement.kind === "target-connection") {
      assert.ok(receipt.connector && receipt.effects);
      const after = authenticated.afterState;
      assert.equal(after.current?.at(-1) ?? after.nextAction()?.nodeId, receipt.targetStepId,
        "the source's exact saved transition must activate or expose its selected target");
      if (settlement.connector.activateTarget === true) {
        assert.equal(activity.transition.attempt.nodeId, receipt.targetStepId);
        assert.equal(after.attempt.id, activity.transition.attempt.id);
        assert.equal(after.attempt.sequence, activity.transition.attempt.sequence);
      }
    } else {
      assert.equal(receipt.connector, null, "Execution/Await/Failure cannot manufacture a target Connector");
      assert.equal(receipt.targetStepId, null);
    }
    if (!terminal) {
      assert.equal(result.type, "loop-required");
      assert.equal(settlement.kind, "execution");
      assert.notEqual(node.status, "done");
    }
  }
}

/** The phase-02 fixture owns the upstream producer; this subclass only controls
 * external source workers and Review child processes. All publication, decisions,
 * filtering, dispatch, source manifests and downstream reads remain production. */
export class ImplPhaseScenario extends RequirementTestPhaseScenario {
  static publicationObserverOptions = {};
  static create(t, options = {}) {
    const scenario = new this({ autoApprove: true, continueImplementation: true,
      testSource: (id) => `// spec: ${id}\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport path from 'node:path';\ntest('${id}: required behavior', () => { assert.equal(fs.existsSync(path.join(process.cwd(), 'src/implementation.js')), true); });\n`,
      ...options });
    t.after(() => scenario.close());
    scenario.publicationObserver = new ImplPhasePublicationObserver(t, this.publicationObserverOptions);
    scenario.initialize();
    return scenario;
  }
  initialize() {
    super.initialize();
    this.phaseReviews = [];
    this.phaseWorkers = [];
    const parentSpawn = childProcess.spawnSync;
    this.phaseReviewProcess = mock.method(childProcess, "spawnSync", (command, args, options) => {
      if (command !== "node" || !String(args[0]).endsWith("/flow/commands/review.js")
        || !(options.env.SENNEL_REVIEW_TASK_EXECUTION_IDENTITY || this.current() === "impl-review")) {
        return parentSpawn(command, args, options);
      }
      const task = options.env.SENNEL_REVIEW_TASK_EXECUTION_IDENTITY
        ? JSON.parse(options.env.SENNEL_REVIEW_TASK_EXECUTION_IDENTITY) : null;
      const stage = task ? "task-review" : "impl-review";
      const ordinal = this.phaseReviews.filter((entry) => entry.stage === stage && entry.taskId === (task?.taskId ?? null)).length + 1;
      const response = this.options.implReviewResponse?.(stage, ordinal, options.env, this)
        ?? { blockingFindings: this.options.forceRepairs && ordinal === 1 ? [implementationFinding({ taskId: task?.taskId })] : [], nonBlockingImprovements: [] };
      this.phaseReviews.push({ stage, taskId: task?.taskId ?? null, ordinal, environment: structuredClone(options.env), response });
      this.options.beforeImplReview?.(options.env, this);
      if (this.options.reviewProcessResult) return this.options.reviewProcessResult(stage, ordinal, options, this, { command, args });
      const processResult = parentSpawn(process.execPath, [fileURLToPath(new URL("./impl-phase-review-worker.js", import.meta.url))], {
        ...options, env: { ...options.env, SENNEL_IMPL_SCENARIO_RESPONSE: JSON.stringify(response) },
      });
      this.phaseReviews.at(-1).process = { status: processResult.status, stderr: processResult.stderr };
      return processResult;
    });
    syncBuiltinESMExports();
  }
  async worker(prompt, options) {
    const request = JSON.parse(fs.readFileSync(options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST, "utf8"));
    if (!["implement", "task-impl", "task-triage", "task-repair", "impl-triage", "impl-repair"].includes(request.stepId)) return super.worker(prompt, options);
    this.requests.push(request);
    this.phaseWorkers.push(request);
    if (request.stepId === "implement") this.implementationInput = request.inputs.find((entry) => entry.name === "spec.json");
    const custom = await this.options.sourceWorker?.(request, this);
    if (custom !== undefined) return typeof custom === "string" ? custom : JSON.stringify(custom);
    const taskId = request.taskId;
    const file = taskId ? `src/task-${taskId}.js` : "src/implementation.js";
    const effect = { version: 1, stepId: request.stepId, completionStatus: "done", issues: [],
      overview: request.stepId === "task-impl" ? { modules: ["Behavior"], data_flow: [], decisions: [] } : null,
      triage: null, repair: null, noChangeReason: null };
    if (["implement", "task-impl"].includes(request.stepId)) {
      fs.mkdirSync(path.join(this.root, "src"), { recursive: true });
      fs.writeFileSync(path.join(this.root, file), "export const implemented = true;\n");
    } else {
      const review = request.inputs.find((entry) => entry.name === (taskId ? "task-review.json" : "impl-review.json"))?.document;
      const findings = [...(review?.blockingFindings ?? []), ...(review?.nonBlockingImprovements ?? [])];
      if (request.stepId.endsWith("triage")) {
        effect.triage = { version: 1, dispositions: findings.map((entry) => ({ findingKey: entry.findingKey,
          disposition: "apply", basis: "repair-required", rationale: "Implement the required behavior." })) };
      } else {
        const recurrence = request.inputs.find((entry) => entry.name === (taskId ? "task-review-recurrence.json" : "impl-review-recurrence.json"))?.document;
        if (findings.length) fs.appendFileSync(path.join(this.root, file), `// correction ${this.phaseWorkers.length}\n`);
        effect.repair = { version: 1, findings: findings.map((entry) => ({ findingKey: entry.findingKey, paths: [file] })),
          summary: "Applied selected behavior corrections.", recurrenceResolutions: (recurrence?.entries ?? []).map(({ findingKey, fingerprint }) => ({
            findingKey, fingerprint, priorRepairInsufficiency: "The previous correction omitted this exact branch.", repairStrategy: "Preserve prior behavior and add the omitted branch.",
          })) };
      }
    }
    return JSON.stringify(this.options.sourceEffect?.(effect, request, this) ?? effect);
  }
  state() { return this.manager.canonicalState(this.specId); }
  async executeCurrent() {
    const task = TaskStepIdentity.fromStateNode(this.state(), this.current());
    if (task?.role !== "triage") return this.dispatch();
    const next = await this.next();
    if (next.action !== "filter-task-review") return this.dispatch();
    const binding = next.context.taskReviewFilter;
    return new RunFilterTaskReviewCommand().execute({ ...this.context(), exclusions: JSON.stringify(this.options.exclusions ?? []),
      expectAttemptId: binding.attemptId, expectReviewDigest: binding.reviewDigest,
      expectSourceFingerprint: binding.sourceFingerprint, expectCatalogFingerprint: binding.catalogFingerprint });
  }
  async advanceTo(stepId, limit = 64) {
    for (let index = 0; index < limit; index += 1) {
      if (this.state().current?.at(-1) === stepId) return this;
      const outcome = await this.executeCurrent();
      this.reload();
      if (this.state().current?.at(-1) === stepId) return this;
      const next = await this.next();
      assert.ok(!["blocked", "await_user_decision", "await_draft_question"].includes(next.directive?.kind),
        `IMPL_PHASE_ENTRY_BLOCKED: normal producer cannot reach ${stepId}; current=${this.current()}; ${JSON.stringify({
          directive: next.directive, outcome, attempt: this.state().attempt?.toJSON() ?? null,
        })}`);
      assert.ok(outcome.ok !== false || outcome.errors?.every((entry) => entry.code === "FLOW_DISPATCH_LIMIT_REACHED"),
        `normal producer must reach ${stepId}; current=${this.current()}; errors=${JSON.stringify(outcome.errors)}`);
    }
    assert.fail(`normal dispatcher did not reach ${stepId}; current=${this.current()}`);
  }
  commandArtifact(logicalKey, consumerNodeId = this.current()) {
    return new CanonicalTestArtifactStore({ flowManager: this.manager, state: this.manager.loadReadOnly(this.specId) })
      .readCurrentAttempt({ logicalKey, consumerNodeId });
  }
  async consumeRetro() {
    await this.advanceTo("retro");
    this.reload();
    const ctx = { ...this.context(), phase: "retro" };
    const result = await new RunRetroCommand().execute(ctx);
    assert.equal(result.result, "ok", JSON.stringify(result));
    await FLOW_COMMANDS.run.retro.post(ctx, result);
    this.reload();
    return result;
  }
  assertResults(nodeIds) { return assertPhaseResults(this, nodeIds, true); }
  assertClaims(nodeIds) { return assertPhaseResults(this, nodeIds, false); }
  close() { this.phaseReviewProcess?.mock.restore(); super.close(); }
}
