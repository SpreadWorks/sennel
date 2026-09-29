import assert from "node:assert/strict";
import { test } from "node:test";

import { StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { Step } from "../../../src/flow/engine/step.js";
import { SpecService } from "../../../src/flow/services/spec-service.js";
import { SpecStep } from "../../../src/flow/steps/spec/spec.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { SpecStepPreparationFixture } from "../../support/infrastructure/spec-step-preparation.js";
import { ProductionRegistrations } from "../../support/structure/production-registrations.js";
import { ServiceBoundaryCoverage, ServiceBoundaryViolation } from "../../support/structure/service-boundary.js";

const registrationSource = new ProductionRegistrations(
  new URL("../../../src/flow/engine/composition/spec.js", import.meta.url),
  "specStepRegistrations",
);

async function inspectPreparedDependencies(registrations, fixture) {
  const coverage = new ServiceBoundaryCoverage(registrations);
  const { request, input } = fixture.createInput();
  const registration = registrations.find((candidate) => candidate.stepId === request.stepId);
  assert.ok(registration instanceof StepRegistration, `no production registration for ${request.stepId}`);
  const prepared = await registration.create(input);
  for (const [Dependency, instance] of prepared.dependencies) coverage.inspect(Dependency, instance);
  const required = new Set(registrations.flatMap((candidate) => candidate.StepClass.dependencies));
  assert.equal(coverage.assertComplete(), required.size);
  return prepared;
}

test("every registered Spec Step Service has a prepared instance inspected for A07", async (t) => {
  const registrations = await registrationSource.load();
  const root = createTmpDir("spec-service-boundary-");
  t.after(() => removeTmpDir(root));
  const fixture = new SpecStepPreparationFixture(root);
  await inspectPreparedDependencies(registrations, fixture);
});

test("canonical Spec preparation reaches A07 through PreparedStep dependencies", async (t) => {
  const root = createTmpDir("spec-boundary-fixture-");
  t.after(() => removeTmpDir(root));
  const fixture = new SpecStepPreparationFixture(root);
  const registration = new StepRegistration({
    stepId: "spec", StepClass: SpecStep,
    async prepareDependencies(input) {
      return new Map([[SpecService, await SpecService.prepare(input)]]);
    },
  });
  await assert.rejects(inspectPreparedDependencies([registration], fixture), (error) => {
    assert.ok(error instanceof ServiceBoundaryViolation);
    assert.equal(error.rule, "A07");
    assert.ok(error.service instanceof SpecService);
    return true;
  });
});

test("an added declared Service cannot pass without an inspected prepared instance", async () => {
  class CurrentService {}
  class NewService {}
  class CurrentStep extends Step {
    static dependencies = [CurrentService];
    constructor(service) { super(); this.service = service; }
  }
  class NewStep extends Step {
    static dependencies = [NewService];
    constructor(service) { super(); this.service = service; }
  }
  const registrations = [
    new StepRegistration({ stepId: "current", StepClass: CurrentStep,
      prepareDependencies: () => new Map([[CurrentService, new CurrentService()]]) }),
    new StepRegistration({ stepId: "new", StepClass: NewStep,
      prepareDependencies: () => new Map([[NewService, new NewService()]]) }),
  ];
  class CurrentPreparationFixture {
    createInput() { return { request: { stepId: "current" }, input: {} }; }
  }
  await assert.rejects(
    inspectPreparedDependencies(registrations, new CurrentPreparationFixture()),
    /A07 has no inspected instance for NewService/,
  );
});
