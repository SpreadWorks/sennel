import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowArtifactCatalogSnapshotLimits } from "../../src/lib/flow-version.js";
import { SpecGateRepairSettlementWriter } from "../../src/flow/services/spec-gate-repair-settlement-writer.js";

test("repair settlement saves reuse the selected publication limits and return the save receipt", () => {
  const limits = new FlowArtifactCatalogSnapshotLimits({ maxTotalArtifactBytes: 1024 });
  const binding = Object.freeze({ stepId: "spec-gate-repair" });
  const publicationReceipt = Object.freeze({ id: "response-publication" });
  const receipt = Object.freeze({ id: "settlement" });
  const saved = [];
  const save = (input) => { saved.push(input); return receipt; };
  const writer = new SpecGateRepairSettlementWriter({
    ctx: { flowManager: { commitSpecStepResult: save, completeSpecGateRepairProgress: save } },
    binding, publication: { workerArtifact: "sealed" }, publicationReceipt,
    handoffCoordinator: { faultInjector: () => {} }, publicationLimits: limits,
  });
  assert.equal(writer.settle({ result: "repair" }), receipt);
  assert.equal(writer.settleDraftReturn({ result: "draft-return" }), receipt);
  assert.equal(writer.completeProgress({ result: "context" }), receipt);
  assert.deepEqual(saved.map((input) => input.result), ["repair", "draft-return", "context"]);
  for (const input of saved) {
    assert.equal(input.publicationLimits, limits);
    assert.equal(input.binding, binding);
  }
  assert.equal(saved[0].workerArtifact, "sealed");
  assert.equal(saved[2].publicationReceipt, publicationReceipt);
});

test("repair settlement writer refuses untyped publication limits", () => {
  assert.throws(() => new SpecGateRepairSettlementWriter({ publicationLimits: { maxTotalArtifactBytes: 1024 } }),
    (error) => error instanceof TypeError && /typed publication limits/.test(error.message));
});
