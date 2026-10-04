import assert from "node:assert/strict";
import { test } from "node:test";
import { StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { StepExecutionContract } from "../../../src/flow/engine/composition/step-execution-contract.js";
import { StagedExecutionSeed } from "../../fixtures/structure/staged-execution.js";
import { PrepareExecutionObserver } from "../../support/infrastructure/prepare-execution-observer.js";

test("Prepare observation keeps two registrations sharing one contract and their selections separate", async (t) => {
  const seed = new StagedExecutionSeed("prepare", ["branch", "prepare-spec"], null, "prepare-adoption");
  const originalCreate = StepRegistration.prototype.create;
  const originalMethods = ["select", "project", "execute"].map((name) => StepExecutionContract.prototype[name]);
  const observer = new PrepareExecutionObserver(t, { registrations: seed.registrations });
  try {
    assert.equal(seed.registrations[0].executionContract, seed.registrations[1].executionContract);
    for (const registration of seed.registrations) {
      const input = Object.freeze({ stepId: registration.stepId });
      const selection = registration.executionContract.select(input);
      assert.equal(registration.executionContract.project(selection, input), selection);
      assert.equal(registration.executionContract.execute(selection, input), selection);
      const prepared = await registration.create(input);
      assert.deepEqual(observer.prepared(registration), [prepared]);
      observer.assertProjected(registration.stepId);
    }
    observer.assertExecuted(["branch", "prepare-spec"]);
  } finally { observer.restore(); }
  assert.equal(StepRegistration.prototype.create, originalCreate);
  assert.deepEqual(["select", "project", "execute"].map((name) => StepExecutionContract.prototype[name]), originalMethods);
});

for (const operation of ["project", "execute"]) {
  test(`Prepare observation rejects cross-Step selection even when ${operation} throws`, (t) => {
    const seed = new StagedExecutionSeed("prepare", ["branch", "prepare-spec"], null, "prepare-adoption");
    const failure = new Error("the original consumer stopped");
    function select(input) { return input; }
    function consume() { throw failure; }
    const contract = new StepExecutionContract({ select, project: consume, execute: consume });
    const registrations = seed.registrations.map((registration) => new StepRegistration({
      ...registration, executionContract: contract,
    }));
    const observer = new PrepareExecutionObserver(t, { registrations });
    const branch = contract.select({ stepId: "branch" });
    contract.select({ stepId: "prepare-spec" });
    assert.throws(() => contract[operation](branch, { stepId: "prepare-spec" }), (error) => error === failure);
    assert.throws(() => observer.assertCoherent(), {
      name: "AssertionError",
      message: new RegExp(`^A10 prepare-spec: ${operation} must consume this registration's original selection object`),
    });
    observer.restore();
  });
}

for (const stepId of [undefined, "unknown-step"]) {
  test(`Prepare observation rejects ${stepId === undefined ? "missing" : "unknown"} Step identity on a known contract`, (t) => {
    const seed = new StagedExecutionSeed("prepare", ["branch", "prepare-spec"], null, "prepare-adoption");
    const observer = new PrepareExecutionObserver(t, { registrations: seed.registrations });
    const contract = seed.registrations[0].executionContract;
    const selection = contract.select({ stepId: "branch" });
    contract.project(selection, stepId === undefined ? undefined : { stepId });
    assert.throws(() => observer.assertCoherent(), {
      name: "AssertionError",
      message: new RegExp(`^A10 ${stepId}: caller requires its production registration and selected Step identity`),
    });
    observer.restore();
  });
}
