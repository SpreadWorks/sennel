import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding, FlowTargetExpectation } from "../../../src/lib/flow-target-guard.js";
import { FlowDispatchSession, FlowDispatchTarget } from "../../../src/flow/lib/dispatch-invocation.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { NextActionPlanError } from "../../../src/flow/lib/next-action-plan-error.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { flowStepExecutionRegistration } from "../../../src/flow/engine/composition/registered-step-execution.js";
import { PrepareArtifactScenario } from "../../support/prepare-artifact-scenario.js";
import { PrepareExecutionObserver } from "../../support/infrastructure/prepare-execution-observer.js";
import { dispatchContainer } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { futurePhaseManifests } from "../../support/structure/phase-manifest.js";
import { ProductionRegistrations } from "../../support/structure/production-registrations.js";
import { ServiceBoundaryCoverage } from "../../support/structure/service-boundary.js";

const manifest = futurePhaseManifests.find((candidate) => candidate.id === "01");
const scope = manifest.entries[0];
const registrationSource = new ProductionRegistrations(
  new URL(`../../../${scope.composition}`, import.meta.url), scope.exportName);

for (const mode of ["branch", "worktree", "no-branch"]) {
  test(`A07/A10 ${mode} preparation consumes real selections and constructs both Steps with private Services and declared arguments`, async (t) => {
    // Lookup is the production caller's authority. It must contain both leaves
    // before the absent future composition module is dynamically loaded.
    const selected = manifest.leaves.map((leaf) => flowStepExecutionRegistration(leaf.stepId));
    assert.deepEqual(manifest.leaves.filter((leaf, index) => !(selected[index] instanceof StepRegistration))
      .map((leaf) => leaf.stepId), [],
    "A07 production execution lookup must register both branch and prepare-spec");
    const registrations = await registrationSource.load();
    assert.deepEqual(registrations.map((registration) => registration.stepId).sort(),
      manifest.leaves.map((leaf) => leaf.stepId).sort());
    for (const registration of registrations) {
      assert.equal(flowStepExecutionRegistration(registration.stepId), registration,
        `A07 ${registration.stepId}: execution lookup and phase selection must use the same registration`);
    }

    const coverage = new ServiceBoundaryCoverage(registrations);
    const observer = new PrepareExecutionObserver(t);
    const scenario = PrepareArtifactScenario.create(t, { mode });
    try {
      await scenario.initialize();
      const result = await scenario.prepare();
      assert.equal(result.result, "ok", JSON.stringify(result));
      const committed = preparationBytes(scenario);
      await scenario.withEnvironment(() => FLOW_COMMANDS.prepare.post(scenario.context(), result));
      assert.deepEqual(preparationBytes(scenario), committed,
        "the actual prepare post caller must preserve completed Result, receipt and Activity publication");
      assert.equal(fs.existsSync(path.join(scenario.root, ".tmp", "unexpected-agent-calls")), false);
    } finally {
      observer.restore();
    }

    observer.assertExecuted(registrations.map((registration) => registration.stepId));
    for (const registration of registrations) {
      const preparedSteps = observer.prepared(registration);
      assert.equal(preparedSteps.length, 1,
        `A07 ${registration.stepId}: normal prepare must call its production registration.create exactly once`);
      const prepared = preparedSteps[0];
      coverage.inspectPrepared(registration, prepared);
      assert.equal(prepared.step.constructor, registration.StepClass);
      assert.equal(prepared.dependencies.size, registration.StepClass.dependencies.length);
      assert.equal(prepared.serviceArguments.length, 2,
        `A12 ${registration.stepId}: preparation injects a typed input and settlement writer`);
      for (const [index, Type] of registration.ServiceClass.argumentTypes.entries()) {
        assert.equal(prepared.serviceArguments[index] instanceof Type, true);
      }
      for (const Dependency of registration.StepClass.dependencies) {
        assert.equal(prepared.dependency(Dependency) instanceof Dependency, true);
      }
    }
    const required = new Set(registrations.flatMap((registration) => registration.StepClass.dependencies));
    assert.equal(coverage.assertComplete(), required.size);
    assert.deepEqual(registrations.filter((registration) => observer.prepared(registration).length > 0)
      .map((registration) => registration.stepId).sort(),
      ["branch", "prepare-spec"]);
  });
}

/** Stop only after the real Store publishes its fresh, all-pending root. */
async function pendingPreparation(t) {
  const scenario = PrepareArtifactScenario.create(t);
  await scenario.initialize();
  const interruption = new Error("stop after canonical fresh root publication");
  const createFresh = FlowManager.prototype.createFresh;
  const checkpoint = t.mock.method(FlowManager.prototype, "createFresh", function (request) {
    createFresh.call(this, request);
    scenario.specId = request.specId;
    throw interruption;
  });
  try {
    await assert.rejects(scenario.prepare(), (error) => error === interruption);
  } finally {
    checkpoint.mock.restore();
  }
  const state = scenario.reload().canonicalState(scenario.specId);
  assert.equal(state.findNode("branch").status, "pending");
  assert.equal(state.attempt, null);
  assert.equal(scenario.flowManager.activityLedger(scenario.specId)
    .some((activity) => activity.attemptId !== null), false,
  "fresh publication must not manufacture a canonical Attempt from preparation identity");
  return scenario;
}

