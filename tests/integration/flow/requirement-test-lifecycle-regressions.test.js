import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  FLOW_COMMANDS,
} from "../../../src/flow/registry.js";
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
  canonicalTestReviewRepairForTarget,
  canonicalTestReviewRepairProgress,
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

function setup(requirementIds = ["R1"]) {
  const root = createTmpDir("requirement-lifecycle-regression-");
  roots.push(root);
  const manager = makeFlowManager(root);
  const specId = `requirement-regression-${roots.length}`;
  new FlowAtStepFixture({
    flowManager: manager,
    specId,
    runId: `run-${specId}`,
    execution: { mode: "direct" },
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

function reviewResult(manager, specId, { verdict = "PASS", tooling = false } = {}) {
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
  const payload = {
    version: 1,
    phase: "test",
    requirementId: item.requirementId,
    specRevision: item.specRevision.toJSON(),
    bundleRevision: item.bundleRevision.revision,
    candidateDigest: candidate.digest,
    sourceAttempt: item.bundleRevision.lineage.sourceAttempt.toJSON(),
    ...(tooling ? { toolingOutcome: { reason: finding.reason } } : { verdict }),
    blockingFindings: verdict === "REJECTED" || tooling ? [finding] : [],
    advisoryFindings: verdict === "ADVISORY" ? [{ ...finding, category: "advisory" }] : [],
    ...(verdict === "REJECTED" ? {
      canonicalEvidence: {
        disposition: "REJECTED",
        blockingFindings: [{ findingId: finding.findingId, fingerprint: finding.fingerprint }],
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

  it("Gate promotion rejects a candidate path already owned by a promoted Requirement", async () => {
    const value = setup(["R1", "R2"]);
    const sharedPath = "tests/shared.test.js";
    for (const requirementId of ["R1", "R2"]) {
      publishGenerated({ manager: value.manager, specId: value.specId, ...candidateFor(value.manager, value.specId, requirementId, sharedPath) });
      await postReview(value, { verdict: "PASS" });
      const result = gateResult(value.manager, value.specId);
      if (requirementId === "R1") {
        const decision = await postGate(value, result);
        assert.equal(decision.disposition, "promote");
        const after = canonicalSnapshot(value);
        assert.equal(value.manager.canonicalState(value.specId).current.at(-1), "test-generate");
        assert.equal(new RequirementTestArtifactStore({
          flowManager: value.manager,
          state: value.manager.canonicalState(value.specId),
        }).readPlan("test-generate").artifact.plan.activeWorkItem().requirementId, "R2");
        value.manager = makeFlowManager(value.root);
        await assert.rejects(() => postGate(value, result));
        assert.deepEqual(canonicalSnapshot(value), after);
      } else {
        await assert.rejects(
          () => postGate(value, result),
          /collides with a promoted test source/,
        );
        assert.equal(value.manager.loadReadOnly(value.specId).currentNodeId, "test-gate");
      }
    }
  });
});
