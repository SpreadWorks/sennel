import assert from "node:assert/strict";
import { test } from "node:test";
import { AcceptanceEvidenceExecutionPlan, buildAcceptancePrompt, buildDeferredDispositionRepairPrompt } from "../../src/flow/lib/run-acceptance-review.js";
import { executionValueDigest } from "../../src/flow/lib/flow-execution-contract.js";
import { stableArtifactViewJson } from "../../src/flow/lib/artifact-view-fingerprint.js";
import { PromptRequestLimit } from "../../src/lib/prompt-batching.js";

test("Acceptance map requests retain their full identity after canonical JSON readback", () => {
  const evidence = { originalRequest: "Confirm the required behavior.",
    requirements: [{ id: "R1", desc: "Preserve the branch.", metadata: { status: "verified", source: "canonical" } }],
    diff: "The complete source preserves the required branch.\n".repeat(1_000) };
  const restored = JSON.parse(stableArtifactViewJson(evidence));
  assert.equal(stableArtifactViewJson(evidence), stableArtifactViewJson(restored));
  const limit = new PromptRequestLimit({ maxCharacters: 16_000 });
  const first = new AcceptanceEvidenceExecutionPlan({ evidence }, { limit }).observationPlan;
  const resumed = new AcceptanceEvidenceExecutionPlan({ evidence: restored }, { limit }).observationPlan;
  assert.ok(first.batches.length > 1);
  assert.equal(resumed.digest, first.digest);
  assert.deepEqual(resumed.batches.map((batch) => batch.request), first.batches.map((batch) => batch.request));
});

test("Acceptance map identity still distinguishes changed canonical evidence bytes", () => {
  const limit = new PromptRequestLimit({ maxCharacters: 16_000 });
  const first = new AcceptanceEvidenceExecutionPlan({ evidence: { diff: "Required branch is present." } }, { limit }).observationPlan;
  const changed = new AcceptanceEvidenceExecutionPlan({ evidence: { diff: "Required branch is missing." } }, { limit }).observationPlan;
  assert.notEqual(changed.digest, first.digest);
});

test("Acceptance direct and deferred repair requests retain identity after canonical JSON readback", () => {
  const evidence = { originalRequest: "Confirm the required behavior.",
    requirements: [{ id: "R2", desc: "Preserve the second branch." }, { id: "R1", desc: "Preserve the first branch." }],
    diff: "Required branches are present.", repairEvidence: { ref: "acceptance:no-repair", kind: "no-repair" },
    upgradeEvidence: { valid: true, required: false }, testEvidence: [],
    deferredFindingEvidence: [{ findingId: "F1", sourceRef: "flow:F1" }] };
  const context = { evidence };
  const restored = { evidence: JSON.parse(stableArtifactViewJson(evidence)) };
  const missing = [{ findingId: "F1", finalDisposition: "still_open" }];
  const requests = (input) => ({ direct: executionValueDigest(buildAcceptancePrompt(input)),
    deferred: executionValueDigest(buildDeferredDispositionRepairPrompt(input, missing)) });
  assert.deepEqual(requests(restored), requests(context));
  assert.deepEqual(restored.evidence.requirements.map((entry) => entry.id), ["R2", "R1"]);
});
