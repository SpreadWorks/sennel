import assert from "node:assert/strict";
import { FinalRegressionRepositoryBinding, validateFinalRegressionEvidence }
  from "../../../src/flow/lib/test-artifacts.js";
import { RepairArtifactRegistry } from "../../../src/flow/lib/repair-state-identity.js";

/** Connect genuine saved process evidence to the existing consumer validator. */
export function assertAcceptanceFinalRegressionEvidence(scenario, artifact, { result, exitCode, failureKind } = {}) {
  const payload = artifact.payload;
  assert.equal(artifact.descriptor.logicalKey, "final.regression");
  assert.equal(payload.result, result);
  assert.equal(payload.process.started, true);
  assert.equal(payload.process.exitCode, exitCode);
  assert.equal(payload.process.timedOut, false);
  if (failureKind !== undefined) assert.equal(payload.failureKind, failureKind);
  const binding = payload.executionBinding;
  assert.equal(binding.parsedResult, result);
  assert.ok(Number.isSafeInteger(binding.testCount) && binding.testCount >= 0);
  if (result === "pass") assert.ok(binding.testCount > 0, "PASS needs actual executed test coverage");
  assert.equal(binding.truncated, false);
  for (const stream of ["stdout", "stderr"]) {
    assert.equal(binding[stream].truncated, false);
    assert.equal(binding[stream].capturedByteLength, binding[stream].originalByteLength);
  }
  const repositoryBindingOptions = { pathspecExcludes: new RepairArtifactRegistry(
    scenario.manager.specLocation(scenario.specId).relativeSpecFile).gitPathspecExcludes() };
  const current = FinalRegressionRepositoryBinding.capture(scenario.root, repositoryBindingOptions);
  for (const field of ["headSha", "treeSha", "worktreeSha256"]) assert.equal(binding[field], current[field],
    "the actual saved command evidence must still bind the current repository before consumer adoption");
  assert.deepEqual(validateFinalRegressionEvidence({ root: scenario.root, artifact: payload, repositoryBindingOptions }),
    { ok: true, rawEvidence: "verified" }, "readback must authenticate the actual raw log, streams, count and repository binding");
}
