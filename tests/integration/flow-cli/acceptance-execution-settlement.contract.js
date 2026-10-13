import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { AcceptancePhaseScenario } from "../../support/acceptance-phase-scenario.js";
import { FlowExecutionContract } from "../../../src/flow/lib/flow-execution-contract.js";
import { executeAcceptanceReviewInput } from "../../../src/flow/lib/run-acceptance-review.js";

/** Share only the owning suite's immutable normal upstream producer seed. */
export function registerAcceptanceExecutionSettlementCases(getSeed) {
  describe("Acceptance execution final publication and acknowledgement", () => {

    it("refuses changed saved-response inputs with a new mechanical blocker before direct or dispatch publication", async (t) => {
      const scenario = AcceptancePhaseScenario.fromSeed(t, getSeed());
      await scenario.advanceTo("acceptance-review");
      const context = await scenario.observeAcceptanceInput();
      assert.deepEqual(context.mechanicalBlockers, []);
      const manager = scenario.manager;
      const save = manager.savePromptExecutionProgress;
      let interrupted = false;
      manager.savePromptExecutionProgress = function (input) {
        const result = save.call(this, input);
        if (!interrupted && input.record.event === "response") {
          interrupted = true;
          const error = new Error("Interrupt after saving the real Acceptance response");
          error.code = "TEST_ACCEPTANCE_RESPONSE_SAVED";
          throw error;
        }
        return result;
      };
      t.after(() => { manager.savePromptExecutionProgress = save; });
      const stopped = await scenario.runRegistered("acceptance-review");
      assert.equal(stopped.ok, false);
      assert.equal(stopped.errors[0].code, "TEST_ACCEPTANCE_RESPONSE_SAVED");
      manager.savePromptExecutionProgress = save;
      scenario.reload();
      const saved = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "acceptance-review" });
      assert.equal(saved.receipt.executionLifecycle.phase, "claimed");
      const contract = scenario.manager.readStoredExecutionContract({ binding: saved.result.evidence.identity,
        generation: saved.result.evidence.executionGeneration });
      const progress = scenario.manager.readPromptExecutionEpisode({ executionContract: contract });
      assert.equal(progress.budget.providerCallCount, 1);
      assert.equal(progress.scopes[0].batches[0].responses.length, 1);
      assert.equal(progress.scopes[0].batches[0].claim, null);
      const before = scenario.snapshot();
      const source = path.join(scenario.root, "src/skills/continuation-evidence/SKILL.md");
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, "# Project source changed after Acceptance response persistence\n");
      const changed = await scenario.observeAcceptanceInput();
      assert.notEqual(changed.fingerprint.hash, context.fingerprint.hash);
      assert.ok(changed.mechanicalBlockers.some((blocker) => blocker.kind === "invalid_upgrade"));
      for (const command of ["acceptance-review", "dispatch"]) {
        const refused = await scenario.runRegistered(command);
        assert.equal(refused.ok, false, JSON.stringify(refused));
        assert.equal(refused.errors[0].code, "FLOW_EXECUTION_CONTRACT_MISMATCH");
        scenario.reload();
        assert.deepEqual(scenario.snapshot(), before, "refusal preserves claim, response, budgets, Attempt and catalog");
        assert.equal(scenario.manager.readArtifact({ specId: scenario.specId, logicalKey: "acceptance.review",
          consumerNodeId: "final-regression", optional: true }), null);
      }
      assert.equal(scenario.acceptanceProviderCalls.length, 1);
    });

    it("rolls back a failed final transaction and reuses validated responses after manager reload", async (t) => {
      const scenario = AcceptancePhaseScenario.fromSeed(t, getSeed());
      await scenario.advanceTo("acceptance-review");
      const attempt = scenario.state().attempt;
      const failure = new Error("Acceptance final transaction interrupted before state publication");
      failure.code = "TEST_ACCEPTANCE_FINAL_SAVE_FAILED";
      let savingFinal = false;
      let injected = false;
      let beforeFinal = null;
      let contract = null;
      scenario.reload({ versionStoreFaultInjector({ phase }) {
        if (savingFinal && !injected && phase === "before-current-flow-state-temp-write") {
          injected = true;
          throw failure;
        }
      } });
      const manager = scenario.manager;
      const original = manager.settleAcceptanceStepResult;
      manager.settleAcceptanceStepResult = function (input) {
        if (input.stepResult.kind === "acceptance-review-passed") {
          savingFinal = true;
          beforeFinal = scenario.snapshot();
          contract = input.executionContract;
          assert.throws(() => original.call(this, { ...input, executionContract: null }),
            { code: "FLOW_EXECUTION_CONTRACT_MISMATCH" }, "the Store cannot publish a claimed execution without its contract");
          assert.deepEqual(scenario.snapshot(), beforeFinal);
        }
        return original.call(this, input);
      };
      t.after(() => { manager.settleAcceptanceStepResult = original; });
      const interrupted = await scenario.runRegistered("acceptance-review");
      assert.equal(interrupted.ok, false);
      assert.equal(injected, true, `the failure must reach the actual final canonical transaction: ${JSON.stringify(interrupted)}`);
      scenario.reload();
      assert.deepEqual(scenario.snapshot(), beforeFinal, "a failed final commit cannot append a semantic error or alter the Attempt");
      assert.equal(scenario.current(), "acceptance-review");
      assert.equal(scenario.state().attempt.id, attempt.id);
      assert.equal(scenario.state().attempt.consumption.semantic, attempt.consumption.semantic);
      assert.equal(scenario.state().findNode("final-regression").status, "pending");
      assert.equal(scenario.manager.readArtifact({ specId: scenario.specId, logicalKey: "acceptance.review",
        consumerNodeId: "final-regression", optional: true }), null);
      const episode = scenario.manager.readPromptExecutionEpisode({ executionContract: contract });
      assert.equal(episode.budget.providerCallCount, 1);
      assert.ok(episode.scopes.every((scope) => scope.batches.every((batch) => batch.completion !== null)));
      assert.equal(scenario.acceptanceProviderCalls.length, 1);
      const resumed = await scenario.runRegistered("acceptance-review");
      assert.equal(resumed.verdict, "pass", JSON.stringify(resumed));
      assert.equal(scenario.acceptanceProviderCalls.length, 1, "validated responses survive final-commit failure without another RPC");
      assert.equal(scenario.commandArtifact("acceptance.review", "final-regression").payload.verdict, "pass");
      assert.equal(scenario.state().findNode("acceptance-review").status, "done");
    });

    it("recovers a lost final acknowledgement and replays the exact receipt before checking a pending runtime contract", async (t) => {
      const scenario = AcceptancePhaseScenario.fromSeed(t, getSeed());
      await scenario.advanceTo("acceptance-review");
      const manager = scenario.manager;
      const original = manager.settleAcceptanceStepResult;
      const lost = new Error("Acceptance final acknowledgement was lost after canonical commit");
      let injected = false;
      let finalInput = null;
      manager.settleAcceptanceStepResult = function (input) {
        const outcome = original.call(this, input);
        if (!injected && input.stepResult.kind === "acceptance-review-passed") {
          injected = true;
          finalInput = input;
          throw lost;
        }
        return outcome;
      };
      t.after(() => { manager.settleAcceptanceStepResult = original; });
      const accepted = await scenario.runRegistered("acceptance-review");
      assert.equal(injected, true, JSON.stringify(accepted));
      assert.equal(accepted.verdict, "pass", JSON.stringify(accepted));
      assert.equal(scenario.acceptanceProviderCalls.length, 1);
      scenario.reload();
      const saved = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId,
        stepId: "acceptance-review", completed: true });
      assert.equal(saved.result.kind, "acceptance-review-passed");
      assert.equal(saved.receipt.id, accepted.settlementReceipt.id);
      const before = scenario.snapshot();
      const mismatchedPendingContract = new FlowExecutionContract({ ...finalInput.executionContract.toJSON(),
        inputBaselines: finalInput.executionContract.inputBaselines,
        runtimeRevision: "a different unfinished runtime" });
      const replay = scenario.manager.commitSpecStepResult({ ...finalInput, executionContract: mismatchedPendingContract });
      assert.equal(replay.receipt.id, saved.receipt.id,
        "supported final receipt recovery must precede conditions that apply only to unfinished execution");
      const projected = await executeAcceptanceReviewInput({ ...scenario.context(), flowManager: scenario.manager,
        specId: scenario.specId, stepId: "acceptance-review", receipt: saved.receipt });
      assert.equal(projected.id, saved.receipt.id);
      assert.deepEqual(scenario.reload().snapshot(), before);
      assert.equal(scenario.acceptanceProviderCalls.length, 1);
      assert.equal(scenario.commandArtifact("acceptance.review", "final-regression").payload.verdict, "pass");
    });
  });
}
