import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PreparedStep, StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { flowStepExecutionRegistration } from "../../../src/flow/engine/composition/registered-step-execution.js";
import { StagedExecutionSeed } from "../../fixtures/structure/staged-execution.js";
import { PrepareExecutionObserver } from "../../support/infrastructure/prepare-execution-observer.js";
import { AcceptancePhaseProductionRegistrations, acceptancePhaseManifest }
  from "../../support/structure/acceptance-phase-scope.js";
import { ServiceBoundaryCoverage, assertPreparedServiceBoundary, assertFixturePublicPropertyDetection }
  from "../../support/structure/service-boundary.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const leaves = acceptancePhaseManifest.leaves;

async function createScenario(t, riskRequired) {
  const { AcceptancePhaseScenario, acceptanceProviderResponse } = await import("../../support/acceptance-phase-scenario.js");
  return AcceptancePhaseScenario.create(t, riskRequired ? {
    acceptanceResponse: (_ordinal, scenario) => acceptanceProviderResponse(scenario, { status: "notVerifiable" }),
  } : {});
}

for (const leaf of leaves) {
  test(`A07/A10 ${leaf.stepId} has its own real production registration`, () => {
    const registration = flowStepExecutionRegistration(leaf.stepId);
    assert.ok(registration instanceof StepRegistration,
      `A07/A10 ${leaf.stepId}: missing production registration; create(), dependencies and constructor arguments remain unverified`);
    assert.equal(registration.stepId, leaf.stepId);
    assert.deepEqual(registration.StepClass.dependencies, [registration.ServiceClass]);
    assert.equal(typeof registration.create, "function");
  });

  test(`A07/A12 ${leaf.stepId} real caller prepares typed inputs after producer persistence and reload`, async (t) => {
    const { selected, registry } = await new AcceptancePhaseProductionRegistrations(root).registry();
    const registration = selected.find((candidate) => candidate.stepId === leaf.stepId);
    assert.equal(flowStepExecutionRegistration(leaf.stepId), registration);
    // Missing production contracts fail above; importing a hypothetical product
    // implementation cannot obscure the intended initial assertion failure.
    const scenario = await createScenario(t, leaf.stepId === "acceptance-decision");
    await scenario.advanceTo(leaf.stepId);
    scenario.reload();
    const state = scenario.manager.canonicalState(scenario.specId);
    assert.equal(state.current?.at(-1) ?? state.nextAction().nodeId, leaf.nodeId,
      `A07 ${leaf.stepId}: reload must retain the lawful producer-established frontier`);
    const observer = new PrepareExecutionObserver(t, { registrations: registry, stepIds: [leaf.stepId] });
    try {
      await scenario.next();
      if (leaf.stepId === "acceptance-decision") await scenario.acceptDecision("accept_risk_and_continue");
      else await scenario.executeCurrent();
      const preparedSteps = observer.prepared(registration);
      assert.ok(preparedSteps.length > 0,
        `A07 ${leaf.stepId}: the real caller must use this exact registration.create(), even with a shared Service`);
      const coverage = new ServiceBoundaryCoverage([registration]);
      for (const prepared of preparedSteps) assertPreparedServiceBoundary(registration, prepared, coverage);
      observer.assertConsumed([leaf.stepId]);
      observer.assertProjected(leaf.stepId);
      assert.equal(coverage.assertComplete(), new Set(registration.StepClass.dependencies).size);
    } finally { observer.restore(); }
  });
}

test("A07 all five Acceptance create paths execute through explicit risk acceptance and report", async (t) => {
  const { selected, registry } = await new AcceptancePhaseProductionRegistrations(root).registry();
  assert.deepEqual(selected.map((registration) => registration.stepId).sort(), leaves.map((leaf) => leaf.stepId).sort());
  const scenario = await createScenario(t, true);
  await scenario.advanceTo("retro");
  scenario.reload();
  const observer = new PrepareExecutionObserver(t, { registrations: registry, stepIds: leaves.map((leaf) => leaf.stepId) });
  try {
    await scenario.advanceTo("acceptance-decision");
    scenario.reload();
    await scenario.next();
    await scenario.acceptDecision("accept_risk_and_continue");
    await scenario.advanceTo("finalize-commit");
    scenario.reload();
    const coverage = new ServiceBoundaryCoverage(selected);
    for (const registration of selected) {
      const preparations = observer.prepared(registration);
      assert.ok(preparations.length > 0, `A07 ${registration.stepId}: shared Service coverage cannot replace this leaf's production create()`);
      for (const prepared of preparations) assertPreparedServiceBoundary(registration, prepared, coverage);
    }
    observer.assertConsumed(leaves.map((leaf) => leaf.stepId));
    assert.equal(coverage.assertComplete(), new Set(selected.flatMap((registration) => registration.StepClass.dependencies)).size);
  } finally { observer.restore(); }
});

test("A07 isolated shared Service fixture detects each omitted leaf and accepts exact restoration", async () => {
  const fixture = new StagedExecutionSeed("acceptance", leaves.map((leaf) => leaf.stepId));
  for (const omitted of fixture.registrations) {
    const coverage = new ServiceBoundaryCoverage(fixture.registrations);
    for (const registration of fixture.registrations.filter((candidate) => candidate !== omitted)) {
      assertPreparedServiceBoundary(registration, await registration.create({}), coverage);
    }
    assert.throws(() => coverage.assertComplete(), (error) => error.rule === "A07"
      && error.registrations.length === 1 && error.registrations[0] === omitted);
    assertPreparedServiceBoundary(omitted, await omitted.create({}), coverage);
    assert.equal(coverage.assertComplete(), 1);
  }
});

test("A07/A12 isolated hidden/Symbol properties and actual argument mismatches fail for every leaf", async () => {
  const fixture = new StagedExecutionSeed("acceptance", leaves.map((leaf) => leaf.stepId));
  for (const registration of fixture.registrations) {
    const prepared = await registration.create({});
    assertFixturePublicPropertyDetection(registration, prepared);
    const malformed = new PreparedStep(prepared.step, prepared.dependencies,
      [prepared.serviceArguments[1], prepared.serviceArguments[0]]);
    const coverage = new ServiceBoundaryCoverage([registration]);
    assert.throws(() => coverage.inspectPrepared(registration, malformed), (error) =>
      error.rule === "A07" && error.registration === registration && error.service === registration.ServiceClass
        && error.argumentIndex === 0 && error.expectedType === registration.ServiceClass.argumentTypes[0]
        && error.actualValue === prepared.serviceArguments[1]);
    assert.throws(() => coverage.assertComplete(), (error) => error.rule === "A07" && error.registrations.includes(registration));
    assertPreparedServiceBoundary(registration, prepared, coverage);
    assert.equal(coverage.assertComplete(), 1);
  }
});
