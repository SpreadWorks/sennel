import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { ImplPhaseScenario } from "../../support/impl-phase-scenario.js";
import { implStepRegistration, recoverTestChainExecution } from "../../../src/flow/engine/composition/impl.js";
import { DraftStepSettlementReceiptValue } from "../../../src/flow/lib/draft-step-settlement-receipt.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";

/** Malformed external receipt input; never used to produce or save evidence. */
class ReceiptBoundaryInput extends DraftStepSettlementReceiptValue {
  #document;
  constructor(document) { super(); this.#document = structuredClone(document); }
  toJSON() { return structuredClone(this.#document); }
}

function fileDigests(root, roots) {
  const files = [];
  const visit = (relative) => {
    const target = path.join(root, relative);
    if (!fs.existsSync(target)) return;
    if (fs.statSync(target).isDirectory()) {
      for (const child of fs.readdirSync(target).sort()) visit(path.join(relative, child));
    } else files.push([relative, createHash("sha256").update(fs.readFileSync(target)).digest("hex")]);
  };
  for (const relative of roots) visit(relative);
  return files;
}

function protectedEvidence(scenario) {
  const canonical = scenario.snapshot();
  const location = scenario.manager.specLocation(scenario.specId);
  return {
    canonical,
    artifacts: canonical.catalog.artifacts.map(({ relativePath }) => [relativePath,
      createHash("sha256").update(fs.readFileSync(location.resolve(relativePath))).digest("hex")]),
    canonicalFiles: fileDigests(location.directory, [""]),
    source: fileDigests(scenario.root, ["src", "project-tests", "package.json"]),
    metrics: canonical.activities.filter((entry) => entry.metric !== null).map(({ id, metric }) => ({ id, metric })),
    workers: scenario.requests.length,
    reviews: scenario.reviews.length + scenario.phaseReviews.length,
    dispatches: scenario.dispatches.length,
  };
}

test("completed test-chain receipts replay after reload without repeating either producer", async (t) => {
  const scenario = ImplPhaseScenario.create(t);
  // The normal dispatcher creates both observations from promoted Requirement
  // tests and the material implementation; no final publication is seeded.
  await scenario.advanceTo("impl-review");
  const producerManager = scenario.manager;
  scenario.reload();
  assert.notEqual(scenario.manager, producerManager);
  const producers = [
    ["test-execute", "test.execute", "test-result-review"],
    ["test-result-review", "test.result.review", "impl-review"],
  ].map(([stepId, logicalKey, target]) => ({ stepId, target,
    publication: scenario.commandArtifact(logicalKey, "impl-review") }));
  const before = protectedEvidence(scenario);
  const processCalls = [];
  const processMocks = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]
    .map((name) => {
      const original = childProcess[name];
      return t.mock.method(childProcess, name, function (...args) {
        processCalls.push({ name, command: args[0] });
        return original.apply(this, args);
      });
    });
  syncBuiltinESMExports();
  t.after(() => { for (const mocked of processMocks) mocked.mock.restore(); syncBuiltinESMExports(); });

  for (const { stepId, target, publication } of producers) {
    const saved = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId, completed: true });
    assert.equal(saved.activityId, publication.descriptor.activityId);
    assert.equal(saved.receipt.binding.stepId, stepId);
    assert.equal(saved.receipt.targetStepId, target);
    const expected = scenario.state().findNode(stepId).result.draftSettlementReceipt.toJSON();
    const registration = implStepRegistration(stepId);
    const input = { flowManager: scenario.manager, specId: scenario.specId, stepId,
      registration, receipt: saved.receipt };
    const selection = registration.executionContract.select(input);
    const executed = await registration.executionContract.execute(selection, input);
    const recovered = await recoverTestChainExecution({ ...input, selection });
    for (const receipt of [executed, recovered]) {
      assert.equal(receipt.id, expected.id);
      assert.deepEqual(receipt.toJSON(), expected);
    }

    const raw = scenario.manager.readRuntimeArtifact({ specId: scenario.specId,
      logicalKey: "test.execute.raw-log", consumerNodeId: stepId });
    const location = scenario.manager.specLocation(scenario.specId);
    for (const [kind, relativePath] of [["cataloged publication", publication.descriptor.relativePath],
      ["runtime raw log", raw.relativePath]]) {
      const chosen = registration.executionContract.select(input);
      const file = location.resolve(relativePath);
      const bytes = fs.readFileSync(file);
      let altered = false;
      const restore = () => {
        if (altered) { fs.writeFileSync(file, bytes); altered = false; }
      };
      t.after(restore);
      try {
        altered = true;
        fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from("\n")]));
        assert.notDeepEqual(fs.readFileSync(file), bytes, `${kind} must actually change after selection`);
        await assert.rejects(() => registration.executionContract.execute(chosen, input),
          StepAdmissionRefusal, `${stepId} execution must reauthenticate changed ${kind}`);
        await assert.rejects(async () => recoverTestChainExecution({ ...input, selection: chosen }),
          StepAdmissionRefusal, `${stepId} recovery must reauthenticate changed ${kind}`);
        assert.deepEqual(processCalls, [], `${kind} refusal must not start another process`);
      } finally { restore(); }
      assert.deepEqual(fs.readFileSync(file), bytes, `${kind} must be restored exactly`);
      assert.deepEqual(protectedEvidence(scenario), before,
        `${stepId} changed ${kind} refusal must preserve all canonical evidence and effects`);
    }

    const wrongBinding = new ReceiptBoundaryInput({ ...expected,
      binding: { ...expected.binding, attemptId: `${expected.binding.attemptId}-other` } });
    const wrongDigest = new ReceiptBoundaryInput({ ...expected,
      resultDigest: expected.resultDigest === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64) });
    for (const receipt of [wrongBinding, wrongDigest]) {
      assert.throws(() => registration.executionContract.select({ ...input, receipt }), StepAdmissionRefusal);
      assert.deepEqual(protectedEvidence(scenario), before, "a mismatched receipt must be rejected before effects");
    }
  }
  assert.deepEqual(processCalls, [], "replay and refused receipt inputs must not start another process");
  for (const mocked of processMocks) mocked.mock.restore();
  syncBuiltinESMExports();
  scenario.reload();
  assert.deepEqual(protectedEvidence(scenario), before,
    "exact replay must retain canonical state, publications, source, producer counts and metrics");
});
