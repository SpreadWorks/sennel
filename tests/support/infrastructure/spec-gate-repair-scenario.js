import fs from "node:fs";
import { createHash } from "node:crypto";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowFixture } from "./flow-setup.js";
import { createTmpDir, removeTmpDir } from "../builders/tmp-dir.js";
import { validWorkerHandoffSpec } from "./worker-artifact.js";
import { SpecGateEvaluationBinding } from "../../../src/flow/engine/connectors/spec/spec-step-binding.js";
import { SpecGateService } from "../../../src/flow/services/spec-gate-service.js";
import { SpecGateStep } from "../../../src/flow/steps/spec/spec-gate.js";
import { SpecGateIssuePublication } from "../../../src/flow/lib/gate-issue-publication.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { SpecEntryConnector } from "../../../src/flow/engine/connectors/spec/spec-entry-connector.js";
import { SpecGateRepairService } from "../../../src/flow/services/spec-gate-repair-service.js";
import { SpecGateRepairStep } from "../../../src/flow/steps/spec/spec-gate-repair.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { StepFactory } from "../../../src/flow/engine/step-factory.js";
import { workerArtifactJson } from "./worker-artifact.js";
import { parseGuardrailArticleEvaluation } from "../../../src/flow/lib/run-gate.js";

/** A real failed Gate route, leaving one active bounded repair Attempt. */
export async function createSpecGateRepairScenario({
  specId = "500-spec-gate-repair-scenario", specRecord = validWorkerHandoffSpec(),
  locator = "requirements[R1].desc", requirementRef = "R1", beforeGate = null,
  target = { entity: "requirement", id: "R1", field: "desc" },
  operationKinds = ["edit-text-field"],
  mutateGateObservations = (observations) => observations,
  additionalObservations = [],
  issue = null, issueSnapshot = null, request = "Repair the bounded Spec Gate finding.",
  taskTestStrategy = null,
  versionStoreFaultInjector = null, coordinatorFaultInjector = () => {},
} = {}) {
  const root = createTmpDir("spec-gate-repair-scenario-");
  try {
    const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId,
      ...(versionStoreFaultInjector ? { versionStoreFaultInjector } : {}) });
    const flow = new CanonicalFlowFixture({ flowManager, specId,
      runId: `run-${specId}`, request, issue, issueSnapshot, specRecord,
    }).create().registerActive();
    for (const taskId of new Set(specRecord.requirements.flatMap((requirement) => requirement.task_ids))) {
      flow.addTask({ id: taskId, title: `Implement ${taskId}`, goal: "Exercise the repair route.",
        origin: "plan", added_round: 0, status: "pending",
        ...(taskTestStrategy === null ? {} : { test_strategy: taskTestStrategy }) });
    }
    if (beforeGate) await beforeGate({ root, specId, flowManager, flow });
    if (flowManager.canonicalState(specId).current?.at(-1) !== "spec-gate") flow.activate("spec-gate");
    const binding = new SpecGateEvaluationBinding({ flowManager, specId });
    const record = flowManager.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "spec-gate" });
    const spec = JSON.parse(record.bytes.toString("utf8"));
    const specRevision = `sha256:${createHash("sha256").update(record.bytes).digest("hex")}`;
    const rawObservations = [{ failureMode: "guardrail-violation",
      requirementRef, where: { file: "spec.json", locator },
      observed: "The selected Spec field needs a bounded correction.",
      targets: [target], allowedTargets: [{ target, operationKinds }] },
    ...additionalObservations];
    const observations = mutateGateObservations(parseGuardrailArticleEvaluation(JSON.stringify({ observations: rawObservations }),
      [...new Set(rawObservations.map((observation) => observation.requirementRef))],
      { spec, specRevision }));
    const commandResult = new CanonicalGatePromotion({
      state: flowManager.canonicalState(specId), phase: "spec", nodeId: "spec-gate",
    }).promote({ result: "fail", artifacts: { phase: "spec", failureKind: "ai_semantic_fail",
      failureCode: "GATE_REJECTED", nextAction: { diagnosis: { observations } } } });
    const issuePublication = new SpecGateIssuePublication({ binding,
      entry: { step: "spec-gate", phase: "spec", observations,
        reason: "The selected Spec field needs a correction.", trigger: "gate post hook (auto)",
        timestamp: binding.assertCurrent().attempt.startedAt } });
    const gate = await new SpecGateStep(new SpecGateService({
      flowManager, binding, commandResult, issuePublication,
    })).execute();
    if (gate.kind !== "spec-gate-repair-required"
      || flowManager.canonicalState(specId).current?.at(-1) !== "spec-gate-repair") {
      throw new Error("Spec Gate scenario did not enter its repair Attempt");
    }
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
export async function prepareSpecGateRepairHandoff({
  ctx, invocation, replacement,
  coordinator = new WorkerArtifactHandoffCoordinator({
    now: () => new Date("2026-08-04T00:00:00.000Z"),
  }),
} = {}) {
  const request = coordinator.createRequest({
    ctx, state: ctx.flowManager.load(ctx.specId), invocation,
  });
  const selected = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json")
    ?.document.selections[0];
  const range = selected?.ranges.find((entry) => entry.writable);
  if (!range || typeof range.value !== "string" || selected.unit.findings.length !== 1) {
    throw new Error("Spec Gate repair scenario requires one canonical writable text finding unit");
  }
  fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson({
    version: 1, stage: "spec-gate-repair", baseRevision: selected.baseRevision,
    groups: [{ findingIdentities: [selected.unit.findings[0].identity], operations: [{
      kind: "edit-text-field", target: range.target, expectedDigest: range.digest,
      edits: [{ startByte: 0, endByte: Buffer.byteLength(range.value, "utf8"), replacement }],
      reason: "Correct the exact finding selected by Spec Gate.",
    }] }],
  }));
  SpecGateRepairService.reserveWorkerCall({ ctx, request, prompt: JSON.stringify(request.toPromptReference()) });
  sealWorkerArtifactHandoff({
    requestPath: request.requestPath, invocationId: request.dispatchInvocationId,
    now: () => new Date("2026-08-04T00:00:01.000Z"),
  });
  const service = await SpecGateRepairService.prepare({
    ctx, request, Connector: SpecEntryConnector, handoffCoordinator: coordinator,
  });
  return { request, service, selected, range };
}

/** Exercise the production bounded repair handoff from an active repair Attempt. */
export async function completeSpecGateRepairHandoff(options = {}) {
  const prepared = await prepareSpecGateRepairHandoff(options);
  const result = await new StepFactory().provide(SpecGateRepairService, prepared.service)
    .create(SpecGateRepairStep).execute();
  return { ...prepared, result };
}
