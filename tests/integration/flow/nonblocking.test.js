import { CURRENT_FLOW_SCHEMA_REVISION } from "../../../src/lib/flow-schema-revision.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowArtifactAttemptHistory, FlowArtifactAttemptRecord } from "../../../src/lib/flow-artifact-contract.js";
import { CurrentFlowPolicy, CurrentFlowNonBlockingPolicy, ActivityTransition, ActivityNonBlockingRecord, CurrentFlowStateInvariantError } from "../../../src/flow/lib/current-flow-state.js";
import { CurrentFlowStateConflictError } from "../../../src/flow/lib/current-flow-state-conflict-error.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";
import { CanonicalFlowRuntime } from "../../../src/flow/lib/canonical-flow-runtime.js";
import { CanonicalFlowManagerStore } from "../../../src/flow/lib/canonical-flow-manager-store.js";
import {
  NonBlockingPolicy,
  NonBlockingEvidenceError,
  advisorySummary,
  activateNonBlockingPolicy,
  definitionNonblockingEligibilityForActiveFlow,
  decisionContextForActiveFlow,
  decisionEvidenceForActiveFlow,
  recordNonBlockingDecision,
} from "../../../src/flow/lib/nonblocking.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { fromAcceptanceResult, fromFinalRegressionResult, fromGateResult, fromReviewResult, fromVerificationResult } from "../../../src/flow/lib/nonblocking-evidence.js";
import { CanonicalAcceptanceArtifactStore } from "../../../src/flow/lib/canonical-acceptance-artifacts.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunDispatchCommand, { FlowDispatchAction } from "../../../src/flow/lib/run-dispatch.js";
import { ImplPhaseScenario } from "../../support/impl-phase-scenario.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { ImplementationReviewProducer } from "../../support/infrastructure/implementation-review-producer.js";
import RunGateCommand from "../../../src/flow/lib/run-gate.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { container } from "../../../src/lib/container.js";
import { CanonicalCommandAttemptArtifactHistory } from "../../../src/flow/lib/canonical-command-result.js";
import { canonicalSourceFindings } from "../../../src/flow/lib/flow-finding-source.js";
import RunRetroCommand from "../../../src/flow/lib/run-retro.js";
import RunAcceptanceReviewCommand, { AcceptanceReviewResponseSource } from "../../../src/flow/lib/run-acceptance-review.js";

async function scenario(t, { step = "impl-gate", payload = null, mixedGateFindings = false, passOnly = false } = {}) {
  if (payload !== null && !["retro", "acceptance-review"].includes(step)) return malformedReviewScenario(t, payload);
  const phase = ImplPhaseScenario.create(t, {
    ...(mixedGateFindings ? { requirements: [
      { id: "R1", desc: "Implement the required behavior.", task_ids: ["T1"], preimplementation_test_expectation: "fail" },
      { id: "R2", desc: "Preserve the independent behavior.", task_ids: ["T1"], preimplementation_test_expectation: "fail" },
    ] } : {}),
    ...(step === "retro" ? { testSource: (id) => `// spec: ${id}\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('${id}: unresolved requirement', () => assert.fail('The required behavior remains unproved.'));\n` } : {}),
    gateResponse(_prompt, options, current) {
    if (current.current() !== "impl-gate" || step !== "impl-gate") return null;
    if (!(options.jsonSchema?.required ?? []).includes("evaluations")) return null;
    const ids = options.jsonSchema.properties.evaluations.items.properties.guardrail_id.enum;
    return JSON.stringify({ evaluations: ids.map((guardrail_id) => ({ guardrail_id,
      result: mixedGateFindings && guardrail_id === "R2" ? "pass" : "fail",
      reason: mixedGateFindings && guardrail_id === "R2" ? "This independently mapped requirement is satisfied."
        : `[REQ:${guardrail_id}] Evaluation ${current.state().attempt.sequence} identifies an omitted behavior branch.` })) });
  } });
  if (step === "impl-gate") {
    const config = path.join(phase.root, ".sennel/guardrail.json");
    const document = JSON.parse(fs.readFileSync(config, "utf8"));
    document.guardrails.push({ id: "R1", title: "Current implementation behavior", body: "The mapped behavior must be implemented.",
      meta: { phase: ["integration"], category: "requirements" } });
    fs.writeFileSync(config, JSON.stringify(document));
  }
  await phase.advanceTo(step);
  const { root, manager, specId } = phase;
  const fixture = { specId, runId: phase.state().runId };
  if (step === "impl-gate" && !passOnly) {
    const limit = phase.state().definition.contractForNode(phase.state().findNode("impl-gate")).semanticRetryLimit + 2;
    let stop = null;
    for (let index = 0; index < limit; index += 1) {
      const ctx = { ...phase.context(), phase: "integration" };
      await FLOW_COMMANDS.run.gate.pre(ctx);
      const outcome = await new RunGateCommand().execute(ctx);
      await FLOW_COMMANDS.run.gate.post(ctx, outcome);
      phase.reload();
      assert.equal(outcome.result, "fail", JSON.stringify(outcome));
      if (ctx.gateTransitionDecision.disposition.operation === "defer") {
        stop = phase.manager.readCurrentStepSettlement({ specId, stepId: "impl-gate" });
        break;
      }
      assert.equal(ctx.gateTransitionDecision.disposition.operation, "retry");
      assert.equal(phase.state().attempt.nodeId, "impl-gate");
    }
    assert.ok(stop, "actual registered Gate evaluations must exhaust the semantic retry budget");
    assert.equal(stop.result.kind, "impl-gate-semantic-failure");
    assert.equal(stop.settlement.application.decision.disposition.operation, "defer");
  } else if (step === "retro") {
    const outcome = await new RunRetroCommand().execute(phase.context());
    assert.ok(outcome.artifacts.summary.not_done > 0, JSON.stringify(outcome));
    manager.publishCurrentAttemptResult({ specId, commandResult: outcome });
  } else if (step === "acceptance-review") {
    const outcome = await new RunAcceptanceReviewCommand({ responseSource: new InconclusiveAcceptanceResponse() })
      .execute(phase.context());
    assert.equal(outcome.verdict, "user_decision_required", JSON.stringify(outcome));
    manager.publishCurrentAttemptResult({ specId, commandResult: outcome });
  }
  return { root, manager, fixture, phase };
}

class InconclusiveAcceptanceResponse extends AcceptanceReviewResponseSource {
  load(context) {
    return { requirementJudgments: context.requirementIds.map((requirementId) => ({ requirementId,
      status: "notVerifiable", requestRefs: ["flow.request"], requirementRefs: [`spec.json#${requirementId}`],
      diffRefs: [], repairRefs: [context.evidence.repairEvidence.ref], testRefs: [],
      missingEvidence: ["Independent acceptance cannot certify the requested behavior from this evidence."] })),
      deferredFindingDispositions: [] };
  }
}

