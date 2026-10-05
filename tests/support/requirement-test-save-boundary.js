import assert from "node:assert/strict";
import fs from "node:fs";
import { RequirementTestPhaseScenario, rejectFirstRequirementReview } from "./requirement-test-phase-scenario.js";
import { assertRequirementTestResultRoundtrip } from "./assertions/requirement-test-result.js";

export async function enterRequirementTestLeaf(t, leaf, options = {}) {
  const scenario = RequirementTestPhaseScenario.create(t, {
    ...(leaf === "test-repair" ? { reviewResponse: rejectFirstRequirementReview } : {}),
    ...options,
  });
  await scenario.advanceTo("approval");
  if (leaf !== "approval") {
    scenario.approve();
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
  return Object.fromEntries(files.map((file) => [location.relativePath(file),
    fs.existsSync(file) ? fs.readFileSync(file) : null]));
}

export function assertGatePublicationRollback(before, restored) {
  assert.deepEqual(restored, before,
    "Gate rollback must restore state, Activity/Result/receipt, plan, catalog, Gate evidence and every primary/support source");
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
    const original = scenario.manager[method];
    this.control = t.mock.method(scenario.manager, method, function (...args) {
      if (owner.hit || scenario.current() !== leaf) return original.apply(this, args);
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
