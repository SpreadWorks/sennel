import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { artifactWorkerRecoveryRegistrations, artifactWorkerRecoveryRegistration } from "../../../src/flow/engine/composition/artifact-worker-recovery.js";
import { ArtifactWorkerRecoveryEvidence } from "../../../src/flow/lib/artifact-worker-recovery-values.js";
import { FlowExecutionContract } from "../../../src/flow/lib/flow-execution-contract.js";
import { ArtifactWorkerRecoveryWriter } from "../../../src/flow/services/artifact-worker-recovery-settlement-writer.js";
import { ServiceBoundaryCoverage, assertPreparedServiceBoundary } from "../../support/structure/service-boundary.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

test("every artifact recovery producer prepares its actual registered private Service from acquired selection and save capability", (t) => {
  const root = createTmpDir("artifact-recovery-service-boundary-");
  t.after(() => removeTmpDir(root));
  const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const registrations = artifactWorkerRecoveryRegistrations();
  assert.equal(artifactWorkerRecoveryRegistrations(), registrations, "all lookups reuse the same immutable initialized collection");
  const coverage = new ServiceBoundaryCoverage(registrations);
  const inspected = [];
  for (const registration of registrations) {
    assert.equal(artifactWorkerRecoveryRegistration(registration.stepId), registration);
    // Only pure acquired values and real save capabilities are constructed here.
    // Persistence/physical admission belongs to the recovery integration scenario.
    const sourceContract = new FlowExecutionContract({ runId: "service-boundary-run", specId: "artifact-recovery-service-boundary",
      stepId: registration.stepId, attemptId: "service-boundary-attempt", attemptSequence: 1, generation: 0,
      inputRevision: "1".repeat(64), runtimeRevision: "saved-runtime", promptDigest: "2".repeat(64), schemaDigest: "3".repeat(64) });
    const targetContract = new FlowExecutionContract({ ...sourceContract.toJSON(), generation: 1, runtimeRevision: "current-runtime" });
    const evidence = new ArtifactWorkerRecoveryEvidence({ sourceContract, targetContract,
      requestDigest: "4".repeat(64), targetRequestDigest: "5".repeat(64), physicalEvidenceDigest: "6".repeat(64),
      budget: { providerCallCount: 0, synthesisCallCount: 0, aggregateCharacters: 0, aggregateItemCount: 0 },
      sourceDispatchInvocationId: "source-dispatch", targetDispatchInvocationId: "target-dispatch" });
    const writer = new ArtifactWorkerRecoveryWriter({ flowManager, evidence });
    const selection = evidence.selection();
    const prepared = registration.create({ selection, writer });
    const service = assertPreparedServiceBoundary(registration, prepared, coverage);
    assert.equal(service.evidence, selection);
    assert.equal(service.receipt, null);
    assert.equal(prepared.serviceArguments[1], writer);
    inspected.push(registration.stepId);
  }
  assert.equal(coverage.assertComplete(), 1, "the shared Service type covers every independently prepared producer registration");
  assert.deepEqual(inspected, registrations.map((registration) => registration.stepId));
  assert.equal(artifactWorkerRecoveryRegistration("spec-gate-repair"), null);
});