async function malformedReviewScenario(t, payload) {
  const phase = ImplPhaseScenario.create(t);
  await phase.advanceTo("impl-review");
  const { root, manager, specId } = phase;
  const candidate = new FlowArtifactAttemptHistory([new FlowArtifactAttemptRecord({
    attempt: phase.state().attempt.sequence, payload: { artifact: { logicalKey: "impl.review", payload } },
  })]);
  manager.publishArtifacts({ specId, nodeId: "impl-review", artifactWrites: [{ logicalKey: "impl.review",
    mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(candidate.toJSON())}\n`) }] });
  return { root, manager, fixture: { specId, runId: phase.state().runId }, phase };
}

async function taskScenario(t, step = "review", { failureKind = "mechanical", nextTask = false, reviewTooling = false, rejectPublication = false } = {}) {
  if (reviewTooling) return toolingReviewScenario(t);
  const phase = nextTask ? await mappedTaskScenario(t, failureKind) : new TaskReviewScenario(t,
    step === "gate" && failureKind === "mechanical" ? { implementationContent: "x".repeat(1024 * 1024 + 64) } : {});
  const { root, manager, specId } = phase;
  const fixture = { specId, runId: phase.state().runId };
  if (step === "review") {
    const outcome = await phase.review(() => { const error = new Error("external Review invocation failed before provider start");
      error.code = "EIO"; throw error; }).execute(phase.context());
    assert.equal(outcome.ok, false);
    assert.ok(phase.state().attempt.failure, JSON.stringify(outcome));
    return { root, manager, fixture, phase };
  }
  assert.notEqual((await new ImplementationReviewProducer().publish(phase.context())).ok, false);
  const originalGet = container.get.bind(container);
  container.get = (key) => key !== "agent" ? originalGet(key) : {
    resolve: () => failureKind !== "provider",
    call: async (_prompt, options) => {
      if (!(options.jsonSchema?.required ?? []).includes("evaluations")) return JSON.stringify({ observations: [] });
      const ids = options.jsonSchema.properties.evaluations.items.properties.guardrail_id.enum;
      return JSON.stringify({ evaluations: ids.map((guardrail_id) => ({ guardrail_id, result: "fail",
        reason: `[REQ:${guardrail_id}] The mapped behavior contradicts the current source.` })) });
    },
  };
  let publicationSnapshot = null;
  try {
    const ctx = { ...phase.context(), phase: "task-impl", skipGuardrail: failureKind !== "mechanical" };
    await FLOW_COMMANDS.run.gate.pre(ctx);
    const outcome = await new RunGateCommand().execute(ctx);
    if (rejectPublication) {
      publicationSnapshot = phase.snapshot();
      const catalogFile = manager.specLocation(specId).catalogFile;
      let injected = false;
      const rejected = new FlowManager({ root, mainRoot: root, inWorktree: false,
        versionStoreFaultInjector({ phase: point, filePath }) {
          if (!injected && point === "before-json-rename" && filePath === catalogFile) {
            injected = true;
            throw new Error("Task Gate publication refused before catalog rename");
          }
        } });
      await assert.rejects(() => FLOW_COMMANDS.run.gate.post({ ...ctx, flowManager: rejected }, outcome), /before catalog rename/);
      assert.equal(injected, true);
      assert.equal(phase.reload().snapshot(), publicationSnapshot);
    } else await FLOW_COMMANDS.run.gate.post(ctx, outcome);
    assert.equal(outcome.result, "fail", JSON.stringify(outcome));
  } finally { container.get = originalGet; }
  phase.reload();
  const saved = manager.readCurrentStepSettlement({ specId, stepId: "task-gate" });
  assert.ok(saved);
  if (!rejectPublication && failureKind === "mechanical") {
    assert.equal(saved.result.type, "error");
    assert.equal(saved.result.error.data.evidence.failure.category, "local");
    assert.equal(saved.result.error.data.evidence.failure.code, "GATE_LOCAL_INPUT_INVALID");
    assert.equal(saved.receipt.binding.attemptId, phase.state().attempt.id);
    assert.equal(saved.receipt.binding.attemptSequence, phase.state().attempt.sequence);
  }
  return { root, manager, fixture, phase, publicationSnapshot };
}

async function mappedTaskScenario(t, failureKind) {
  const ids = ["T-1", "T-2"];
  const phase = ImplPhaseScenario.create(t, {
    tasks: ids.map((id) => ({ id, title: `Implement ${id}`, goal: "Implement R1", origin: "plan", added_round: 0, status: "pending" })),
    requirements: [{ id: "R1", desc: "Implement observable behavior.", task_ids: ids, preimplementation_test_expectation: "fail" }],
    sourceEffect(effect, request, current) {
      if (failureKind === "mechanical" && request.stepId === "task-impl" && request.taskId === "T-1") {
        fs.writeFileSync(path.join(current.root, "src/task-T-1.js"), "x".repeat(1024 * 1024 + 64));
      }
      return effect;
    },
  });
  await phase.advanceTo("T-1-review");
  return phase;
}

async function toolingReviewScenario(t) {
  const phase = ImplPhaseScenario.create(t, { reviewProcessResult(stage, _ordinal, options) {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL(stage === "impl-review"
      ? "../../support/infrastructure/impl-tooling-review-worker.js" : "../../support/impl-phase-review-worker.js", import.meta.url))],
      stage === "impl-review" ? options : { ...options, env: { ...options.env,
        SENNEL_IMPL_SCENARIO_RESPONSE: JSON.stringify({ blockingFindings: [], nonBlockingImprovements: [] }) } });
    return { ...child, ok: child.status === 0 };
  } });
  fs.writeFileSync(path.join(phase.root, ".sennel/config.json"), JSON.stringify({ lang: "en", type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" } }));
  await phase.advanceTo("impl-review");
  await phase.executeCurrent();
  phase.reload();
  assert.equal(phase.manager.readCurrentStepSettlement({ specId: phase.specId, stepId: "impl-review" }).result.kind, "impl-review-tooling");
  return { root: phase.root, manager: phase.manager, fixture: { specId: phase.specId, runId: phase.state().runId }, phase };
}

function raceCanonicalNonblockingCommit({ manager, fixture, invoke, method, registeredContinuation = false }) {
  const original = CanonicalFlowRuntime.prototype[method];
  let injected = false;
  CanonicalFlowRuntime.prototype[method] = function (...args) {
    if (!injected) {
      injected = true;
      new FlowManager({
        root: manager.executionRoot(), mainRoot: manager.executionRoot(), inWorktree: false,
      })
        .appendMetric({ phase: "impl", counter: "reviewRetries", delta: 1 }, { specId: fixture.specId });
    }
    return original.apply(this, args);
  };
  try {
    assert.throws(invoke, (error) => registeredContinuation
      ? error instanceof StepAdmissionRefusal && error.cause instanceof CurrentFlowStateConflictError
        && error.cause.code === "CURRENT_FLOW_STATE_CONFLICT"
        && error.message === "saved Gate continuation source changed before publication"
        && error.cause.message === "saved Gate continuation source changed before publication"
      : error instanceof CurrentFlowStateConflictError && error.code === "CURRENT_FLOW_STATE_CONFLICT"
        && error.message === "nonblocking Definition selection changed before commit");
  } finally {
    CanonicalFlowRuntime.prototype[method] = original;
  }
  assert.equal(injected, true);
}

describe("canonical nonblocking policy", () => {
  for (const [step, payload] of [
    ["retro", { summary: { not_done: 1 } }],
    ["acceptance-review", { verdict: "blocked" }],
  ]) {
    it(`uses Definition-owned acceptance boundary eligibility for ${step}`, async (t) => {
      const { root, manager, fixture } = await scenario(t, { step, payload });
      try {
        const policy = activateNonBlockingPolicy({
          root, flowManager: manager, reason: `${step} requires explicit acceptance disposition.`,
        });
        assert.equal(policy.activatedStep, step);
        assert.equal(decisionContextForActiveFlow(root, manager.load(fixture.specId), manager).resultKind, "quality");
      } finally { removeTmpDir(root); }
    });
  }

  it("keeps activation, evidence identity, and decision in the V1 policy and Activity ledger", async (t) => {
    const { root, manager, fixture } = await scenario(t);
    try {
      const commandContext = () => ({
        root, mainRoot: root, executionRoot: root, specId: fixture.specId,
        flowManager: manager, flowState: manager.load(fixture.specId),
      });
      const strict = await new GetNextActionCommand().execute(commandContext());
      assert.deepEqual(
        strict.directive.actionPrompt.choices.map((choice) => choice.actionId),
        ["KEEP_STRICT_FLOW", "ENABLE_NONBLOCKING"],
      );
      const policy = activateNonBlockingPolicy({
        root,
        flowManager: manager,
        reason: "The canonical Gate requires an explicit acceptance decision.",
      });
      assert.equal(policy.enabled, true);
      assert.equal(policy.activatedStep, "impl-gate");
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      const enabled = await new GetNextActionCommand().execute(commandContext());
      assert.deepEqual(enabled.nonblockingDecision, context.toJSON());
      assert.deepEqual(context.allowedActions, ["repair", "continue"]);
      const recorded = recordNonBlockingDecision({
        root,
        flowManager: manager,
        choice: "continue",
        reason: "The requested behavior is complete despite the Gate result.",
        remainingRisk: "Acceptance retains the rejected Gate as durable evidence.",
        expectEvidenceDigest: context.evidenceDigest,
      });
      assert.equal(recorded.action, "continue");
      const state = manager.load(fixture.specId);
      const activities = manager.activityLedger(fixture.specId);
      assert.equal(state.policy.nonblocking.activatedStep, "impl-gate");
      const activation = activities.find((activity) => activity.transition.operation === "activate_nonblocking");
      assert.equal(activation.type, "policy_updated");
      assert.equal(activation.transition.nonblocking.kind, "observation");
      assert.equal(activities.filter((activity) => activity.type === "nonblocking_recorded").length, 1);
      assert.equal(activities.at(-1).transition.nonblocking.action, "continue");
    } finally {
      removeTmpDir(root);
    }
  });

  it("recovers atomic activation and repair after a journal-first restart", async (t) => {
    const { root, manager, fixture } = await scenario(t);
    try {
      let crash = true;
      const crashingManager = new FlowManager({
        root, mainRoot: root, inWorktree: false,
        versionStoreFaultInjector({ phase }) {
          if (crash && phase === "activity-appended") throw new Error("simulated journal-first crash");
        },
      });
      assert.throws(() => activateNonBlockingPolicy({
        root,
        flowManager: crashingManager,
        reason: "The Gate remains acceptance-backed.",
      }), /simulated journal-first crash/);
      crash = false;
      const restartedManager = new FlowManager({ root, mainRoot: root, inWorktree: false });
      const policy = activateNonBlockingPolicy({
        root,
        flowManager: restartedManager,
        reason: "The Gate remains acceptance-backed.",
      });
      assert.equal(policy.enabled, true);
      assert.equal(restartedManager.activityLedger(fixture.specId)
        .filter((activity) => activity.transition.operation === "activate_nonblocking").length, 1);

      const context = decisionContextForActiveFlow(root, restartedManager.load(fixture.specId), restartedManager);
      crash = true;
      const resumedManagerCatalog = restartedManager.specLocation(fixture.specId).catalogFile;
      const crashingDecisionManager = new FlowManager({
        root, mainRoot: root, inWorktree: false,
        versionStoreFaultInjector({ phase, filePath }) {
          if (crash && phase === "before-json-rename" && filePath === resumedManagerCatalog) throw new Error("simulated decision crash");
        },
      });
      const input = {
        root,
        choice: "repair",
        reason: "Repair the rejected integration Gate.",
        expectEvidenceDigest: context.evidenceDigest,
        expectIdentity: context.identity().toJSON(),
      };
      assert.throws(() => recordNonBlockingDecision({ ...input, flowManager: crashingDecisionManager }),
        /simulated decision crash/);
      crash = false;
      const resumedManager = new FlowManager({ root, mainRoot: root, inWorktree: false });
      const replay = recordNonBlockingDecision({ ...input, flowManager: resumedManager });
      assert.equal(replay.action, "repair");
      const state = resumedManager.load(fixture.specId);
      assert.equal(state.currentNodeId, "impl-gate");
      assert.equal(resumedManager.canonicalState(fixture.specId).attempt.sequence, context.sourceAttempt + 1);
      assert.equal(resumedManager.canonicalState(fixture.specId).attempt.failure, null);
      assert.equal(resumedManager.activityLedger(fixture.specId)
        .filter((activity) => activity.transition.nonblocking?.kind === "decision").length, 1);
      assert.equal(new FlowManager({ root, mainRoot: root, inWorktree: false })
        .canonicalState(fixture.specId).attempt.sequence, context.sourceAttempt + 1);
    } finally {
      removeTmpDir(root);
    }
  });

  it("rejects direct Store mutations whose full evidence identity is not current", async (t) => {
    const { root, manager, fixture } = await scenario(t);
    try {
      activateNonBlockingPolicy({
        root, flowManager: manager, reason: "The Gate remains acceptance-backed.",
      });
      const state = manager.load(fixture.specId);
      const context = decisionContextForActiveFlow(root, state, manager);
      const eligibility = definitionNonblockingEligibilityForActiveFlow(root, state, manager);
      const observation = manager.activityLedger(fixture.specId)
        .find((activity) => activity.transition.operation === "activate_nonblocking")
        .transition.nonblocking;
      const policy = state.policy.nonblocking;
      const before = JSON.stringify({ state: manager.canonicalState(fixture.specId),
        activities: manager.activityLedger(fixture.specId), catalog: manager.artifactCatalog(fixture.specId) });
      for (const mutation of [
        { sourceStep: "spec-gate" },
        { sourceAttempt: context.sourceAttempt + 1 },
        { evidenceRef: "steps/impl-review/other.json" },
        { evidenceDigest: "a".repeat(64) },
        { resultKind: "tooling" },
        { definitionDigest: "b".repeat(64) },
      ]) {
        const mismatchedObservation = new ActivityNonBlockingRecord({
          ...observation,
          ...mutation,
        });
        assert.throws(() => manager.activateNonblockingPolicy({
          specId: fixture.specId,
          policy,
          observation: mismatchedObservation,
          eligibility,
        }), (error) => error instanceof CurrentFlowStateInvariantError
          && error.code === "CURRENT_FLOW_STATE_INVARIANT_INVALID");
        assert.equal(JSON.stringify({ state: manager.canonicalState(fixture.specId),
          activities: manager.activityLedger(fixture.specId), catalog: manager.artifactCatalog(fixture.specId) }), before);
        const mismatchedDecision = new ActivityNonBlockingRecord({
          kind: "decision",
          sourceStep: context.sourceStep,
          sourceAttempt: context.sourceAttempt,
          evidenceRef: context.evidenceRef,
          evidenceDigest: context.evidenceDigest,
          definitionDigest: context.definitionDigest,
          resultKind: context.resultKind,
          action: "continue",
          rationale: "Direct boundary mismatch test.",
          remainingRisk: "The canonical evidence remains unresolved.",
          ...mutation,
        });
        assert.throws(() => manager.applyNonblockingDecision({
          specId: fixture.specId,
          nodeId: "impl-gate",
          record: mismatchedDecision,
          eligibility,
        }), (error) => mutation.sourceStep === "spec-gate"
          ? error instanceof CurrentFlowStateInvariantError && error.code === "CURRENT_FLOW_STATE_INVARIANT_INVALID"
          : Object.keys(mutation).some((key) => ["sourceAttempt", "evidenceRef", "evidenceDigest"].includes(key))
            ? error instanceof NonBlockingEvidenceError && error.code === "NONBLOCKING_STALE_EVIDENCE"
              && error.message === "nonblocking mutation does not match the current Definition-selected evidence identity"
            : error instanceof CurrentFlowStateConflictError && error.code === "CURRENT_FLOW_STATE_CONFLICT");
        assert.equal(JSON.stringify({ state: manager.canonicalState(fixture.specId),
          activities: manager.activityLedger(fixture.specId), catalog: manager.artifactCatalog(fixture.specId) }), before);
        for (const logicalKey of ["nonblocking.handoffs", "flow.findings"]) {
          assert.equal(manager.readArtifact({ specId: fixture.specId, logicalKey,
            consumerNodeId: "acceptance-review", optional: true }), null);
        }
      }
    } finally { removeTmpDir(root); }
  });

  it("revalidates activation and every advisory effect inside the Version transaction", async (t) => {


    {
      const { root, manager, fixture } = await scenario(t);
      try {
        raceCanonicalNonblockingCommit({
          manager,
          fixture,
          method: "activateNonblockingPolicy",
          invoke: () => activateNonBlockingPolicy({
            root, flowManager: manager, reason: "Activation must retain its exact selection.",
          }),
        });
        assert.equal(manager.load(fixture.specId).policy.nonblocking, null);
        assert.equal(manager.activityLedger(fixture.specId)
          .some((activity) => activity.transition.operation === "activate_nonblocking"), false);
      } finally { removeTmpDir(root); }
    }

    for (const choice of ["repair", "continue"]) {
      const { root, manager, fixture } = await scenario(t);
      try {
        activateNonBlockingPolicy({ root, flowManager: manager, reason: "Gate evidence is bounded." });
        const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
        raceCanonicalNonblockingCommit({
          manager,
          fixture,
          method: "continueNonblocking",
          registeredContinuation: choice === "continue",
          invoke: () => recordNonBlockingDecision({
            root, flowManager: manager, choice,
            reason: `${choice} must retain its exact selection.`,
            remainingRisk: choice === "continue" ? "The Gate evidence remains unresolved." : null,
            expectEvidenceDigest: context.evidenceDigest,
            expectIdentity: context.identity().toJSON(),
          }),
        });
        assert.equal(manager.activityLedger(fixture.specId)
          .some((activity) => activity.transition.nonblocking?.kind === "decision"), false);
      } finally { removeTmpDir(root); }
    }

    {
      const { root, manager, fixture } = await taskScenario(t, "review", { reviewTooling: true });
      try {
        activateNonBlockingPolicy({ root, flowManager: manager, reason: "Task Review tooling is unavailable." });
        const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
        raceCanonicalNonblockingCommit({
          manager,
          fixture,
          method: "continueNonblocking",
          invoke: () => recordNonBlockingDecision({
            root, flowManager: manager, choice: "retry",
            reason: "Retry must retain its exact Task selection.",
            expectEvidenceDigest: context.evidenceDigest,
            expectIdentity: context.identity().toJSON(),
          }),
        });
        assert.equal(manager.activityLedger(fixture.specId)
          .some((activity) => activity.transition.nonblocking?.kind === "decision"), false);
      } finally { removeTmpDir(root); }
    }
  });

  it("derives activation policy and admission from one canonical transition snapshot", async (t) => {
    const { root, manager, fixture } = await scenario(t);
    manager.setAutoApprove(false, { specId: fixture.specId });
    const original = CanonicalFlowManagerStore.prototype.readCanonicalTransitionSnapshot;
    let injected = false;
    CanonicalFlowManagerStore.prototype.readCanonicalTransitionSnapshot = function (specId) {
      if (!injected) {
        injected = true;
        new FlowManager({ root, mainRoot: root, inWorktree: false })
          .setAutoApprove(true, { specId: fixture.specId });
      }
      return original.call(this, specId);
    };
    try {
      activateNonBlockingPolicy({
        root, flowManager: manager, reason: "Activation must preserve the snapshot policy.",
      });
    } finally {
      CanonicalFlowManagerStore.prototype.readCanonicalTransitionSnapshot = original;
    }
    try {
      assert.equal(injected, true);
      const state = manager.canonicalState(fixture.specId);
      assert.equal(state.policy.autoApprove, true);
      assert.equal(state.policy.nonblocking.enabled, true);
      const activation = manager.activityLedger(fixture.specId)
        .find((activity) => activity.transition.operation === "activate_nonblocking");
      assert.equal(activation.transition.policy.autoApprove, true);
    } finally { removeTmpDir(root); }
  });

  it("derives a decision effect and replacement Attempt from one canonical transition snapshot", async (t) => {
    const { root, manager, fixture } = await scenario(t);
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Gate evidence is bounded." });
      const state = manager.load(fixture.specId);
      const context = decisionContextForActiveFlow(root, state, manager);
      const eligibility = definitionNonblockingEligibilityForActiveFlow(root, state, manager);
      const record = new ActivityNonBlockingRecord({
        kind: "decision",
        sourceStep: context.sourceStep,
        sourceAttempt: context.sourceAttempt,
        evidenceRef: context.evidenceRef,
        evidenceDigest: context.evidenceDigest,
        definitionDigest: context.definitionDigest,
        resultKind: context.resultKind,
        action: "repair",
        rationale: "Repair the exact rejected Gate Attempt.",
        remainingRisk: null,
      });
      const originalLoad = CanonicalFlowRuntime.prototype.load;
      const originalSnapshot = CanonicalFlowManagerStore.prototype.readCanonicalTransitionSnapshot;
      let snapshotStarted = false;
      let competingDecisionInjected = false;
      CanonicalFlowManagerStore.prototype.readCanonicalTransitionSnapshot = function (specId) {
        snapshotStarted = true;
        return originalSnapshot.call(this, specId);
      };
      CanonicalFlowRuntime.prototype.load = function (specId) {
        const stale = originalLoad.call(this, specId);
        if (!snapshotStarted && !competingDecisionInjected) {
          competingDecisionInjected = true;
          new FlowManager({ root, mainRoot: root, inWorktree: false }).applyNonblockingDecision({
            specId: fixture.specId,
            nodeId: "impl-gate",
            record,
            eligibility,
          });
        }
        return stale;
      };
      try {
        manager.applyNonblockingDecision({
          specId: fixture.specId,
          nodeId: "impl-gate",
          record,
          eligibility,
        });
      } finally {
        CanonicalFlowRuntime.prototype.load = originalLoad;
        CanonicalFlowManagerStore.prototype.readCanonicalTransitionSnapshot = originalSnapshot;
      }
      assert.equal(competingDecisionInjected, false,
        "decision settlement must not read mutable state before its canonical transition snapshot");
      const settled = manager.canonicalState(fixture.specId);
      assert.equal(settled.current.at(-1), "impl-gate");
      assert.equal(settled.attempt.sequence, context.sourceAttempt + 1);
      assert.equal(settled.attempt.failure, null);
      assert.equal(manager.activityLedger(fixture.specId)
        .filter((activity) => activity.transition.nonblocking?.kind === "decision").length, 1);
    } finally { removeTmpDir(root); }
  });

  it("rejects missing schema fields rather than normalizing an older policy or Activity transition", () => {
    assert.throws(() => new CurrentFlowPolicy({ autoApprove: false }), /policy\.nonblocking is required/);
    assert.throws(() => new CurrentFlowPolicy({ autoApprove: false, nonblocking: false }), /policy\.nonblocking must be an object/);
    assert.throws(() => new CurrentFlowNonBlockingPolicy({
      enabled: false,
      activatedAt: "2026-08-14T00:00:00.000Z",
      activatedStep: "impl-review",
      reason: "invalid",
    }), /must be enabled/);
    assert.throws(() => new ActivityTransition({
      operation: "record_note", nodeId: "flow", task: null, attempt: null, status: null,
      policy: null, outbox: null, approval: null,
    }), /activity\.transition\.nonblocking is required/);
    assert.throws(() => new NonBlockingPolicy({ enabled: false, activatedStep: "impl-review", reason: "invalid" }), /one-way/);
  });

  it("rejects digest-only replay when canonical decisions have different full identities", () => {
    const digest = "d".repeat(64);
    const decision = (sourceStep, sourceAttempt, evidenceRef) => new ActivityNonBlockingRecord({
      kind: "decision",
      sourceStep,
      sourceAttempt,
      evidenceRef,
      evidenceDigest: digest,
      definitionDigest: "e".repeat(64),
      resultKind: "quality",
      action: "repair",
      rationale: "Repair the exact source.",
      remainingRisk: null,
    });
    const state = {
      schemaRevision: CURRENT_FLOW_SCHEMA_REVISION,
      specId: "477-ambiguous-replay",
      policy: { nonblocking: { enabled: true } },
      currentNodeId: null,
      currentTaskId: null,
      confirmationOrder: 9,
    };
    const flowManager = {
      load() { return state; },
      activityLedger() {
        return [
          { transition: { nonblocking: decision("impl-review", 1, "steps/impl/review/result.json") } },
          { transition: { nonblocking: decision("test-result-review", 2, "steps/test/result-review/result.json") } },
        ];
      },
      readActiveProducerArtifact() {},
      recordNonblocking() {},
      applyNonblockingDecision() {},
    };
    assert.throws(() => recordNonBlockingDecision({
      root: "/canonical-fixture",
      flowManager,
      choice: "repair",
      reason: "Repair the exact source.",
      expectEvidenceDigest: digest,
    }), (error) => error.code === "NONBLOCKING_AMBIGUOUS_REPLAY");
  });

  it("rejects pass evidence and stale decisions without manufacturing an observation", async (t) => {
    const { root, manager, fixture } = await scenario(t);
    try {
      const state = manager.load(fixture.specId);
      // The fixture publication is rejected, so first prove the digest guard
      // against the immutable catalog value rather than a path-derived file.
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Bounded Gate recovery is exhausted." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      assert.throws(() => recordNonBlockingDecision({
        root, flowManager: manager, choice: "continue", reason: "The Gate is retained.",
        remainingRisk: "The evidence remains visible.", expectEvidenceDigest: "b".repeat(64),
      }), /evidence changed/);
      assert.equal(manager.activityLedger(fixture.specId).filter((entry) => entry.transition.nonblocking?.kind === "decision").length, 0);
      assert.equal(context.sourceAttempt, manager.canonicalState(fixture.specId).attempt.sequence);
      assert.equal(state.policy.nonblocking, null);
    } finally { removeTmpDir(root); }
  });

  it("does not offer review continuation without valid acceptance-backed semantic findings", async (t) => {
    const malformedFinding = {
      fingerprint: "c".repeat(64), disposition: "deferred",
      rationale: "Mechanical evidence cannot be deferred as a semantic finding.",
      failureKind: "schema_error",
    };
    for (const payload of [
      {
        phase: "impl", verdict: "REJECTED", blockingFindings: [],
        canonicalEvidence: null,
      },
      {
        phase: "impl", verdict: "REJECTED", blockingFindings: [malformedFinding],
        canonicalEvidence: {
          disposition: "REJECTED", identity: { evidenceDigest: "d".repeat(64) },
          blockingFindings: [malformedFinding], advisoryFindings: [],
        },
      },
    ]) {
      const { root, manager, fixture } = await scenario(t, { payload });
      try {
        const before = JSON.stringify({ state: manager.canonicalState(fixture.specId),
          activities: manager.activityLedger(fixture.specId), catalog: manager.artifactCatalog(fixture.specId) });
        const next = await new GetNextActionCommand().execute({
          root, mainRoot: root, executionRoot: root, specId: fixture.specId,
          flowManager: manager, flowState: manager.load(fixture.specId),
        });
        assert.equal(next.directive.actionPrompt, undefined);
        assert.equal(next.nonblockingDecision, undefined);
        assert.throws(() => activateNonBlockingPolicy({
          root, flowManager: manager,
          reason: "Invalid review evidence cannot enter acceptance.",
        }), /not selected by the current Definition strict stop/);
        assert.equal(JSON.stringify({ state: manager.canonicalState(fixture.specId),
          activities: manager.activityLedger(fixture.specId), catalog: manager.artifactCatalog(fixture.specId) }), before);
      } finally { removeTmpDir(root); }
    }
  });

  it("retains saved Result meaning after metrics change and rejects a stale canonical decision transaction", async (t) => {
    const { root, manager, fixture } = await scenario(t);
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Gate recovery was exhausted." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      const beforeSource = decisionEvidenceForActiveFlow(root, manager.load(fixture.specId), manager, context);
      const beforeResult = manager.readCurrentStepSettlement({ specId: fixture.specId, stepId: "impl-gate" });
      // Saved Result meaning replaces the retired raw-artifact/metric rejudgment.
      manager.appendMetric({ phase: "impl", counter: "reviewRetry", delta: 1 }, { specId: fixture.specId });
      assert.equal(decisionEvidenceForActiveFlow(root, manager.load(fixture.specId), manager, context), beforeSource);
      assert.deepEqual(decisionContextForActiveFlow(root, manager.load(fixture.specId), manager).toJSON(), context.toJSON());
      assert.deepEqual(manager.readCurrentStepSettlement({ specId: fixture.specId, stepId: "impl-gate" }).result.toJSON(), beforeResult.result.toJSON());
      const originalAttempt = manager.canonicalState(fixture.specId).attempt;
      raceCanonicalNonblockingCommit({ manager, fixture, method: "continueNonblocking",
        invoke: () => recordNonBlockingDecision({ root, flowManager: manager, choice: "repair",
          reason: "This stale transaction must not run.", expectEvidenceDigest: context.evidenceDigest,
          expectIdentity: context.identity().toJSON() }) });
      assert.equal(manager.activityLedger(fixture.specId).some((entry) => entry.transition.nonblocking?.kind === "decision"), false);
      assert.equal(manager.canonicalState(fixture.specId).attempt.id, originalAttempt.id);
      assert.deepEqual(manager.canonicalState(fixture.specId).attempt.failure, originalAttempt.failure);
      for (const logicalKey of ["nonblocking.handoffs", "flow.findings"]) {
        assert.equal(manager.readArtifact({ specId: fixture.specId, logicalKey, consumerNodeId: "acceptance-review", optional: true }), null);
      }
    } finally { removeTmpDir(root); }
  });

  it("defers every current failed Gate finding and excludes a passing Requirement", async (t) => {
    const { root, manager, fixture } = await scenario(t, { mixedGateFindings: true });
    const source = manager.readActiveProducerArtifact({ specId: fixture.specId, nodeId: "impl-gate", logicalKey: "impl.gate" });
    const payload = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: "impl.gate", bytes: source.bytes }).current.payload;
    assert.ok(payload.artifacts.evaluations.some((entry) => entry.guardrail_id === "R2" && entry.result === "pass"));
    assert.ok(payload.artifacts.evaluations.some((entry) => entry.guardrail_id === "R1" && entry.result === "fail"));
    const selected = canonicalSourceFindings({ artifact: payload, sourceStep: "impl-gate", sourceArtifact: source.relativePath })
      .map((entry) => entry.identity.fingerprint);
    assert.equal(selected.length, 1, "the passed rule must not create a deferred semantic finding");
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Only accepted findings may be deferred." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      recordNonBlockingDecision({
        root, flowManager: manager, choice: "continue",
        reason: "Continue with only the selected deferred finding.",
        remainingRisk: "The selected finding remains explicit for acceptance.",
        expectEvidenceDigest: context.evidenceDigest,
        expectIdentity: context.identity().toJSON(),
      });
      const findings = JSON.parse(manager.readArtifact({
        specId: fixture.specId, logicalKey: "flow.findings", consumerNodeId: "acceptance-review",
      }).bytes.toString("utf8"));
      assert.deepEqual(findings.entries.map((entry) => entry.fingerprint), [...selected]);
    } finally { removeTmpDir(root); }
  });

  it("is idempotent for an exact continue decision and projects advisory completion from Activities", async (t) => {
    const { root, manager, fixture } = await scenario(t);
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "The Gate needs acceptance disposition." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      const input = {
        root, flowManager: manager, choice: "continue", reason: "The requested behavior is complete.",
        remainingRisk: "The rejected Gate remains durable.", expectEvidenceDigest: context.evidenceDigest,
      };
      const first = recordNonBlockingDecision(input);
      const second = recordNonBlockingDecision(input);
      assert.deepEqual(second, first);
      const state = manager.load(fixture.specId);
      assert.equal(state.steps.flatMap((entry) => entry.children || [entry]).find((entry) => entry.id === "impl-gate").status, "done");
      assert.equal(state.steps.flatMap((entry) => entry.children || [entry]).find((entry) => entry.id === "impl-triage").status, "skipped");
      assert.deepEqual(advisorySummary(state), [{
        stepId: "impl-gate", evidenceRef: context.evidenceRef,
        rationale: input.reason, remainingRisk: input.remainingRisk,
      }]);
      assert.equal(manager.activityLedger(fixture.specId).filter((entry) => entry.transition.nonblocking?.kind === "decision").length, 1);
    } finally { removeTmpDir(root); }
  });

  it("uses repair as a new typed Attempt and rejects a conflicting decision identity", async (t) => {
    const { root, manager, fixture } = await scenario(t);
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Repair is explicitly selected." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      recordNonBlockingDecision({
        root, flowManager: manager, choice: "repair", reason: "Repair the Gate-reviewed behavior.",
        expectEvidenceDigest: context.evidenceDigest,
      });
      assert.equal(manager.load(fixture.specId).currentNodeId, "impl-gate");
      assert.throws(() => recordNonBlockingDecision({
        root, flowManager: manager, choice: "continue", reason: "A second disposition conflicts.",
        remainingRisk: "Not applicable.", expectEvidenceDigest: context.evidenceDigest,
      }), /different nonblocking decision/);
    } finally { removeTmpDir(root); }
  });

  it("does not bypass the Definition-owned Task Review recovery connector", async (t) => {
    const { root, manager, fixture } = await taskScenario(t, "review");
    try {
      assert.throws(() => activateNonBlockingPolicy({ root, flowManager: manager, reason: "Task review is bounded." }),
        /not selected by the current Definition strict stop/);
      assert.equal(manager.load(fixture.specId).policy.nonblocking, null);
    } finally { removeTmpDir(root); }
  });

  it("materializes Definition-owned bounded Flow Review tooling retry and continuation targets", async (t) => {
    for (const choice of ["retry", "continue"]) {
      const { root, manager, fixture } = await taskScenario(t, "review", { reviewTooling: true });
      try {
        const strict = await new GetNextActionCommand().execute({
          root, mainRoot: root, executionRoot: root, specId: fixture.specId,
          flowManager: manager, flowState: manager.load(fixture.specId),
        });
        assert.deepEqual(strict.directive.actionPrompt.choices.map((entry) => entry.actionId), [
          "KEEP_STRICT_FLOW", "ENABLE_NONBLOCKING",
        ]);
        activateNonBlockingPolicy({ root, flowManager: manager, reason: "bounded Flow Review tooling is unavailable." });
        const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false });
        const context = decisionContextForActiveFlow(root, reloaded.load(fixture.specId), reloaded);
        assert.equal(context.sourceStep, "impl-review");
        assert.equal(context.continueTargetStepId, "impl-gate");
        recordNonBlockingDecision({
          root, flowManager: reloaded, choice,
          reason: `${choice} the unavailable Task Review producer.`,
          remainingRisk: choice === "continue" ? "Acceptance retains the unavailable Task Review judgment." : null,
          expectEvidenceDigest: context.evidenceDigest,
          expectIdentity: context.identity().toJSON(),
        });
        const persisted = new FlowManager({ root, mainRoot: root, inWorktree: false });
        const canonical = persisted.canonicalState(fixture.specId);
        assert.equal(choice === "retry" ? canonical.current.at(-1) : canonical.nextAction().nodeId,
          choice === "retry" ? "impl-review" : "impl-gate");
        if (choice === "continue") {
          assert.equal(canonical.findNode("impl-review").status, "done");
          assert.equal(canonical.findNode("impl-triage").status, "skipped");
          assert.equal(canonical.findNode("impl-repair").status, "skipped");
          assert.equal(canonical.findNode("impl-gate").status, "pending");
        }
      } finally { removeTmpDir(root); }
    }
  });

  it("publishes unavailable Task Gate evidence and acceptance risk in one continuation Activity", async (t) => {
    const { root, manager, fixture } = await taskScenario(t, "gate");
    try {
      const originalGate = manager.readProducerArtifact({
        specId: fixture.specId, nodeId: "T-1-gate", logicalKey: "task.gate", parameters: { taskId: "T-1" },
      });
      const commandContext = () => ({
        root, mainRoot: root, executionRoot: root, specId: fixture.specId,
        flowManager: manager, flowState: manager.load(fixture.specId),
      });
      const strict = await new GetNextActionCommand().execute(commandContext());
      assert.equal(strict.directive.kind, "await_user_decision");
      assert.deepEqual(strict.directive.actionPrompt.choices.map((choice) => choice.actionId), [
        "KEEP_STRICT_FLOW", "ENABLE_NONBLOCKING",
      ]);
      assert.equal(strict.nonblockingDecision, undefined);
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Task gate is bounded." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      assert.equal(context.sourceStep, "task-gate");
      assert.deepEqual(context.allowedActions, ["retry", "continue"]);
      assert.equal(context.evidenceRef, "steps/impl/T-1/gate/result.json");
      const enabled = await new GetNextActionCommand().execute(commandContext());
      assert.deepEqual(enabled.nonblockingDecision, context.toJSON());
      const decisionInput = {
        root, choice: "continue",
        reason: "The local Gate did not obtain semantic judgment.",
        remainingRisk: "Acceptance retains the unavailable Gate judgment.",
        expectEvidenceDigest: context.evidenceDigest,
        expectIdentity: context.identity().toJSON(),
      };
      const crashing = new FlowManager({
        root, mainRoot: root, inWorktree: false,
        versionStoreFaultInjector({ phase }) {
          if (phase === "activity-appended") throw new Error("simulated Task Gate continuation crash");
        },
      });
      assert.throws(() => recordNonBlockingDecision({ ...decisionInput, flowManager: crashing }),
        /simulated Task Gate continuation crash/);
      const resumed = new FlowManager({ root, mainRoot: root, inWorktree: false });
      for (const logicalKey of ["nonblocking.handoffs", "flow.findings"]) {
        assert.equal(resumed.readArtifact({
          specId: fixture.specId,
          logicalKey,
          consumerNodeId: "acceptance-review",
          optional: true,
        }), null);
      }
      const decision = recordNonBlockingDecision({ ...decisionInput, flowManager: resumed });
      assert.equal(decision.action, "continue");
      const state = resumed.load(fixture.specId);
      assert.equal(state.tasks[0].status, "done");
      assert.equal(state.currentNodeId, null);
      assert.equal(resumed.canonicalState(fixture.specId).nextAction().nodeId, "test-execute");
      assert.deepEqual(recordNonBlockingDecision({
        ...decisionInput, flowManager: resumed,
      }), decision);
      const handoffs = JSON.parse(resumed.readArtifact({
        specId: fixture.specId, logicalKey: "nonblocking.handoffs", consumerNodeId: "acceptance-review",
      }).bytes.toString("utf8"));
      assert.equal(handoffs.findings.length, 1);
      assert.equal(handoffs.findings.at(-1).sourceStep, "task-gate");
      assert.equal(handoffs.findings.at(-1).evidenceDigest, context.evidenceDigest);
      const findings = JSON.parse(resumed.readArtifact({
        specId: fixture.specId, logicalKey: "flow.findings", consumerNodeId: "acceptance-review",
      }).bytes.toString("utf8"));
      assert.equal(findings.entries.length, 1);
      const deferred = findings.entries.at(-1);
      assert.deepEqual({
        sourceStep: deferred.sourceStep,
        sourceArtifact: deferred.sourceArtifact,
        sourceFindingId: deferred.sourceFindingId,
        fingerprint: deferred.fingerprint,
        rationale: deferred.rationale,
        finalDisposition: deferred.finalDisposition,
      }, {
        sourceStep: "task-gate",
        sourceArtifact: "steps/nonblocking-handoffs.json",
        sourceFindingId: handoffs.findings.at(-1).findingId,
        fingerprint: handoffs.findings.at(-1).fingerprint,
        rationale: decisionInput.remainingRisk,
        finalDisposition: "still_open",
      });
      const decisionActivity = resumed.activityLedger(fixture.specId).find((activity) => (
        activity.transition.nonblocking?.kind === "decision"
      ));
      const catalog = resumed.artifactCatalog(fixture.specId);
      for (const logicalKey of ["nonblocking.handoffs", "flow.findings"]) {
        assert.equal(catalog.artifacts.find((artifact) => artifact.logicalKey === logicalKey).activityId,
          decisionActivity.id);
      }
      const acceptance = new CanonicalAcceptanceArtifactStore({
        flowManager: resumed,
        state: resumed.load(fixture.specId),
      }).deferredFindings([]);
      assert.deepEqual(acceptance.findings, [{
        findingId: deferred.findingId,
        sourceStep: "task-gate",
        sourceArtifact: "steps/nonblocking-handoffs.json",
        sourceFindingId: handoffs.findings.at(-1).findingId,
        finalDisposition: "still_open",
        evidenceRefs: [],
      }]);
      assert.deepEqual(acceptance.evidence, [{
        findingId: deferred.findingId,
        sourceRef: `steps/nonblocking-handoffs.json#${handoffs.findings.at(-1).findingId}`,
        sourceFinding: handoffs.findings.at(-1),
      }]);
      const settledGate = resumed.artifactCatalog(fixture.specId).artifacts
        .find((artifact) => artifact.relativePath === originalGate.relativePath);
      assert.equal(settledGate.hash, originalGate.descriptor.hash);
      const issueLog = JSON.parse(resumed.readArtifact({
        specId: fixture.specId, logicalKey: "issue.log", consumerNodeId: "T-1-gate",
      }).bytes.toString("utf8"));
      assert.equal(issueLog.entries.length > 0, true);
    } finally { removeTmpDir(root); }
  });

  it("retries a provider-unavailable Task Gate atomically without advancing the next Task", async (t) => {
    const { root, manager, fixture } = await taskScenario(t, "gate", { failureKind: "provider", nextTask: true });
    try {
      const original = manager.readProducerArtifact({
        specId: fixture.specId,
        nodeId: "T-1-gate",
        logicalKey: "task.gate",
        parameters: { taskId: "T-1" },
      });
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "The Gate provider is unavailable." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      assert.equal(context.resultKind, "tooling");
      assert.deepEqual(context.allowedActions, ["retry", "continue"]);
      const result = recordNonBlockingDecision({
        root,
        flowManager: manager,
        choice: "retry",
        reason: "Retry the provider-backed Task Gate.",
        expectEvidenceDigest: context.evidenceDigest,
        expectIdentity: context.identity().toJSON(),
      });
      assert.equal(result.action, "retry");
      const state = manager.load(fixture.specId);
      assert.equal(state.currentTaskId, "T-1");
      assert.equal(state.currentNodeId, "T-1-gate");
      assert.equal(state.tasks.find((task) => task.id === "T-1").status, "in_progress");
      assert.equal(state.tasks.find((task) => task.id === "T-2").status, "pending");
      assert.equal(manager.canonicalState(fixture.specId).attempt.sequence, context.sourceAttempt + 1);
      assert.equal(manager.readProducerArtifact({
        specId: fixture.specId,
        nodeId: "T-1-gate",
        logicalKey: "task.gate",
        parameters: { taskId: "T-1" },
      }).descriptor.hash, original.descriptor.hash);
    } finally { removeTmpDir(root); }
  });

  it("retries unavailable Task Gate evidence in one decision Activity", async (t) => {
    const { root, manager, fixture } = await taskScenario(t, "gate");
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Retry the unavailable local Gate." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      const input = {
        root, flowManager: manager, choice: "retry",
        reason: "Retry the canonical Gate producer.",
        expectEvidenceDigest: context.evidenceDigest,
        expectIdentity: context.identity().toJSON(),
      };
      const first = recordNonBlockingDecision(input);
      assert.equal(first.action, "retry");
      const canonical = manager.canonicalState(fixture.specId);
      assert.equal(canonical.current.at(-1), "T-1-gate");
      assert.equal(canonical.attempt.sequence, context.sourceAttempt + 1);
      assert.equal(manager.load(fixture.specId).tasks[0].status, "in_progress");
      assert.deepEqual(recordNonBlockingDecision(input), first);
      assert.equal(manager.activityLedger(fixture.specId)
        .filter((activity) => activity.transition.nonblocking?.kind === "decision").length, 1);
    } finally { removeTmpDir(root); }
  });

  it("continues a local-invalid Task Gate through the Definition-selected next Task lifecycle", async (t) => {
    const { root, manager, fixture } = await taskScenario(t, "gate", { failureKind: "mechanical", nextTask: true });
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "The local Gate input is unavailable." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      recordNonBlockingDecision({
        root,
        flowManager: manager,
        choice: "continue",
        reason: "Continue to the next Task while retaining the failed Gate.",
        remainingRisk: "Acceptance must account for the missing Task Gate judgment.",
        expectEvidenceDigest: context.evidenceDigest,
        expectIdentity: context.identity().toJSON(),
      });
      const state = manager.load(fixture.specId);
      assert.equal(state.tasks.find((task) => task.id === "T-1").status, "done");
      assert.equal(state.tasks.find((task) => task.id === "T-2").status, "pending");
      assert.equal(state.currentTaskId, null);
      assert.equal(state.currentNodeId, null);
      assert.equal(manager.canonicalState(fixture.specId).nextAction().nodeId, "T-2-impl");
      assert.equal(manager.activityLedger(fixture.specId).at(-1).transition.gateTaskLifecycle.successorStepId, "T-2-impl");
    } finally { removeTmpDir(root); }
  });

  it("rejects direct activation while Definition still selects ordinary Task Gate recovery", async (t) => {
    const { root, manager, fixture } = await taskScenario(t, "gate", {
      failureKind: "ai_semantic_fail",
    });
    try {
      const next = await new GetNextActionCommand().execute({
        root, mainRoot: root, executionRoot: root, specId: fixture.specId,
        flowManager: manager, flowState: manager.load(fixture.specId),
      });
      assert.equal(next.directive.actionPrompt, undefined);
      assert.equal(next.nonblockingDecision, undefined);
      assert.throws(() => activateNonBlockingPolicy({
        root, flowManager: manager, reason: "A direct command cannot bypass Definition recovery.",
      }), /not selected by the current Definition strict stop/);
      assert.equal(manager.load(fixture.specId).policy.nonblocking, null);
    } finally { removeTmpDir(root); }
  });

  it("does not mask an actual precommit local or tooling Task Gate publication refusal", async (t) => {
    for (const failureKind of ["mechanical", "provider"]) {
      const { root, manager, fixture } = await taskScenario(t, "gate", {
        failureKind,
        rejectPublication: true,
      });
      try {
        const next = await new GetNextActionCommand().execute({
          root, mainRoot: root, executionRoot: root, specId: fixture.specId,
          flowManager: manager, flowState: manager.load(fixture.specId),
        });
        assert.equal(next.directive.kind, "execute_step");
        assert.equal(manager.readProducerArtifact({ specId: fixture.specId, nodeId: "T-1-gate",
          logicalKey: "task.gate", parameters: { taskId: "T-1" }, optional: true }), null);
        assert.equal(next.directive.actionPrompt, undefined);
        assert.equal(next.nonblockingDecision, undefined);
        assert.throws(() => activateNonBlockingPolicy({
          root, flowManager: manager,
          reason: "Incomplete Task Gate settlement cannot be bypassed.",
        }), /not selected by the current Definition strict stop/);
        assert.equal(manager.load(fixture.specId).policy.nonblocking, null);
      } finally { removeTmpDir(root); }
    }
  });

  it("has the dispatcher record one dedicated decision and reload canonical next-action", async (t) => {
    const { root, manager, fixture } = await taskScenario(t, "gate");
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "The local Gate is unavailable." });
      let nextActionReads = 0;
      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run() {
            nextActionReads += 1;
            if (nextActionReads > 1) return {
              taskId: null, step: null, action: "completed", instructions: null, context: null,
              output_schema: null, requires_approval: false,
              directive: { kind: "completed", terminal: true, requiresUserAction: false },
            };
            return new GetNextActionCommand().execute({
              root, mainRoot: root, executionRoot: root, specId: fixture.specId,
              flowManager: manager, flowState: manager.load(fixture.specId),
            });
          },
        },
        agent: { async call() {
          return JSON.stringify({
            choice: "continue",
            reason: "Semantic judgment was unavailable.",
            remainingRisk: "Acceptance retains the unavailable Task Gate judgment.",
          });
        } },
        repositoryFingerprint: () => "nonblocking-dispatch-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
        handoffCoordinator: { recoverPending() {} },
      });
      dispatcher.container = {};
      const decisionContext = {
        root, mainRoot: root, executionRoot: root, specId: fixture.specId,
        flowManager: manager, flowState: manager.load(fixture.specId),
      };
      const projected = await new GetNextActionCommand().execute(decisionContext);
      const action = new FlowDispatchAction(projected);
      dispatcher.agent = { async call() { return '{"choice":"continue"}'; } };
      await assert.rejects(
        () => dispatcher.runNonblockingAgentDecision(decisionContext, action),
        /reason is required/,
      );
      dispatcher.agent = { async call() { throw new Error("provider unavailable"); } };
      await assert.rejects(
        () => dispatcher.runNonblockingAgentDecision(decisionContext, action),
        /provider unavailable/,
      );
      const stale = structuredClone(projected);
      stale.nonblockingDecision.evidenceDigest = "c".repeat(64);
      await assert.rejects(
        () => dispatcher.runNonblockingAgentDecision(decisionContext, new FlowDispatchAction(stale)),
        /evidence changed/,
      );
      assert.equal(manager.activityLedger(fixture.specId).filter((entry) => (
        entry.transition.nonblocking?.kind === "decision"
      )).length, 0);
      dispatcher.agent = { async call() {
        return JSON.stringify({
          choice: "continue",
          reason: "Semantic judgment was unavailable.",
          remainingRisk: "Acceptance retains the unavailable Task Gate judgment.",
        });
      } };
      const result = await dispatcher.execute({
        root, mainRoot: root, executionRoot: root, specId: fixture.specId,
        flowManager: manager, flowState: manager.load(fixture.specId),
        expectRunId: fixture.runId, expectSpec: fixture.specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      });
      assert.equal(result.dispatch?.boundary, "completed", JSON.stringify(result));
      assert.equal(result.dispatch.dispatchCount, 1);
      assert.equal(nextActionReads, 2);
      assert.equal(manager.activityLedger(fixture.specId).filter((entry) => (
        entry.transition.nonblocking?.kind === "decision"
      )).length, 1);
      assert.equal(manager.canonicalState(fixture.specId).nextAction().nodeId, "test-execute");
    } finally { removeTmpDir(root); }
  });

  it("classifies rejected review evidence as quality", () => {
    assert.equal(fromReviewResult({ ref: "review", source: '{"verdict":"REJECTED"}' }).resultKind, "quality");
  });
  it("classifies tooling review evidence as retryable tooling", () => {
    assert.equal(fromReviewResult({ ref: "review", source: '{"toolingOutcome":{"reason":"offline"}}' }).resultKind, "tooling");
  });
  it("classifies semantic and tooling gate failures distinctly", () => {
    assert.equal(fromGateResult({ ref: "gate", source: '{"result":"fail","artifacts":{"failureKind":"ai_semantic_fail"}}' }).resultKind, "quality");
    assert.equal(fromGateResult({ ref: "gate", source: '{"result":"fail","artifacts":{"failureKind":"schema"}}' }).resultKind, "tooling");
    assert.equal(fromGateResult({ ref: "gate", source: '{"result":"fail","artifacts":{"failureKind":"provider"}}' }).resultKind, "tooling");
    assert.equal(fromGateResult({ ref: "gate", source: '{"result":"fail","artifacts":{"failureKind":"mechanical"}}' }).resultKind, "unavailable");
    assert.equal(fromGateResult({ ref: "gate", source: '{"result":"fail","artifacts":{"failureKind":"mechanical_guardrail_fail"}}' }).resultKind, "unavailable");
    assert.throws(
      () => fromGateResult({ ref: "gate", source: '{"result":"fail","failureKind":"schema"}' }),
      /artifacts must be an object/,
    );
  });
  it("classifies acceptance blockers as quality evidence", () => {
    assert.equal(fromAcceptanceResult({ ref: "acceptance", source: '{"verdict":"blocked"}' }).resultKind, "quality");
  });
  it("classifies final-regression infrastructure failure as tooling evidence", () => {
    assert.equal(fromFinalRegressionResult({ ref: "regression", source: '{"result":"fail","failureKind":"infra_failure"}' }).resultKind, "tooling");
  });
  it("does not activate an advisory policy from pass evidence", async (t) => {
    const { root, manager } = await scenario(t, { passOnly: true });
    try {
      const before = JSON.stringify({ state: manager.canonicalState(), activities: manager.activityLedger(), catalog: manager.artifactCatalog() });
      assert.equal(fromReviewResult({ ref: "review", source: '{"verdict":"PASS"}' }), null);
      assert.throws(() => activateNonBlockingPolicy({ root, flowManager: manager, reason: "Pass evidence has no advisory route." }),
        (error) => error.code === "NONBLOCKING_NOT_DEFINITION_ELIGIBLE");
      assert.equal(JSON.stringify({ state: manager.canonicalState(), activities: manager.activityLedger(), catalog: manager.artifactCatalog() }), before);
    } finally { removeTmpDir(root); }
  });
  it("requires the catalog digest to identify a decision before it can be replayed", async (t) => {
    const { root, manager, fixture } = await scenario(t);
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Identity must remain immutable." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      assert.match(context.evidenceDigest, /^[a-f0-9]{64}$/);
      assert.notEqual(context.evidenceDigest, "a".repeat(64));
    } finally { removeTmpDir(root); }
  });
});
