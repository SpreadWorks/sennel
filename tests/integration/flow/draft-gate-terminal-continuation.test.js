import assert from "node:assert/strict";
import fs from "node:fs";
import { it } from "node:test";

import { resolveGateTransition } from "../../../src/flow/definition.js";
import { CanonicalGateObservationCycle } from "../../../src/flow/lib/canonical-gate-observation-cycle.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { readCurrentGateTransitionFacts } from "../../../src/flow/lib/gate-transition-facts.js";
import RunRepairPlanGateCommand from "../../../src/flow/lib/run-repair-plan-gate.js";
import { WorkerArtifactHandoffCoordinator } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { DraftGateRepairScenario } from "../../support/infrastructure/draft-gate-repair-scenario.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";

const semanticObservations = [{
  kind: "violation",
  failureMode: "guardrail-violation",
  requirementRef: "R-1",
  where: { file: "draft.json", locator: "goal" },
  observed: "The retained behavior remains unresolved.",
  severity: "blocking",
  refs: ["R-1"],
}];

function recordDraftGateFailure(manager, specId, issueLogId, observations = semanticObservations) {
  const artifacts = {
    phase: "draft", failureKind: "ai_semantic_fail", failureCode: "GATE_REJECTED",
    nextAction: { diagnosis: { observations } },
  };
  const commandResult = new CanonicalGatePromotion({
    state: manager.canonicalState(specId), phase: "draft", nodeId: "draft-gate",
  }).promote({ result: "fail", artifacts });
  manager.failCurrentAttempt({
    specId,
    failure: {
      category: "semantic", code: "GATE_REJECTED", message: "The draft Gate retained one finding.",
      retryable: true, retryKind: "semantic",
    },
    commandResult,
  });
  manager.appendIssueLog({
    specId,
    entry: {
      issueLogId, step: "draft-gate", phase: "draft", observations,
      reason: "The finding continues to Spec.", trigger: "gate post hook (auto)",
      timestamp: "2026-09-15T00:00:00.000Z",
    },
    idempotencyKey: issueLogId,
  });
}

