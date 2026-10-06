import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { CanonicalFlowRuntime } from "../../src/flow/lib/canonical-flow-runtime.js";
import { CurrentFlowSpecRecord } from "../../src/flow/lib/current-flow-state.js";
import { RequirementTestArtifactStore } from "../../src/flow/lib/requirement-test-store.js";
import { acquireApprovalInput, acquireRequirementTestInput, requirementTestStepRegistration } from "../../src/flow/engine/composition/test.js";
import { ApprovalInput } from "../../src/flow/services/approval-input.js";
import { RequirementTestPhaseScenario, rejectFirstRequirementReview } from "./requirement-test-phase-scenario.js";
import { assertRequirementTestResultRoundtrip } from "./assertions/requirement-test-result.js";

export async function enterRequirementTestLeaf(t, leaf, options = {}) {
  const scenario = RequirementTestPhaseScenario.create(t, {
    ...(leaf === "test-repair" ? { reviewResponse: rejectFirstRequirementReview } : {}),
    ...options,
  });
  await scenario.advanceTo("approval");
  if (leaf !== "approval") {
    await scenario.approve();
    await scenario.advanceTo(leaf);
  }
  return scenario;
}

export function assertSavedRequirementTestResult(scenario, leaf) {
  const results = scenario.manager.activityLedger(scenario.specId)
    .filter((activity) => activity.nodeId === leaf && activity.result?.stepResult);
  assert.ok(results.length > 0, `unmet 02 durable ${leaf} Result/receipt contract`);
  const activity = results.at(-1);
  assertRequirementTestResultRoundtrip(leaf, activity.result.stepResult, scenario.evidenceFor(activity));
  assert.ok(activity.result.draftSettlementReceipt,
    "the shared settlement receipt must be saved with the Result, never supplied by the interrupted caller");
  return activity;
}

/** Immutable candidate support remains a Gate audit input after downstream activation. */
export function readGateSupportBaseline(scenario, parameters) {
  return scenario.manager.readArtifact({ specId: scenario.specId,
    logicalKey: "test.requirement.support", parameters, consumerNodeId: "test-gate", optional: true });
}

/** Read promoted Requirement source through its catalog-authorized Gate consumer. */
export function readActiveRequirementTestSource(scenario, testPath) {
  return scenario.manager.readArtifact({ specId: scenario.specId, logicalKey: "tests.source",
    parameters: { testPath }, consumerNodeId: "test-gate", optional: true });
}

