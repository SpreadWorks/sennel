import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-values.js";
import { fixtureRepository } from "./flow-dispatch-scenario.js";
import { ProcessRuntimeFlowScenario } from "./process-runtime-flow-scenario.js";

/** Phase-scoped real external workers; internal admission and recovery stay real. */
export class PhaseProcessEvidenceScenario extends ProcessRuntimeFlowScenario {
  static seed() {
    const root = fixtureRepository("phase-process-evidence-seed-");
    fs.mkdirSync(path.join(root, ".sennel"), { recursive: true });
    return root;
  }

  constructor(seed, { test, phase }) {
    super(seed, { test, step: phase, specId: `process-evidence-${phase}`, runId: `process-evidence-${phase}-run` });
    this.phase = phase;
  }

  async verify({ unknown }) {
    const dispatcher = await this.startProvider();
    const request = JSON.parse(fs.readFileSync(this.request, "utf8"));
    const before = this.snapshot();
    const artifactKey = this.phase === "draft" ? "draft" : "spec.record";
    const artifactRead = manager => manager.readArtifact({ specId: this.specId, logicalKey: artifactKey,
      consumerNodeId: this.phase === "draft" ? "draft-questions-review" : "spec-review", optional: true });
    // Spec's normal Draft-entry connector can already own its partial record.
    // A failed worker must preserve it, rather than requiring an impossible
    // phase entry with no upstream publication.
    const originalArtifact = artifactRead(this.manager());
    const binding = { runId: this.runId, specId: this.specId, stepId: this.phase, attempt: before.state.attempt };
    const source = this.manager().artifactWorkerExecutionState({ binding });
    const budgetBefore = this.manager().readStoredPromptExecutionEpisode({ executionContract: source.executionContract }).budget;
    const initial = ProcessExecutionRuntime.inspect({ mainRoot: this.root });
    if (unknown) dispatcher.kill();
    else this.releaseProvider();
    const finished = await dispatcher.result;
    assert.notEqual(finished.status, 0, JSON.stringify(finished));
    if (!unknown) {
      // The existing public handoff contract permits one fresh correction;
      // both missing outputs must fail before the terminal refusal is saved.
      assert.equal(finished.envelope.errors[0].code, "FLOW_ARTIFACT_HANDOFF_RETRY_EXHAUSTED", JSON.stringify(finished.envelope.errors));
      assert.equal(finished.envelope.data.attempts, 2);
      assert.equal(finished.envelope.data.first.code, "FLOW_ARTIFACT_HANDOFF_MISSING");
      assert.equal(finished.envelope.data.second.code, "FLOW_ARTIFACT_HANDOFF_MISSING");
    }

    const manager = this.manager();
    const state = manager.canonicalState(this.specId);
    assert.equal(state.attempt.id, before.state.attempt.id);
    assert.equal(state.attempt.sequence, before.state.attempt.sequence);
    assert.deepEqual(state.attempt.consumption.toJSON(), before.state.attempt.consumption);
    const retainedArtifact = artifactRead(manager);
    assert.deepEqual(retainedArtifact?.descriptor ?? null, originalArtifact?.descriptor ?? null);
    assert.deepEqual(retainedArtifact?.bytes ?? null, originalArtifact?.bytes ?? null);
    assert.equal(manager.activityLedger(this.specId).some(activity =>
      activity.nodeId === this.phase && activity.result?.stepResult?.kind === `${this.phase}-created`), false);
    assert.equal(manager.readCurrentStepSettlement({ specId: this.specId, stepId: this.phase }), null);
    const readback = ProcessExecutionRuntime.inspect({ mainRoot: this.root });
    const execution = readback.executions.find(entry => entry.executionId === initial.slot);
    const provider = execution.calls.find(call => call.invocation.kind === "provider"
      && call.binding.executionContractId === request.executionContractId);
    assert.ok(provider, "the real phase worker must retain its registered provider identity");
    if (unknown) {
      assert.equal(provider.receipt, null);
      assert.notEqual(execution.status, "closed");
      assert.deepEqual(this.snapshot(), before, "owner loss cannot synthesize a phase settlement");
    } else {
      const receipt = new ProcessExecutionStopReceipt(provider.receipt);
      assert.equal(receipt.stopEvidence.confirmed, true);
      assert.equal(receipt.observation.code, 0, "a normal exit cannot substitute for required output");
      assert.equal(receipt.output.completion, "complete");
      assert.equal(state.attempt.failure.code, "FLOW_ARTIFACT_HANDOFF_RETRY_EXHAUSTED");
      assert.equal(execution.status, "closed");
    }
    const saved = this.snapshot();
    const frontier = manager.artifactWorkerExecutionState({ binding });
    const calls = fs.readFileSync(this.calls, "utf8").trimEnd().split("\n").map(JSON.parse);
    assert.equal(calls.length, unknown ? 1 : 2);
    assert.deepEqual(frontier.contracts.map(contract => contract.id).sort(), [...new Set(calls.map(call => call.executionContractId))].sort());
    assert.ok(frontier.contracts.some(contract => contract.id === source.executionContract.id));
    assert.equal(frontier.executionContract.id, calls.at(-1).executionContractId);
    if (unknown) assert.deepEqual(manager.readStoredPromptExecutionEpisode({ executionContract: frontier.executionContract }).budget, budgetBefore);
    else for (const contract of frontier.contracts) {
      assert.equal(contract.budgetId, source.executionContract.budgetId,
        "fresh correction contracts retain the same episode budget");
      assert.equal(manager.readStoredPromptExecutionEpisode({ executionContract: contract }).budget.providerCallCount,
        calls.length);
    }
    const restarted = await this.invoke(["run", "dispatch"]);
    if (unknown) {
      assert.notEqual(restarted.status, 0);
      assert.ok(["PROCESS_EXECUTION_BUSY", "FLOW_DISPATCH_BUSY"].includes(restarted.envelope.errors[0].code));
    } else {
      // Projecting an already persisted block is a successful read of that
      // boundary, not successful completion of the phase or another worker.
      assert.equal(restarted.status, 0);
      const dispatch = restarted.envelope.dispatch ?? restarted.envelope.data?.dispatch;
      assert.equal(dispatch.boundary, "blocked");
      assert.equal(dispatch.dispatchCount, 0);
    }
    assert.deepEqual(this.snapshot(), saved, "fresh dispatcher cannot publish or execute the failed worker again");
    assert.equal(fs.readFileSync(this.count, "utf8"), unknown ? "1" : "2");
    assert.deepEqual(this.manager().artifactWorkerRecoveryReceipts({ specId: this.specId }), []);
  }
}
