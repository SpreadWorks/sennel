import assert from "node:assert/strict";
import { test } from "node:test";

import { PreparedStep, StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
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


test("A07 rejects an unprepared registration even when another Step uses the same Service", async (t) => {
  const root = createTmpDir("spec-shared-service-boundary-");
  t.after(() => removeTmpDir(root));
  const fixture = new SpecStepPreparationFixture(root);
  t.after(() => fixture.dispose());
  const coverage = new ServiceBoundaryCoverage(specStepRegistrations);
  const omitted = specStepRegistrations.find((registration) => registration.stepId === "spec-repair");
  assert.ok(specStepRegistrations.some((registration) => registration !== omitted
    && registration.ServiceClass === omitted.ServiceClass));
  for (const registration of specStepRegistrations.filter((candidate) => candidate !== omitted)) {
    const { input } = await fixture.createInput(registration.stepId);
    coverage.inspectPrepared(registration, await registration.create(input));
  }
  assert.throws(() => coverage.assertComplete(), (error) => error.rule === "A07"
    && error.registrations.includes(omitted) && error.message.includes("spec-repair"));
  const { input } = await fixture.createInput(omitted.stepId);
  coverage.inspectPrepared(omitted, await omitted.create(input));
  const types = new Set(specStepRegistrations.map((registration) => registration.ServiceClass));
  assert.equal(coverage.assertComplete(), types.size);
});

test("A07 records registration and constructor argument evidence for wrong prepared arguments", async (t) => {
  const root = createTmpDir("spec-argument-boundary-");
  t.after(() => removeTmpDir(root));
  const fixture = new SpecStepPreparationFixture(root);
  t.after(() => fixture.dispose());
  const registration = specStepRegistrations.find((candidate) => candidate.stepId === "spec");
  const { input } = await fixture.createInput(registration.stepId);
  const prepared = await registration.create(input);
  const coverage = new ServiceBoundaryCoverage([registration]);
  const invalid = new PreparedStep(prepared.step, prepared.dependencies,
    [prepared.serviceArguments[1], prepared.serviceArguments[0]]);
  assert.throws(() => coverage.inspectPrepared(registration, invalid), (error) =>
    error.rule === "A07" && error.registration === registration
      && error.service === registration.ServiceClass && error.argumentIndex === 0
      && error.expectedType === registration.ServiceClass.argumentTypes[0]
      && error.actualValue === prepared.serviceArguments[1]);
  assert.throws(() => coverage.assertComplete(), /no inspected instance/);
  coverage.inspectPrepared(registration, prepared);
  assert.equal(coverage.assertComplete(), 1);
});


test("A07 records the production registration for hidden and Symbol Service properties", async (t) => {
  const root = createTmpDir("spec-public-property-boundary-");
  t.after(() => removeTmpDir(root));
  const fixture = new SpecStepPreparationFixture(root);
  t.after(() => fixture.dispose());
  const registration = specStepRegistrations.find((candidate) => candidate.stepId === "spec");
  const { input } = await fixture.createInput(registration.stepId);
  const prepared = await registration.create(input);
  const service = prepared.dependency(registration.ServiceClass);
  for (const property of ["hidden", Symbol("hidden")]) {
    const coverage = new ServiceBoundaryCoverage([registration]);
    Object.defineProperty(service, property, { value: true, enumerable: false, configurable: true });
    assert.throws(() => coverage.inspectPrepared(registration, prepared), (error) =>
      error instanceof ServiceBoundaryViolation && error.rule === "A07"
        && error.registration === registration && error.service === service && error.property === property);
    assert.throws(() => coverage.assertComplete(), /no inspected instance/);
    delete service[property];
    coverage.inspectPrepared(registration, prepared);
    assert.equal(coverage.assertComplete(), 1);
  }
});

test("A07 type boundary inspection cannot substitute for production Step preparation", async (t) => {
  const root = createTmpDir("spec-type-only-boundary-");
  t.after(() => removeTmpDir(root));
  const fixture = new SpecStepPreparationFixture(root);
  t.after(() => fixture.dispose());
  const registration = specStepRegistrations.find((candidate) => candidate.stepId === "spec");
  const { input } = await fixture.createInput(registration.stepId);
  const prepared = await registration.create(input);
  const coverage = new ServiceBoundaryCoverage([registration]);
  coverage.inspect(registration.ServiceClass, prepared.dependency(registration.ServiceClass));
  assert.throws(() => coverage.assertComplete(), (error) => error.rule === "A07"
    && error.registrations.length === 1 && error.registrations[0] === registration);
  const unrelated = new StepRegistration({ ...registration });
  assert.throws(() => coverage.inspectPrepared(unrelated, prepared), /registered production StepRegistration/);
  coverage.inspectPrepared(registration, prepared);
  assert.equal(coverage.assertComplete(), 1);
});
