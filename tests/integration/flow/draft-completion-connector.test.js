import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  DraftCompletionConnector,
  DraftCompletionSettlementApplication,
  DraftExecutionSettlement,
  DraftReviewExecutionBinding,
  DraftReviewExecutionClaim,
  DraftReviewExecutionTargetIdentity,
  resolveDraftCompletionConnector,
  resolveLifecyclePlan,
  settleDraftStepResult,
} from "../../../src/flow/definition.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import {
  DraftCoverageRepairChangedResult,
  DraftCoverageRepairUnchangedResult,
  DraftCoverageReviewFindingsResult,
  DraftCoverageReviewPassedResult,
  DraftCoverageReviewExecutionRequiredResult,
} from "../../../src/flow/engine/step-result.js";
import { FlowArtifactAttemptHistory, FlowArtifactAttemptRecord } from "../../../src/lib/flow-artifact-contract.js";
import { CanonicalDraftReviewSource } from "../../../src/flow/lib/canonical-review-artifacts.js";
import { attachCanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import {
  DraftCompletionAbsentLineage,
  DraftCompletionCatalogBinding,
  DraftCompletionFacts,
  StepConnectionReceipt,
} from "../../../src/flow/lib/draft-completion-connector.js";
import { ActivityStepConnectionReceipt, CurrentAttempt } from "../../../src/flow/lib/current-flow-state.js";
import { findStepById } from "../../../src/flow/lib/step-tree.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { DraftGateRepairScenario } from "../../support/infrastructure/draft-gate-repair-scenario.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function receiptId(value) {
  const { id: _id, ...content } = value;
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(content))).digest("hex");
}

function completionApplication(completionFacts) {
  const stepResult = completionFacts.sourceStepId === "draft-coverage-review"
    ? new DraftCoverageReviewPassedResult()
    : new DraftCoverageRepairUnchangedResult();
  return settleDraftStepResult(stepResult.stepId, stepResult, {
    draftCompletionFacts: completionFacts,
  }).application;
}

function settleCompletion(flowManager, {
  specId,
  application,
  stepResult = null,
  artifactWrites = [],
  artifactBaselines = [],
} = {}) {
  assert.ok(application instanceof DraftCompletionSettlementApplication);
  const expectedResult = application.facts.sourceStepId === "draft-coverage-review"
    ? new DraftCoverageReviewPassedResult()
    : new DraftCoverageRepairUnchangedResult();
  const state = flowManager.canonicalState(specId);
  const priorBinding = state.findNode(expectedResult.stepId)?.result?.draftSettlementReceipt?.binding ?? null;
  const attempt = state.current?.at(-1) === expectedResult.stepId
    ? state.attempt
    : priorBinding === null ? null : {
        id: priorBinding.attemptId,
        sequence: priorBinding.attemptSequence,
      };
  return flowManager.settleDraftStepResult({
    binding: { runId: state.runId, specId, stepId: expectedResult.stepId, attempt },
    stepResult: stepResult ?? expectedResult,
    settlement: settleDraftStepResult(expectedResult.stepId, expectedResult, {
      draftCompletionFacts: application.facts,
    }),
    artifactWrites,
    artifactBaselines,
  });
}

function draft({ questions = [] } = {}) {
  return {
    devType: "feature",
    goal: "Confirm a completed draft through the canonical connector.",
    analysis: {
      problem: "The completion marker must have one parent-owned writer.",
      proposedApproach: "Select a connector from canonical coverage facts.",
      validation: "Exercise the connector's complete and reject paths.",
    },
    decisionMap: {
      knownFacts: [], decisionPoints: [], resolvedByProjectRules: [], requiresUserJudgment: [], deferredToSpec: [],
    },
    questionLedger: {
      revision: 0,
      publication: "draft-completion-connector-test",
      evidenceDigest: "a".repeat(64),
      questions,
    },
  };
}

function repairAudit(overrides = {}) {
  return {
    version: 2,
    phase: "draft-coverage-repair",
    sourceTriage: "draft-coverage-triage.json",
    baseRevision: `sha256:${"b".repeat(64)}`,
    acceptedOperations: [],
    discardedOperations: [],
    appliedFindingKeys: [],
    operationDigest: "c".repeat(64),
    audit: {
      envelopeErrors: [],
      baseRevisionMatches: true,
      missingRequiredTargets: [],
      lifecycleIssues: [],
    },
    ...overrides,
  };
}

function facts({
  source = "coverage-pass",
  draftDocument = draft(),
  reviewVerdict = "PASS",
  triage = null,
  repair = null,
  canonicalDigest = null,
  canonicalByteLength = null,
  reviewDraftDigest = null,
  reviewArtifactDigest = "1".repeat(64),
  triageArtifactDigest = undefined,
  questionsReviewArtifactDigest = "2".repeat(64),
} = {}) {
  const bytes = Buffer.from(`${JSON.stringify(draftDocument, null, 2)}\n`, "utf8");
  const sourceDigest = canonicalDigest ?? crypto.createHash("sha256").update(bytes).digest("hex");
  return new DraftCompletionFacts({
    source,
    sourceStepId: "draft-coverage-repair",
    targetStepId: "draft-gate",
    draft: draftDocument,
    draftDigest: sourceDigest,
    draftByteLength: canonicalByteLength ?? bytes.length,
    reviewVerdict,
    reviewDraftDigest: reviewDraftDigest ?? sourceDigest,
    reviewArtifactDigest,
    triageArtifactDigest: triageArtifactDigest === undefined
      ? (triage === null ? null : "3".repeat(64))
      : triageArtifactDigest,
    questionsReviewArtifactDigest,
    triage,
    repair,
  });
}

