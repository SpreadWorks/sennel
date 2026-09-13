import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  FLOW_COMMANDS,
} from "../../../src/flow/registry.js";
import GetStatusCommand from "../../../src/flow/lib/get-status.js";
import {
  RequirementTestLifecycleFacts,
  RequirementTestLifecycleDecision,
  RequirementTestStepObservation,
  initializeRequirementTestLifecycle,
  resolveRequirementTestLifecycle,
} from "../../../src/flow/definition.js";
import {
  attachCanonicalCommandResultArtifact,
  attachedCanonicalCommandResultArtifact,
} from "../../../src/flow/lib/canonical-command-result.js";
import { CurrentAttempt } from "../../../src/flow/lib/current-flow-state.js";
import {
  RequirementTestCandidateBundle,
  RequirementTestCandidateSource,
  RequirementTestGateObservation,
  RequirementTestGateResult,
  RequirementTestPlanArtifact,
} from "../../../src/flow/lib/requirement-test-artifacts.js";
import {
  RequirementTestBudget,
  RequirementTestBundleLineage,
  RequirementTestBundleRevision,
  RequirementTestLifecycleAuthority,
} from "../../../src/flow/lib/requirement-test-lifecycle.js";
import { RequirementTestArtifactStore } from "../../../src/flow/lib/requirement-test-store.js";
import {
  RequirementTestStructuralHandoffError,
  WorkerArtifactHandoffCoordinator,
  WorkerArtifactHandoffError,
  sealWorkerArtifactHandoff,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import {
  canonicalTestReviewRepairForTarget,
  canonicalTestReviewRepairProgress,
  TEST_REVIEW_REPAIR_BATCH_LIMITS,
} from "../../../src/flow/lib/test-review-repair.js";
import { findStepById } from "../../../src/flow/lib/step-tree.js";
import { emptySpecStub } from "../../../src/lib/spec-json.js";
import {
  FlowAtStepFixture,
  makeFlowManager,
} from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const roots = [];
const CONFIRMED_AT = "2026-09-13T01:00:00.000Z";

afterEach(() => {
  while (roots.length > 0) removeTmpDir(roots.pop());
});

function spec(requirementIds) {
  return {
    ...emptySpecStub(),
    requirements: requirementIds.map((id) => ({
      id,
      desc: `${id} behavior`,
      task_ids: ["T1"],
      preimplementation_test_expectation: "fail",
    })),
  };
}

function setup(requirementIds = ["R1"], execution = { mode: "direct" }) {
  const root = createTmpDir("requirement-lifecycle-regression-");
  roots.push(root);
  const manager = makeFlowManager(root);
  const specId = `requirement-regression-${roots.length}`;
  new FlowAtStepFixture({
    flowManager: manager,
    specId,
    runId: `run-${specId}`,
    execution,
    targetStep: "approval",
    specRecord: spec(requirementIds),
    taskDocuments: [{ id: "T1", title: "Implement", goal: "Implement", origin: "plan", added_round: 0, status: "pending" }],
  }).create();
  const state = manager.canonicalState(specId);
  const approvedSpec = JSON.parse(manager.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "approval" }).bytes);
  const specRevision = manager.readCurrentSpecReview({ specId, consumerNodeId: "spec-gate" }).review.identity;
  const initialization = initializeRequirementTestLifecycle({ spec: approvedSpec, specRevision });
  const node = state.findNode(initialization.target);
  const contract = state.definition.contractFor(initialization.target, state.root);
  manager._store.runtime.initializeRequirementTestLifecycle({
    specId,
    activityId: `initialize-${specId}`,
    result: { outcome: "passed", summary: "approved", confirmedAt: CONFIRMED_AT, artifactRefs: [] },
    decision: initialization.effect,
    targetAttempt: new CurrentAttempt({
      id: `generate-${specId}`,
      nodeId: initialization.target,
      sequence: node.attemptSequence + 1,
      startedAt: CONFIRMED_AT,
      consumption: { semantic: 0, tooling: 0 },
      failure: null,
      blocker: null,
      incomplete: [],
      operationClaims: [{ operation: "execute", resources: [...contract.resourceContract.required] }],
    }),
    artifactWrites: [{
      logicalKey: "test.requirement.plan",
      mediaType: "application/json",
      bytes: new RequirementTestPlanArtifact({ plan: initialization.plan }).toBytes(),
    }],
  });
  return { root, manager, specId };
}

function candidateFor(manager, specId, requirementId, testPath = `tests/${requirementId.toLowerCase()}.test.js`) {
  const state = manager.canonicalState(specId);
  const plan = new RequirementTestArtifactStore({ flowManager: manager, state })
    .readPlan(state.current.at(-1)).artifact.plan;
  const item = plan.workItem(requirementId);
  const bytes = Buffer.from(`// spec: ${requirementId}\nimport test from 'node:test';\ntest('${requirementId}: behavior', () => {});\n`);
  const source = RequirementTestCandidateSource.fromBytes({ testPath, bytes });
  const revision = new RequirementTestBundleRevision({
    requirementId,
    specRevision: item.specRevision,
    revision: 1,
    paths: [testPath],
    lineage: new RequirementTestBundleLineage({
      requirementId,
      specRevision: item.specRevision,
      bundleRevision: 1,
      predecessorRevision: null,
      sourceAttempt: { id: state.attempt.id, sequence: state.attempt.sequence },
      sourceFindingFingerprints: [],
    }),
  });
  return { candidate: new RequirementTestCandidateBundle({ bundle: revision, sources: [source] }), bytes };
}

function lifecycleAuthority(state, planDescriptor) {
  return RequirementTestLifecycleAuthority.capture({ state, planDescriptor });
}

