import { specStepRegistration } from "../../../src/flow/engine/composition/spec.js";
import { PreparedStep } from "../../../src/flow/engine/composition/step-registration.js";
import { reserveFixtureSpecGateRepairWorkerCall } from "./spec-gate-repair-admission.js";
import { SpecGateRepairBundle } from "../../../src/flow/lib/spec-gate-repair-bundle.js";
import fs from "node:fs";
import path from "node:path";
import { managedDir } from "../../../src/lib/config.js";
import { installGateProviderFake } from "./flow-dispatch-scenario.js";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowFixture } from "./flow-setup.js";
import { createTmpDir, removeTmpDir } from "../builders/tmp-dir.js";
import { validWorkerHandoffSpec } from "./worker-artifact.js";
import { SpecGateEvaluationBinding } from "../../../src/flow/engine/connectors/spec/spec-step-binding.js";
import { SpecGateIssuePublication } from "../../../src/flow/lib/gate-issue-publication.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { SpecEntryConnector } from "../../../src/flow/engine/connectors/spec/spec-entry-connector.js";
import { SpecGateRepairService } from "../../../src/flow/services/spec-gate-repair-service.js";
import { SpecGateRepairStep } from "../../../src/flow/steps/spec/spec-gate-repair.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { StepFactory } from "../../../src/flow/engine/step-factory.js";
import { workerArtifactJson } from "./worker-artifact.js";
import { RunGateCommand } from "../../../src/flow/lib/run-gate.js";

/** Reuse the same real Gate producer for an initial or recurring repair Attempt. */
export async function enterSpecGateRepairScenario({ flowManager, flow, specId,
  locator = "requirements[R1].desc", requirementRef = "R1",
  target = { entity: "requirement", id: "R1", field: "desc" },
  operationKinds = ["edit-text-field"], mutateGateObservations = (observations) => observations,
  additionalObservations = [],
} = {}) {
  if (flowManager.canonicalState(specId).current?.at(-1) !== "spec-gate") flow.activate("spec-gate");
  const binding = new SpecGateEvaluationBinding({ flowManager, specId });
  const rawObservations = [{ failureMode: "guardrail-violation",
    requirementRef, where: { file: "spec.json", locator },
    observed: "The selected Spec field needs a bounded correction.",
    targets: [target], allowedTargets: [{ target, operationKinds }] },
  ...additionalObservations];
  // Exercise the actual provider admission and Gate evaluator. The fixture
  // supplies only the external response; the CLI owns the execution proof.
  const guardrailFile = path.join(managedDir(flowManager.executionRoot()), "guardrail.json");
  const priorRules = fs.existsSync(guardrailFile) ? JSON.parse(fs.readFileSync(guardrailFile, "utf8")) : { guardrails: [] };
  const ids = [...new Set(rawObservations.map((observation) => observation.requirementRef))];
  const additions = ids.filter((id) => !priorRules.guardrails.some((rule) => rule.id === id)).map((id) => ({
    id, body: "Validate the selected Spec field against its requirement.",
    meta: { phase: ["spec"], category: "requirements" },
  }));
  if (additions.length) fs.writeFileSync(guardrailFile, JSON.stringify({ ...priorRules,
    guardrails: [...priorRules.guardrails, ...additions] }));
  const externalProvider = installGateProviderFake((_prompt, options) => JSON.stringify({
    observations: rawObservations,
    ...(options.jsonSchema.required.includes("evaluationUnavailable") ? { evaluationUnavailable: null } : {}),
  }));
  let commandResult;
  try {
    commandResult = await new RunGateCommand().executeCanonical({ root: flowManager.executionRoot(),
      executionRoot: flowManager.executionRoot(), flowManager, specId,
      flowState: flowManager.loadReadOnly(specId), config: {} }, { phase: "spec" });
  } finally { externalProvider.mock.restore(); }
  if (commandResult.result !== "fail" || commandResult.artifacts.failureKind !== "ai_semantic_fail") {
    throw new Error(`Spec Gate fixture provider did not produce its selected finding: ${JSON.stringify(commandResult)}`);
  }
  // Deliberately malformed system-boundary inputs remain available to the
  // existing refusal scenarios, after their genuine producer claim exists.
  const emittedObservations = commandResult.artifacts.nextAction.diagnosis.observations;
  const emittedBytes = JSON.stringify(emittedObservations);
  const observations = mutateGateObservations(emittedObservations);
  if (JSON.stringify(observations) !== emittedBytes) {
    commandResult = { ...commandResult, artifacts: { ...commandResult.artifacts,
      nextAction: { ...commandResult.artifacts.nextAction,
        diagnosis: { ...commandResult.artifacts.nextAction.diagnosis, observations } } } };
    new CanonicalGatePromotion({ state: flowManager.canonicalState(specId), phase: "spec", nodeId: "spec-gate" }).promote(commandResult);
  }
  const issuePublication = new SpecGateIssuePublication({ binding,
    entry: { step: "spec-gate", phase: "spec", observations,
      reason: "The selected Spec field needs a correction.", trigger: "gate post hook (auto)",
      timestamp: binding.assertCurrent().attempt.startedAt } });
  const preparedGate = await specStepRegistration("spec-gate").create({
    flowManager, binding, commandResult, issuePublication,
  });
  const gate = await preparedGate.step.execute();
  if (gate.kind !== "spec-gate-repair-required"
    || flowManager.canonicalState(specId).current?.at(-1) !== "spec-gate-repair") {
    throw new Error("Spec Gate scenario did not enter its repair Attempt");
  }
  return gate;
}

