import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { SpecJsonValidator } from "../../src/lib/spec-json-validator.js";
import { SpecGateRepairContext } from "../../src/flow/lib/spec-gate-repair-context.js";
import { SpecGateRepairInput } from "../../src/flow/lib/spec-gate-repair-values.js";
import { SpecGateRepairInputUnavailable, SpecGateRepairSelectedInputIdentity } from "../../src/flow/lib/spec-gate-repair-input-unavailable.js";
import { SpecGateRepairInputDescriptor } from "../../src/flow/lib/spec-gate-repair-input-descriptor.js";
import { SpecGateRepairWorkerFacts } from "../../src/flow/lib/spec-gate-repair-worker-facts.js";
import { selectSpecGateRepair } from "../../src/flow/steps/spec/spec-gate-repair.js";
import { StepResult } from "../../src/flow/engine/step-result.js";
import { settleSpecStepResult } from "../../src/flow/definition.js";
import { specGateRepairInflationFixture } from "./spec-gate-repair-inflation-fixture.js";

test("a pure locate context's unavailable response preserves identity through Error Result and Failure without mutation", () => {
  // Current typed Gate findings always supply exact targets; locate remains a
  // pure context contract, not a reason to accept historical targetless Gates.
  const fixture = specGateRepairInflationFixture();
  const finding = { ...fixture.findings[0], targets: [], allowedTargets: [],
    where: { file: "spec.json", locator: "unresolved explanation" } };
  const context = new SpecGateRepairContext({ ...fixture, findings: [finding] });
  const plan = context.locationPlan();
  assert.equal(context.unresolvedFindings().length, 1);
  const document = { mode: "locate", baseRevision: context.baseRevision, finding };
  const digest = createHash("sha256").update(JSON.stringify(document)).digest("hex");
  const attempt = { id: "locate-attempt", sequence: 1 };
  const descriptor = new SpecGateRepairInputDescriptor({ logicalName: "spec-gate-repair-context.json",
    selectionDigest: digest, selectionBytes: Buffer.byteLength(JSON.stringify(document)),
    canonicalLocator: { logicalKey: "spec.gate.repair.progress", attemptId: attempt.id,
      attemptSequence: attempt.sequence, generation: 0, phase: "checkpoint", fragment: "context" },
    deliveryMode: "inline", deliveryReference: { projectRelativePath: "input/selected.json",
      digest, byteLength: Buffer.byteLength(JSON.stringify(document)) },
    selectedIdentity: SpecGateRepairSelectedInputIdentity.selectionFromDocument(document, digest) });
  const request = { runId: "locate-run", specId: "001-locate", stepId: "spec-gate-repair",
    state: { attempt }, inputDigest: "a".repeat(64), inputRevision: "b".repeat(64),
    requestDigest: "c".repeat(64),
    inputs: [{ name: "spec-gate-repair-context.json", document, digest, descriptor }] };
  const failure = SpecGateRepairInputUnavailable.fromRequest(request, {
    reason: "context-unavailable", explanation: "The selected structural index could not be read.",
  });
  const restored = SpecGateRepairInputUnavailable.fromJSON(JSON.parse(JSON.stringify(failure.toJSON())));
  assert.equal(restored.assertRequest(request), restored);
  const input = new SpecGateRepairInput({ repair: null, spec: fixture.spec,
    baseRevision: context.baseRevision, specByteLength: Buffer.byteLength(JSON.stringify(fixture.spec)),
    context, sourceDescriptor: {}, review: null, attempt,
    observationIdentities: [finding.identity], validator: new SpecJsonValidator({}) });
  const result = selectSpecGateRepair(new SpecGateRepairWorkerFacts({ input, proposal: restored.toJSON() }));
  const readback = StepResult.fromStored("spec-gate-repair", JSON.parse(JSON.stringify(result.toJSON())));
  assert.equal(readback.kind, "spec-gate-repair-error");
  assert.equal(readback.error.code, "FLOW_SPEC_GATE_REPAIR_INPUT_UNAVAILABLE");
  assert.deepEqual(readback.error.data, { ...restored.identity.toJSON(),
    reason: restored.reason, explanation: restored.explanation });
  assert.equal(settleSpecStepResult("spec-gate-repair", readback).kind, "failure");
  assert.deepEqual(input.spec, fixture.spec);
  assert.deepEqual(context.locationPlan().batches.map((batch) => batch.digest), plan.batches.map((batch) => batch.digest));
  assert.deepEqual(restored.identity.unitIds, []);
  assert.deepEqual(restored.identity.findingIdentities.map((identity) => identity.toJSON()), [finding.identity]);
  assert.throws(() => restored.assertRequest({ ...request, requestDigest: "d".repeat(64) }), /exact selected request/);
  assert.throws(() => restored.assertRequest({ ...request, stepId: "spec" }), /selected input identity is invalid/);
  for (const otherStage of [{ groups: [] }, { locations: [] }, { additionalRangeIds: [] }, { decision: "user choice" }]) {
    assert.throws(() => SpecGateRepairInputUnavailable.fromJSON({ ...restored.toJSON(), ...otherStage }), /invalid shape/);
  }
});
