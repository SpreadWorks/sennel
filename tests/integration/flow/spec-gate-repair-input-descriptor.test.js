import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { PromptLogicalFootprint } from "../../../src/lib/prompt-batching.js";
import { WorkerArtifactHandoffCoordinator, workerArtifactHandoffPolicy } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { SpecGateRepairCallPlan, specGateRepairCallFootprint } from "../../../src/flow/lib/spec-gate-repair-call-plan.js";
import { latestRepairBudget } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { reserveSpecGateRepairWorkerCall } from "../../../src/flow/engine/composition/spec-gate-repair.js";
import { workerArtifactStableStringify } from "../../../src/flow/lib/worker-artifact-input-format.js";
import { createSpecGateRepairScenario } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

/** Isolates the descriptor transport boundary; production dispatcher wiring has its own scenario. */
class SelectedInputWork {
  constructor(request) { this.request = request; }
  static forAdmission(invocation, request) { return new this(request); }
  workerInvocation() { return null; }
  instructionPrompt() { return `${this.request.specGateRepairInstructionPrompt()}\n`; }
  prompt() { return this.instructionPrompt() + this.request.specGateRepairInputPrompt(); }
}

describe("Spec Gate repair selected input descriptor", () => {
  for (const mode of ["inline", "file"]) {
    it(`restores exact ${mode} input from its canonical checkpoint without embedding the body in the manifest`, async (t) => {
      const value = await createSpecGateRepairScenario({ specId: `500-repair-descriptor-${mode}` });
      t.after(() => removeTmpDir(value.root));
      const coordinator = new WorkerArtifactHandoffCoordinator();
      const executionRoot = mode === "file" ? createTmpDir("repair-descriptor-execution-") : value.root;
      if (mode === "file") t.after(() => removeTmpDir(executionRoot));
      const ctx = { ...value.ctx, executionRoot };
      const initial = coordinator.createRequest({ ctx, state: value.flowManager.loadReadOnly(value.specId),
        invocation: value.invocation, deferPreparation: true });
      const request = initial.withSpecGateRepairDelivery({ mode }).prepare();
      const input = request.inputs[0];
      const text = workerArtifactStableStringify(input.document);
      const work = SelectedInputWork.forAdmission(value.invocation, request);
      const { limit, budget } = latestRepairBudget({ flowManager: value.flowManager, specId: value.specId,
        attemptId: input.descriptor.canonicalLocator.attemptId, baseRevision: input.document.baseRevision,
        consumerNodeId: "spec-gate-repair" });
      const plan = new SpecGateRepairCallPlan({ requests: [request], invocation: value.invocation,
        dispatchWorkClass: SelectedInputWork, limit, budget });
      reserveSpecGateRepairWorkerCall({ ctx, request,
        prompt: work.prompt(), physicalRequest: work.prompt(), instructionPrompt: work.instructionPrompt(), callPlan: plan });
      const manifest = JSON.parse(fs.readFileSync(request.requestPath, "utf8"));
      assert.equal(Object.hasOwn(manifest.inputs[0], "document"), false);
      assert.equal(manifest.inputs[0].descriptor.deliveryMode, mode);
      assert.equal(manifest.inputs[0].descriptor.selectionDigest, input.digest);
      assert.equal(manifest.inputs[0].descriptor.selectionBytes, Buffer.byteLength(text));
      assert.equal(JSON.stringify(manifest).includes(text), false);
      assert.equal(work.prompt().split(text).length - 1, mode === "inline" ? 1 : 0);
      const cost = specGateRepairCallFootprint(request, work.instructionPrompt());
      const metadataCharacters = workerArtifactStableStringify(manifest).length
        + workerArtifactStableStringify(JSON.parse(fs.readFileSync(request.actionRequestPath, "utf8"))).length;
      assert.equal(cost.documentCharacters, text.length + metadataCharacters);
      assert.equal(cost.characters, PromptLogicalFootprint.measure(work.instructionPrompt()).total + text.length + metadataCharacters);
      assert.equal(cost.characters, PromptLogicalFootprint.measure(work.prompt()).total
        + (mode === "file" ? text.length : 0) + metadataCharacters);
      assert.equal(cost.items, 4);
      assert.deepEqual(plan.saved.calls[0].callCost.toJSON(), cost.toJSON());

      const manager = new FlowManager({ root: value.root, mainRoot: value.root, specId: value.specId, inWorktree: false });
      const binding = { runId: request.runId, specId: request.specId, inputDigest: request.inputDigest,
        inputRevision: request.inputRevision, requestDigest: request.requestDigest };
      const codec = workerArtifactHandoffPolicy("spec-gate-repair").inputContract;
      const decode = (options = {}) => codec.decodeInput(manifest.inputs[0], { executionRoot,
        flowManager: manager, binding, ...options });
      const restored = decode();
      assert.equal(workerArtifactStableStringify(restored.document), text);
      assert.deepEqual(restored.toJSON(), manifest.inputs[0]);
      assert.throws(() => { restored.document.bundle.version = 99; }, TypeError);
      assert.throws(() => decode({ binding: { ...binding, inputRevision: "f".repeat(64) } }),
        { code: "FLOW_SPEC_GATE_REPAIR_INPUT_FORMAT_UNAVAILABLE" });
      const before = manager.canonicalState(value.specId).toJSON();
      const deliveryPath = input.descriptor.deliveryPath(executionRoot);
      assert.ok(path.relative(executionRoot, deliveryPath).startsWith(".sennel/"));
      if (mode === "file") {
        assert.notEqual(executionRoot, value.root);
        assert.ok(work.instructionPrompt().includes(executionRoot));
      }
      fs.writeFileSync(deliveryPath, ` ${text.slice(1)}`);
      assert.throws(() => decode(), { code: "FLOW_SPEC_GATE_REPAIR_INPUT_SNAPSHOT_CHANGED" });
      assert.deepEqual(manager.canonicalState(value.specId).toJSON(), before);
      fs.rmSync(deliveryPath);
      assert.throws(() => decode(), { code: "ENOENT" });
      assert.equal(workerArtifactStableStringify(decode({ allowUnavailableDelivery: true }).document), text);
      assert.deepEqual(manager.canonicalState(value.specId).toJSON(), before);
      assert.equal(plan.saved.calls[0].deliveryMode, mode);
      const claimed = JSON.parse(manager.readArtifact({ specId: value.specId,
        logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
        parameters: { attemptId: input.descriptor.canonicalLocator.attemptId,
          generation: String(input.descriptor.canonicalLocator.generation), phase: "claimed" } }).bytes.toString("utf8"));
      assert.equal(claimed.budget.providerCallCount, 1);
      assert.deepEqual(claimed.callCost, cost.toJSON());
    });
  }
});
