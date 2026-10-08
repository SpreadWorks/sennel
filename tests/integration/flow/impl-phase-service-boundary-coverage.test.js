import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { PreparedStep, StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { flowStepExecutionRegistration } from "../../../src/flow/engine/composition/registered-step-execution.js";
import { Step } from "../../../src/flow/engine/step.js";
import { TaskStepIdentity } from "../../../src/flow/lib/task-step-identity.js";
import { workerStepExecutionContract } from "../../../src/flow/lib/worker-execution-admission.js";
import { PrepareExecutionObserver } from "../../support/infrastructure/prepare-execution-observer.js";
import { validWorkerHandoffTaskSpec } from "../../support/infrastructure/worker-artifact.js";
import { implPhaseManifest, implPhaseScopes, ImplPhaseProductionRegistrations }
  from "../../support/structure/impl-phase-scope.js";
import { ServiceBoundaryCoverage, assertPreparedServiceBoundary as assertPrepared, assertFixturePublicPropertyDetection }
  from "../../support/structure/service-boundary.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const leaves = implPhaseManifest.leaves;

function createScenario(t, Scenario) {
  const seed = validWorkerHandoffTaskSpec();
  return Scenario.create(t, {
    forceRepairs: true,
    tasks: seed.tasks.map((task) => ({ ...task, id: "T17" })),
    requirements: seed.requirements.map(({ testable, ...requirement }) => ({
      ...requirement, task_ids: ["T17"], preimplementation_test_expectation: "fail",
    })),
  });
}

for (const leaf of leaves) {
  test(`A07/A10 ${leaf.stepId} has its own actual production registration`, () => {
    const registration = flowStepExecutionRegistration(leaf.stepId);
    assert.ok(registration instanceof StepRegistration,
      `A07/A10 ${leaf.stepId}: missing production registration; its create(), dependencies and constructor arguments cannot be inspected`);
    assert.equal(registration.stepId, leaf.stepId);
    assert.deepEqual(registration.StepClass.dependencies, [registration.ServiceClass]);
    assert.equal(typeof registration.create, "function");
  });

  test(`A07/A12 ${leaf.stepId} prepares its real Service from a persisted lawful producer chain`, async (t) => {
    const entry = implPhaseScopes.find((candidate) => candidate.definition.leaves.includes(leaf));
    // Product admission is deliberate: missing implementation contracts must be
    // assertion failures, before scenario setup or a dynamic product import.
    const { selected: registrations, registry } = await new ImplPhaseProductionRegistrations(root, entry).registry();
    const registration = registrations.find((candidate) => candidate.stepId === leaf.stepId);
    assert.equal(flowStepExecutionRegistration(leaf.stepId), registration);
    const { ImplPhaseScenario } = await import("../../support/impl-phase-scenario.js");
    const scenario = createScenario(t, ImplPhaseScenario);
    await scenario.advanceTo(leaf.nodeId);
    scenario.reload();
    const state = scenario.manager.canonicalState(scenario.specId);
    assert.equal(state.current?.at(-1) ?? state.nextAction().nodeId, leaf.nodeId,
      `A07 ${leaf.stepId}: fresh manager must read the exact producer-established frontier`);
    if (leaf.taskIdentity !== null) {
      const identity = TaskStepIdentity.fromStateNode(state, leaf.nodeId);
      assert.ok(identity instanceof TaskStepIdentity);
      assert.equal(identity.taskId, "T17");
      assert.equal(identity.definitionId, leaf.stepId);
      assert.equal(identity.nodeId, leaf.nodeId);
      assert.equal(flowStepExecutionRegistration(identity.definitionId), registration);
    }
    const observer = new PrepareExecutionObserver(t, {
      // Shared execution contracts can also project the next leaf after this
      // one settles. Use the actual admitted production snapshot for coherence;
      // boundary coverage below still requires this leaf's own create().
      registrations: registry, stepIds: [leaf.stepId],
    });
    try {
      await scenario.next();
      await scenario.executeCurrent();
      const preparedSteps = observer.prepared(registration);
      assert.ok(preparedSteps.length > 0,
        `A07 ${leaf.stepId}: its lawful production caller must invoke this exact registration.create()`);
      const coverage = new ServiceBoundaryCoverage([registration]);
      for (const prepared of preparedSteps) {
        // The shared checker inspects every own descriptor, including Symbol
        // and non-enumerable keys. A compliant production Service may be frozen.
        assertPrepared(registration, prepared, coverage);
      }
      observer.assertConsumed([leaf.stepId]);
      observer.assertProjected(leaf.stepId);
      assert.equal(coverage.assertComplete(), new Set(registration.StepClass.dependencies).size);
    } finally {
      observer.restore();
    }
  });
}

test("A07 all twelve production create paths are covered without a representative shared Service shortcut", async (t) => {
  const snapshots = await Promise.all(implPhaseScopes.map((entry) =>
    new ImplPhaseProductionRegistrations(root, entry).registry()));
  const registrations = snapshots.flatMap((snapshot) => snapshot.selected);
  const registry = [...new Set(snapshots.flatMap((snapshot) => snapshot.registry))];
  assert.deepEqual(registrations.map((entry) => entry.stepId).sort(), leaves.map((leaf) => leaf.stepId).sort());
  const { ImplPhaseScenario } = await import("../../support/impl-phase-scenario.js");
  const scenario = createScenario(t, ImplPhaseScenario);
  const observer = new PrepareExecutionObserver(t, { registrations: registry, stepIds: leaves.map((leaf) => leaf.stepId) });
  try {
    await scenario.advanceTo("retro");
    scenario.reload();
    const coverage = new ServiceBoundaryCoverage(registrations);
    for (const registration of registrations) {
      const preparedSteps = observer.prepared(registration);
      assert.ok(preparedSteps.length > 0,
        `A07 ${registration.stepId}: all-twelve coverage requires this production create(), including host filters and repairs`);
      for (const prepared of preparedSteps) assertPrepared(registration, prepared, coverage);
    }
    observer.assertConsumed(leaves.map((leaf) => leaf.stepId));
    assert.equal(coverage.assertComplete(), new Set(registrations.flatMap((entry) => entry.StepClass.dependencies)).size);
  } finally {
    observer.restore();
  }
});

class BoundaryInput {
  constructor(stepId) {
    assert.ok(leaves.some((leaf) => leaf.stepId === stepId));
    this.stepId = stepId;
    Object.freeze(this);
  }
}

class BoundaryWriter {}

class BoundaryService {
  static argumentTypes = [BoundaryInput, BoundaryWriter];
  #input;
  #writer;
  constructor(input, writer) {
    assert.ok(input instanceof BoundaryInput && writer instanceof BoundaryWriter);
    this.#input = input;
    this.#writer = writer;
  }
}

/** Isolated checker fixture, never installed into a production execution registry. */
function boundaryFixture() {
  return leaves.map((leaf) => {
    class BoundaryStep extends Step {
      static dependencies = [BoundaryService];
      #service;
      constructor(service) { super(); this.#service = service; }
    }
    return new StepRegistration({
      stepId: leaf.stepId, StepClass: BoundaryStep, ServiceClass: BoundaryService,
      prepareServiceArguments: ({ observed, writer }) => [observed, writer],
      executionContract: workerStepExecutionContract,
    });
  });
}

function boundaryInput(registration) {
  return { observed: new BoundaryInput(registration.stepId), writer: new BoundaryWriter() };
}

test("A07 isolated positive checker fixture inspects twelve distinct create paths and rejects an omitted shared-Service leaf", async () => {
  const registrations = boundaryFixture();
  const coverage = new ServiceBoundaryCoverage(registrations);
  const omitted = registrations.find((registration) => registration.stepId === "task-gate");
  for (const registration of registrations.filter((candidate) => candidate !== omitted)) {
    const prepared = await registration.create(boundaryInput(registration));
    assertPrepared(registration, prepared, coverage);
  }
  assert.throws(() => coverage.assertComplete(), (error) => error.rule === "A07"
    && error.registrations.length === 1 && error.registrations[0] === omitted);
  const prepared = await omitted.create(boundaryInput(omitted));
  assertPrepared(omitted, prepared, coverage);
  assert.equal(coverage.assertComplete(), 1);
  assert.equal(registrations.length, 12);
});

test("A07 isolated checker fixture records hidden/Symbol violations and actual constructor argument mismatches for every leaf", async () => {
  const registrations = boundaryFixture();
  for (const registration of registrations) {
    const prepared = await registration.create(boundaryInput(registration));
    assertFixturePublicPropertyDetection(registration, prepared);
    const invalid = new PreparedStep(prepared.step, prepared.dependencies,
      [prepared.serviceArguments[1], prepared.serviceArguments[0]]);
    const coverage = new ServiceBoundaryCoverage([registration]);
    assert.throws(() => coverage.inspectPrepared(registration, invalid), (error) =>
      error.rule === "A07" && error.registration === registration
        && error.service === registration.ServiceClass && error.argumentIndex === 0
        && error.expectedType === BoundaryInput && error.actualValue === prepared.serviceArguments[1]);
    assert.throws(() => coverage.assertComplete(), (error) => error.rule === "A07"
      && error.registrations.includes(registration));
    coverage.inspectPrepared(registration, prepared);
    assert.equal(coverage.assertComplete(), 1);
  }
});
