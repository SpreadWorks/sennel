import assert from "node:assert/strict";
import { test } from "node:test";

import { StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { specStepRegistrations } from "../../../src/flow/engine/composition/spec.js";
import { workerStepExecutionContract } from "../../../src/flow/lib/worker-execution-admission.js";
import { Step } from "../../../src/flow/engine/step.js";
import { SpecGateRepairService } from "../../../src/flow/services/spec-gate-repair-service.js";
import { SpecGateService } from "../../../src/flow/services/spec-gate-service.js";
import { SpecReviewService } from "../../../src/flow/services/spec-review-service.js";
import { SpecService } from "../../../src/flow/services/spec-service.js";
import { SpecReviewWorkerService } from "../../../src/flow/services/spec-worker-review-service.js";
import { SpecGateRepairStep } from "../../../src/flow/steps/spec/spec-gate-repair.js";
import { SpecGateStep } from "../../../src/flow/steps/spec/spec-gate.js";
import { SpecRepairStep } from "../../../src/flow/steps/spec/spec-repair.js";
import { SpecReviewStep } from "../../../src/flow/steps/spec/spec-review.js";
import { SpecTriageStep } from "../../../src/flow/steps/spec/spec-triage.js";
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
  const preparedSteps = new Map();
  for (const registration of registrations) {
    const { request, input } = await fixture.createInput(registration.stepId);
    assert.equal(request.stepId, registration.stepId);
    const prepared = await registration.create(input);
    coverage.inspectPrepared(registration, prepared);
    preparedSteps.set(registration.stepId, prepared);
  }
  const required = new Set(registrations.flatMap((candidate) => candidate.StepClass.dependencies));
  assert.equal(coverage.assertComplete(), required.size);
  return preparedSteps;
}

test("every registered Spec Step Service has a prepared instance inspected for A07", async (t) => {
  const registrations = await registrationSource.load();
  const root = createTmpDir("spec-service-boundary-");
  t.after(() => removeTmpDir(root));
  const fixture = new SpecStepPreparationFixture(root);
  t.after(() => fixture.dispose());
  await inspectPreparedDependencies(registrations, fixture);
});

test("canonical Spec preparation passes declared typed arguments into every Service", async (t) => {
  const root = createTmpDir("spec-boundary-fixture-");
  t.after(() => removeTmpDir(root));
  const fixture = new SpecStepPreparationFixture(root);
  t.after(() => fixture.dispose());
  for (const registration of specStepRegistrations) {
    const { input } = await fixture.createInput(registration.stepId);
    const prepared = await registration.create(input);
    const ServiceClass = registration.ServiceClass;
    new ServiceBoundaryCoverage(specStepRegistrations).inspectPrepared(registration, prepared);
    assert.equal(prepared.step.constructor, registration.StepClass);
    assert.ok(prepared.dependency(ServiceClass) instanceof ServiceClass);
  }
});

test("A07 inspects every prepared Service and accepts healthy registrations", async () => {
  class CurrentService { static argumentTypes = []; }
  class NewService { static argumentTypes = []; }
  class CurrentStep extends Step {
    static dependencies = [CurrentService];
    constructor(service) { super(); this.service = service; }
  }
  class NewStep extends Step {
    static dependencies = [NewService];
    constructor(service) { super(); this.service = service; }
  }
  const registrations = [
    new StepRegistration({ stepId: "current", StepClass: CurrentStep, ServiceClass: CurrentService,
      prepareServiceArguments: () => [], executionContract: workerStepExecutionContract }),
    new StepRegistration({ stepId: "new", StepClass: NewStep, ServiceClass: NewService,
      prepareServiceArguments: () => [], executionContract: workerStepExecutionContract }),
  ];
  class PreparationFixture {
    createInput(stepId = "current") { return { request: { stepId }, input: {} }; }
  }
  const prepared = await inspectPreparedDependencies(registrations, new PreparationFixture());
  assert.deepEqual([...prepared.keys()], ["current", "new"]);
  assert.ok(prepared.get("current").dependency(CurrentService) instanceof CurrentService);
  assert.ok(prepared.get("new").dependency(NewService) instanceof NewService);
});

test("A07 rejects a violating Service in a later registered Step", async () => {
  class HealthyService { static argumentTypes = []; }
  class ExposedService { static argumentTypes = []; constructor() { this.exposed = true; } }
  class HealthyStep extends Step {
    static dependencies = [HealthyService];
    constructor(service) { super(); this.service = service; }
  }
  class ExposedStep extends Step {
    static dependencies = [ExposedService];
    constructor(service) { super(); this.service = service; }
  }
  const registrations = [
    new StepRegistration({ stepId: "healthy", StepClass: HealthyStep, ServiceClass: HealthyService,
      prepareServiceArguments: () => [], executionContract: workerStepExecutionContract }),
    new StepRegistration({ stepId: "exposed", StepClass: ExposedStep, ServiceClass: ExposedService,
      prepareServiceArguments: () => [], executionContract: workerStepExecutionContract }),
  ];
  class PreparationFixture {
    createInput(stepId = "healthy") { return { request: { stepId }, input: {} }; }
  }
  await assert.rejects(
    inspectPreparedDependencies(registrations, new PreparationFixture()),
    (error) => error instanceof ServiceBoundaryViolation && error.property === "exposed",
  );
});