function completionEvidence(flowManager, specId, { includeTriage = false } = {}) {
  const catalog = flowManager.artifactCatalog(specId).toJSON();
  const artifact = (logicalKey) => catalog.artifacts.find((entry) => entry.logicalKey === logicalKey) ?? null;
  const review = artifact("draft.coverage.review");
  const questionsReview = artifact("draft.questions.review");
  const triage = artifact("draft.coverage.triage");
  assert.ok(review, "coverage review fixture evidence is required");
  assert.ok(questionsReview, "questions review fixture evidence is required");
  if (includeTriage) assert.ok(triage, "coverage triage fixture evidence is required");
  const reviewHistory = JSON.parse(flowManager.readArtifact({
    specId, logicalKey: "draft.coverage.review", consumerNodeId: "draft-coverage-repair",
  }).bytes.toString("utf8"));
  const reviewDocument = reviewHistory.attempts.at(-1).artifact.payload;
  return {
    reviewVerdict: reviewDocument.verdict,
    reviewDraftDigest: reviewDocument.sourceDraftRevision?.digest ?? null,
    reviewArtifactDigest: review.hash,
    questionsReviewArtifactDigest: questionsReview.hash,
    triageArtifactDigest: includeTriage ? triage.hash : null,
    triage: includeTriage
      ? JSON.parse(flowManager.readArtifact({
        specId, logicalKey: "draft.coverage.triage", consumerNodeId: "draft-coverage-repair",
      }).bytes.toString("utf8"))
      : null,
  };
}

function coverageReviewArtifactBytes(flowManager, specId, draftBytes, verdict = "PASS") {
  const payload = {
    version: 2,
    phase: "draft-coverage",
    sourceDraft: "draft.json",
    sourceDraftRevision: new CanonicalDraftReviewSource({
      flowManager, state: flowManager.loadReadOnly(specId), phase: "draft-coverage",
    }).revision(),
    generatedAt: "2026-08-28T00:00:00.000Z",
    verdict,
    summary: verdict === "PASS" ? "No findings." : "Repair is required.",
    blockingFindings: [],
    advisoryFindings: [],
    repairTargets: [],
  };
  assert.equal(payload.sourceDraftRevision.digest, crypto.createHash("sha256").update(draftBytes).digest("hex"));
  const previous = flowManager.readArtifact({
    specId, logicalKey: "draft.coverage.review", consumerNodeId: "draft-coverage-repair", optional: true,
  });
  const history = previous === null ? new FlowArtifactAttemptHistory()
    : FlowArtifactAttemptHistory.fromJSON(JSON.parse(previous.bytes.toString("utf8")));
  const next = history.append(new FlowArtifactAttemptRecord({
    attempt: flowManager.canonicalState(specId).attempt.sequence,
    payload: { artifact: { logicalKey: "draft.coverage.review", payload } },
  }));
  return Buffer.from(`${JSON.stringify(next.toJSON(), null, 2)}\n`, "utf8");
}

function publishCoverageReviewEvidence(flowManager, specId, draftBytes, verdict = "PASS") {
  flowManager.confirmCurrentAttempt({
    specId,
    artifactWrites: [{
      logicalKey: "draft.coverage.review",
      mediaType: "application/json",
      bytes: coverageReviewArtifactBytes(flowManager, specId, draftBytes, verdict),
    }],
  });
}

function persistedSnapshot(flowManager, specId) {
  return JSON.stringify({
    state: flowManager.loadReadOnly(specId),
    activities: flowManager.activityLedger(specId),
    catalog: flowManager.artifactCatalog(specId).toJSON(),
  });
}

function versionFileSnapshot(flowManager, specId) {
  const root = flowManager.specLocation(specId).directory;
  const files = [];
  const collect = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(absolute);
      else if (entry.isFile()) {
        files.push(Object.freeze({
          relativePath: path.relative(root, absolute),
          bytes: fs.readFileSync(absolute),
        }));
      }
    }
  };
  collect(root);
  return Object.freeze(files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)));
}

