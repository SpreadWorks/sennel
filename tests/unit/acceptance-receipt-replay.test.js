import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceStepRegistration, recoverAcceptanceExecution } from "../../src/flow/engine/composition/acceptance.js";
import { StepAdmissionRefusal } from "../../src/flow/lib/step-admission-refusal.js";

class Receipt {
  constructor(id) { this.id = id; Object.freeze(this); }
  toJSON() { return { id: this.id }; }
}
class SavedSettlement {
  constructor(receipt) { this.receipt = receipt; Object.freeze(this); }
}
class CanonicalReceiptReader {
  #saved;
  constructor(receipt) { this.#saved = new SavedSettlement(receipt); }
  replace(receipt) { this.#saved = receipt === null ? null : new SavedSettlement(receipt); }
  canonicalState() { return { runId: "run", specId: "spec", current: [], attempt: null }; }
  readCurrentStepSettlement({ specId, stepId, completed = false }) {
    assert.equal(specId, "spec");
    assert.equal(stepId, "report");
    return completed ? this.#saved : null;
  }
}
function selectedReplay() {
  const receipt = new Receipt("original");
  const flowManager = new CanonicalReceiptReader(receipt);
  const registration = acceptanceStepRegistration("report");
  const input = { flowManager, specId: "spec", stepId: "report", registration, receipt };
  const selection = registration.executionContract.select(input);
  return { receipt, flowManager, registration, input, selection };
}

test("Acceptance replay returns the same receipt while its canonical proof is current", async () => {
  const replay = selectedReplay();
  assert.equal(recoverAcceptanceExecution({ ...replay.input, selection: replay.selection }), replay.receipt);
  assert.equal(await replay.registration.executionContract.execute(replay.selection, replay.input), replay.receipt);
});
for (const replacement of [new Receipt("new-producer"), null]) {
  test(`Acceptance replay refuses ${replacement === null ? "removed" : "replaced"} canonical proof at both consumption boundaries`, async () => {
    const replay = selectedReplay();
    replay.flowManager.replace(replacement);
    assert.throws(() => recoverAcceptanceExecution({ ...replay.input, selection: replay.selection }), StepAdmissionRefusal);
    await assert.rejects(() => replay.registration.executionContract.execute(replay.selection, replay.input), StepAdmissionRefusal);
  });
}
