import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { SpecGateRepairExecutionFormatUnavailable, SpecGateRepairExecutionStop } from "../../../src/flow/definition.js";
import { StepPersistenceFailure } from "../../../src/flow/lib/definition-lifecycle-failure.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunDispatchCommand, { FlowDispatchWork } from "../../../src/flow/lib/run-dispatch.js";
import { planSpecGateRepairWorkerExecution } from "../../../src/flow/lib/spec-gate-repair-execution.js";
import { selectWorkerExecutionAdmission, projectWorkerExecutionAdmission,
  assertWorkerExecutionAdmission } from "../../../src/flow/lib/worker-execution-admission.js";
import { WorkerArtifactHandoffCoordinator, WorkerArtifactHandoffError,
  sealWorkerArtifactHandoff, workerArtifactHandoffPolicy } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { SpecGateRepairBundle } from "../../../src/flow/lib/spec-gate-repair-bundle.js";
import { reserveFixtureSpecGateRepairWorkerCall } from "../../support/infrastructure/spec-gate-repair-admission.js";
import { createSpecGateRepairScenario } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

function fileSnapshot(directory) {
  const files = [];
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else files.push([child, fs.readFileSync(path.join(directory, child)).toString("base64")]);
    }
  };
  visit("");
  return files;
}

function durableSnapshot(manager, specId, request) {
  const state = manager.canonicalState(specId);
  return {
    state: state.toJSON(),
    activities: manager.activityLedger(specId),
    catalog: manager.artifactCatalog(specId).toJSON(),
    execution: manager.draftStepExecutionState({ binding: {
      runId: state.runId, specId, stepId: "spec-gate-repair", attempt: state.attempt,
    } }).lifecycle.toJSON(),
    canonicalFiles: fileSnapshot(manager.specLocation(specId).directory),
    handoffFiles: fileSnapshot(request.directory),
  };
}

function changedProgressWrites(input, change) {
  return input.artifactWrites.map((write) => {
    assert.equal(write.logicalKey, "spec.gate.repair.progress");
    const document = JSON.parse(write.bytes.toString("utf8"));
    // Inject the historical format at the normal Store publication boundary.
    // The Store still owns catalog hashes, receipts and the legal lifecycle;
    // altering a saved file afterward would test integrity rejection instead.
    change(document);
    return { ...write, bytes: Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8") };
  });
}

function oldProgressWrites(input) {
  return changedProgressWrites(input, (document) => {
    document.version = 2;
    delete document.inputDescriptors;
    delete document.sourceSnapshots;
    delete document.physicalPromptFootprint;
    delete document.deliveryMode;
  });
}

function writeRepairPayload(request) {
  const context = request.inputs[0].document;
  const selected = SpecGateRepairBundle.fromJSON(context.bundle).selections()[0];
  const range = selected.ranges.find((entry) => entry.writable);
  fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson({
    version: 1, stage: "spec-gate-repair", baseRevision: context.baseRevision,
    groups: [{ findingIdentities: selected.unit.findings.map((finding) => finding.identity),
      operations: [{ kind: "edit-text-field", target: range.target, expectedDigest: range.digest,
        edits: [{ startByte: 0, endByte: Buffer.byteLength(range.value),
          replacement: "Publish an explicitly validated artifact." }],
        reason: "Correct the selected bounded finding." }] }],
  }));
}

