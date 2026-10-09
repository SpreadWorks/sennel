/**
 * `retro` aggregates producer-owned test Attempt artifacts. The immutable
 * upstream seed runs actual producers, and each consumer owns a separate root.
 */

// spec: R5 R52
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RunRetroCommand } from "../../../src/flow/lib/run-retro.js";
import { buildRepairFingerprint } from "../../../src/flow/lib/repair-fingerprint.js";
import { findStepById } from "../../../src/flow/lib/step-tree.js";
import { AcceptancePhaseScenario } from "../../support/acceptance-phase-scenario.js";
import { removeCatalogedArtifactForCorruptionFixture } from "../../support/infrastructure/flow-setup.js";

describe("R5: retro consumes canonical test Attempt results (spec 251)", { concurrency: false }, () => {
  let seed;
  const seedCleanups = [];
  after(() => { for (const cleanup of seedCleanups.reverse()) cleanup(); });
  before(async () => {
    const scope = { mock, after(cleanup) { seedCleanups.push(cleanup); } };
    seed = await AcceptancePhaseScenario.seed(scope, {
      frontier: "retro",
      seedSpecId: "001-test",
    });
  });

  it("R5: dry-run retro aggregates pass/fail per requirement when producer artifacts exist", async (t) => {
    const scenario = AcceptancePhaseScenario.fromSeed(t, seed);

    const out = await new RunRetroCommand().execute({ ...scenario.context(), dryRun: true });

    assert.equal(out.result, "dry-run", JSON.stringify(out));
    assert.equal(out.artifacts.summary.total, 1);
    assert.equal(out.artifacts.summary.done, 1);
    assert.match(out.artifacts.spec, /^specs\/001-test\/001\/spec\.json$/);
  });

  it("R5: returns Envelope.fail when the canonical test-execute result is missing", async (t) => {
    const scenario = AcceptancePhaseScenario.fromSeed(t, seed);
    removeCatalogedArtifactForCorruptionFixture(scenario.manager, scenario.specId, "test.execute");

    const result = await new RunRetroCommand().execute({ ...scenario.context(), dryRun: true });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "TEST_EXECUTE_RESULT_MISSING");
    assert.match(result.errors[0].messages.join(" "), /test-execute canonical artifact is absent/i);
  });

  it("rewinds stale post-gate evidence to test-execute through one canonical recovery Activity", async (t) => {
    const scenario = AcceptancePhaseScenario.fromSeed(t, seed);
    const { root, specId, manager: flowManager } = scenario;
    const location = flowManager.specLocation(specId);
    const oldExecution = scenario.commandArtifact("test.execute", "retro");
    const oldReview = scenario.commandArtifact("test.result.review", "retro");
    const oldAttempt = flowManager.canonicalState(specId).findNode("test-execute");
    const previousFingerprint = oldExecution.payload.repairFingerprint;
    assert.equal(previousFingerprint, buildRepairFingerprint({ root, artifactRoot: root,
      specPath: location.relativeSpecFile }).hash);
    assert.equal(oldReview.payload.repairFingerprint, previousFingerprint);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "post-gate-repair.js"), "export const repaired = true;\n");
    const currentFingerprint = buildRepairFingerprint({
      root,
      specPath: location.relativeSpecFile,
    }).hash;

    const result = await new RunRetroCommand().execute(scenario.context());
    scenario.reload();
    const recoveredState = scenario.manager.loadReadOnly(specId);
    const recoveredAttempt = scenario.manager.canonicalState(specId).attempt;

    assert.equal(result.result, "recovered");
    assert.equal(result.artifacts.evidenceRefresh.activeStep, "test-execute");
    assert.equal(result.artifacts.evidenceRefresh.recovered, true);
    assert.equal(result.artifacts.evidenceRefresh.previousFingerprint, previousFingerprint);
    assert.equal(result.artifacts.evidenceRefresh.currentFingerprint, currentFingerprint);
    assert.equal(findStepById(recoveredState.steps, "test-execute").status, "in_progress");
    assert.equal(findStepById(recoveredState.steps, "retro").status, "invalidated");
    assert.equal(scenario.manager.activityLedger(specId).at(-1).transition.operation, "rewind_test_evidence");
    assert.equal(recoveredAttempt.nodeId, "test-execute");
    assert.equal(recoveredAttempt.sequence, oldAttempt.attemptSequence + 1);
    assert.deepEqual(scenario.commandArtifact("test.execute", "retro"), oldExecution);
    assert.deepEqual(scenario.commandArtifact("test.result.review", "retro"), oldReview);
    assert.equal(fs.existsSync(path.join(root, "specs", specId, "test-execute-result.json")), false);
    assert.equal(fs.existsSync(path.join(root, "specs", specId, "test-result-review.json")), false);
  });
});
