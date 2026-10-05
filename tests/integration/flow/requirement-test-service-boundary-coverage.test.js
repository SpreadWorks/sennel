import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { PreparedStep, StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { flowStepExecutionRegistration, gateStepExecutionRegistration, reviewStepExecutionRegistration }
  from "../../../src/flow/engine/composition/registered-step-execution.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import RunRequirementTestGateCommand from "../../../src/flow/lib/run-requirement-test-gate.js";
import { RequirementTestPhaseScenario, rejectFirstRequirementReview } from "../../support/requirement-test-phase-scenario.js";
import { PrepareExecutionObserver } from "../../support/infrastructure/prepare-execution-observer.js";
import { RequirementTestProductionRegistrations, requirementTestManifest }
  from "../../support/structure/requirement-test-scope.js";
import { ServiceBoundaryCoverage } from "../../support/structure/service-boundary.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const production = new RequirementTestProductionRegistrations(root);
const stepIds = requirementTestManifest.leaves.map((leaf) => leaf.stepId);

for (const stepId of stepIds) {
  test(`A07/A10 ${stepId} is selected by actual production execution lookup before preparation`, () => {
    const registration = flowStepExecutionRegistration(stepId);
    assert.ok(registration instanceof StepRegistration,
      `A07/A10 ${stepId}: missing production Step registration; no real create/PreparedStep/dependencies/arguments can be inspected`);
    assert.equal(registration.stepId, stepId);
    assert.deepEqual(registration.StepClass.dependencies, [registration.ServiceClass]);
    assert.equal(typeof registration.create, "function");
  });
}

for (const [stepId, lookup] of [
  ["test-review", reviewStepExecutionRegistration], ["test-gate", gateStepExecutionRegistration],
]) {
  test(`A10 named ${stepId} route consumes the same RequirementTest production registration`, () => {
    const registration = flowStepExecutionRegistration(stepId);
    assert.ok(registration instanceof StepRegistration,
      `A10 ${stepId}: missing actual registration before named command route can be compared`);
    assert.equal(lookup("test"), registration,
      `A10 ${stepId}: command and registry post must consume the same production registration`);
  });
}

test("A07/A10/A12 real approval, generation, Review, repair and Gate all construct private Services with declared arguments", async (t) => {
  // This assertion gate deliberately precedes scenario creation and dynamic
  // composition loading. Current absence is contract red, never an import error.
  const registrations = await production.load();
  const coverage = new ServiceBoundaryCoverage(registrations);
  const observer = new PrepareExecutionObserver(t, { registrations, stepIds });
  const scenario = RequirementTestPhaseScenario.create(t, {
    reviewResponse: rejectFirstRequirementReview,
  });
  try {
    await scenario.advanceTo("approval");
    await scenario.next();
    await scenario.approve();
    await scenario.advanceTo("test-repair");
    await scenario.next();
    scenario.reload();
    await scenario.advanceTo("implement");
    observer.assertConsumed(stepIds);
    for (const registration of registrations) {
      const preparedSteps = observer.prepared(registration);
      assert.ok(preparedSteps.length > 0,
        `A07 ${registration.stepId}: real phase must invoke production registration.create and return PreparedStep`);
      for (const prepared of preparedSteps) {
        assert.ok(prepared instanceof PreparedStep, `A07 ${registration.stepId}: receipt replay cannot replace initial DI coverage`);
        coverage.inspectPrepared(registration, prepared);
        assert.equal(prepared.step.constructor, registration.StepClass);
        assert.equal(prepared.dependencies.size, registration.StepClass.dependencies.length);
        assert.equal(prepared.serviceArguments.length, 2,
          `A12 ${registration.stepId}: inject typed input and settlement writer`);
        for (const [index, Type] of registration.ServiceClass.argumentTypes.entries()) {
          assert.ok(prepared.serviceArguments[index] instanceof Type,
            `A12 ${registration.stepId}: constructor argument ${index} must be ${Type.name}`);
        }
        for (const Dependency of registration.StepClass.dependencies) {
          assert.ok(prepared.dependency(Dependency) instanceof Dependency,
            `A07 ${registration.stepId}: missing real ${Dependency.name} dependency`);
        }
      }
      observer.assertProjected(registration.stepId);
    }
    assert.equal(coverage.assertComplete(), new Set(registrations.flatMap((registration) => registration.StepClass.dependencies)).size);
  } finally {
    observer.restore();
  }
});

for (const [stepId, commandKey, Command] of [
  ["test-review", "review", RunReviewCommand],
  ["test-gate", "requirement-test-gate", RunRequirementTestGateCommand],
]) {
  test(`A07/A10 direct ${stepId} and actual registry post preserve the production selection and prepare its Service`, async (t) => {
    const registrations = await production.load();
    const registration = registrations.find((entry) => entry.stepId === stepId);
    const scenario = RequirementTestPhaseScenario.create(t);
    await scenario.advanceTo("approval");
    await scenario.approve();
    await scenario.advanceTo(stepId);
    scenario.reload();
    const observer = new PrepareExecutionObserver(t, { registrations, stepIds });
    try {
      await scenario.next();
      const ctx = { ...scenario.context(), phase: "test" };
      const result = await new Command().execute(ctx);
      await FLOW_COMMANDS.run[commandKey].post(ctx, result);
      observer.assertConsumed([stepId]);
      observer.assertProjected(stepId);
      const preparedSteps = observer.prepared(registration);
      assert.ok(preparedSteps.length > 0,
        `A07 ${stepId}: direct command/post must use its production registration.create`);
      const coverage = new ServiceBoundaryCoverage([registration]);
      for (const prepared of preparedSteps) coverage.inspectPrepared(registration, prepared);
      assert.equal(coverage.assertComplete(), new Set(registration.StepClass.dependencies).size);
    } finally {
      observer.restore();
    }
  });
}
