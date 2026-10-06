import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { CanonicalFlowRuntime } from "../../../src/flow/lib/canonical-flow-runtime.js";
import { StepResult } from "../../../src/flow/engine/step-result.js";
import { StepPersistenceFailure } from "../../../src/flow/lib/definition-lifecycle-failure.js";
import {
  ArtifactPublicationRace, enterRequirementTestLeaf, LifecycleSaveFault,
  prepareCommonRequirementTestError, assertSavedRequirementTestResult,
} from "../../support/requirement-test-save-boundary.js";

const LEAVES = ["approval", "test-generate", "test-review", "test-repair", "test-gate"];
const SOURCE_PUBLICATIONS = LEAVES.flatMap((leaf) => [
  [leaf, "spec.record"], ...(leaf === "approval" ? [] : [[leaf, "test.requirement.plan"]]),
]);

/** Include physical bytes so a rejected save cannot hide a partial write behind the catalog. */
function publishedBytes(scenario) {
  const location = scenario.manager.specLocation(scenario.specId);
  const catalog = JSON.parse(fs.readFileSync(location.catalogFile, "utf8"));
  const paths = [...new Set([location.catalogFile, location.flowStateFile, location.activitiesFile,
    ...catalog.artifacts.map((entry) => location.resolve(entry.relativePath))])].sort();
  return Object.fromEntries(paths.map((file) => [file, fs.readFileSync(file)]));
}

/** Inject after the manager's prechecks, before the real catalog-lock admission. */
function raceAtFailurePublication(t, mutate) {
  let hit = false;
  const original = CanonicalFlowRuntime.prototype.failAttempt;
  const control = t.mock.method(CanonicalFlowRuntime.prototype, "failAttempt", function (...args) {
    if (!hit) { hit = true; mutate(); }
    return original.apply(this, args);
  });
  return { get hit() { return hit; }, restore() { control.mock.restore(); } };
}

function sourceDescriptor(scenario, logicalKey) {
  const catalog = scenario.manager.artifactCatalog(scenario.specId);
  const descriptor = catalog.artifacts.find((entry) => entry.logicalKey === logicalKey);
  assert.ok(descriptor, `normal producer must publish ${logicalKey}`);
  return descriptor;
}

