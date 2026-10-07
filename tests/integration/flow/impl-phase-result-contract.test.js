import assert from "node:assert/strict";
import { it } from "node:test";
import { futurePhaseManifests } from "../../support/structure/phase-manifest.js";
import { ImplPhaseResultContract, implPhaseResultContracts } from "../../support/assertions/impl-phase-result.js";
import * as definition from "../../../src/flow/definition.js";

it("37e4 fixes concrete semantic Result contracts for every owning leaf", () => {
  const expected = futurePhaseManifests.find((entry) => entry.id === "03").leaves.map((entry) => entry.stepId).sort();
  assert.deepEqual([...new Set(implPhaseResultContracts.map((entry) => entry.stepId))].sort(), expected);
  assert.equal(new Set(implPhaseResultContracts.map((entry) => entry.kind)).size, implPhaseResultContracts.length);
  assert.equal(implPhaseResultContracts.filter((entry) => entry.type === "error").length, 12);
});

for (const contract of implPhaseResultContracts) {
  it(`37e4 ${contract.stepId}: single registry keeps ${contract.className}/${contract.kind}/${contract.type}`, () => {
    contract.registration();
  });
}

it("implementation contract values reject invalid identities and result types", () => {
  assert.throws(() => new ImplPhaseResultContract("", "Result", "result", "completed", "37e4"), TypeError);
  assert.throws(() => new ImplPhaseResultContract("implement", "Result", "result", "pass", "37e4"), TypeError);
});

for (const name of ["settleImplStepResult", "settleTaskStepResult"]) {
  it(`37e4 saved Result-only Definition selection exposes ${name}`, () => {
    assert.equal(typeof definition[name], "function", `IMPL_PHASE_SETTLEMENT_API_MISSING: ${name}`);
  });
}