describe("unfinished Spec Gate repair input format admission", () => {
  for (const scenario of [
    { name: "checkpoint", phase: "checkpoint", sealed: false,
      expectedCode: "FLOW_SPEC_GATE_REPAIR_INPUT_FORMAT_UNAVAILABLE" },
    { name: "claimed with sealed response", phase: "claimed", sealed: true,
      expectedCode: "FLOW_SPEC_GATE_REPAIR_INPUT_FORMAT_UNAVAILABLE" },
    { name: "claimed without response", phase: "claimed", sealed: false,
      expectedCode: "FLOW_SPEC_GATE_REPAIR_RESPONSE_UNAVAILABLE" },
  ]) {
    it(`refuses an old ${scenario.name} after reload without changing its claim, budget or request`, async (t) => {
      const value = await createSpecGateRepairScenario();
      t.after(() => removeTmpDir(value.root));
      const request = value.coordinator.createRequest({ ctx: value.ctx,
        state: value.flowManager.loadReadOnly(value.specId), invocation: value.invocation });
      const method = scenario.phase === "checkpoint" ? "checkpointDraftStepExecution" : "claimDraftStepExecution";
      const save = value.flowManager[method].bind(value.flowManager);
      value.flowManager[method] = (input) => {
        const result = save({ ...input, artifactWrites: oldProgressWrites(input) });
        if (scenario.phase === "checkpoint") throw new Error("interrupted after old-format checkpoint publication");
        return result;
      };
      try {
        const reserve = () => reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request,
          prompt: JSON.stringify(request.toPromptReference()) });
        if (scenario.phase === "checkpoint") {
          assert.throws(reserve, (error) => {
            assert(error instanceof StepPersistenceFailure);
            assert.equal(error.message, "interrupted after old-format checkpoint publication");
            return true;
          });
        } else reserve();
      } finally {
        value.flowManager[method] = save;
      }
      if (scenario.sealed) {
        writeRepairPayload(request);
        // The external producer seals its delivery copy. Admission below must
        // still refuse the older canonical progress even with a real response.
        const submission = sealWorkerArtifactHandoff({ requestPath: request.requestPath,
          invocationId: request.dispatchInvocationId });
        assert.equal(submission.sealed, true);
      }

      const manager = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      const ctx = { ...value.ctx, flowManager: manager };
      const state = manager.canonicalState(value.specId);
      const savedArtifact = manager.readArtifact({ specId: value.specId,
        logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
        parameters: { attemptId: state.attempt.id, generation: "0", phase: scenario.phase } });
      const saved = JSON.parse(savedArtifact.bytes.toString("utf8"));
      assert.equal(saved.version, 2);
      assert.equal(Object.hasOwn(saved, "inputDescriptors"), false);
      assert.equal(saved.budget.providerCallCount, scenario.phase === "claimed" ? 1 : 0);
      assert.equal(fs.existsSync(request.submissionPath), scenario.sealed);
      const before = durableSnapshot(manager, value.specId, request);
      assert.equal(before.execution.phase, scenario.phase);
      if (scenario.phase === "claimed") assert.deepEqual(before.execution.claim, saved.executionLocator);
      else assert.equal(before.execution.claim, null);

      const selection = selectWorkerExecutionAdmission({ ctx, stepId: "spec-gate-repair" });
      assert(selection.repair.decision instanceof (scenario.expectedCode.endsWith("RESPONSE_UNAVAILABLE")
        ? SpecGateRepairExecutionStop : SpecGateRepairExecutionFormatUnavailable));
      const directive = projectWorkerExecutionAdmission(selection);
      assert.equal(directive.kind, "blocked");
      assert.equal(directive.code, scenario.expectedCode);
      const refuses = (error) => {
        assert(error instanceof WorkerArtifactHandoffError);
        assert.equal(error.code, scenario.expectedCode);
        assert.equal(error.retryable, false);
        return true;
      };
      assert.throws(() => assertWorkerExecutionAdmission(selection), refuses);
      const next = await new GetNextActionCommand().execute({ ...ctx,
        flowState: manager.loadReadOnly(value.specId), flowResolutionError: null });
      assert.equal(next.directive.kind, "blocked");
      assert.equal(next.directive.code, scenario.expectedCode);

      let regeneratedRequests = 0;
      const coordinator = new WorkerArtifactHandoffCoordinator();
      coordinator.planSpecGateRepairRequest = () => {
        regeneratedRequests += 1;
        assert.fail("an unavailable historical input must not regenerate a request");
      };
      assert.throws(() => planSpecGateRepairWorkerExecution({ ctx,
        state: manager.canonicalState(value.specId), invocation: value.invocation,
        handoffCoordinator: coordinator, dispatchWorkClass: FlowDispatchWork }), refuses);
      let providerCalls = 0;
      const dispatcher = new RunDispatchCommand({ handoffCoordinator: coordinator, agent: {
        async call() { providerCalls += 1; assert.fail("a refused historical repair must not call its provider"); },
      } });
      await assert.rejects(() => dispatcher.runWorkerAttempt(ctx, value.invocation), refuses);
      assert.equal(providerCalls, 0);
      assert.equal(regeneratedRequests, 0);
      assert.deepEqual(durableSnapshot(manager, value.specId, request), before);
      const reloaded = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      assert.deepEqual(durableSnapshot(reloaded, value.specId, request), before);
    });
  }

  for (const scenario of [
    { name: "missing source snapshots", change: (saved) => { delete saved.sourceSnapshots; },
      expectedCode: "FLOW_SPEC_GATE_REPAIR_INPUT_FORMAT_UNAVAILABLE" },
    { name: "tampered source content", change: (saved) => { saved.sourceSnapshots.sources[0].content += "changed"; },
      expectedMessage: "Repair source snapshot digest mismatch" },
    { name: "missing input descriptors", change: (saved) => { delete saved.inputDescriptors; },
      expectedCode: "FLOW_SPEC_GATE_REPAIR_INPUT_FORMAT_UNAVAILABLE" },
    { name: "tampered descriptor selection digest", change: (saved) => {
      saved.inputDescriptors[0].descriptor.selectionDigest = "0".repeat(64);
    }, expectedCode: "FLOW_SPEC_GATE_REPAIR_INPUT_FORMAT_UNAVAILABLE" },
  ]) {
    it(`refuses a current checkpoint with ${scenario.name} through admission and trusted descriptor restoration`, async (t) => {
      const value = await createSpecGateRepairScenario();
      t.after(() => removeTmpDir(value.root));
      const request = value.coordinator.createRequest({ ctx: value.ctx,
        state: value.flowManager.loadReadOnly(value.specId), invocation: value.invocation });
      const checkpoint = value.flowManager.checkpointDraftStepExecution.bind(value.flowManager);
      value.flowManager.checkpointDraftStepExecution = (input) => {
        checkpoint({ ...input, artifactWrites: changedProgressWrites(input, scenario.change) });
        throw new Error("interrupted after malformed current checkpoint publication");
      };
      try {
        assert.throws(() => reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request,
          prompt: JSON.stringify(request.toPromptReference()) }), (error) => {
          assert(error instanceof StepPersistenceFailure);
          assert.equal(error.message, "interrupted after malformed current checkpoint publication");
          return true;
        });
      } finally {
        value.flowManager.checkpointDraftStepExecution = checkpoint;
      }

      const manager = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      const ctx = { ...value.ctx, flowManager: manager };
      const state = manager.canonicalState(value.specId);
      // This read verifies the real catalog hash before the contract reader sees
      // malformed bytes. A post-publication file edit would stop before it.
      const artifact = manager.readArtifact({ specId: value.specId,
        logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
        parameters: { attemptId: state.attempt.id, generation: "0", phase: "checkpoint" } });
      const saved = JSON.parse(artifact.bytes.toString("utf8"));
      assert.equal(saved.version, 3);
      assert.equal(saved.budget.providerCallCount, 0);
      const before = durableSnapshot(manager, value.specId, request);
      assert.equal(before.execution.phase, "checkpoint");
      assert.equal(before.execution.claim, null);
      const refuses = (error) => {
        if (scenario.expectedCode) {
          assert(error instanceof WorkerArtifactHandoffError);
          assert.equal(error.code, scenario.expectedCode);
          assert.equal(error.retryable, false);
        } else {
          assert.equal(error.constructor, Error);
          assert.equal(error.message, scenario.expectedMessage);
        }
        return true;
      };

      assert.throws(() => assertWorkerExecutionAdmission(selectWorkerExecutionAdmission({ ctx,
        stepId: "spec-gate-repair" })), refuses);
      const manifest = JSON.parse(fs.readFileSync(request.requestPath, "utf8"));
      const codec = workerArtifactHandoffPolicy("spec-gate-repair").inputContract;
      assert.throws(() => codec.decodeInput(manifest.inputs[0], { executionRoot: value.root,
        flowManager: manager, binding: { runId: manifest.runId, specId: manifest.specId,
          inputDigest: manifest.inputDigest, inputRevision: manifest.inputRevision,
          requestDigest: request.requestDigest } }), refuses);

      let regeneratedRequests = 0;
      let providerCalls = 0;
      const coordinator = new WorkerArtifactHandoffCoordinator();
      coordinator.planSpecGateRepairRequest = () => {
        regeneratedRequests += 1;
        assert.fail("a malformed saved snapshot must not regenerate its request");
      };
      assert.throws(() => planSpecGateRepairWorkerExecution({ ctx, state,
        invocation: value.invocation, handoffCoordinator: coordinator,
        dispatchWorkClass: FlowDispatchWork }), refuses);
      const dispatcher = new RunDispatchCommand({ handoffCoordinator: coordinator, agent: {
        async call() { providerCalls += 1; assert.fail("a malformed saved snapshot must not call its provider"); },
      } });
      await assert.rejects(() => dispatcher.runWorkerAttempt(ctx, value.invocation), refuses);
      assert.equal(providerCalls, 0);
      assert.equal(regeneratedRequests, 0);
      assert.deepEqual(durableSnapshot(manager, value.specId, request), before);
      const reloaded = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      assert.deepEqual(durableSnapshot(reloaded, value.specId, request), before);
    });
  }
});