function preparationBytes(scenario) {
  const manager = scenario.reload();
  const location = manager.specLocation(scenario.specId);
  const optional = (file) => fs.existsSync(file) ? fs.readFileSync(file) : null;
  return [
    ...["flow.state", "flow.activities", "artifact.catalog", "spec.record"]
      .map((key) => fs.readFileSync(location.artifact(key))),
    optional(path.join(scenario.root, ".sennel", `.active-flow.${scenario.runId}`)),
    optional(path.join(scenario.root, ".sennel", ".worktree-prepare-attempt.json")),
  ];
}

test("A10 pending Prepare display preserves state and uses its production selection when an Action is available", async (t) => {
  const scenario = await pendingPreparation(t);
  const before = preparationBytes(scenario);
  const observer = new PrepareExecutionObserver(t);
  const session = new FlowDispatchSession({ target: new FlowDispatchTarget({
    expectation: new FlowTargetExpectation({ expectRunId: scenario.runId, expectSpec: scenario.specId }),
  }) });
  const read = async () => {
    scenario.reload();
    try {
      return await scenario.withEnvironment(() => new GetNextActionCommand().execute(scenario.context()));
    } catch (error) {
      // The existing instruction loader rejects this pending leaf because it
      // has no worker prompt. That precise refusal is safe; adding a fake
      // prompt would manufacture an Action the production caller cannot expose.
      const prompt = fileURLToPath(new URL("../../../src/flow/prompts/plan/branch.md", import.meta.url));
      const unavailable = `INSTRUCTIONS_NOT_FOUND: no prompt file for key 'plan.branch' (expected at ${prompt})`;
      if (error.constructor === Error && error.message === unavailable) return unavailable;
      assert.ok(error instanceof NextActionPlanError, `unexpected pending Action error: ${error.stack}`);
      assert.equal(error.code, "NEXT_ACTION_TARGET_MISMATCH");
      return error.code;
    }
  };
  const first = await read();
  const ActualDate = Date;
  const clock = t.mock.method(globalThis, "Date", class extends ActualDate {
    constructor(...args) { super(...(args.length ? args : [2_000_000_000_000])); }
    static now() { return 2_000_000_000_000; }
  });
  let reloaded;
  try { reloaded = await read(); } finally { clock.mock.restore(); }
  observer.restore();
  assert.deepEqual(preparationBytes(scenario), before, "display must preserve the pending root and preparing authority");
  assert.equal(fs.existsSync(path.join(scenario.root, ".tmp", "unexpected-agent-calls")), false);
  assert.deepEqual(reloaded, first, "pending Action or explicit refusal must be stable after reload and clock advance");
  observer.assertCoherent();
  if (typeof first === "string") return;
  assert.ok(first.step === "branch" || first.step === null, "incomplete preparation cannot expose Draft");
  if (["execute_step", "execute_command", "repair_evidence"].includes(first.directive.kind)) {
    assert.equal(first.step, "branch");
    assert.equal(session.captureAction(reloaded, scenario.baseOid).digest,
      session.captureAction(first, scenario.baseOid).digest);
    observer.assertProjected("branch");
  } else {
    assert.ok(["blocked", "idle", "await_user_decision"].includes(first.directive.kind),
      "pending preparation may stop safely but cannot report completion");
  }
});

test("A10 unpublished pending Prepare is refused by the public target loader and actual dispatch without a worker or mutation", async (t) => {
  const scenario = await pendingPreparation(t);
  const before = preparationBytes(scenario);
  const displayed = scenario.cli(["get", "next-action", "--expect-run-id", scenario.runId,
    "--expect-spec", scenario.specId]);
  assert.equal(displayed.status, 1, displayed.stdout || displayed.stderr);
  assert.equal(displayed.envelope?.ok, false);
  assert.equal(displayed.envelope.errors[0].code, "FLOW_TARGET_NOT_FOUND");

  let workers = 0;
  const agent = { async call() { workers += 1; throw new Error("pending Prepare must not start a worker"); } };
  const manager = scenario.reload();
  const context = scenario.context();
  context.expectBinding = FlowTargetBinding.capture({ flowState: context.flowState,
    mainRoot: scenario.root, authorityRoot: scenario.executionRoot }).serialize();
  context._envelopeType = "run";
  context._envelopeKey = "dispatch";
  const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1 });
  dispatcher.container = dispatchContainer({ root: scenario.root, flowManager: manager, agent });
  dispatcher.container.register("config", scenario.config);
  const observer = new PrepareExecutionObserver(t);
  let result;
  try { result = await scenario.withEnvironment(() => dispatcher.execute(context)); }
  finally { observer.restore(); }
  assert.equal(result.dispatch.boundary, "target_mismatch", JSON.stringify(result));
  assert.equal(result.dispatch.dispatchCount, 0);
  assert.equal(result.nextAction, null);
  assert.equal(workers, 0);
  assert.equal(fs.existsSync(path.join(scenario.root, ".tmp", "unexpected-agent-calls")), false);
  assert.deepEqual(preparationBytes(scenario), before,
    "unavailable target must preserve canonical bytes, preparing state and journal");
  observer.assertCoherent();
});
