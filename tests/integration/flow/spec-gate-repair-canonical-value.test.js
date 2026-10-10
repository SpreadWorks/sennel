import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import fs from "node:fs";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalWorkerSpecPublication } from "../../../src/flow/lib/current-flow-state.js";
import { readSpecJsonValidator } from "../../../src/lib/spec-json.js";
import { latestRepairBudget } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { SpecGateRepairStep, selectSpecGateRepair } from "../../../src/flow/steps/spec/spec-gate-repair.js";
import { SpecGateRepairBundle } from "../../../src/flow/lib/spec-gate-repair-bundle.js";
import { sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { SpecEntryConnector } from "../../../src/flow/engine/connectors/spec/spec-entry-connector.js";
import { createSpecGateRepairScenario, completeSpecGateRepairHandoff, prepareSpecGateRepairService } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { reserveFixtureSpecGateRepairWorkerCall } from "../../support/infrastructure/spec-gate-repair-admission.js";
import { validWorkerHandoffSpec, validWorkerHandoffTaskSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { canonicalLargeTaskAcceptance } from "./fixtures/spec-repair-canonical-values.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

test("publishes a canonical-valid requirement above 32 KiB and reloads its exact Review input", async () => {
  const prefix = `Retain the existing requirement. ${"条".repeat(8_220)}`;
  const original = `${prefix}${"x".repeat(24_709 - Buffer.byteLength(prefix))}`;
  const correctedPrefix = `${original}\nRequire the corrected canonical behavior. `;
  const replacement = `${correctedPrefix}${"x".repeat(34_522 - Buffer.byteLength(correctedPrefix))}`;
  const specRecord = validWorkerHandoffSpec();
  specRecord.requirements[0] = { ...specRecord.requirements[0], id: "R4", desc: original };
  const expectedSpec = { ...specRecord, requirements: [{ ...specRecord.requirements[0], desc: replacement }] };
  assert.equal(Buffer.byteLength(original), 24_709);
  assert.equal(Buffer.byteLength(replacement), 34_522);
  assert.ok(replacement.length < 120_000);
  const value = await createSpecGateRepairScenario({ specRecord, locator: "requirements[R4].desc",
    requirementRef: "R4", target: { entity: "requirement", id: "R4", field: "desc" } });
  try {
    const canonical = JSON.parse(value.flowManager.readArtifact({ specId: value.specId,
      logicalKey: "spec.record", consumerNodeId: "spec-gate-repair" }).bytes.toString("utf8"));
    readSpecJsonValidator().validate({ ...canonical, requirements: expectedSpec.requirements });
    const before = value.flowManager.artifactCatalog(value.specId).toJSON();
    const attemptId = value.flowManager.canonicalState(value.specId).attempt.id;
    // Observe the real writer input without replacing publication or settlement.
    const settle = value.flowManager.settleSpecStepResult.bind(value.flowManager);
    let selectedInput;
    value.flowManager.settleSpecStepResult = (input) => {
      if (input.specGateRepairSelection) selectedInput = input;
      return settle(input);
    };
    let completed;
    try {
      completed = await completeSpecGateRepairHandoff({ ctx: value.ctx, invocation: value.invocation,
        coordinator: value.coordinator, replacement });
    } finally { value.flowManager.settleSpecStepResult = settle; }
    assert.equal(completed.result.kind, "spec-gate-repair-review-required");
    assert.equal(completed.range.value, original);
    const savedReceipt = completed.service.workerOutcome.receipt;
    const manager = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
    assert.equal(manager.canonicalState(value.specId).nextAction().nodeId, "spec-review");
    const specInput = manager.readArtifact({ specId: value.specId, logicalKey: "spec.record", consumerNodeId: "spec-review" });
    const saved = JSON.parse(specInput.bytes.toString("utf8"));
    assert.deepEqual(saved.requirements, expectedSpec.requirements);
    assert.deepEqual(saved.overview, specRecord.overview);
    readSpecJsonValidator().validate(saved);
    const audit = JSON.parse(manager.readArtifact({ specId: value.specId, logicalKey: "spec.gate.repair.audit",
      consumerNodeId: "spec-review", parameters: { attemptId } }).bytes.toString("utf8"));
    assert.equal(audit.acceptedGroups.length, 1);
    assert.deepEqual(audit.discardedGroups, []);
    assert.equal(audit.reviewFacts.requiresReview, true);
    const reviewInput = manager.readCurrentSpecReviewInput({ specId: value.specId, consumerNodeId: "spec-review" });
    assert.equal(reviewInput.review.identity.digest, createHash("sha256").update(specInput.bytes).digest("hex"));
    const budget = latestRepairBudget({ flowManager: manager, specId: value.specId, attemptId,
      baseRevision: completed.selected.baseRevision, consumerNodeId: "spec-gate-repair" }).budget.snapshot();
    assert.equal(budget.providerCallCount, 1);
    const snapshot = { state: manager.canonicalState(value.specId).toJSON(),
      activities: manager.activityLedger(value.specId), catalog: manager.artifactCatalog(value.specId).toJSON() };
    // Handoff cleanup consumes the worker payload and invalidates its Service.
    // Replay the exact Store publication, as the existing receipt scenario does.
    assert.ok(selectedInput?.specGateRepairSelection);
    const replay = manager.settleSpecStepResult(selectedInput);
    assert.equal(replay.receipt.resultKind, completed.result.kind);
    assert.equal(replay.receipt.id, savedReceipt.id);
    assert.deepEqual({ state: manager.canonicalState(value.specId).toJSON(),
      activities: manager.activityLedger(value.specId), catalog: manager.artifactCatalog(value.specId).toJSON() }, snapshot);
    assert.deepEqual(latestRepairBudget({ flowManager: manager, specId: value.specId, attemptId,
      baseRevision: completed.selected.baseRevision, consumerNodeId: "spec-gate-repair" }).budget.snapshot(), budget);
    assert.equal(snapshot.catalog.artifacts.filter((entry) => entry.logicalKey === "spec.snapshot").length,
      before.artifacts.filter((entry) => entry.logicalKey === "spec.snapshot").length + 1);
  } finally { removeTmpDir(value.root); }
});

test("publishes a 34,522-byte Gate Task acceptance and retains its canonical consumer inputs", async () => {
  const target = { entity: "task", id: "T1", field: "acceptance" };
  const specRecord = validWorkerHandoffTaskSpec();
  specRecord.tasks[0].acceptance = ["The existing acceptance criterion."];
  const value = await createSpecGateRepairScenario({
    admitMappedTasks: false,
    beforeGate({ flow, flowManager, specId }) {
      flow.activate("spec");
      flowManager.confirmCurrentAttempt({ specId, specRecord: new CanonicalWorkerSpecPublication(specRecord) });
    },
    locator: "tasks[T1].acceptance", requirementRef: "R1", target,
    operationKinds: ["replace-entity-field"],
  });
  try {
    const request = value.coordinator.createRequest({ ctx: value.ctx,
      state: value.flowManager.load(value.specId), invocation: value.invocation });
    const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
    const selected = SpecGateRepairBundle.fromJSON(context.bundle).selections()[0];
    const range = selected.ranges.find((entry) => entry.writable && entry.target.field === "acceptance");
    assert.ok(range);
    const acceptance = canonicalLargeTaskAcceptance();
    assert.equal(Buffer.byteLength(JSON.stringify(acceptance)), 34_522);
    fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson({
      version: 1, stage: "spec-gate-repair", baseRevision: selected.baseRevision,
      groups: [{ findingIdentities: selected.unit.findings.map((finding) => finding.identity),
        operations: [{ kind: "replace-entity-field", target: range.target, expectedDigest: range.digest,
          replacement: acceptance, reason: "Retain every canonical Task acceptance criterion." }] }],
    }));
    reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request,
      prompt: JSON.stringify(request.toPromptReference()) });
    sealWorkerArtifactHandoff({ requestPath: request.requestPath,
      invocationId: request.dispatchInvocationId, now: () => new Date("2026-08-04T00:00:01.000Z") });
    const service = await prepareSpecGateRepairService({ ctx: value.ctx, request,
      Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });
    const beforePreview = { state: value.flowManager.canonicalState(value.specId).toJSON(),
      activities: value.flowManager.activityLedger(value.specId), catalog: value.flowManager.artifactCatalog(value.specId).toJSON() };
    const preview = selectSpecGateRepair(service.inspectWorkerCompletion());
    assert.equal(preview.result.kind, "spec-gate-repair-review-required");
    assert.deepEqual(preview.candidate.spec.tasks[0].acceptance, acceptance);
    assert.deepEqual({ state: value.flowManager.canonicalState(value.specId).toJSON(),
      activities: value.flowManager.activityLedger(value.specId), catalog: value.flowManager.artifactCatalog(value.specId).toJSON() }, beforePreview);
    const result = await new SpecGateRepairStep(service).execute();
    assert.equal(result.kind, preview.result.kind);

    const restored = new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId });
    assert.equal(restored.canonicalState(value.specId).nextAction().nodeId, "spec-review");
    const input = restored.readArtifact({ specId: value.specId,
      logicalKey: "spec.record", consumerNodeId: "spec-review" });
    const saved = JSON.parse(input.bytes.toString("utf8"));
    assert.deepEqual(saved.tasks[0].acceptance, acceptance);
    assert.deepEqual(saved, preview.candidate.spec);
    const audit = JSON.parse(restored.readArtifact({ specId: value.specId,
      logicalKey: "spec.gate.repair.audit", consumerNodeId: "spec-review",
      parameters: { attemptId: service.workerOutcome.receipt.binding.attemptId } }).bytes.toString("utf8"));
    assert.deepEqual(audit, preview.audit);
    readSpecJsonValidator().validate(saved);
    const review = restored.readCurrentSpecReviewInput({ specId: value.specId, consumerNodeId: "spec-review" });
    const snapshot = restored.readArtifact({ specId: value.specId, logicalKey: "spec.snapshot",
      consumerNodeId: "spec-review", parameters: { revision: review.review.identity.revision.toString() } });
    assert.equal(snapshot.descriptor.hash, review.review.identity.digest);
    assert.deepEqual(JSON.parse(snapshot.bytes.toString("utf8")).tasks, saved.tasks);
    assert.deepEqual(restored.loadReadOnly(value.specId).tasks, []);
  } finally { removeTmpDir(value.root); }
});