/** A real failed Gate route, leaving one active bounded repair Attempt. */
export async function createSpecGateRepairScenario({
  specId = "500-spec-gate-repair-scenario", specRecord = validWorkerHandoffSpec(),
  locator = "requirements[R1].desc", requirementRef = "R1", beforeGate = null,
  target = { entity: "requirement", id: "R1", field: "desc" },
  operationKinds = ["edit-text-field"],
  mutateGateObservations = (observations) => observations,
  additionalObservations = [],
  issue = null, issueSnapshot = null, request = "Repair the bounded Spec Gate finding.",
  taskTestStrategy = "Run the focused Gate repair scenario.",
  admitMappedTasks = true,
  versionStoreFaultInjector = null, coordinatorFaultInjector = () => {},
} = {}) {
  const root = createTmpDir("spec-gate-repair-scenario-");
  try {
    specRecord = { ...specRecord, requirements: specRecord.requirements.map((requirement) =>
      specRecord.requirements.length > 3 && requirement.priority == null
        ? { ...requirement, priority: "must" } : requirement) };
    const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId,
      ...(versionStoreFaultInjector ? { versionStoreFaultInjector } : {}) });
    const flow = new CanonicalFlowFixture({ flowManager, specId,
      runId: `run-${specId}`, request, issue, issueSnapshot, specRecord,
    }).create().registerActive();
    for (const taskId of admitMappedTasks
      ? new Set(specRecord.requirements.flatMap((requirement) => requirement.task_ids)) : []) {
      flow.addTask({ id: taskId, title: `Implement ${taskId}`, goal: "Exercise the repair route.",
        origin: "plan", added_round: 0, status: "pending",
        ...(taskTestStrategy === null ? {} : { test_strategy: taskTestStrategy }) });
    }
    if (beforeGate) await beforeGate({ root, specId, flowManager, flow });
    await enterSpecGateRepairScenario({ flowManager, flow, specId, locator, requirementRef,
      target, operationKinds, mutateGateObservations, additionalObservations });
    const ctx = { root, mainRoot: root, executionRoot: root, specId, flowManager };
    const invocation = { id: "dispatch-spec-gate-repair", target: { digest: "b".repeat(64) },
      action: { digest: "a".repeat(64), nextAction: { step: "spec-gate-repair" } } };
    const coordinator = new WorkerArtifactHandoffCoordinator({
      now: () => new Date("2026-08-04T00:00:00.000Z"), faultInjector: coordinatorFaultInjector,
    });
    return { root, specId, flowManager, flow, ctx, invocation, coordinator };
  } catch (error) {
    removeTmpDir(root);
    throw error;
  }
}

/** Produce and durably publish one bounded worker response before Step selection. */
export function prepareSpecGateRepairHandoffInput({
  ctx, invocation, replacement, edits = null,
  coordinator = new WorkerArtifactHandoffCoordinator({
    now: () => new Date("2026-08-04T00:00:00.000Z"),
  }),
} = {}) {
  const request = coordinator.createRequest({
    ctx, state: ctx.flowManager.load(ctx.specId), invocation,
  });
  const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
  const selected = SpecGateRepairBundle.fromJSON(context.bundle).selections()[0];
  const range = selected?.ranges.find((entry) => entry.writable);
  if (!range || typeof range.value !== "string" || selected.unit.findings.length !== 1) {
    throw new Error("Spec Gate repair scenario requires one canonical writable text finding unit");
  }
  fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson({
    version: 1, stage: "spec-gate-repair", baseRevision: selected.baseRevision,
    groups: [{ findingIdentities: [selected.unit.findings[0].identity], operations: [{
      kind: "edit-text-field", target: range.target, expectedDigest: range.digest,
      edits: edits ?? [{ startByte: 0, endByte: Buffer.byteLength(range.value, "utf8"), replacement }],
      reason: "Correct the exact finding selected by Spec Gate.",
    }] }],
  }));
  reserveFixtureSpecGateRepairWorkerCall({ ctx, request, prompt: JSON.stringify(request.toPromptReference()) });
  sealWorkerArtifactHandoff({
    requestPath: request.requestPath, invocationId: request.dispatchInvocationId,
    now: () => new Date("2026-08-04T00:00:01.000Z"),
  });
  return {
    request, selected, range,
    input: { ctx, request, Connector: SpecEntryConnector, handoffCoordinator: coordinator },
  };
}

export async function prepareSpecGateRepairHandoff(options = {}) {
  const prepared = prepareSpecGateRepairHandoffInput(options);
  const service = await prepareSpecGateRepairService(prepared.input);
  return { ...prepared, service };
}

/** Exercise the production bounded repair handoff from an active repair Attempt. */
export async function completeSpecGateRepairHandoff(options = {}) {
  const prepared = await prepareSpecGateRepairHandoff(options);
  const result = await new StepFactory().provide(SpecGateRepairService, prepared.service)
    .create(SpecGateRepairStep).execute();
  return { ...prepared, result };
}

/** Exercise production composition, including its exact completed-receipt replay. */
export async function prepareSpecGateRepairService(input) {
  const prepared = await specStepRegistration("spec-gate-repair").create(input);
  return prepared instanceof PreparedStep ? prepared.dependency(SpecGateRepairService) : prepared;
}
