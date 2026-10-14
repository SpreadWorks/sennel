import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, mock, test } from "node:test";
import { SeedCleanupScope } from "../../support/builders/seed-work-root.js";
import { PreparedStep, StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { flowStepExecutionRegistration } from "../../../src/flow/engine/composition/registered-step-execution.js";
import { ReportGeneratedResult } from "../../../src/flow/engine/step-result.js";
import { StagedExecutionSeed } from "../../fixtures/structure/staged-execution.js";
import { PrepareExecutionObserver } from "../../support/infrastructure/prepare-execution-observer.js";
import { FinalizationPhaseProductionRegistrations, finalizationPhaseManifest }
  from "../../support/structure/finalization-phase-scope.js";
import { ServiceBoundaryCoverage, assertPreparedServiceBoundary, assertFixturePublicPropertyDetection }
  from "../../support/structure/service-boundary.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const leaves = finalizationPhaseManifest.leaves;

const seedScope = new SeedCleanupScope(after, mock);
let reportSeed;
async function beforeReport(Scenario) {
  reportSeed ??= Scenario.seed(seedScope, { frontier: "report" });
  return reportSeed;
}

for (const leaf of leaves) {
  test(`A07/A10 ${leaf.stepId} has its own exact production registration`, () => {
    const registration = flowStepExecutionRegistration(leaf.stepId);
    assert.ok(registration instanceof StepRegistration,
      `A07/A10 ${leaf.stepId}: missing production registration; create(), dependencies and constructor arguments remain unverified`);
    assert.equal(registration.stepId, leaf.stepId);
    assert.deepEqual(registration.StepClass.dependencies, [registration.ServiceClass]);
    assert.equal(typeof registration.create, "function");
  });

  test(`A07/A12 ${leaf.stepId} direct and dispatch callers prepare real typed Services across reload`, async (t) => {
    // Admission is local to each production test. Isolated checker probes below
    // remain runnable when the finalization migration has not registered a leaf.
    const { selected, registry } = await new FinalizationPhaseProductionRegistrations(root).registry();
    const registration = selected.find((candidate) => candidate.stepId === leaf.stepId);
    assert.equal(flowStepExecutionRegistration(leaf.stepId), registration,
      `A07 ${leaf.stepId}: composition and caller lookup must use the exact same StepRegistration`);
    const { FinalizationPhaseScenario } = await import("../../support/finalization-phase-scenario.js");
    const upstream = await beforeReport(FinalizationPhaseScenario);
    const seed = await FinalizationPhaseScenario.seed(t, { ...upstream.options,
      seedRoot: upstream.root, seedSpecId: upstream.specId, frontier: leaf.nodeId });
    for (const route of ["direct", "dispatch"]) {
      await t.test(route, async (routeTest) => {
        const scenario = FinalizationPhaseScenario.fromSeed(routeTest, seed);
        const saved = scenario.snapshot();
        const producedReport = scenario.report();
        scenario.reload();
        assert.deepEqual(scenario.snapshot(), saved,
          `A12 ${leaf.stepId}: a fresh manager must read the persisted producer frontier unchanged`);
        assert.equal(scenario.current(), leaf.nodeId,
          `A12 ${leaf.stepId}: production report and preceding finalizers must establish this frontier`);
        const reloadedReport = scenario.report();
        assert.deepEqual(reloadedReport, producedReport,
          `A12 ${leaf.stepId}: report bytes and catalog identity must survive manager reconstruction`);
        const reportSettlement = scenario.manager.readCurrentStepSettlement({
          specId: scenario.specId, stepId: "report", completed: true,
        });
        assert.ok(reportSettlement?.result instanceof ReportGeneratedResult,
          `A12 ${leaf.stepId}: a preconstructed report cannot replace the real persisted producer Result`);
        assert.equal(reportSettlement.receipt.targetStepId, "finalize-commit");
        assert.equal(reportSettlement.result.evidence.publication.producerActivityId, reloadedReport.descriptor.activityId);
        assert.equal(reportSettlement.result.evidence.publication.fingerprint, reloadedReport.descriptor.hash);
        assert.equal(reportSettlement.result.evidence.publication.artifactId, reloadedReport.relativePath);
        const observer = new PrepareExecutionObserver(routeTest, { registrations: registry, stepIds: [leaf.stepId] });
        try {
          await scenario.next();
          assert.deepEqual(scenario.snapshot(), saved,
            `A10 ${leaf.stepId}: Action projection must not mutate canonical state`);
          const projectionPreparations = observer.prepared(registration).length;
          if (route === "direct") await scenario.runRegistered(leaf.stepId);
          else await scenario.executeCurrent();
          const preparations = observer.prepared(registration).slice(projectionPreparations);
          assert.ok(preparations.length > 0,
            `A07 ${leaf.stepId}: ${route} execution must call this exact production registration.create(); projection alone cannot satisfy coverage`);
          const coverage = new ServiceBoundaryCoverage([registration]);
          for (const prepared of preparations) assertPreparedServiceBoundary(registration, prepared, coverage);
          observer.assertConsumed([leaf.stepId]);
          observer.assertProjected(leaf.stepId);
          assert.equal(coverage.assertComplete(), new Set(registration.StepClass.dependencies).size);
        } finally { observer.restore(); }
      });
    }
  });
}

test("A07/A10 direct finalization callers refuse the pending report frontier without preparation or canonical mutation", async (t) => {
  const { selected, registry } = await new FinalizationPhaseProductionRegistrations(root).registry();
  assert.deepEqual(selected.map((registration) => registration.stepId).sort(), leaves.map((leaf) => leaf.stepId).sort());
  const { FinalizationPhaseScenario } = await import("../../support/finalization-phase-scenario.js");
  const seed = await beforeReport(FinalizationPhaseScenario);
  for (const registration of selected) {
    await t.test(registration.stepId, async (refusalTest) => {
      const scenario = FinalizationPhaseScenario.fromSeed(refusalTest, seed);
      scenario.reload();
      assert.equal(scenario.current(), "report");
      const before = scenario.snapshot();
      const gitBefore = scenario.gitSnapshot();
      const workerCount = scenario.phaseWorkers.length;
      const docsCount = scenario.docsCalls.length;
      const observer = new PrepareExecutionObserver(refusalTest, { registrations: registry, stepIds: [registration.stepId] });
      try {
        const refused = await scenario.runRegistered(registration.stepId);
        assert.equal(refused.ok, false,
          `A10 ${registration.stepId}: unselected direct command must return a refusal`);
        assert.ok(refused.errors.length > 0);
        assert.ok(refused.errors.every((error) => typeof error.code === "string" && error.code.length > 0));
        assert.equal(observer.prepared(registration).length, 0,
          `A07 ${registration.stepId}: refusal must precede real Service preparation`);
        observer.assertCoherent();
        scenario.reload();
        assert.deepEqual(scenario.snapshot(), before,
          `A10 ${registration.stepId}: refusal must preserve state, Attempts, Activities, outbox and artifact catalog`);
        assert.deepEqual(scenario.gitSnapshot(), gitBefore,
          `A10 ${registration.stepId}: refusal must preserve Git refs, index and working tree`);
        assert.equal(scenario.phaseWorkers.length, workerCount);
        assert.equal(scenario.docsCalls.length, docsCount);
      } finally { observer.restore(); }
    });
  }
});

test("A07 isolated shared Service fixture detects each single omitted finalization leaf and accepts restoration", async () => {
  const fixture = new StagedExecutionSeed("finalize", leaves.map((leaf) => leaf.stepId));
  assert.equal(fixture.registrations.length, 4);
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

test("A07/A12 isolated hidden/Symbol properties and actual argument mismatches fail for every finalization leaf", async () => {
  const fixture = new StagedExecutionSeed("finalize", leaves.map((leaf) => leaf.stepId));
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