function exerciseTerminalContinuation(kind) {
  const root = createTmpDir(`draft-gate-${kind}-continuation-`);
  const specId = `521-draft-gate-${kind}`;
  try {
    initGitRepo(root);
    fs.writeFileSync(`${root}/README.md`, "draft Gate terminal continuation\n");
    commitAll(root, "draft Gate terminal continuation");
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const fixture = new CanonicalFlowFixture({
      flowManager: manager, specId, runId: "run-draft-gate-terminal", issue: 521,
      request: "Carry an unresolved draft finding into Spec.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft");
    manager.confirmCurrentAttempt({ specId, artifactWrites: [{
      logicalKey: "draft", mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument({ goal: "Unresolved behavior", questions: [] }), null, 2)}\n`),
    }] });
    fixture.activate("draft-gate");
    const scenario = new DraftGateRepairScenario({ flowManager: manager, root, specId })
      .select({ observations: semanticObservations, issueLogId: "initial-draft-gate-finding" });
    scenario.createRequest();
    const payload = scenario.replacement("goal", "Unresolved behavior");
    if (kind === "no-progress") payload.operations = [];
    else {
      payload.operations[0].path = "analysis.missing";
      payload.operations[0].expectedDigest = "f".repeat(64);
    }
    const before = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair" }).descriptor.hash;
    const repaired = scenario.apply(payload);
    assert.equal(repaired.result.rejected, true);
    assert.equal(repaired.bytes.length > 0, true);
    assert.equal(manager.artifactCatalog(specId).artifacts.some((entry) => (
      entry.logicalKey === "plan.gate.repair.outcome"
    )), kind === "no-progress");

    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    assert.equal(reloaded.canonicalState(specId).findNode("draft-gate-repair").status, "done");
    assert.equal(reloaded.canonicalState(specId).nextAction().nodeId, "draft-coverage-review");
    assert.equal(reloaded.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-coverage-review" }).descriptor.hash, before);

    fixture.flowManager = reloaded;
    fixture.settle("draft-coverage-review").settle("draft-coverage-triage").settle("draft-coverage-repair").activate("draft-gate");
    recordDraftGateFailure(reloaded, specId, "recurring-draft-gate-finding");
    const facts = readCurrentGateTransitionFacts({
      flowManager: reloaded, flowState: reloaded.loadReadOnly(specId), phase: "draft",
    });
    const decision = resolveGateTransition(facts);
    assert.equal(decision.disposition.operation, "defer");
    reloaded.settleGateTransition({ specId, decision });

    const finalReload = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    assert.equal(finalReload.canonicalState(specId).nextAction().nodeId, "spec");
    const findings = finalReload.readArtifact({
      specId, logicalKey: "flow.findings", consumerNodeId: "system",
    });
    assert.equal(JSON.parse(findings.bytes).entries.length > 0, true);
    assert.equal(new CanonicalGateObservationCycle({
      flowManager: finalReload, state: finalReload.loadReadOnly(specId),
    }).status().entries[0].finalDisposition, "deferred");
    finalReload.beginNextAction(specId);
    const specRequest = new WorkerArtifactHandoffCoordinator().createRequest({
      ctx: { root, mainRoot: root, executionRoot: root, flowManager: finalReload, specId },
      state: finalReload.loadReadOnly(specId),
      invocation: {
        id: "spec-after-deferred-draft-gate", target: { digest: "b".repeat(64) },
        action: { digest: "a".repeat(64), nextAction: { step: "spec" } },
      },
    });
    const findingsInput = specRequest.inputs.find((entry) => entry.name === "flow-findings.json");
    const persistedFindings = JSON.parse(findings.bytes);
    assert.deepEqual(
      findingsInput.document.entries.map(({ sourceObservation, ...entry }) => entry),
      persistedFindings.entries,
    );
    assert.deepEqual(findingsInput.document.entries[0].sourceObservation, semanticObservations[0]);
  } finally {
    removeTmpDir(root);
  }
}

it("persists no-progress repair completion and defers the recurring draft Gate finding to Spec", () => {
  exerciseTerminalContinuation("no-progress");
});

it("persists invalid repair completion without partial artifacts and defers the draft Gate finding to Spec", () => {
  exerciseTerminalContinuation("invalid-payload");
});

it("settles the fifth draft Gate failure after four completed repair and coverage cycles", () => {
  const root = createTmpDir("draft-gate-semantic-budget-");
  const specId = "522-draft-gate-semantic-budget";
  try {
    initGitRepo(root);
    fs.writeFileSync(`${root}/README.md`, "draft Gate semantic budget\n");
    commitAll(root, "draft Gate semantic budget");
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const fixture = new CanonicalFlowFixture({
      flowManager: manager, specId, runId: "run-draft-gate-semantic-budget", issue: 522,
      request: "Bound repeated draft Gate repairs.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft");
    manager.confirmCurrentAttempt({ specId, artifactWrites: [{
      logicalKey: "draft", mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument({ goal: "Draft revision 0", questions: [] }), null, 2)}\n`),
    }] });
    fixture.activate("draft-gate");

    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const observations = [{
        ...semanticObservations[0],
        failureMode: `semantic-finding-${cycle}`,
        observed: `Unresolved semantic finding ${cycle}.`,
      }];
      const scenario = new DraftGateRepairScenario({ flowManager: manager, root, specId })
        .select({ observations, issueLogId: `draft-gate-cycle-${cycle}` });
      scenario.createRequest();
      const result = scenario.apply(scenario.replacement("goal", `Draft revision ${cycle}`));
      assert.notEqual(result.result.rejected, true);
      fixture
        .settle("draft-coverage-review")
        .settle("draft-coverage-triage")
        .settle("draft-coverage-repair")
        .activate("draft-gate");
    }

    const finalObservation = [{
      ...semanticObservations[0],
      failureMode: "semantic-finding-5",
      observed: "A fifth distinct semantic finding remains.",
    }];
    recordDraftGateFailure(manager, specId, "draft-gate-cycle-5", finalObservation);
    const facts = readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.loadReadOnly(specId), phase: "draft",
    });
    assert.deepEqual(facts.retry.toJSON(), { used: 4, maximum: 4, remaining: 0 });
    assert.equal(resolveGateTransition(facts).disposition.operation, "defer");
    const beforeAttempt = manager.canonicalState(specId).attempt;
    const beforeActivities = manager.activityLedger(specId).length;
    const bypass = new RunRepairPlanGateCommand().execute({
      root, mainRoot: root, executionRoot: root, flowManager: manager, specId,
      flowState: manager.loadReadOnly(specId),
    });
    assert.equal(bypass.ok, false);
    assert.deepEqual(manager.canonicalState(specId).attempt, beforeAttempt);
    assert.equal(manager.activityLedger(specId).length, beforeActivities);
  } finally {
    removeTmpDir(root);
  }
});