/** Physical transaction audit, including files not yet visible in the catalog. */
export function gatePublicationBytes(scenario, candidate) {
  const location = scenario.manager.specLocation(scenario.specId);
  const files = [
    location.flowStateFile, location.activitiesFile, location.catalogFile,
    location.artifact("test.requirement.plan"), location.artifact("test.requirement.gate"),
    ...[...candidate.sources, ...candidate.support].map((source) => location.artifact("tests.source", {
      testPath: (source.testPath ?? source.supportPath).slice("tests/".length),
    })),
  ];
  return Object.fromEntries(files.map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
}

export function assertGatePublicationRollback(before, restored) {
  assert.deepEqual(restored, before,
    "Gate rollback must restore state, Activity/Result/receipt, plan, catalog, Gate evidence and every primary/support source");
}

/** Compare an uncertain worker save with its durable frontier, allowing only that call's metric Activity. */
export function assertSnapshotAfterMetricFlush(actual, expected, phase) {
  const previousMetrics = expected.activities.filter((entry) => entry.transition.operation === "record_metric");
  const actualMetrics = actual.activities.filter((entry) => entry.transition.operation === "record_metric");
  assert.equal(actualMetrics.length, previousMetrics.length + 1, "one completed worker invocation records one metric Activity");
  const previousOtherActivities = expected.activities.length - previousMetrics.length;
  const actualOtherActivities = actual.activities.length - actualMetrics.length;
  assert.equal(actual.state.confirmationOrder, expected.state.confirmationOrder + 1
    + actualOtherActivities - previousOtherActivities);
  const metric = actualMetrics.at(-1);
  assert.equal(metric.metric.phase, phase);
  assert.equal(metric.transition.operation, "record_metric");

  const normalized = structuredClone(actual);
  normalized.activities = normalized.activities.filter((entry) => entry.transition.operation !== "record_metric");
  normalized.state.confirmationOrder = expected.state.confirmationOrder + 1;
  const expectedWithoutMetrics = structuredClone(expected);
  expectedWithoutMetrics.activities = expectedWithoutMetrics.activities
    .filter((entry) => entry.transition.operation !== "record_metric");
  expectedWithoutMetrics.state.confirmationOrder = expected.state.confirmationOrder + 1;
  const expectedDescriptors = new Map(expected.catalog.artifacts.map((entry) => [entry.relativePath, entry]));
  normalized.catalog.artifacts = normalized.catalog.artifacts.map((entry) => {
    if (!["flow.activities", "flow.state"].includes(entry.logicalKey)) return entry;
    assert.equal(entry.activityId, actual.activities.at(-1).id, `${entry.logicalKey} must publish the final Activity`);
    const prior = expectedDescriptors.get(entry.relativePath);
    assert.ok(prior, `${entry.logicalKey} must already have its canonical descriptor`);
    return prior;
  });
  normalized.catalog.hash = expected.catalog.hash;
  assert.deepEqual(normalized, expectedWithoutMetrics,
    "recovery may append its provider metric while preserving every semantic Activity, artifact and route");
}

/** Match the candidate's independently read source identities to downstream catalog provenance. */
export function assertGatePublicationMembers(expected, observed, activityId) {
  const identity = (member) => ({ testPath: member.testPath, hash: member.hash, size: member.size, activityId: member.activityId });
  const sorted = (members) => members.map(identity).sort((left, right) => left.testPath.localeCompare(right.testPath));
  assert.deepEqual(sorted(observed), sorted(expected.map((member) => ({ ...member, activityId }))),
    "Gate promotion must bind every primary/support member to the exact Result Activity");
}

/** Caller faults surround the real save; storeCommit faults interrupt its actual catalog commit. */
export class LifecycleSaveFault {
  constructor(t, scenario, leaf, phase, { method = leaf === "approval" ? "approveSpecContinuation" : "completeRequirementTestLifecycle", artifactKey = null, storeCommit = false, observePersisted = null } = {}) {
    this.leaf = leaf;
    this.phase = phase;
    this.error = new Error(`a1ee ${leaf} ${phase} save boundary`);
    this.hit = false;
    this.before = null;
    this.committed = null;
    const owner = this;
    if (phase === "before-commit" && storeCommit) {
      const catalogFile = scenario.manager.specLocation(scenario.specId).catalogFile;
      scenario.reload({ versionStoreFaultInjector({ phase: storePhase, filePath }) {
        if (owner.armed && !owner.hit && storePhase === "before-json-rename" && filePath === catalogFile) {
          owner.hit = true;
          // Only direct file observation is legal while the catalog transaction is open.
          owner.pendingPersisted = observePersisted?.();
          throw owner.error;
        }
      } });
    }
    // Review post-hooks may use a root-scoped FlowManager instance. Patch the
    // shared method slot so the fault still surrounds the same canonical save.
    const target = Object.getPrototypeOf(scenario.manager);
    const original = target[method];
    this.control = t.mock.method(target, method, function (...args) {
      const operationStepId = args[0]?.nodeId ?? args[0]?.stepResult?.stepId
        ?? args[0]?.binding?.stepId ?? args[0]?.binding?.leaf ?? null;
      if (owner.hit || (artifactKey === null && scenario.current() !== leaf)
        || (artifactKey !== null && operationStepId !== leaf)) return original.apply(this, args);
      if (leaf === "test-review" && args[0]?.stepResult?.kind === "test-review-execution-required") {
        return original.apply(this, args);
      }
      if (artifactKey !== null && !args[0]?.artifactWrites?.some((write) => write.logicalKey === artifactKey)) {
        return original.apply(this, args);
      }
      owner.before = scenario.snapshot();
      owner.beforePersisted = observePersisted?.();
      if (phase === "before-commit") {
        if (!storeCommit) { owner.hit = true; throw owner.error; }
        owner.armed = true;
        try { return original.apply(this, args); }
        finally { owner.armed = false; }
      }
      owner.hit = true;
      const committed = original.apply(this, args);
      owner.committed = scenario.snapshot();
      if (phase === "receipt-read") {
        owner.readHit = false;
        owner.readControl = t.mock.method(scenario.manager, "activityLedger", () => {
          owner.readHit = true;
          throw owner.error;
        });
        return committed;
      }
      throw owner.error;
    });
  }
  restore() { this.control.mock.restore(); this.readControl?.mock.restore(); }
}

/** Prepare the common Error through production input acquisition and the registered Service. */
export async function prepareCommonRequirementTestError(scenario, stepId, error = Object.assign(new Error("semantic Step failure"), {
  code: "SEMANTIC_STEP_FAILURE", data: { requirementId: "R1" },
})) {
  const state = scenario.manager.canonicalState(scenario.specId);
  const specRecord = scenario.manager.readArtifact({ specId: scenario.specId,
    logicalKey: "spec.record", consumerNodeId: stepId });
  let observed;
  if (stepId === "approval") {
    const review = scenario.manager.readCurrentSpecReview({ specId: scenario.specId, consumerNodeId: stepId });
    const acquired = acquireApprovalInput({ state, specDescriptor: specRecord.descriptor,
      spec: JSON.parse(specRecord.bytes.toString("utf8")), review: review.review, approved: false });
    observed = new ApprovalInput({ ...acquired, error });
  } else {
    const planRead = new RequirementTestArtifactStore({ flowManager: scenario.manager, state }).readPlan(stepId);
    observed = acquireRequirementTestInput({ state, stepId, planRead,
      specRecordPublication: specRecord.descriptor,
      error,
    });
  }
  const registration = requirementTestStepRegistration(stepId);
  const prepared = await registration.create({ flowManager: scenario.manager,
    specId: scenario.specId, observed, expectedSpecDigest: specRecord.descriptor.hash });
  return { prepared, service: prepared.dependency(registration.ServiceClass) };
}


/** Republishes only genuine producer bytes; it never fabricates authority, values or evidence. */
export class ArtifactPublicationRace {
  constructor(leaf, logicalKey) {
    this.leaf = leaf;
    this.logicalKey = logicalKey;
    this.hit = false;
    this.snapshot = null;
  }

  publish(scenario) {
    if (this.hit) return;
    this.hit = true;
    const original = scenario.artifact(this.logicalKey);
    assert.ok(original, `legal producer must have published ${this.logicalKey} before the race`);
    if (this.logicalKey === "spec.record") {
      // The canonical Spec requires its narrow typed writer, never a generic
      // artifact write. Reuse the producer's exact document and actual Definition;
      // the Store owns the new Activity, descriptor and revision decision.
      const runtime = new CanonicalFlowRuntime({ repositoryRoot: scenario.root,
        definition: scenario.manager.canonicalState(scenario.specId).definition });
      runtime.updateSpecRecord({ specId: scenario.specId,
        activityId: `spec-record-updated-${randomUUID()}`, nodeId: "approval",
        specRecord: new CurrentFlowSpecRecord(JSON.parse(original.bytes.toString("utf8")),
          { specId: scenario.specId }),
      });
    } else {
      scenario.manager.publishArtifacts({ specId: scenario.specId, nodeId: this.leaf,
        artifactWrites: [{ logicalKey: this.logicalKey, mediaType: "application/json", bytes: original.bytes }],
      });
    }
    const replaced = scenario.artifact(this.logicalKey);
    assert.deepEqual(replaced.bytes, original.bytes);
    assert.equal(replaced.descriptor.hash, original.descriptor.hash);
    assert.equal(replaced.descriptor.size, original.descriptor.size);
    assert.notEqual(replaced.descriptor.activityId, original.descriptor.activityId,
      "same byte hash/size is not the same canonical publication");
    this.snapshot = scenario.snapshot();
  }
}