function publishGenerated({ manager, specId, candidate, bytes }) {
  const state = manager.canonicalState(specId);
  const store = new RequirementTestArtifactStore({ flowManager: manager, state });
  const planRead = store.readPlan("test-generate");
  const plan = planRead.artifact.plan;
  const decision = resolveRequirementTestLifecycle(new RequirementTestLifecycleFacts({
    authority: lifecycleAuthority(state, planRead.descriptor),
    plan, leaf: "test-generate", observation: candidate,
  }));
  const parameters = { requirementId: candidate.bundle.requirementId, bundleRevision: "1" };
  manager.completeRequirementTestLifecycle({
    specId,
    decision,
    artifactWrites: [{
      logicalKey: "test.requirement.candidate.source",
      parameters: { ...parameters, testPath: candidate.sources[0].testPath.slice("tests/".length) },
      mediaType: "text/javascript",
      bytes,
    }, {
      logicalKey: "test.requirement.candidate.bundle",
      parameters,
      mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(candidate.toJSON())}\n`),
    }],
  });
}

function generationDecision(value, candidate) {
  const state = value.manager.canonicalState(value.specId);
  const planRead = new RequirementTestArtifactStore({ flowManager: value.manager, state })
    .readPlan("test-generate");
  const facts = new RequirementTestLifecycleFacts({
    authority: RequirementTestLifecycleAuthority.capture({ state, planDescriptor: planRead.descriptor }),
    plan: planRead.artifact.plan,
    leaf: "test-generate",
    observation: candidate,
  });
  return { state, planRead, facts, decision: resolveRequirementTestLifecycle(facts) };
}

function candidateWrites(candidate, bytes) {
  const parameters = {
    requirementId: candidate.bundle.requirementId,
    bundleRevision: String(candidate.bundle.revision),
  };
  return [{
    logicalKey: "test.requirement.candidate.source",
    parameters: { ...parameters, testPath: candidate.sources[0].testPath.slice("tests/".length) },
    mediaType: "text/javascript",
    bytes,
  }, {
    logicalKey: "test.requirement.candidate.bundle",
    parameters,
    mediaType: "application/json",
    bytes: Buffer.from(`${JSON.stringify(candidate.toJSON())}\n`),
  }];
}

function canonicalSnapshot(value) {
  return {
    state: value.manager.canonicalState(value.specId).toJSON(),
    activities: value.manager.activityLedger(value.specId),
    catalog: value.manager.artifactCatalog(value.specId).toJSON(),
  };
}

function requirementTestHandoff(value, invocationId = "requirement-test-structural", stepId = "test-generate") {
  const coordinator = new WorkerArtifactHandoffCoordinator({
    now: () => new Date(CONFIRMED_AT),
  });
  const invocation = {
    id: invocationId,
    target: { digest: crypto.createHash("sha256").update(`${invocationId}:target`).digest("hex") },
    action: {
      digest: crypto.createHash("sha256").update(`${invocationId}:action`).digest("hex"),
      nextAction: { step: stepId },
    },
  };
  const ctx = {
    root: value.root,
    executionRoot: value.root,
    mainRoot: value.root,
    specId: value.specId,
    flowManager: value.manager,
  };
  const request = coordinator.createRequest({
    ctx,
    state: value.manager.loadReadOnly(value.specId),
    invocation,
  });
  return { coordinator, ctx, request };
}

function sealRequirementTestHandoff(request) {
  return sealWorkerArtifactHandoff({
    requestPath: request.requestPath,
    invocationId: request.dispatchInvocationId,
    now: () => new Date(CONFIRMED_AT),
  });
}

function reviewResult(manager, specId, { verdict = "PASS", tooling = false, permissionRelated = false, findings = null } = {}) {
  const state = manager.canonicalState(specId);
  const store = new RequirementTestArtifactStore({ flowManager: manager, state });
  const item = store.readPlan("test-review").artifact.plan.activeWorkItem();
  const candidate = store.readCandidate({ bundle: item.bundleRevision, consumerNodeId: "test-review" }).candidate;
  const finding = {
    findingId: `${item.requirementId}-review-blocker`,
    fingerprint: "e".repeat(64),
    requirementId: item.requirementId,
    category: tooling ? "tooling_failure" : "semantic_rejection",
    reason: tooling ? "review provider unavailable" : "assertion does not prove the Requirement",
  };
  const blockingFindings = verdict === "REJECTED" || tooling ? (findings ?? [finding]) : [];
  const payload = {
    version: 1,
    phase: "test",
    requirementId: item.requirementId,
    specRevision: item.specRevision.toJSON(),
    bundleRevision: item.bundleRevision.revision,
    candidateDigest: candidate.digest,
    sourceAttempt: item.bundleRevision.lineage.sourceAttempt.toJSON(),
    ...(tooling ? {
      toolingOutcome: {
        kind: "TOOLING_ERROR", stage: "provider", attempt: 1, maxAttempts: 3, remainingAttempts: 2,
        reason: finding.reason, permissionRelated,
      },
    } : { verdict }),
    blockingFindings,
    advisoryFindings: verdict === "ADVISORY" ? [{ ...finding, category: "advisory" }] : [],
    ...(verdict === "REJECTED" ? {
      canonicalEvidence: {
        disposition: "REJECTED",
        blockingFindings: blockingFindings.map(({ findingId, fingerprint }) => ({ findingId, fingerprint })),
        identity: { evidenceDigest: "f".repeat(64) },
      },
    } : {}),
  };
  const result = {
    result: tooling ? "tooling-error" : "ok",
    artifacts: { phase: "test", ...(tooling ? { toolingOutcome: payload.toolingOutcome } : { verdict }) },
  };
  attachCanonicalCommandResultArtifact(result, { logicalKey: "test.requirement.review", payload });
  return result;
}

async function postReview(value, options) {
  const result = reviewResult(value.manager, value.specId, options);
  return FLOW_COMMANDS.run.review.post({
    flowManager: value.manager,
    flowState: value.manager.loadReadOnly(value.specId),
    specId: value.specId,
    phase: "test",
  }, result);
}

function gateResult(manager, specId) {
  const state = manager.canonicalState(specId);
  const store = new RequirementTestArtifactStore({ flowManager: manager, state });
  const item = store.readPlan("test-gate").artifact.plan.activeWorkItem();
  const candidate = store.readCandidate({ bundle: item.bundleRevision, consumerNodeId: "test-gate" }).candidate;
  const payload = new RequirementTestGateResult({
    observation: new RequirementTestGateObservation({
      requirementId: item.requirementId,
      specRevision: item.specRevision,
      bundleRevision: item.bundleRevision.revision,
      candidateDigest: candidate.digest,
      testName: `${item.requirementId}: behavior`,
      kind: "assertion_failed",
      sourceAttempt: item.bundleRevision.lineage.sourceAttempt,
    }),
    command: null,
    rawOutputPath: "steps/test-gate/output.log",
    process: { started: true, exitCode: 1, signal: null, timedOut: false, spawnError: null },
  }).toJSON();
  const result = { result: "ok", artifacts: { phase: "test", requirementId: item.requirementId } };
  attachCanonicalCommandResultArtifact(result, { logicalKey: "test.requirement.gate", payload });
  return result;
}

async function postGate(value, result = gateResult(value.manager, value.specId)) {
  return FLOW_COMMANDS.run["requirement-test-gate"].post({
    flowManager: value.manager,
    flowState: value.manager.loadReadOnly(value.specId),
    specId: value.specId,
  }, result);
}

function setReviewBudget({ manager, specId }, budget) {
  const state = manager.canonicalState(specId);
  const store = new RequirementTestArtifactStore({ flowManager: manager, state });
  const current = store.readPlan("test-review");
  const active = current.artifact.plan.activeWorkItem();
  const plan = current.artifact.plan.withWorkItem(active.withState({ budget }));
  manager.publishArtifacts({
    specId,
    nodeId: "test-review",
    artifactWrites: [{ logicalKey: "test.requirement.plan", mediaType: "application/json", bytes: new RequirementTestPlanArtifact({ plan }).toBytes() }],
    artifactBaselines: [current.baseline],
  });
}

describe("Requirement test lifecycle regressions", () => {
  it("preserves an R6 candidate and R-bound structural finding when its sealed bundle claims only R8", () => {
    const value = setup(["R6", "R8"]);
    const { coordinator, ctx, request } = requirementTestHandoff(value);
    const workerSpec = request.toWorkerJSON().inputs.find((input) => input.name === "spec.json").document;
    assert.deepEqual(workerSpec.requirements.map((requirement) => requirement.id), ["R6"]);
    assert.equal(workerSpec.expectation, "fail");
    assert.equal(JSON.stringify(workerSpec).includes("R8"), false, "the request must not disclose another Requirement");
    assert.equal(Object.hasOwn(workerSpec.requirements[0], "task_ids"), false, "Task assignment is not worker-visible Requirement-test context");
    assert.equal(JSON.stringify(workerSpec).includes("T1"), false, "the request must not disclose Task details");
    const bytes = Buffer.from("// spec: R8\nimport test from 'node:test';\ntest('R8: misplaced ownership', () => {});\n");
    fs.writeFileSync(path.join(request.payloadPath("spec-tests"), "r8.test.js"), bytes);
    sealRequirementTestHandoff(request);
    const before = canonicalSnapshot(value);

    assert.throws(
      () => coordinator.reconcile({ ctx, request }),
      (error) => {
        assert.ok(error instanceof RequirementTestStructuralHandoffError, `${error.name}: ${error.message} ${JSON.stringify(error.data)}`);
        assert.equal(error.code, "FLOW_REQUIREMENT_TEST_HANDOFF_STRUCTURAL_INVALID");
        assert.equal(error.retryable, false);
        assert.equal(error.result.requirementId, "R6");
        assert.equal(error.result.candidate.bundle.requirementId, "R6");
        assert.equal(error.result.candidateSources[0].testPath, "r8.test.js");
        assert.deepEqual(error.result.finding.document.recoverableIssues, [{
          code: "assigned_requirement_uncovered", requirementId: "R6", file: null,
        }]);
        assert.equal(error.result.finding.document.validation.validationResult.uncoveredRequirements[0].id, "R6");
        assert.match(error.result.finding.document.reason, /R6/);
        const connector = error.result.connectorInput();
        assert.deepEqual(connector.candidateSources[0].bytes, bytes);
        assert.equal(connector.finding.candidateDigest, error.result.candidate.digest);
        return true;
      },
    );
    assert.deepEqual(canonicalSnapshot(value), before, "the connector alone may publish the candidate and finding");
  });

  it("settles an unresolved static import as an R-bound repair finding without consuming tooling budget", () => {
    const value = setup(["R6"]);
    const { coordinator, ctx, request } = requirementTestHandoff(value, "requirement-test-bootstrap-recovery");
    const bytes = Buffer.from([
      "// spec: R6",
      "import helper from './support/not-yet-implemented.js';",
      "import test from 'node:test';",
      "test('R6: bootstrap ownership', () => { assert.ok(helper); });",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(request.payloadPath("spec-tests"), "r6.test.js"), bytes);
    sealRequirementTestHandoff(request);
    const before = canonicalSnapshot(value);

    let structuralResult = null;
    assert.throws(
      () => coordinator.reconcile({ ctx, request }),
      (error) => {
        assert.ok(error instanceof RequirementTestStructuralHandoffError);
        assert.equal(error.retryable, false, "semantic bootstrap invalidity must not enter tooling retry");
        assert.equal(error.result.requirementId, "R6");
        assert.equal(error.result.candidateSources[0].digest, crypto.createHash("sha256").update(bytes).digest("hex"));
        const [issue] = error.result.finding.document.recoverableIssues;
        assert.equal(issue.code, "static_import_unresolved");
        assert.equal(issue.relativeTestFile, "r6.test.js");
        assert.equal(issue.specifier, "./support/not-yet-implemented.js");
        assert.match(issue.expectedPath, /payload\/tests\/support\/not-yet-implemented\.js$/);
        structuralResult = error.result;
        return true;
      },
    );
    assert.deepEqual(canonicalSnapshot(value), before, "the active test tree remains untouched before the connector settles");

    value.manager.completeRequirementTestStructuralHandoff({ specId: value.specId, structuralResult });
    const state = value.manager.canonicalState(value.specId);
    assert.equal(state.current.at(-1), "test-repair");
    const store = new RequirementTestArtifactStore({ flowManager: value.manager, state });
    const item = store.readPlan("test-repair").artifact.plan.activeWorkItem();
    assert.equal(item.budget.tooling, 0, "recoverable semantic evidence does not consume tooling budget");
    const candidate = store.readCandidate({ bundle: item.bundleRevision, consumerNodeId: "test-repair" }).candidate;
    assert.equal(candidate.digest, structuralResult.candidate.digest);
    const repair = canonicalTestReviewRepairForTarget({
      flowManager: value.manager,
      state: value.manager.loadReadOnly(value.specId),
      targetStepId: "test-repair",
    });
    assert.equal(repair.blockingFindings[0].document.fingerprint, structuralResult.finding.fingerprint);
  });

  it("does not downgrade a post-seal Requirement test payload tamper into a structural result", () => {
    const value = setup(["R6", "R8"]);
    const { coordinator, ctx, request } = requirementTestHandoff(value, "requirement-test-tamper");
    const target = path.join(request.payloadPath("spec-tests"), "r8.test.js");
    fs.writeFileSync(target, "// spec: R8\nimport test from 'node:test';\ntest('R8: original', () => {});\n");
    sealRequirementTestHandoff(request);
    fs.writeFileSync(target, "// spec: R6\nimport test from 'node:test';\ntest('R6: tampered', () => {});\n");
    const before = canonicalSnapshot(value);

    assert.throws(
      () => coordinator.reconcile({ ctx, request }),
      (error) => {
        assert.ok(error instanceof WorkerArtifactHandoffError);
        assert.ok(!(error instanceof RequirementTestStructuralHandoffError));
        assert.equal(error.code, "FLOW_ARTIFACT_HANDOFF_INVALID");
        assert.equal(error.data.transport, undefined, "a post-seal integrity failure is never an output transport retry");
        return true;
      },
    );
    assert.deepEqual(canonicalSnapshot(value), before, "tampering must leave canonical state untouched");
  });

  it("does not classify a missing sealed handoff control as worker-output transport", () => {
    const value = setup(["R6"]);
    const { coordinator, ctx, request } = requirementTestHandoff(value, "requirement-test-control-missing");
    fs.writeFileSync(
      path.join(request.payloadPath("spec-tests"), "r6.test.js"),
      "// spec: R6\nimport test from 'node:test';\ntest('R6: owned', () => {});\n",
    );
    sealRequirementTestHandoff(request);
    fs.unlinkSync(request.requestPath);

    assert.throws(
      () => coordinator.reconcile({ ctx, request }),
      (error) => {
        assert.ok(error instanceof WorkerArtifactHandoffError);
        assert.equal(error.code, "FLOW_ARTIFACT_HANDOFF_MISSING");
        assert.equal(error.data.transport, undefined);
        return true;
      },
    );
  });

  it("publishes shared support outside the primary Requirement candidate sources", () => {
    const value = setup(["R1"]);
    const { coordinator, ctx, request } = requirementTestHandoff(value, "requirement-test-support-generate");
    const primary = Buffer.from("// spec: R2\nimport test from 'node:test';\ntest('R2: misplaced', () => {});\n");
    const helper = Buffer.from("export const fixture = true;\n");
    fs.writeFileSync(path.join(request.payloadPath("spec-tests"), "r1.test.js"), primary);
    fs.mkdirSync(path.join(request.payloadPath("spec-tests"), "support"));
    fs.writeFileSync(path.join(request.payloadPath("spec-tests"), "support", "fixture.js"), helper);
    sealRequirementTestHandoff(request);
    let structuralResult = null;
    assert.throws(() => coordinator.reconcile({ ctx, request }), (error) => {
      assert.ok(error instanceof RequirementTestStructuralHandoffError);
      structuralResult = error.result;
      return true;
    });
    value.manager.completeRequirementTestStructuralHandoff({ specId: value.specId, structuralResult });

    const state = value.manager.canonicalState(value.specId);
    assert.equal(state.current.at(-1), "test-repair");
    const store = new RequirementTestArtifactStore({ flowManager: value.manager, state });
    const item = store.readPlan("test-repair").artifact.plan.activeWorkItem();
    const candidate = store.readCandidate({ bundle: item.bundleRevision, consumerNodeId: "test-repair" });
    assert.deepEqual(candidate.candidate.bundle.paths, ["tests/r1.test.js"]);
    assert.equal(candidate.candidate.support.length, 1);
    assert.equal(candidate.candidate.support[0].ownerRequirementId, "R1");
    assert.equal(candidate.candidate.support[0].supportPath, "tests/support/fixture.js");
    assert.deepEqual(candidate.support[0].bytes, helper);

    const repair = requirementTestHandoff(value, "requirement-test-support-repair", "test-repair");
    assert.equal(repair.request.requirementTestBinding.candidateBaseline.support[0].digest, candidate.candidate.support[0].digest);
    assert.equal(
      fs.existsSync(path.join(repair.request.payloadPath("spec-tests"), "support", "fixture.js")),
      false,
      "repair receives only primary capability and reuses immutable support by owner/digest",
    );
    sealRequirementTestHandoff(repair.request);
    const beforeUnchangedRepair = canonicalSnapshot(value);
    assert.throws(
      () => repair.coordinator.reconcile({ ctx: repair.ctx, request: repair.request }),
      (error) => {
        assert.ok(error instanceof WorkerArtifactHandoffError);
        assert.ok(!(error instanceof RequirementTestStructuralHandoffError));
        assert.equal(error.code, "FLOW_TEST_REVIEW_REPAIR_NO_PROGRESS", error.message);
        return true;
      },
    );
    assert.deepEqual(canonicalSnapshot(value), beforeUnchangedRepair, "unchanged invalid repair bytes cannot create a replacement structural finding");
  });

  it("settles a sealed R-bound structural handoff through the Definition repair route", () => {
    const value = setup(["R6", "R8"]);
    const { coordinator, ctx, request } = requirementTestHandoff(value, "requirement-test-structural-settlement");
    fs.writeFileSync(
      path.join(request.payloadPath("spec-tests"), "r8.test.js"),
      "// spec: R8\nimport test from 'node:test';\ntest('R8: misplaced ownership', () => {});\n",
    );
    sealRequirementTestHandoff(request);

    let structuralResult = null;
    assert.throws(
      () => coordinator.reconcile({ ctx, request }),
      (error) => {
        assert.ok(error instanceof RequirementTestStructuralHandoffError);
        structuralResult = error.result;
        return true;
      },
    );
    value.manager.completeRequirementTestStructuralHandoff({
      specId: value.specId,
      structuralResult,
    });

    const state = value.manager.canonicalState(value.specId);
    assert.equal(state.current.at(-1), "test-repair");
    const repair = canonicalTestReviewRepairForTarget({
      flowManager: value.manager,
      state: value.manager.loadReadOnly(value.specId),
      targetStepId: "test-repair",
    });
    assert.ok(repair, "the canonical structural finding must produce a concrete test-repair input");
    assert.equal(repair.sourceCandidate.bundle.requirementId, "R6");
    assert.equal(repair.blockingFindings[0].document.fingerprint, structuralResult.finding.fingerprint);
    const store = new RequirementTestArtifactStore({ flowManager: value.manager, state });
    const item = store.readPlan("test-repair").artifact.plan.activeWorkItem();
    assert.equal(item.requirementId, "R6");
    const candidate = store.readCandidate({ bundle: item.bundleRevision, consumerNodeId: "test-repair" }).candidate;
    assert.equal(candidate.bundle.requirementId, "R6");
    const failure = JSON.parse(value.manager.readArtifact({
      specId: value.specId,
      logicalKey: "test.requirement.failure",
      parameters: {
        requirementId: "R6",
        bundleRevision: "1",
        fingerprint: structuralResult.finding.fingerprint,
      },
      consumerNodeId: "test-repair",
    }).bytes);
    assert.equal(failure.blockingFindings[0].requirementId, "R6");
    assert.equal(failure.blockingFindings[0].category, "requirement_test_handoff_structure");
  });

  it("defers an exhausted structural candidate using its sealed revision rather than the preceding plan candidate", () => {
    const value = setup(["R6", "R8"]);
    const promotedSourcesBefore = value.manager.artifactCatalog(value.specId).artifacts
      .filter((entry) => entry.logicalKey === "tests.source");
    const before = value.manager.canonicalState(value.specId);
    const planRead = new RequirementTestArtifactStore({ flowManager: value.manager, state: before }).readPlan("test-generate");
    const active = planRead.artifact.plan.activeWorkItem();
    value.manager.publishArtifacts({
      specId: value.specId,
      nodeId: "test-generate",
      artifactWrites: [{
        logicalKey: "test.requirement.plan",
        mediaType: "application/json",
        bytes: new RequirementTestPlanArtifact({ plan: planRead.artifact.plan.withWorkItem(active.withState({
          budget: new RequirementTestBudget({ autoSemantic: 0, manualSemantic: 5, tooling: 0 }),
        })) }).toBytes(),
      }],
      artifactBaselines: [planRead.baseline],
    });
    const { coordinator, ctx, request } = requirementTestHandoff(value, "requirement-test-structural-exhausted");
    fs.writeFileSync(path.join(request.payloadPath("spec-tests"), "r8.test.js"), "// spec: R8\nimport test from 'node:test';\ntest('R8: misplaced ownership', () => {});\n");
    sealRequirementTestHandoff(request);
    let structuralResult = null;
    assert.throws(() => coordinator.reconcile({ ctx, request }), (error) => {
      assert.ok(error instanceof RequirementTestStructuralHandoffError);
      structuralResult = error.result;
      return true;
    });
    value.manager.completeRequirementTestStructuralHandoff({ specId: value.specId, structuralResult });
    const state = value.manager.canonicalState(value.specId);
    assert.equal(state.current.at(-1), "test-generate");
    const receipt = JSON.parse(value.manager.readArtifact({
      specId: value.specId,
      logicalKey: "test.requirement.deferred",
      parameters: { requirementId: "R6" },
      consumerNodeId: "test-generate",
    }).bytes);
    assert.equal(receipt.bundleRevision, 1);
    assert.equal(receipt.candidateDigest, structuralResult.candidate.digest);
    const plan = new RequirementTestArtifactStore({ flowManager: value.manager, state }).readPlan("test-generate").artifact.plan;
    assert.equal(plan.workItem("R6").bundleRevision.revision, 1);
    assert.equal(plan.workItem("R6").status, "deferred");
    assert.equal(plan.activeWorkItem().requirementId, "R8");
    assert.deepEqual(value.manager.artifactCatalog(value.specId).artifacts
      .filter((entry) => entry.logicalKey === "tests.source"), promotedSourcesBefore);
  });

  it("rejects stale plan authority before any candidate or Activity publication", () => {
    const value = setup();
    const generated = candidateFor(value.manager, value.specId, "R1");
    const selected = generationDecision(value, generated.candidate);
    const active = selected.planRead.artifact.plan.activeWorkItem();
    const changedPlan = selected.planRead.artifact.plan.withWorkItem(active.withState({
      budget: new RequirementTestBudget({ tooling: 1 }),
    }));
    value.manager.publishArtifacts({
      specId: value.specId,
      nodeId: "test-generate",
      artifactWrites: [{
        logicalKey: "test.requirement.plan",
        mediaType: "application/json",
        bytes: new RequirementTestPlanArtifact({ plan: changedPlan }).toBytes(),
      }],
      artifactBaselines: [selected.planRead.baseline],
    });
    const before = canonicalSnapshot(value);
    assert.throws(() => value.manager.completeRequirementTestLifecycle({
      specId: value.specId,
      decision: selected.decision,
      artifactWrites: candidateWrites(generated.candidate, generated.bytes),
    }), /plan changed after Definition selected/);
    assert.deepEqual(canonicalSnapshot(value), before);
  });

  it("rejects a decision bound to a stale leaf Attempt without side effects", () => {
    const value = setup();
    const generated = candidateFor(value.manager, value.specId, "R1");
    const selected = generationDecision(value, generated.candidate);
    const staleAuthority = new RequirementTestLifecycleAuthority({
      ...selected.facts.authority.toJSON(),
      attempt: { id: "stale-generate-attempt", sequence: selected.state.attempt.sequence },
    });
    const staleCandidate = new RequirementTestCandidateBundle({
      bundle: new RequirementTestBundleRevision({
        requirementId: generated.candidate.bundle.requirementId,
        specRevision: generated.candidate.bundle.specRevision,
        revision: generated.candidate.bundle.revision,
        paths: generated.candidate.bundle.paths,
        lineage: new RequirementTestBundleLineage({
          requirementId: generated.candidate.bundle.requirementId,
          specRevision: generated.candidate.bundle.specRevision,
          bundleRevision: generated.candidate.bundle.revision,
          predecessorRevision: null,
          sourceAttempt: staleAuthority.attempt,
          sourceFindingFingerprints: [],
        }),
      }),
      sources: generated.candidate.sources,
    });
    const staleFacts = new RequirementTestLifecycleFacts({
      authority: staleAuthority,
      plan: selected.facts.plan,
      leaf: "test-generate",
      observation: staleCandidate,
    });
    const before = canonicalSnapshot(value);
    assert.throws(() => value.manager.completeRequirementTestLifecycle({
      specId: value.specId,
      decision: resolveRequirementTestLifecycle(staleFacts),
      artifactWrites: candidateWrites(staleCandidate, generated.bytes),
    }), /no longer addresses the active Attempt/);
    assert.deepEqual(canonicalSnapshot(value), before);
  });

  it("rejects facts bound to a different candidate publication without side effects", () => {
    const value = setup();
    const generated = candidateFor(value.manager, value.specId, "R1");
    publishGenerated({ manager: value.manager, specId: value.specId, ...generated });
    const state = value.manager.canonicalState(value.specId);
    const store = new RequirementTestArtifactStore({ flowManager: value.manager, state });
    const planRead = store.readPlan("test-review");
    const active = planRead.artifact.plan.activeWorkItem();
    const actual = store.readCandidate({ bundle: active.bundleRevision, consumerNodeId: "test-review" }).candidate;
    const forgedSource = RequirementTestCandidateSource.fromBytes({
      testPath: actual.sources[0].testPath,
      bytes: Buffer.from("// spec: R1\n// stale candidate bytes\n"),
    });
    const forged = new RequirementTestCandidateBundle({ bundle: actual.bundle, sources: [forgedSource] });
    const observation = new RequirementTestStepObservation({
      requirementId: active.requirementId,
      specRevision: active.specRevision,
      bundleRevision: active.bundleRevision.revision,
      candidateDigest: forged.digest,
      sourceAttempt: active.bundleRevision.lineage.sourceAttempt,
      kind: "review_pass",
    });
    const facts = new RequirementTestLifecycleFacts({
      authority: RequirementTestLifecycleAuthority.capture({ state, planDescriptor: planRead.descriptor }),
      plan: planRead.artifact.plan,
      leaf: "test-review",
      observation,
      candidateBundle: forged,
    });
    const result = reviewResult(value.manager, value.specId, { verdict: "PASS" });
    const attached = attachedCanonicalCommandResultArtifact(result);
    const forgedResult = { ...result };
    attachCanonicalCommandResultArtifact(forgedResult, {
      logicalKey: attached.logicalKey,
      payload: { ...attached.payload, candidateDigest: forged.digest },
    });
    const before = canonicalSnapshot(value);
    assert.throws(() => value.manager.completeRequirementTestLifecycle({
      specId: value.specId,
      decision: resolveRequirementTestLifecycle(facts),
      commandResult: forgedResult,
    }), /observation is not bound to current candidate lineage/);
    assert.deepEqual(canonicalSnapshot(value), before);
  });

  it("rejects a schema-valid decision different from the Definition decision", () => {
    const value = setup();
    const generated = candidateFor(value.manager, value.specId, "R1");
    const selected = generationDecision(value, generated.candidate);
    const arbitrary = new RequirementTestLifecycleDecision({
      disposition: "tooling_retry",
      target: "test-generate",
      nextStatus: "in_progress",
      budgetIncrement: "tooling",
      requirementId: "R1",
      facts: selected.facts,
    });
    const before = canonicalSnapshot(value);
    assert.throws(() => value.manager.completeRequirementTestLifecycle({
      specId: value.specId,
      decision: arbitrary,
      artifactWrites: candidateWrites(generated.candidate, generated.bytes),
    }), /Definition decision changed before settlement/);
    assert.deepEqual(canonicalSnapshot(value), before);
  });

  for (const verdict of ["PASS", "ADVISORY"]) {
    it(`${verdict} review atomically skips repair and activates Gate`, async () => {
      const value = setup();
      publishGenerated({ manager: value.manager, specId: value.specId, ...candidateFor(value.manager, value.specId, "R1") });
      const before = value.manager.activityLedger(value.specId).length;
      const decision = await postReview(value, { verdict });
      const state = value.manager.loadReadOnly(value.specId);
      assert.equal(decision.target, "test-gate");
      assert.equal(state.currentNodeId, "test-gate");
      assert.equal(findStepById(state.steps, "test-repair").status, "skipped");
      assert.equal(value.manager.activityLedger(value.specId).length, before + 1);
    });
  }

  for (const mode of ["semantic", "tooling"]) {
    it(`${mode} review exhaustion publishes a deferred receipt in the lifecycle transaction`, async () => {
      const value = setup();
      publishGenerated({ manager: value.manager, specId: value.specId, ...candidateFor(value.manager, value.specId, "R1") });
      setReviewBudget(value, mode === "semantic"
        ? new RequirementTestBudget({ autoSemantic: 5, manualSemantic: 5, tooling: 0 })
        : new RequirementTestBudget({ autoSemantic: 0, manualSemantic: 0, tooling: 3 }));
      const decision = await postReview(value, mode === "semantic" ? { verdict: "REJECTED" } : { tooling: true });
      assert.equal(decision.disposition, "defer");
      const deferred = value.manager.readArtifact({
        specId: value.specId,
        logicalKey: "test.requirement.deferred",
        parameters: { requirementId: "R1" },
        consumerNodeId: "implement",
      });
      assert.equal(JSON.parse(deferred.bytes).requirementId, "R1");
      assert.equal(deferred.descriptor.publicationStep, "test-review");
      assert.equal(value.manager.loadReadOnly(value.specId).currentNodeId, "implement");
    });
  }

  for (const leaf of ["test-generate", "test-repair"]) {
    it(`${leaf} tooling retries and exhausts from reloaded canonical state`, async () => {
      const value = setup();
      if (leaf === "test-repair") {
        publishGenerated({ manager: value.manager, specId: value.specId, ...candidateFor(value.manager, value.specId, "R1") });
        await postReview(value, { verdict: "REJECTED" });
      }
      for (let tooling = 1; tooling <= 3; tooling += 1) {
        value.manager.completeRequirementTestToolingFailure({
          specId: value.specId,
          message: `${leaf} provider unavailable`,
        });
        value.manager = makeFlowManager(value.root);
        const state = value.manager.canonicalState(value.specId);
        const plan = new RequirementTestArtifactStore({ flowManager: value.manager, state })
          .readPlan(leaf).artifact.plan;
        assert.equal(plan.activeWorkItem().budget.tooling, tooling);
        assert.equal(state.current.at(-1), leaf);
      }
      value.manager.completeRequirementTestToolingFailure({
        specId: value.specId,
        message: `${leaf} provider unavailable`,
      });
      value.manager = makeFlowManager(value.root);
      assert.equal(value.manager.canonicalState(value.specId).current.at(-1), "implement");
      const receipt = value.manager.readArtifact({
        specId: value.specId,
        logicalKey: "test.requirement.deferred",
        parameters: { requirementId: "R1" },
        consumerNodeId: "implement",
      });
      assert.equal(JSON.parse(receipt.bytes).requirementId, "R1");
    });
  }

  it("discards Attempt-bound repair progress atomically before a tooling retry", async () => {
    const value = setup();
    const generated = candidateFor(value.manager, value.specId, "R1");
    publishGenerated({ manager: value.manager, specId: value.specId, ...generated });
    await postReview(value, { verdict: "REJECTED" });
    const state = value.manager.loadReadOnly(value.specId);
    const repair = canonicalTestReviewRepairForTarget({
      flowManager: value.manager,
      state,
      targetStepId: "test-repair",
    });
    const progress = canonicalTestReviewRepairProgress({
      flowManager: value.manager,
      state,
      repair,
      consumerNodeId: "test-repair",
      stagedSources: [{ testPath: generated.candidate.sources[0].testPath.slice("tests/".length), bytes: generated.bytes }],
    });
    value.manager.publishArtifacts({
      specId: value.specId,
      nodeId: "test-repair",
      artifactWrites: [{
        logicalKey: "test.requirement.repair.progress",
        parameters: { requirementId: "R1" },
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(progress.toJSON(), null, 2)}\n`),
      }],
    });

    value.manager.completeRequirementTestToolingFailure({
      specId: value.specId,
      message: "test-repair provider unavailable",
    });
    value.manager = makeFlowManager(value.root);
    const reloaded = value.manager.canonicalState(value.specId);
    assert.equal(reloaded.current.at(-1), "test-repair");
    assert.equal(new RequirementTestArtifactStore({ flowManager: value.manager, state: reloaded })
      .readPlan("test-repair").artifact.plan.activeWorkItem().budget.tooling, 1);
    assert.equal(value.manager.readArtifact({
      specId: value.specId,
      logicalKey: "test.requirement.repair.progress",
      parameters: { requirementId: "R1" },
      consumerNodeId: "test-repair",
      optional: true,
    }), null);
  });

  it("restarts partial repair progress under the new tooling Attempt and continues the remaining batch", async () => {
    const value = setup();
    const generated = candidateFor(value.manager, value.specId, "R1");
    publishGenerated({ manager: value.manager, specId: value.specId, ...generated });
    const findings = ["e", "f"].map((letter, index) => ({
      findingId: `R1-partial-${index + 1}`,
      fingerprint: letter.repeat(64),
      requirementId: "R1",
      category: "semantic_rejection",
      reason: `partial repair finding ${index + 1}`,
      target: "GLOBAL",
      issue: `partial repair finding ${index + 1}`,
      requiredChange: `partial repair finding ${index + 1}`,
    }));
    await postReview(value, { verdict: "REJECTED", findings });
    const state = value.manager.loadReadOnly(value.specId);
    const repair = canonicalTestReviewRepairForTarget({
      flowManager: value.manager, state, targetStepId: "test-repair",
    });
    const stagedSources = [{ testPath: generated.candidate.sources[0].testPath.slice("tests/".length), bytes: generated.bytes }];
    const progress = canonicalTestReviewRepairProgress({
      flowManager: value.manager, state, repair, consumerNodeId: "test-repair", stagedSources,
    });
    const oneFindingBatch = { ...TEST_REVIEW_REPAIR_BATCH_LIMITS, findingCount: 1 };
    const batch = progress.nextBatch(repair, stagedSources, oneFindingBatch);
    const receipt = {
      batchId: batch.batchId,
      findingIds: [...batch.findingIds],
      beforeTreeDigest: "a".repeat(64), afterTreeDigest: "b".repeat(64),
      changedPaths: [{ path: batch.allowedTestPaths[0], beforeDigest: null, afterDigest: "c".repeat(64) }],
      sourceCandidate: repair.sourceCandidate.toJSON(),
      handoffDigest: "d".repeat(64), requestDigest: "e".repeat(64), payloadDigest: "f".repeat(64),
    };
    const partial = progress.markBatchComplete(repair, batch, receipt, stagedSources);
    assert.equal(partial.complete, false);
    value.manager.publishArtifacts({
      specId: value.specId,
      nodeId: "test-repair",
      artifactWrites: [{
        logicalKey: "test.requirement.repair.progress",
        parameters: { requirementId: "R1" },
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(partial.toJSON(), null, 2)}\n`),
      }],
    });

    const activeBeforeRetry = value.manager.canonicalState(value.specId);
    const oldAttempt = { id: activeBeforeRetry.attempt.id, sequence: activeBeforeRetry.attempt.sequence };
    value.manager.completeRequirementTestToolingFailure({
      specId: value.specId, message: "partial repair worker disconnected",
    });
    value.manager = makeFlowManager(value.root);
    const resumed = value.manager.canonicalState(value.specId);
    assert.equal(resumed.current.at(-1), "test-repair");
    assert.notDeepEqual({ id: resumed.attempt.id, sequence: resumed.attempt.sequence }, oldAttempt);
    assert.equal(value.manager.readArtifact({
      specId: value.specId, logicalKey: "test.requirement.repair.progress", parameters: { requirementId: "R1" },
      consumerNodeId: "test-repair", optional: true,
    }), null);
    const freshRepair = canonicalTestReviewRepairForTarget({
      flowManager: value.manager, state: value.manager.loadReadOnly(value.specId), targetStepId: "test-repair",
    });
    const fresh = canonicalTestReviewRepairProgress({
      flowManager: value.manager, state: resumed, repair: freshRepair, consumerNodeId: "test-repair", stagedSources,
    });
    assert.equal(fresh.coordinatorAttempt.id, resumed.attempt.id);
    assert.equal(fresh.coordinatorAttempt.sequence, resumed.attempt.sequence);
    assert.ok(fresh.nextBatch(freshRepair, stagedSources, oneFindingBatch), "the reconstructed Attempt receives a legal fresh repair batch");
  });

  it("Gate promotion rejects a candidate path already owned by a promoted Requirement", async () => {
    const value = setup(["R1", "R2"]);
    const sharedPath = "tests/shared.test.js";
    publishGenerated({ manager: value.manager, specId: value.specId, ...candidateFor(value.manager, value.specId, "R1", sharedPath) });
    assert.equal(value.manager.canonicalState(value.specId).current.at(-1), "test-generate");
    publishGenerated({ manager: value.manager, specId: value.specId, ...candidateFor(value.manager, value.specId, "R2", sharedPath) });
    assert.equal(value.manager.canonicalState(value.specId).current.at(-1), "test-review");

    await postReview(value, { verdict: "PASS" });
    const firstResult = gateResult(value.manager, value.specId);
    const decision = await postGate(value, firstResult);
    assert.equal(decision.disposition, "promote");
    const after = canonicalSnapshot(value);
    assert.equal(value.manager.canonicalState(value.specId).current.at(-1), "test-review");
    assert.equal(new RequirementTestArtifactStore({
      flowManager: value.manager,
      state: value.manager.canonicalState(value.specId),
    }).readPlan("test-review").artifact.plan.activeWorkItem().requirementId, "R2");
    value.manager = makeFlowManager(value.root);
    await assert.rejects(() => postGate(value, firstResult));
    assert.deepEqual(canonicalSnapshot(value), after);

    await postReview(value, { verdict: "PASS" });
    await assert.rejects(
      () => postGate(value, gateResult(value.manager, value.specId)),
      /collides with a promoted test source/,
    );
    assert.equal(value.manager.loadReadOnly(value.specId).currentNodeId, "test-gate");
  });

  it("uses the same Requirement Definition route for direct, branch, and worktree executions", async () => {
    const summaries = [];
    for (const execution of [
      { mode: "direct" },
      { mode: "branch", baseBranch: "main", featureBranch: "feature/requirement-tests" },
      { mode: "worktree", baseBranch: "main", featureBranch: "feature/requirement-tests" },
    ]) {
      const value = setup(["R1"], execution);
      publishGenerated({ manager: value.manager, specId: value.specId, ...candidateFor(value.manager, value.specId, "R1") });
      const review = await postReview(value, { verdict: "PASS" });
      const gate = await postGate(value);
      const state = value.manager.canonicalState(value.specId);
      const plan = new RequirementTestArtifactStore({ flowManager: value.manager, state })
        .readPlan("implement").artifact.plan;
      summaries.push({
        review: { disposition: review.disposition, target: review.target },
        gate: { disposition: gate.disposition, target: gate.target },
        current: state.current.at(-1),
        workItem: {
          status: plan.workItem("R1").status,
          bundleRevision: plan.workItem("R1").bundleRevision.revision,
          budget: plan.workItem("R1").budget.toJSON(),
        },
      });
    }
    assert.deepEqual(summaries, [summaries[0], summaries[0], summaries[0]]);
    assert.deepEqual(summaries[0].review, { disposition: "advance", target: "test-gate" });
    assert.deepEqual(summaries[0].gate, { disposition: "promote", target: "implement" });
    assert.equal(summaries[0].workItem.status, "promoted");
  });

  it("does not let nonblocking policy bypass a Requirement semantic repair or its selected budget", async () => {
    const value = setup();
    value.manager._store.runtime.activateNonblockingPolicy({
      specId: value.specId,
      activityId: "fixture-independent-nonblocking-policy",
      policy: {
        autoApprove: false,
        nonblocking: {
          enabled: true,
          activatedAt: CONFIRMED_AT,
          activatedStep: "test-result-review",
          reason: "A separate advisory policy is active.",
        },
      },
      nonblocking: {
        kind: "observation",
        sourceStep: "test-result-review",
        sourceAttempt: 1,
        evidenceRef: "steps/test-result-review/result.json",
        evidenceDigest: "a".repeat(64),
        definitionDigest: "b".repeat(64),
        resultKind: "unavailable",
        action: null,
        rationale: null,
        remainingRisk: null,
      },
    });
    publishGenerated({ manager: value.manager, specId: value.specId, ...candidateFor(value.manager, value.specId, "R1") });
    const decision = await postReview(value, { verdict: "REJECTED" });
    const state = value.manager.canonicalState(value.specId);
    const workItem = new RequirementTestArtifactStore({ flowManager: value.manager, state })
      .readPlan("test-repair").artifact.plan.workItem("R1");
    assert.equal(decision.disposition, "semantic_retry");
    assert.equal(decision.target, "test-repair");
    assert.equal(state.current.at(-1), "test-repair");
    assert.equal(workItem.budget.manualSemantic, 1);
    assert.equal(workItem.budget.autoSemantic, 0);
  });

  it("projects selected auto/manual semantic budgets and R tooling readback in status", async () => {
    const value = setup(["R1", "R2"]);
    publishGenerated({ manager: value.manager, specId: value.specId, ...candidateFor(value.manager, value.specId, "R1") });
    publishGenerated({ manager: value.manager, specId: value.specId, ...candidateFor(value.manager, value.specId, "R2") });
    await postReview(value, { verdict: "REJECTED" });
    value.manager.completeRequirementTestToolingFailure({ specId: value.specId, message: "temporary repair provider outage" });
    value.manager = makeFlowManager(value.root);
    const manual = new GetStatusCommand().execute({
      root: value.root, executionRoot: value.root, mainRoot: value.root,
      flowManager: value.manager, flowState: value.manager.loadReadOnly(value.specId),
    }).requirementTestLifecycle;
    assert.equal(manual.semanticMode, "manual");
    assert.deepEqual(manual.requirements.map((item) => ({
      requirementId: item.requirementId, semantic: item.semantic, tooling: item.tooling,
    })), [{
      requirementId: "R1",
      semantic: {
        mode: "manual", attempts: 1, remaining: 4,
        auto: { attempts: 0, remaining: 5 }, manual: { attempts: 1, remaining: 4 },
      },
      tooling: { attempts: 1, remaining: 2 },
    }, {
      requirementId: "R2",
      semantic: {
        mode: "manual", attempts: 0, remaining: 5,
        auto: { attempts: 0, remaining: 5 }, manual: { attempts: 0, remaining: 5 },
      },
      tooling: { attempts: 0, remaining: 3 },
    }]);

    const auto = setup();
    auto.manager.setAutoApprove(true, { specId: auto.specId });
    publishGenerated({ manager: auto.manager, specId: auto.specId, ...candidateFor(auto.manager, auto.specId, "R1") });
    await postReview(auto, { verdict: "REJECTED" });
    const autoStatus = new GetStatusCommand().execute({
      root: auto.root, executionRoot: auto.root, mainRoot: auto.root,
      flowManager: auto.manager, flowState: auto.manager.loadReadOnly(auto.specId),
    }).requirementTestLifecycle;
    assert.equal(autoStatus.semanticMode, "auto");
    assert.deepEqual(autoStatus.requirements[0].semantic, {
      mode: "auto", attempts: 1, remaining: 4,
      auto: { attempts: 1, remaining: 4 }, manual: { attempts: 0, remaining: 5 },
    });
  });

  it("records a permission-denied Requirement review as external-blocked without R tooling consumption", async () => {
    const value = setup();
    publishGenerated({ manager: value.manager, specId: value.specId, ...candidateFor(value.manager, value.specId, "R1") });
    const decision = await postReview(value, { tooling: true, permissionRelated: true });
    const state = value.manager.canonicalState(value.specId);
    const workItem = new RequirementTestArtifactStore({ flowManager: value.manager, state })
      .readPlan("test-review").artifact.plan.workItem("R1");
    assert.deepEqual(decision, { disposition: "external_blocked", target: "test-review" });
    assert.equal(state.attempt.failure.category, "external");
    assert.equal(state.attempt.failure.code, "REQUIREMENT_TEST_REVIEW_PERMISSION_DENIED");
    assert.equal(workItem.budget.tooling, 0);
  });

  it("binds an external generate block to the plan frontier published in the same Attempt", () => {
    const value = setup(["R1", "R2"]);
    publishGenerated({ manager: value.manager, specId: value.specId, ...candidateFor(value.manager, value.specId, "R1") });
    const before = value.manager.canonicalState(value.specId);
    assert.equal(before.current.at(-1), "test-generate");
    assert.equal(new RequirementTestArtifactStore({ flowManager: value.manager, state: before })
      .readPlan("test-generate").artifact.plan.activeWorkItem().requirementId, "R2");

    value.manager.completeRequirementTestExternalFailure({
      specId: value.specId,
      failure: { code: "REQUIREMENT_TEST_GENERATE_AUTH_REQUIRED", message: "generation provider authentication is required" },
    });
    const after = value.manager.canonicalState(value.specId);
    const plan = new RequirementTestArtifactStore({ flowManager: value.manager, state: after })
      .readPlan("test-generate").artifact.plan;
    assert.equal(after.attempt.failure.category, "external");
    assert.equal(after.attempt.failure.code, "REQUIREMENT_TEST_GENERATE_AUTH_REQUIRED");
    assert.equal(plan.workItem("R1").status, "candidate_saved");
    assert.equal(plan.workItem("R2").status, "in_progress");
    assert.equal(plan.workItem("R1").budget.tooling, 0);
    assert.equal(plan.workItem("R2").budget.tooling, 0);
  });
});