function completeInitialDraftCoveragePass({ flowManager, specId, runId, claimGate = true }) {
  const fixture = new CanonicalFlowFixture({ flowManager, specId, runId });
  fixture.create().registerActive().activate("draft");
  const source = draft();
  const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`, "utf8");
  flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: sourceBytes }] });
  fixture.activate("draft-coverage-review");
  publishCoverageReviewEvidence(flowManager, specId, sourceBytes);
  fixture.activate("draft-coverage-repair");
  const initial = completionApplication(facts({
    draftDocument: source,
    ...completionEvidence(flowManager, specId),
  }));
  settleCompletion(flowManager, { specId, application: initial });
  const completedBytes = flowManager.readArtifact({
    specId, logicalKey: "draft", consumerNodeId: "draft-gate",
  }).bytes;
  if (claimGate) flowManager.beginNextAction(specId);
  return Object.freeze({ source, sourceBytes, completedBytes });
}

function repairDraftGateForCoverageRecovery({ flowManager, repository, specId }) {
  const scenario = new DraftGateRepairScenario({ flowManager, root: repository, specId }).select({
    issueLogId: `draft-gate-recover-connector-${specId}`,
    observations: [{
      kind: "violation", failureMode: "guardrail-violation", requirementRef: "R-1",
      where: { file: "spec.json", locator: "requirements[0]" },
      observed: "The required behavior is absent from the draft.", severity: "blocking", refs: ["R-1"],
    }, {
      kind: "violation", failureMode: "process-evidence-missing", requirementRef: "process:gate-structure",
      where: null, observed: "The draft omits a required retained behavior.",
      severity: "blocking", refs: ["process:diff-verifiable"],
    }],
  });
  scenario.createRequest();
  return scenario.apply(scenario.replacement(
    "analysis.proposedApproach",
    "Select a connector from canonical coverage facts while retaining the complete behavior contract.",
  ));
}

function uncheckedRecoveryAttempt(state, nodeId) {
  const node = state.findNode(nodeId);
  assert.ok(node, `unchecked recovery requires ${nodeId}`);
  const requiredResources = state.definition.contractForNode(node).resourceContract.required;
  return new CurrentAttempt({
    id: `unchecked-${nodeId}-attempt-${node.attemptSequence + 1}`,
    nodeId,
    sequence: node.attemptSequence + 1,
    startedAt: "2026-08-28T00:00:00.000Z",
    consumption: { semantic: 0, tooling: 0 },
    failure: null,
    blocker: null,
    incomplete: [],
    operationClaims: requiredResources.length === 0
      ? []
      : [{ operation: "resolve-command-context", resources: requiredResources }],
  });
}

/**
 * Enter below the Store boundary so this fixture can retain a stale producer
 * publication. The State/Activity history remains valid; only the review
 * descriptor deliberately retains its preceding Attempt identity.
 */
function recoverAttemptWithoutStoreAdmission(flowManager, specId, nodeId) {
  const state = flowManager.canonicalState(specId);
  const next = state.nextAction();
  assert.equal(next.nodeId, nodeId);
  assert.equal(next.operation, "recover");
  const attempt = uncheckedRecoveryAttempt(state, nodeId);
  flowManager._store.runtime.recover({
    specId,
    activityId: `unchecked-${nodeId}-recovered-${attempt.sequence}`,
    nodeId,
    attempt: attempt.toJSON(),
  });
  return attempt;
}

function confirmAttemptWithoutStorePublication(flowManager, specId, attempt) {
  flowManager._store.runtime.confirmAttempt({
    specId,
    activityId: `unchecked-${attempt.nodeId}-confirmed-${attempt.sequence}`,
    result: {
      outcome: "passed",
      summary: `unchecked confirmation for ${attempt.nodeId}`,
      confirmedAt: "2026-08-28T00:00:00.000Z",
      artifactRefs: [],
    },
  });
}

describe("DraftCompletionConnector", () => {
  it("materializes the selected coverage PASS connector through the production Review path", async () => {
    const repository = createTmpDir("draft-coverage-review-production-path-");
    const specId = "715f-coverage-review-production-path";
    const flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    try {
      const fixture = new CanonicalFlowFixture({ flowManager, specId, runId: "715f-review-production-run" });
      fixture.create().registerActive().activate("draft");
      const source = draft();
      const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`, "utf8");
      flowManager.confirmCurrentAttempt({
        specId,
        artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: sourceBytes }],
      });
      fixture.activate("draft-coverage-review");
      const reviewState = flowManager.canonicalState(specId);
      const reviewBinding = {
        runId: reviewState.runId,
        specId,
        stepId: "draft-coverage-review",
        attempt: reviewState.attempt,
      };
      const executionResult = new DraftCoverageReviewExecutionRequiredResult();
      const executionSettlement = settleDraftStepResult(reviewBinding.stepId, executionResult);
      const executionBinding = new DraftReviewExecutionBinding({
        executionGeneration: 0,
        manifestDigest: "c".repeat(64),
        inputDigest: "d".repeat(64),
        target: new DraftReviewExecutionTargetIdentity({
          treeSha: "a".repeat(40),
          targetStateDigest: "b".repeat(64),
        }),
      });
      flowManager.checkpointDraftStepExecution({
        binding: reviewBinding,
        stepResult: executionResult,
        settlement: executionSettlement,
        executionBinding,
      });
      flowManager.claimDraftStepExecution({
        binding: reviewBinding,
        stepResult: executionResult,
        settlement: executionSettlement,
        executionBinding,
        executionClaim: new DraftReviewExecutionClaim(),
      });
      const history = JSON.parse(coverageReviewArtifactBytes(flowManager, specId, sourceBytes).toString("utf8"));
      const payload = history.attempts.at(-1).artifact.payload;
      const result = attachCanonicalCommandResultArtifact({
        result: "ok",
        artifacts: { phase: "draft-coverage", retryPhase: "draft-coverage", verdict: "PASS" },
      }, { logicalKey: "draft.coverage.review", payload });
      const settle = flowManager.settleDraftStepResult.bind(flowManager);
      const observedSettlements = [];
      flowManager.settleDraftStepResult = (input) => {
        observedSettlements.push(input.settlement);
        if (!(input.settlement instanceof DraftExecutionSettlement)) {
          assert.ok(input.settlement.application instanceof DraftCompletionSettlementApplication);
          assert.equal(Object.hasOwn(input, "draftCompletionFacts"), false);
        }
        return settle(input);
      };

      await FLOW_COMMANDS.run.review.post({
        root: repository,
        mainRoot: repository,
        executionRoot: repository,
        specId,
        phase: "draft-coverage",
        flowManager,
        flowState: flowManager.loadReadOnly(specId),
      }, result);
      assert.equal(observedSettlements.length, 2);
      assert.ok(observedSettlements[0] instanceof DraftExecutionSettlement);

      const reloaded = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
      const state = reloaded.canonicalState(specId);
      assert.equal(state.nextAction().nodeId, "draft-gate");
      assert.equal(state.findNode("draft-coverage-review").result.stepResult.kind, "draft-coverage-review-passed");
      assert.equal(state.findNode("draft-coverage-review").result.draftSettlementReceipt.targetStepId, "draft-gate");
      assert.equal(reloaded.activityLedger(specId).at(-1).transition.stepConnectionReceipt.sourceStepId,
        "draft-coverage-review");
      assert.deepEqual(reloaded.readArtifact({
        specId, logicalKey: "draft", consumerNodeId: "draft-gate",
      }).bytes, sourceBytes);
    } finally {
      removeTmpDir(repository);
    }
  });

  it("confirms coverage PASS on its Review Attempt with a durable completion receipt", () => {
    const repository = createTmpDir("draft-coverage-review-completion-");
    const specId = "715f-coverage-review-source";
    const flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    try {
      const fixture = new CanonicalFlowFixture({ flowManager, specId, runId: "715f-review-run" });
      fixture.create().registerActive().activate("draft");
      const source = draft();
      const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`, "utf8");
      flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: sourceBytes }] });
      fixture.activate("draft-coverage-review");
      const beforeUnauthorizedWrite = persistedSnapshot(flowManager, specId);
      assert.throws(() => flowManager.publishArtifacts({
        specId, nodeId: "draft-coverage-review",
        artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: sourceBytes }],
      }), /only through its selected completion connector/);
      assert.equal(persistedSnapshot(flowManager, specId), beforeUnauthorizedWrite);
      flowManager.publishArtifacts({
        specId, nodeId: "draft-coverage-review",
        artifactWrites: [{ logicalKey: "draft.coverage.review", mediaType: "application/json",
          bytes: coverageReviewArtifactBytes(flowManager, specId, sourceBytes) }],
      });
      const draftBeforePass = flowManager.artifactCatalog(specId).toJSON().artifacts
        .find((artifact) => artifact.logicalKey === "draft");
      const evidence = completionEvidence(flowManager, specId);
      const selected = completionApplication(facts({
        source: "coverage-pass", draftDocument: source, ...evidence,
      }));
      // The default fixture facts target the passive repair connector. The
      // Review source uses the same canonical evidence and selected connector.
      const reviewSelected = completionApplication(new DraftCompletionFacts({
        ...selected.facts.toJSON(), sourceStepId: "draft-coverage-review", draft: source,
      }));
      const publishedButUnconfirmed = persistedSnapshot(flowManager, specId);
      const invalidResult = new DraftCoverageReviewFindingsResult();
      assert.throws(() => settleCompletion(flowManager, {
        specId, application: reviewSelected, stepResult: invalidResult,
      }), /exact Result binding/);
      assert.equal(persistedSnapshot(flowManager, specId), publishedButUnconfirmed);
      const passedResult = new DraftCoverageReviewPassedResult();
      settleCompletion(flowManager, {
        specId, application: reviewSelected, stepResult: passedResult,
      });
      const reloaded = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
      const state = reloaded.canonicalState(specId);
      const draftAfterPass = reloaded.artifactCatalog(specId).toJSON().artifacts
        .find((artifact) => artifact.logicalKey === "draft");
      assert.equal(state.nextAction().nodeId, "draft-gate");
      assert.deepEqual(draftAfterPass, draftBeforePass, "coverage PASS must not republish the Draft revision");
      assert.deepEqual(
        reloaded.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-gate" }).bytes,
        sourceBytes,
        "coverage PASS must preserve canonical Draft bytes",
      );
      assert.deepEqual(state.findNode("draft-coverage-review").result.stepResult.toJSON(),
        passedResult.toJSON());
      assert.equal(state.findNode("draft-coverage-review").result.draftSettlementReceipt.targetStepId, "draft-gate");
      assert.equal(reloaded.activityLedger(specId).at(-1).transition.stepConnectionReceipt.sourceStepId,
        "draft-coverage-review");
    } finally {
      removeTmpDir(repository);
    }
  });

  it("leaves Draft Review lifecycle settlement to the typed Step route", () => {
    const actions = resolveLifecyclePlan({
      event: "review:post",
      currentStepId: "draft-coverage-review",
      phase: "draft",
      result: { artifacts: { phase: "draft-coverage", retryPhase: "draft-coverage", verdict: "PASS" } },
      flowState: { policy: { nonblocking: { enabled: false } } },
    }).actions;

    assert.deepEqual(actions, []);
  });

  it("is selected by Definition for the no-repair coverage path without changing the draft", () => {
    const source = draft();
    const connector = resolveDraftCompletionConnector(facts({ draftDocument: source }));

    assert.ok(connector instanceof DraftCompletionConnector);
    assert.equal(connector.source, "coverage-pass");
    assert.equal(connector.sourceStepId, "draft-coverage-repair");
    assert.equal(connector.targetStepId, "draft-gate");
    assert.equal(connector.expectedDraftDigest, facts({ draftDocument: source }).draftDigest);
    const connected = connector.applyTo(source);
    assert.deepEqual(connected, source);
    assert.notEqual(connected, source);
  });

  it("is selected after a valid coverage repair while keeping discarded unrelated operations auditable", () => {
    const source = draft();
    const connector = resolveDraftCompletionConnector(facts({
      source: "coverage-repair",
      draftDocument: source,
      reviewVerdict: "REJECTED",
      triage: { items: [{ decision: "apply" }] },
      repair: repairAudit({
        discardedOperations: [{ reason: "out-of-scope operation" }],
      }),
    }));

    assert.ok(connector instanceof DraftCompletionConnector);
    assert.equal(connector.source, "coverage-repair");
    assert.deepEqual(connector.applyTo(source), source);
  });

  it("rejects completion selection when canonical coverage facts are incomplete, stale, or structurally invalid", () => {
    const unresolved = {
      state: "AwaitingUserAnswer",
      id: "q1",
      category: "user-visible-behavior",
      question: "Which behavior should be selected?",
      revision: 0,
      provenance: { producer: "test" },
      evidenceDigest: "d".repeat(64),
    };
    const cases = [
      facts({ draftDocument: draft({ questions: [unresolved] }) }),
      facts({ reviewVerdict: "REJECTED" }),
      facts({ triage: { items: [{ decision: "requires_user_decision" }] }, repair: repairAudit() }),
      facts({ source: "coverage-repair", triage: { items: [{ decision: "requires_user_decision" }] }, repair: repairAudit() }),
      facts({ source: "coverage-repair", triage: { items: [{ decision: "apply" }] }, repair: repairAudit({ audit: { envelopeErrors: ["invalid"], baseRevisionMatches: true, missingRequiredTargets: [], lifecycleIssues: [] } }) }),
      facts({ source: "coverage-repair", triage: { items: [{ decision: "apply" }] }, repair: repairAudit({ audit: { envelopeErrors: [], baseRevisionMatches: false, missingRequiredTargets: [], lifecycleIssues: [] } }) }),
      facts({ source: "coverage-repair", triage: { items: [{ decision: "apply" }] }, repair: repairAudit({ audit: { envelopeErrors: [], baseRevisionMatches: true, missingRequiredTargets: [{ path: "goal" }], lifecycleIssues: [] } }) }),
    ];

    for (const candidate of cases) {
      assert.throws(() => resolveDraftCompletionConnector(candidate), /connector is unavailable/);
      assert.throws(() => completionApplication(candidate), /connector is unavailable/);
    }
    assert.throws(() => facts({ reviewArtifactDigest: null }), /review artifact digest/i);
    assert.throws(() => facts({ questionsReviewArtifactDigest: null }), /questions review artifact digest/i);
    assert.throws(() => facts({
      source: "coverage-repair", triageArtifactDigest: null, reviewVerdict: "REJECTED",
      triage: { items: [{ decision: "apply" }] }, repair: repairAudit(),
    }), /triage document and publication digest/i);
  });

  it("binds connector application to the exact canonical draft revision", () => {
    const source = draft();
    const connector = resolveDraftCompletionConnector(facts({ draftDocument: source }));
    const changed = { ...source, goal: "A different canonical draft." };

    assert.throws(
      () => connector.applyTo(changed),
      /draft revision/i,
    );
    assert.equal(digest(connector.toJSON()).length, 64);
  });

  it("publishes completion, catalog provenance, and repair-to-gate promotion in one replay-safe transaction", () => {
    const repository = createTmpDir("draft-completion-connector-");
    const specId = "715f-draft-completion";
    const flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    try {
      const fixture = new CanonicalFlowFixture({ flowManager, specId, runId: "715f-run" });
      fixture.create().registerActive().activate("draft");
      const source = draft();
      const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`, "utf8");
      flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: sourceBytes }] });
      fixture.activate("draft-coverage-review");
      publishCoverageReviewEvidence(flowManager, specId, sourceBytes);
      fixture.activate("draft-coverage-repair");
      const evidence = completionEvidence(flowManager, specId);
      const selected = completionApplication(facts({
        draftDocument: source,
        ...evidence,
      }));
      const draftBeforeCompletion = flowManager.artifactCatalog(specId).toJSON().artifacts
        .find((artifact) => artifact.logicalKey === "draft");
      const before = flowManager.activityLedger(specId).length;
      const beforeInvalidOutput = persistedSnapshot(flowManager, specId);
      const invalidResult = new DraftCoverageRepairChangedResult();
      assert.throws(() => settleCompletion(flowManager, {
        specId, application: selected, stepResult: invalidResult,
      }), /exact Result binding/);
      assert.equal(persistedSnapshot(flowManager, specId), beforeInvalidOutput);
      const completedResult = new DraftCoverageRepairUnchangedResult();
      settleCompletion(flowManager, {
        specId, application: selected, stepResult: completedResult,
      });

      const state = flowManager.loadReadOnly(specId);
      const ledger = flowManager.activityLedger(specId);
      const published = flowManager.readArtifact({
        specId, logicalKey: "draft", consumerNodeId: "draft-gate",
      });
      assert.deepEqual(JSON.parse(published.bytes.toString("utf8")), source);
      assert.equal(findStepById(state.steps, "draft-coverage-repair").status, "done");
      assert.equal(state.currentNodeId, null, "the connector promotes the target but does not pre-claim its Attempt");
      const canonical = flowManager.canonicalState(specId);
      assert.equal(canonical.attempt, null, "beginNextAction remains the only normal target Attempt owner");
      assert.equal(flowManager.canonicalState(specId).nextAction().operation, "start");
      assert.equal(flowManager.canonicalState(specId).nextAction().nodeId, "draft-gate");
      assert.equal(ledger.length, before + 1);
      assert.deepEqual(published.descriptor, draftBeforeCompletion);
      assert.equal(ledger.at(-1).result.artifactRefs.at(-1).kind, "draft-completion-connector");
      assert.deepEqual(ledger.at(-1).result.stepResult, completedResult.toJSON());
      assert.equal(ledger.at(-1).transition.stepConnectionReceipt.kind, "draft-completion");
      assert.equal(ledger.at(-1).transition.stepConnectionReceipt.targetStepId, "draft-gate");
      assert.equal(ledger.at(-1).transition.stepConnectionReceipt.lineage.coverageReview.logicalKey, "draft.coverage.review");

      flowManager.beginNextAction(specId);
      assert.equal(flowManager.canonicalState(specId).current.at(-1), "draft-gate");
      const afterTargetClaim = flowManager.activityLedger(specId).length;

      settleCompletion(flowManager, { specId, application: selected });
      assert.equal(flowManager.activityLedger(specId).length, afterTargetClaim, "replay must not duplicate the connector Activity or target claim");

      const staleDraft = { ...source, goal: "A stale alternative completion." };
      const staleDecision = completionApplication(facts({
        draftDocument: staleDraft,
        canonicalDigest: selected.facts.draftDigest,
        canonicalByteLength: selected.facts.draftByteLength,
        ...evidence,
      }));
      const beforeStaleReplay = persistedSnapshot(flowManager, specId);
      assert.throws(
        () => settleCompletion(flowManager, { specId, application: staleDecision }),
        /different Result, Settlement, or Publication/i,
      );
      assert.equal(persistedSnapshot(flowManager, specId), beforeStaleReplay);
    } finally {
      removeTmpDir(repository);
    }
  });

  it("rejects a stale recovered coverage review before the atomic connector changes durable state", () => {
    const repository = createTmpDir("draft-completion-connector-stale-admission-");
    const specId = "715f-draft-completion-stale-admission";
    const flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    try {
      const { source } = completeInitialDraftCoveragePass({
        flowManager, specId, runId: "715f-stale-admission-run", claimGate: false,
      });
      // Re-review the same canonical draft through the public rewind route.
      // Gate repair now requires a changed draft, which would mask the stale
      // producer Attempt with an earlier revision mismatch in this test.
      flowManager.rewindTo("draft-coverage-review", { specId });
      const staleReview = flowManager.canonicalState(specId).attempt;
      confirmAttemptWithoutStorePublication(flowManager, specId, staleReview);
      const triage = recoverAttemptWithoutStoreAdmission(
        flowManager, specId, "draft-coverage-triage",
      );
      confirmAttemptWithoutStorePublication(flowManager, specId, triage);
      const stateBefore = flowManager.canonicalState(specId);
      assert.equal(stateBefore.nextAction().nodeId, "draft-coverage-repair");
      assert.equal(stateBefore.nextAction().operation, "recover");
      assert.equal(stateBefore.findNode("draft-coverage-review").attemptSequence, 2);
      const reviewDescriptor = flowManager.artifactCatalog(specId).toJSON().artifacts
        .find((artifact) => artifact.logicalKey === "draft.coverage.review");
      const reviewPublication = flowManager.activityLedger(specId)
        .find((activity) => activity.id === reviewDescriptor.activityId);
      assert.equal(reviewPublication.sequence, 1, "the catalog must retain the preceding review Attempt");

      // The facts reader still sees the retained Attempt 1 review bytes. The
      // Step connection must instead bind that descriptor to Attempt 2.
      const selected = completionApplication(facts({
        draftDocument: source,
        ...completionEvidence(flowManager, specId),
      }));
      flowManager.beginNextAction(specId);
      const beforeState = persistedSnapshot(flowManager, specId);
      const beforeFiles = versionFileSnapshot(flowManager, specId);
      assert.throws(
        () => settleCompletion(flowManager, { specId, application: selected }),
        /canonical producer artifact is not ready for draft-gate: draft\.coverage\.review has no matching confirmed producer Activity/,
      );
      assert.equal(persistedSnapshot(flowManager, specId), beforeState);
      assert.deepEqual(versionFileSnapshot(flowManager, specId), beforeFiles);
    } finally {
      removeTmpDir(repository);
    }
  });

  it("recovers the invalidated draft completion source after guarded draft-gate repair without fabricating pass triage or repair output", () => {
    const repository = createTmpDir("draft-completion-recover-after-gate-repair-");
    const specId = "715f-draft-completion-recover";
    const flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    try {
      completeInitialDraftCoveragePass({
        flowManager, specId, runId: "715f-recover-run",
      });
      const { source, bytes: completedBytes } = repairDraftGateForCoverageRecovery({ flowManager, repository, specId });
      assert.equal(flowManager.canonicalState(specId).nextAction().operation, "recover");
      assert.equal(flowManager.canonicalState(specId).nextAction().nodeId, "draft-coverage-review");
      flowManager.beginNextAction(specId);
      publishCoverageReviewEvidence(flowManager, specId, completedBytes);
      assert.equal(flowManager.canonicalState(specId).nextAction().operation, "recover");
      assert.equal(flowManager.canonicalState(specId).nextAction().nodeId, "draft-coverage-triage");
      flowManager.beginNextAction(specId);
      flowManager.confirmCurrentAttempt({ specId });
      flowManager.beginNextAction(specId);

      const before = flowManager.activityLedger(specId).length;
      const beforeCatalog = flowManager.artifactCatalog(specId).toJSON().artifacts
        .filter((artifact) => ["draft.coverage.triage", "draft.coverage.repair"].includes(artifact.logicalKey));
      const recovered = completionApplication(facts({
        draftDocument: source,
        ...completionEvidence(flowManager, specId),
      }));
      settleCompletion(flowManager, { specId, application: recovered });

      const state = flowManager.canonicalState(specId);
      const activity = flowManager.activityLedger(specId).at(-1);
      const afterCatalog = flowManager.artifactCatalog(specId).toJSON().artifacts
        .filter((artifact) => ["draft.coverage.triage", "draft.coverage.repair"].includes(artifact.logicalKey));
      assert.equal(state.findNode("draft-coverage-repair").status, "done");
      assert.equal(
        state.findNode("draft-coverage-repair").attemptSequence,
        2,
        "the connector must recover the invalidated source rather than starting a fresh first Attempt",
      );
      assert.equal(state.attempt, null, "the atomic connector must not claim the target");
      assert.equal(state.nextAction().nodeId, "draft-gate");
      assert.equal(state.nextAction().operation, "recover");
      assert.equal(activity.transition.operation, "complete_draft_completion");
      assert.equal(flowManager.activityLedger(specId).length, before + 1);
      assert.deepEqual(afterCatalog, beforeCatalog, "a coverage PASS must not invent triage or repair artifacts");
      assert.deepEqual(JSON.parse(flowManager.readArtifact({
        specId, logicalKey: "draft", consumerNodeId: "draft-gate",
      }).bytes.toString("utf8")), source);

      flowManager.beginNextAction(specId);
      assert.equal(flowManager.canonicalState(specId).current.at(-1), "draft-gate");
      assert.equal(flowManager.canonicalState(specId).attempt.sequence, 2);
    } finally {
      removeTmpDir(repository);
    }
  });

  it("publishes a repaired draft, its audit, and completion together when repair facts are eligible", () => {
    const repository = createTmpDir("draft-completion-repair-");
    const specId = "715f-draft-completion-repair";
    const flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    try {
      const fixture = new CanonicalFlowFixture({ flowManager, specId, runId: "715f-repair-run" });
      fixture.create().registerActive().activate("draft");
      const source = draft();
      const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`, "utf8");
      flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: sourceBytes }] });
      fixture.activate("draft-coverage-review");
      publishCoverageReviewEvidence(flowManager, specId, sourceBytes, "REJECTED");
      const triageDocument = {
        version: 1,
        phase: "draft-coverage-triage",
        sourceReview: "draft-review-coverage.json",
        summary: "Apply the selected repair.",
        items: [{ decision: "apply" }],
      };
      fixture.activate("draft-coverage-triage");
      flowManager.confirmCurrentAttempt({
        specId,
        artifactWrites: [{
          logicalKey: "draft.coverage.triage",
          mediaType: "application/json",
          bytes: Buffer.from(`${JSON.stringify(triageDocument, null, 2)}\n`, "utf8"),
        }],
      });
      fixture.activate("draft-coverage-repair");
      const repaired = { ...source, goal: "Repaired canonical coverage goal." };
      const audit = repairAudit({
        acceptedOperations: [{ path: "goal" }],
        operationDigest: "e".repeat(64),
      });
      const selected = completionApplication(facts({
        source: "coverage-repair",
        draftDocument: repaired,
        ...completionEvidence(flowManager, specId, { includeTriage: true }),
        canonicalDigest: crypto.createHash("sha256").update(sourceBytes).digest("hex"),
        canonicalByteLength: sourceBytes.length,
        reviewVerdict: "REJECTED",
        triage: triageDocument,
        repair: audit,
      }));
      settleCompletion(flowManager, {
        specId,
        application: selected,
        artifactBaselines: [{
          logicalKey: "draft",
          digest: crypto.createHash("sha256").update(sourceBytes).digest("hex"),
          byteLength: sourceBytes.length,
        }],
        artifactWrites: [{
          logicalKey: "draft.coverage.repair",
          mediaType: "application/json",
          bytes: Buffer.from(`${JSON.stringify(audit, null, 2)}\n`, "utf8"),
        }],
      });

      const published = JSON.parse(flowManager.readArtifact({
        specId, logicalKey: "draft", consumerNodeId: "draft-gate",
      }).bytes.toString("utf8"));
      const repairPublication = flowManager.readArtifact({
        specId, logicalKey: "draft.coverage.repair", consumerNodeId: "draft-gate",
      });
      const activity = flowManager.activityLedger(specId).at(-1);
      assert.deepEqual(published, repaired);
      assert.equal(repairPublication.descriptor.activityId, activity.id);
      assert.equal(activity.result.artifactRefs.at(-1).kind, "draft-completion-connector");
    } finally {
      removeTmpDir(repository);
    }
  });

  it("rejects a stale draft/refine revision without any completion side effect", () => {
    const repository = createTmpDir("draft-completion-stale-");
    const specId = "715f-draft-completion-stale";
    const flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    try {
      const fixture = new CanonicalFlowFixture({ flowManager, specId, runId: "715f-stale-run" });
      fixture.create().registerActive().activate("draft");
      const source = draft();
      flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(source, null, 2)}\n`) }] });
      fixture.activate("draft-coverage-review");
      publishCoverageReviewEvidence(flowManager, specId, Buffer.from(`${JSON.stringify(source, null, 2)}\n`, "utf8"));
      fixture.activate("draft-coverage-repair");
      const selected = completionApplication(facts({
        draftDocument: source,
        ...completionEvidence(flowManager, specId),
      }));
      const changed = { ...source, goal: "A changed draft/refine canonical revision." };
      flowManager.publishArtifacts({
        specId,
        nodeId: "draft-coverage-repair",
        artifactWrites: [{
          logicalKey: "draft", mediaType: "application/json",
          bytes: Buffer.from(`${JSON.stringify(changed, null, 2)}\n`, "utf8"),
        }],
      });
      const before = persistedSnapshot(flowManager, specId);

      assert.throws(
        () => settleCompletion(flowManager, { specId, application: selected }),
        /stale canonical draft revision/i,
      );
      assert.equal(persistedSnapshot(flowManager, specId), before);
    } finally {
      removeTmpDir(repository);
    }
  });

  it("rejects a selected source Attempt that became stale without publishing completion", () => {
    const repository = createTmpDir("draft-completion-stale-attempt-");
    const specId = "715f-draft-completion-stale-attempt";
    const flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    try {
      const fixture = new CanonicalFlowFixture({ flowManager, specId, runId: "715f-stale-attempt-run" });
      fixture.create().registerActive().activate("draft");
      const source = draft();
      const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`, "utf8");
      flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: sourceBytes }] });
      fixture.activate("draft-coverage-review");
      publishCoverageReviewEvidence(flowManager, specId, sourceBytes);
      fixture.activate("draft-coverage-repair");
      const selected = completionApplication(facts({
        draftDocument: source,
        ...completionEvidence(flowManager, specId),
      }));
      flowManager.failCurrentAttempt({
        specId,
        failure: { category: "tooling", code: "TEST_STALE_SOURCE", message: "The selected source Attempt was superseded.", retryable: true, retryKind: "tooling" },
      });
      const before = persistedSnapshot(flowManager, specId);
      assert.throws(
        () => settleCompletion(flowManager, { specId, application: selected }),
        /cannot overwrite a failed Attempt/i,
      );
      assert.equal(persistedSnapshot(flowManager, specId), before);
    } finally {
      removeTmpDir(repository);
    }
  });

  it("rejects stale selected coverage, triage, and questions lineage without completion side effects", () => {
    for (const [logicalKey, message] of [
      ["draft.coverage.review", /stale coverage review artifact/i],
      ["draft.coverage.triage", /stale coverage triage artifact/i],
      ["draft.questions.review", /stale questions review artifact/i],
    ]) {
      const repository = createTmpDir(`draft-completion-stale-${logicalKey.replaceAll(".", "-")}-`);
      const specId = `715f-stale-${logicalKey.replaceAll(".", "-")}`;
      const flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
      try {
        const fixture = new CanonicalFlowFixture({ flowManager, specId, runId: `715f-${logicalKey}-run` });
        fixture.create().registerActive().activate("draft");
        const source = draft();
        const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`, "utf8");
        flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: sourceBytes }] });
        fixture.activate("draft-coverage-review");
        publishCoverageReviewEvidence(flowManager, specId, sourceBytes, "REJECTED");
        const triageDocument = {
          version: 1,
          phase: "draft-coverage-triage",
          sourceReview: "draft-review-coverage.json",
          summary: "No repair is required for this stale-plan fixture.",
          items: [{ decision: "apply" }],
        };
        fixture.activate("draft-coverage-triage");
        flowManager.confirmCurrentAttempt({
          specId,
          artifactWrites: [{
            logicalKey: "draft.coverage.triage",
            mediaType: "application/json",
            bytes: Buffer.from(`${JSON.stringify(triageDocument, null, 2)}\n`, "utf8"),
          }],
        });
        fixture.activate("draft-coverage-repair");
        const canonicalDraft = flowManager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-coverage-repair" });
        const coverageReview = flowManager.readArtifact({ specId, logicalKey: "draft.coverage.review", consumerNodeId: "draft-coverage-repair" });
        const coverageTriage = flowManager.readArtifact({ specId, logicalKey: "draft.coverage.triage", consumerNodeId: "draft-coverage-repair" });
        const questionsReview = flowManager.readCanonicalTransitionView({
          specId,
          read: (view) => view.catalog.artifacts.find((artifact) => artifact.logicalKey === "draft.questions.review") ?? null,
        });
        assert.ok(questionsReview, "questions review must be cataloged before completion selection");
        const selectedDraft = JSON.parse(canonicalDraft.bytes.toString("utf8"));
        const staleDigest = logicalKey === "draft.coverage.review"
          ? (coverageReview.descriptor.hash === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64))
          : logicalKey === "draft.coverage.triage"
            ? (coverageTriage.descriptor.hash === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64))
          : (questionsReview.hash === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64));
        const audit = repairAudit();
        const selected = completionApplication(facts({
          source: "coverage-repair",
          draftDocument: selectedDraft,
          canonicalDigest: canonicalDraft.descriptor.hash,
          canonicalByteLength: canonicalDraft.descriptor.size,
          ...completionEvidence(flowManager, specId, { includeTriage: true }),
          reviewVerdict: "REJECTED",
          triage: triageDocument,
          repair: audit,
          reviewArtifactDigest: logicalKey === "draft.coverage.review" ? staleDigest : coverageReview.descriptor.hash,
          triageArtifactDigest: logicalKey === "draft.coverage.triage" ? staleDigest : coverageTriage.descriptor.hash,
          questionsReviewArtifactDigest: logicalKey === "draft.questions.review" ? staleDigest : questionsReview.hash,
        }));
        const before = persistedSnapshot(flowManager, specId);
        assert.throws(
          () => settleCompletion(flowManager, {
            specId,
            application: selected,
            artifactWrites: [{
              logicalKey: "draft.coverage.repair",
              mediaType: "application/json",
              bytes: Buffer.from(`${JSON.stringify(audit, null, 2)}\n`, "utf8"),
            }],
          }),
          message,
        );
        assert.equal(persistedSnapshot(flowManager, specId), before, `${logicalKey} stale rejection must be side-effect free`);
      } finally {
        removeTmpDir(repository);
      }
    }
  });

  it("rejects an unavailable connector before completion can publish or promote", () => {
    const repository = createTmpDir("draft-completion-no-connector-");
    const specId = "715f-draft-completion-no-connector";
    fs.writeFileSync(`${repository}/README.md`, "draft completion gate fixture\n");
    initGitRepo(repository);
    commitAll(repository, "fixture baseline");
    const flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    try {
      const fixture = new CanonicalFlowFixture({ flowManager, specId, runId: "715f-no-connector-run" });
      fixture.create().registerActive().activate("draft");
      const source = draft();
      const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`, "utf8");
      flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: sourceBytes }] });
      fixture.activate("draft-coverage-review");
      publishCoverageReviewEvidence(flowManager, specId, sourceBytes);
      fixture.activate("draft-coverage-repair");
      const before = persistedSnapshot(flowManager, specId);
      assert.throws(() => completionApplication(facts({
        draftDocument: source,
        ...completionEvidence(flowManager, specId),
        reviewVerdict: "REJECTED",
      })), /connector is unavailable/);
      assert.equal(persistedSnapshot(flowManager, specId), before);
      assert.equal(flowManager.canonicalState(specId).nextAction().nodeId, "draft-coverage-repair");
      assert.equal(flowManager.canonicalState(specId).attempt?.nodeId, "draft-coverage-repair");
    } finally {
      removeTmpDir(repository);
    }
  });

  it("rejects malformed and incomplete drafts at every canonical writer before publication", () => {
    const repository = createTmpDir("draft-publication-boundary-");
    const flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    try {
      for (const stepId of ["draft", "draft-questions-repair", "draft-refine", "draft-gate-repair", "draft-coverage-repair"]) {
        const specId = `715f-${stepId}`;
        new CanonicalFlowFixture({ flowManager, specId, runId: `draft-publication-${stepId}` })
          .create().registerActive().activate(stepId);
        for (const [caseName, bytes] of [
          ["malformed", Buffer.from("{ invalid", "utf8")],
          ["incomplete", Buffer.from(JSON.stringify({ ...draft(), goal: "" }), "utf8")],
          ["retired-approval", Buffer.from(JSON.stringify({ ...draft(), approval: { approved: false } }), "utf8")],
        ]) {
          const before = persistedSnapshot(flowManager, specId);
          assert.throws(
            () => flowManager.publishArtifacts({
              specId,
              nodeId: stepId,
              artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes }],
            }),
            /draft publication (is invalid|is incomplete)/,
          );
          assert.equal(persistedSnapshot(flowManager, specId), before, `${stepId} ${caseName} rejection must be atomic`);
        }
      }
    } finally {
      removeTmpDir(repository);
    }
  });

  it("allows an intermediate question-state writer but rejects final connector completion", () => {
    const repository = createTmpDir("draft-question-publication-boundary-");
    const specId = "715f-draft-question-publication";
    const flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    try {
      new CanonicalFlowFixture({ flowManager, specId, runId: "draft-question-publication" })
        .create().registerActive().activate("draft");
      const candidate = {
        state: "CandidateQuestion",
        id: "q1",
        category: "user-visible-behavior",
        question: "Which behavior should be selected?",
        revision: 0,
        provenance: { producer: "test" },
        evidenceDigest: "d".repeat(64),
      };
      flowManager.publishArtifacts({
        specId,
        nodeId: "draft",
        artifactWrites: [{
          logicalKey: "draft",
          mediaType: "application/json",
          bytes: Buffer.from(JSON.stringify(draft({ questions: [candidate] })), "utf8"),
        }],
      });
      const unresolvedDraft = draft({ questions: [candidate] });
      flowManager.confirmCurrentAttempt({ specId });
      assert.equal(flowManager.canonicalState(specId).findNode("draft").status, "done");
      assert.equal(flowManager.canonicalState(specId).nextAction().nodeId, "draft-questions-review");
      assert.throws(
        () => resolveDraftCompletionConnector(facts({ draftDocument: unresolvedDraft })),
        /connector is unavailable/,
      );
    } finally {
      removeTmpDir(repository);
    }
  });

  it("rehydrates the Activity receipt into typed fixed lineage slots", () => {
    const repository = createTmpDir("draft-completion-receipt-reload-");
    const specId = "715f-draft-completion-receipt-reload";
    const flowManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    try {
      const fixture = new CanonicalFlowFixture({ flowManager, specId, runId: "715f-receipt-reload-run" });
      fixture.create().registerActive().activate("draft");
      const source = draft();
      const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`, "utf8");
      flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: sourceBytes }] });
      fixture.activate("draft-coverage-review");
      publishCoverageReviewEvidence(flowManager, specId, sourceBytes);
      fixture.activate("draft-coverage-repair");
      settleCompletion(flowManager, {
        specId,
        application: completionApplication(facts({
          draftDocument: source,
          ...completionEvidence(flowManager, specId),
        })),
      });

      const persisted = flowManager.activityLedger(specId).at(-1).transition.stepConnectionReceipt;
      const reloaded = StepConnectionReceipt.fromJSON(JSON.parse(JSON.stringify(persisted)));
      assert.equal(reloaded.id, persisted.id);
      assert.ok(reloaded.lineage.questionsReview instanceof DraftCompletionCatalogBinding);
      assert.ok(reloaded.lineage.questionsRefine instanceof DraftCompletionCatalogBinding);
      assert.ok(reloaded.lineage.coverageReview instanceof DraftCompletionCatalogBinding);
      assert.ok(reloaded.lineage.coverageTriage instanceof DraftCompletionAbsentLineage);
      assert.equal(reloaded.lineage.coverageTriage.reason, "coverage-pass");
      assert.ok(reloaded.lineage.coverageRepair instanceof DraftCompletionAbsentLineage);
      assert.equal(reloaded.lineage.coverageRepair.reason, "coverage-pass");
      assert.ok(reloaded.lineage.canonicalDraft instanceof DraftCompletionCatalogBinding);
      const altered = structuredClone(persisted);
      altered.decisionEvidence.discardedOperationCount += 1;
      assert.throws(() => StepConnectionReceipt.fromJSON(altered), /content digest/i);
      assert.throws(() => new ActivityStepConnectionReceipt(altered), /content digest/i);
      const malformed = structuredClone(persisted);
      malformed.lineage = {};
      malformed.id = receiptId(malformed);
      assert.throws(() => StepConnectionReceipt.fromJSON(malformed), /unsupported fields/i);
      assert.throws(() => new ActivityStepConnectionReceipt(malformed), /schema is invalid/i);
    } finally {
      removeTmpDir(repository);
    }
  });
});
