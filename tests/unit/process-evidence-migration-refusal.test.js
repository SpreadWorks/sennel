import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { FLOW_ARTIFACT_CONTRACTS } from "../../src/lib/flow-artifact-contract.js";
import { ProcessEvidenceArtifactMigration, ProcessEvidenceMigrationRefusal } from "../../src/lib/process-evidence-artifact-migration.js";

const original = JSON.parse(fs.readFileSync(new URL("../fixtures/process-runtime-record-v8-canonical/archives/2e9ded1e-d0db-4fa7-ae6b-30b18c03756a.json", import.meta.url)));
const receipt = original.payload.execution.calls.find(call => call.receipt !== null).receipt;
const wire = value => Buffer.from(JSON.stringify(value));
const digest = "a".repeat(64);

// Unsupported boundary records deliberately omit producer graph context. The
// expected outcome is preservation/refusal, never a successful migration claim.
for (const [logicalKey, parameters, value] of [
  ["spec.review", { revision: "001" }, { processStop: receipt }],
  ["source.handoff.event", { handoffId: digest, eventSequence: "001", eventDigest: digest }, { processStopEvidence: receipt }],
  ["activity.evidence", { ownerPath: "spec-review", digest }, { review: { processStop: receipt } }],
  ["draft.questions.review", {}, { attempts: [{ artifact: { payload: { processStop: receipt } } }] }],
  ["draft.coverage.review", {}, { processStop: receipt }],
  ["test.requirement.review", {}, { attempts: [{ artifact: { payload: { processStop: receipt } } }] }],
  ["impl.review", {}, { attempts: [{ artifact: { payload: { processStop: receipt } } }] }],
  ["task.review", { taskId: "T1" }, { attempts: [{ artifact: { payload: { processStop: receipt } } }] }],
]) {
  test("explicit migration refuses previous hash-bound evidence in " + logicalKey + " without returning partial replacements", () => {
    const descriptor = logicalKey === "activity.evidence"
      ? FLOW_ARTIFACT_CONTRACTS.activityEvidence({ nodeId: "spec-review", digest })
      : FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, parameters);
    const bytes = wire(value), before = Buffer.from(bytes);
    assert.throws(() => new ProcessEvidenceArtifactMigration([{ descriptor, bytes }]), cause =>
      cause instanceof ProcessEvidenceMigrationRefusal && cause.code === "UNSAFE_SOURCE_FORMAT"
      && cause.logicalKey === logicalKey && cause.relativePath === descriptor.relativePath);
    assert.deepEqual(bytes, before);
  });
}

test("format migration leaves unrelated opaque review output intact", () => {
  const descriptor = FLOW_ARTIFACT_CONTRACTS.resolve("impl.review");
  const value = { attempts: [{ artifact: { payload: { providerResponse: { processStop: receipt } } } }] };
  const bytes = wire(value);
  assert.deepEqual(new ProcessEvidenceArtifactMigration([{ descriptor, bytes }]).replacements, []);
  assert.deepEqual(JSON.parse(bytes), value);
});


test("unrecognized hash-bound receipt revisions cannot be reported as already current", () => {
  const descriptor = FLOW_ARTIFACT_CONTRACTS.resolve("spec.review", { revision: "001" });
  for (const schemaVersion of [1, 2, 5]) {
    const bytes = wire({ processStop: { ...receipt, schemaVersion } });
    assert.throws(() => new ProcessEvidenceArtifactMigration([{ descriptor, bytes }]),
      cause => cause instanceof ProcessEvidenceMigrationRefusal && cause.code === "UNSAFE_SOURCE_FORMAT");
  }
});
