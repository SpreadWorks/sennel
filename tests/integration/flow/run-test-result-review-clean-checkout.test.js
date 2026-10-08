import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import RunClaimNextActionCommand from "../../../src/flow/lib/run-claim-next-action.js";
import RunTestExecuteCommand from "../../../src/flow/lib/run-test-execute.js";
import RunTestResultReviewCommand from "../../../src/flow/lib/run-test-result-review.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { implStepRegistration } from "../../../src/flow/engine/composition/impl.js";
import { attachedCanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";
import { ImplPhaseScenario } from "../../support/impl-phase-scenario.js";
import { dispatchContainer } from "../../support/infrastructure/flow-dispatch-scenario.js";

test("completed canonical test evidence survives transient diagnostic cleanup", async (t) => {
  const scenario = ImplPhaseScenario.create(t);
  await scenario.advanceTo("test-execute");
  const command = new RunTestExecuteCommand();
  command.container = dispatchContainer({ root: scenario.root, flowManager: scenario.manager });
  const executionResult = await command.execute(scenario.context());
  await FLOW_COMMANDS.run["test-execute"].post(scenario.context(), executionResult);
  const execution = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId,
    stepId: "test-execute", completed: true });
  assert.equal(execution.result.kind, "test-execute-observed");
  assert.equal(execution.result.evidence.completion.completed, true);
  assert.equal(execution.result.evidence.observation.rawAvailable, true);
  const raw = scenario.manager.readRuntimeArtifact({ specId: scenario.specId,
    logicalKey: "test.execute.raw-log", consumerNodeId: "test-result-review" });
  assert.ok(raw.bytes.length > 0);
  // This diagnostic is explicitly transient and absent from the durable catalog.
  const rawPath = scenario.manager.specLocation(scenario.specId).resolve(raw.relativePath);
  fs.unlinkSync(rawPath);
  const producerManager = scenario.manager;
  scenario.reload();
  assert.notEqual(scenario.manager, producerManager);

  await t.test("test-result review trusts cataloged structured evidence when the transient execution log is absent", async () => {
    const claimed = await new RunClaimNextActionCommand().execute(scenario.context());
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    assert.equal(scenario.state().attempt.nodeId, "test-result-review");
    const result = await new RunTestResultReviewCommand().execute(scenario.context());
    await FLOW_COMMANDS.run["test-result-review"].post(scenario.context(), result);
    const publication = attachedCanonicalCommandResultArtifact(result);
    assert.equal(result.result, "ok", JSON.stringify(publication?.payload));
    assert.equal(result.artifacts.verdict, "pass");
    assert.equal(publication.logicalKey, "test.result.review");
    assert.equal(publication.payload.verdict, "pass");
    assert.equal(publication.payload.checked_items.every((entry) => entry.result === "pass"), true);
    assert.equal(publication.payload.raw_output_path.includes("test-execute"), true);
    assert.equal(publication.payload.rawEvidenceFingerprint,
      execution.result.evidence.observation.value("rawEvidenceFingerprint"));
    scenario.reload();
    const saved = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId,
      stepId: "test-result-review", completed: true });
    assert.equal(saved.result.kind, "test-result-review-evidence-accepted");
    assert.equal(saved.result.evidence.observation.rawAvailable, false);
    assert.equal(saved.result.evidence.observation.executionCompletion.receiptId, execution.receipt.id);
    assert.equal(saved.result.evidence.completion.completed, true);
    assert.equal(scenario.current(), "impl-review");
    const before = scenario.snapshot();
    for (const stepId of ["test-execute", "test-result-review"]) {
      const registration = implStepRegistration(stepId);
      const receipt = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId,
        stepId, completed: true }).receipt;
      const input = { flowManager: scenario.manager, specId: scenario.specId, stepId, registration, receipt };
      const selected = registration.executionContract.select(input);
      assert.equal((await registration.executionContract.execute(selected, input)).id, receipt.id);
      fs.writeFileSync(rawPath, Buffer.concat([raw.bytes, Buffer.from("tampered\n")]));
      try {
        await assert.rejects(() => registration.executionContract.execute(selected, input), StepAdmissionRefusal);
      } finally { fs.unlinkSync(rawPath); }
    }
    assert.deepEqual(scenario.snapshot(), before);
  });

  await t.test("cataloged scenario and execution evidence remain complete without transient raw log bytes", () => {
    const executionArtifact = scenario.commandArtifact("test.execute", "impl-review");
    assert.equal(executionArtifact.payload.summary[0].result, "pass");
    assert.equal(scenario.manager.readRuntimeArtifact({ specId: scenario.specId,
      logicalKey: "test.execute.raw-log", consumerNodeId: "test-result-review", optional: true }), null);
    assert.equal(executionArtifact.payload.rawEvidenceFingerprint,
      execution.result.evidence.observation.value("rawEvidenceFingerprint"));
    assert.equal(scenario.commandArtifact("test.result.review", "impl-review").payload.verdict, "pass");
  });
});