describe("Requirement Test common Error Result source admission and atomic settlement", { concurrency: false }, () => {
  for (const [leaf, logicalKey] of SOURCE_PUBLICATIONS) {
    it(`ERROR STALE ${leaf} rejects a same-byte ${logicalKey} publication after prechecks`, async (t) => {
      const scenario = await enterRequirementTestLeaf(t, leaf);
      const { prepared } = await prepareCommonRequirementTestError(scenario, leaf);
      const race = new ArtifactPublicationRace(leaf, logicalKey);
      let beforeBytes;
      const control = raceAtFailurePublication(t, () => {
        race.publish(scenario);
        beforeBytes = publishedBytes(scenario);
      });
      try {
        await assert.rejects(() => prepared.step.execute(), /changed|publication|conflict/i);
      } finally { control.restore(); }
      assert.equal(control.hit, true, "Error producer must reach its real publication boundary");
      assert.equal(race.hit, true);
      scenario.reload();
      assert.deepEqual(scenario.snapshot(), race.snapshot,
        "stale Error cannot append a failure/Result/receipt or alter Attempt, budget and frontier");
      assert.deepEqual(publishedBytes(scenario), beforeBytes,
        "refusal precedes every physical publication write");
      assert.equal(scenario.manager.canonicalState(scenario.specId).attempt.failure, null);
    });
  }

  const tamperCases = [
    ...SOURCE_PUBLICATIONS,
    ["approval", "spec.review"], ["approval", "spec.snapshot"],
    ...["test-review", "test-repair", "test-gate"].flatMap((leaf) => [
      "test.requirement.candidate.bundle", "test.requirement.candidate.source",
    ].flatMap((logicalKey) => [
      [leaf, logicalKey], [leaf, logicalKey, "reload"],
    ])),
  ];
  for (const [leaf, logicalKey, boundary = "settlement"] of tamperCases) {
    it(`ERROR TAMPER ${leaf} refuses altered ${logicalKey} bytes at ${boundary}`, async (t) => {
      const scenario = await enterRequirementTestLeaf(t, leaf);
      const descriptor = sourceDescriptor(scenario, logicalKey);
      const file = scenario.manager.specLocation(scenario.specId).resolve(descriptor.relativePath);
      const before = scenario.snapshot();
      let changedBytes;
      const tamper = () => {
        // Keep the actual producer's JSON/source intact and alter only its seal.
        fs.appendFileSync(file, "\n");
        changedBytes = publishedBytes(scenario);
      };
      if (boundary === "reload") {
        tamper();
        scenario.reload();
        assert.throws(() => scenario.manager.canonicalState(scenario.specId), /hash|size|integrity|digest|catalog|content/i,
          "the first canonical read after manager reconstruction must reject bytes whose catalog seal no longer matches");
        assert.deepEqual(publishedBytes(scenario), changedBytes,
          "failed canonical loading cannot repair or otherwise alter the hostile bytes");
        fs.writeFileSync(file, changedBytes[file].subarray(0, changedBytes[file].length - 1));
        scenario.reload();
        assert.deepEqual(scenario.snapshot(), before,
          "restoring catalog-sealed candidate bytes makes the original Attempt readable again");
        assert.equal(scenario.manager.canonicalState(scenario.specId).attempt.failure, null);
        return;
      }
      const { prepared } = await prepareCommonRequirementTestError(scenario, leaf);
      const control = raceAtFailurePublication(t, tamper);
      try {
        await assert.rejects(() => prepared.step.execute(), /hash|size|integrity|digest|catalog|changed|match/i);
      } finally { control?.restore(); }
      assert.equal(control.hit, true, "tamper must occur after Store prechecks");
      assert.deepEqual(publishedBytes(scenario), changedBytes,
        "tamper rejection cannot change state, ledger, catalog or other artifact bytes");
      // Restore the hostile boundary input only after auditing refusal, then discard
      // managers and verify the persisted source Attempt still has no Failure Result.
      fs.writeFileSync(file, changedBytes[file].subarray(0, changedBytes[file].length - 1));
      scenario.reload();
      assert.deepEqual(scenario.snapshot(), before);
      assert.equal(scenario.manager.canonicalState(scenario.specId).attempt.failure, null);
    });
  }

  for (const leaf of LEAVES) {
    it(`ERROR ATOMIC ${leaf} rolls back catalog-commit failure and resumes with one exact receipt`, async (t) => {
      const scenario = await enterRequirementTestLeaf(t, leaf);
      const fault = new LifecycleSaveFault(t, scenario, leaf, "before-commit", {
        storeCommit: true, observePersisted: () => publishedBytes(scenario),
      });
      const { prepared } = await prepareCommonRequirementTestError(scenario, leaf);
      try {
        await assert.rejects(() => prepared.step.execute(),
          (error) => error instanceof StepPersistenceFailure && error.cause === fault.error);
      } finally { fault.restore(); }
      assert.equal(fault.hit, true, "Error must reach the actual catalog commit fault");
      assert.notDeepEqual(fault.pendingPersisted, fault.beforePersisted,
        "the fault must follow real state/Activity writes, so rollback is exercised");
      scenario.reload();
      assert.deepEqual(scenario.snapshot(), fault.before);
      assert.deepEqual(publishedBytes(scenario), fault.beforePersisted,
        "rollback restores every physical artifact, including Result and receipt bytes");

      const resumed = await prepareCommonRequirementTestError(scenario, leaf);
      const result = await resumed.prepared.step.execute();
      scenario.reload();
      const activity = assertSavedRequirementTestResult(scenario, leaf);
      assert.deepEqual(StepResult.fromStored(leaf, activity.result.stepResult).toJSON(), result.toJSON());
      assert.equal(activity.transition.operation, "fail_attempt");
      assert.equal(activity.result.draftSettlementReceipt.id, resumed.service.settlementOutcome.receipt.id);
      assert.equal(activity.result.draftSettlementReceipt.settlementKind, "failure");
      assert.equal(scenario.manager.canonicalState(scenario.specId).attempt.failure.code, "SEMANTIC_STEP_FAILURE");
      const committed = scenario.snapshot();
      const committedBytes = publishedBytes(scenario);

      const replay = await prepareCommonRequirementTestError(scenario, leaf);
      await replay.prepared.step.execute();
      assert.equal(replay.service.settlementOutcome.receipt.id, activity.result.draftSettlementReceipt.id);
      scenario.reload();
      assert.deepEqual(scenario.snapshot(), committed, "exact Error replay adds no duplicate failure or receipt");
      assert.deepEqual(publishedBytes(scenario), committedBytes);

      const conflicting = await prepareCommonRequirementTestError(scenario, leaf,
        Object.assign(new Error("different semantic Error"), { code: "SEMANTIC_STEP_FAILURE", data: { requirementId: "R1" } }));
      await assert.rejects(() => conflicting.prepared.step.execute(), /conflict|different|changed|match/i);
      scenario.reload();
      assert.deepEqual(scenario.snapshot(), committed, "a different Error cannot reuse the saved receipt");
      assert.deepEqual(publishedBytes(scenario), committedBytes);
    });
  }
});
