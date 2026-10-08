import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { WorkerArtifactInputSnapshot, WorkerArtifactWorkerInstructions }
  from "../../src/flow/lib/worker-artifact-handoff.js";

test("Spec repair research preserves the existing recurrence report and exact fingerprints", () => {
  const fingerprint = "a".repeat(64);
  const document = { version: 1, phase: "spec", targetStepId: "spec-repair", sourceEvidence: null,
    entries: [{ fingerprint, recurrenceCount: 2, priorStrategy: "Clarify the existing verification method." }] };
  const bytes = Buffer.from(JSON.stringify(document));
  const inputs = [new WorkerArtifactInputSnapshot({ name: "gate-observation-recurrence.json",
    targetRelativePath: "gate-observation-recurrence.json", document,
    snapshot: { digest: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length } })];
  const initial = new WorkerArtifactWorkerInstructions({ schemaGuidance: "Preserve the immutable review delta." });
  const bound = initial.bindRequest("spec-repair", inputs);
  assert.match(bound.schemaGuidance, /Research missing source facts directly in the execution checkout/);
  assert.match(bound.schemaGuidance, /Write gate-repair-report\.json in the declared payload path/);
  assert.match(bound.schemaGuidance, /For a recurring observation, explain why the prior strategy was insufficient/);
  assert(bound.schemaGuidance.includes(JSON.stringify([{ fingerprint, recurrenceCount: 2,
    priorStrategy: document.entries[0].priorStrategy }])));
  assert.match(bound.schemaGuidance, /^Preserve the immutable review delta\./);
  assert.equal(initial.schemaGuidance, "Preserve the immutable review delta.");
  assert.equal(bound.bindRequest("spec-repair", inputs), bound);
});
