import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";
import { QueryDraftReviewScenario } from "../../support/infrastructure/query-draft-review-scenario.js";
import { FLOW_ARTIFACT_CONTRACTS, FlowArtifactSpecReviewActivityEvidenceDocument } from "../../../src/lib/flow-artifact-contract.js";
import { CanonicalFlowActivityEvidenceWrite, FlowActivity } from "../../../src/flow/lib/current-flow-state.js";
import { SpecReviewOperations } from "../../../src/flow/lib/spec-review-operations.js";

function retained(scenario, stage) {
  const activity = scenario.manager.activityLedger(scenario.specId).findLast((entry) => entry.reviewPublication?.stage === stage);
  assert.ok(activity);
  const descriptors = scenario.manager.artifactCatalog(scenario.specId).artifacts
    .filter((entry) => entry.logicalKey === "activity.evidence" && entry.activityId === activity.id);
  assert.equal(descriptors.length, 1, "one immutable record belongs to the actual publication Activity");
  const descriptor = descriptors[0];
  const bytes = fs.readFileSync(scenario.manager.specLocation(scenario.specId).resolve(descriptor.relativePath));
  descriptor.verifyBytes(bytes);
  const document = FLOW_ARTIFACT_CONTRACTS.require("activity.evidence").contentContract.parse(bytes);
  assert.ok(document instanceof FlowArtifactSpecReviewActivityEvidenceDocument);
  document.assertActivity(new FlowActivity(activity));
  assert.equal(document.source.hash, activity.reviewPublication.reviewDigest);
  assert.equal(document.source.path, `revisions/${document.review.identity.revision.toString()}/review.json`);
  assert.equal(document.source.pointer, "");
  const recordedAt = activity.timing?.finishedAt ?? activity.result?.confirmedAt;
  if (recordedAt != null) assert.equal(document.observedAt, recordedAt);
  else assert.equal(new Date(document.observedAt).toISOString(), document.observedAt,
    "the writer retained a real publication timestamp without rewriting the Activity timing");
  assert.equal(descriptor.relativePath.endsWith(`${crypto.createHash("sha256").update(bytes).digest("hex")}.json`), true);
  return { activity, descriptor, bytes, document };
}

test("normal Spec publications retain their exact records across Triage, Repair rebasing, failed publication recovery and terminal replay", async (t) => {
  const scenario = new QueryDraftReviewScenario(t, "820-query-spec-storage");
  await scenario.draft();
  await scenario.review("draft-questions");
  await scenario.refine();
  await scenario.review("draft-coverage");
  await scenario.gate();
  await scenario.spec();
  const finding = { kind: "blocking", findingId: "F-storage", title: "Clarify the goal", target: "goal",
    body: "The goal needs a measurable result.", issue: "The exact result is absent.",
    requiredChange: "Record the exact result.", whyBlocking: "The result must be observable." };
  await scenario.specReview([finding]);
  const reviewed = retained(scenario, "spec-review");
  assert.deepEqual(reviewed.document.review.findings.findings, [finding]);
  const beforeReplay = scenario.protectedState();
  const replay = await SpecReviewOperations.terminalReplay({ flowManager: scenario.manager,
    state: scenario.manager.canonicalState(scenario.specId) });
  assert.equal(replay.artifacts.verdict, "REJECTED");
  assert.equal(replay.artifacts.reviewDigest, reviewed.document.review.digest);
  assert.deepEqual(scenario.protectedState(), beforeReplay);

  const target = { entity: "spec", field: "goal" };
  const updates = [{ findingId: finding.findingId, disposition: "apply", evidence: "The saved goal omits the result.",
    allowedTargets: [{ target, operationKinds: ["replace-field"] }] }];
  scenario.manager.beginNextAction(scenario.specId);
  const beforeFailure = scenario.protectedState();
  const write = CanonicalFlowActivityEvidenceWrite.prototype.write;
  let injected = false;
  const fault = t.mock.method(CanonicalFlowActivityEvidenceWrite.prototype, "write", function(location) {
    if (this.document instanceof FlowArtifactSpecReviewActivityEvidenceDocument && !injected) {
      injected = true;
      throw new Error("simulated archive publication failure");
    }
    return write.call(this, location);
  });
  try {
    await assert.rejects(() => scenario.specWorker("spec-triage", { findings: updates }),
      /simulated archive publication failure/);
  } finally { fault.mock.restore(); }
  assert.equal(injected, true, "the fault interrupts the actual derived artifact writer");
  scenario.reload();
  assert.deepEqual(scenario.protectedState(), beforeFailure, "Store rollback restores the complete confirmed publication boundary");
  assert.deepEqual(fs.readFileSync(scenario.manager.specLocation(scenario.specId).resolve(reviewed.descriptor.relativePath)), reviewed.bytes);
  assert.equal((await scenario.specWorker("spec-triage", { findings: updates })).kind, "spec-triage-completed");
  const triaged = retained(scenario, "spec-triage");
  assert.equal(triaged.document.review.generation, reviewed.document.review.generation + 1);
  assert.equal(triaged.document.review.findings.byId(finding.findingId).disposition, "apply");

  const spec = scenario.manager.readArtifact({ specId: scenario.specId, logicalKey: "spec.record", consumerNodeId: "spec-repair" });
  const goal = JSON.parse(spec.bytes).goal;
  const operations = [{ kind: "replace-field", target, findingIds: [finding.findingId],
    expectedDigest: crypto.createHash("sha256").update(JSON.stringify(goal)).digest("hex"),
    replacement: "Publish the exact immutable Review result for each confirmed Activity.", reason: "Make the result observable." }];
  assert.equal((await scenario.specWorker("spec-repair", { operations })).kind, "spec-repair-changed");
  const repaired = retained(scenario, "spec-repair");
  assert.ok(repaired.document.review.identity.revision.value > triaged.document.review.identity.revision.value);
  assert.equal(repaired.document.review.generation, triaged.document.review.generation + 1);
  assert.deepEqual(repaired.document.review.audit.at(-1).appliedFindings, [finding.findingId]);
  assert.equal(repaired.document.review.audit.at(-1).acceptedOperations.length, 1);
  assert.equal(repaired.document.source.hash, repaired.document.review.digest);
  const beforeReadback = scenario.protectedState();
  scenario.reload();
  for (const original of [reviewed, triaged, repaired]) {
    const read = retained(scenario, original.document.owner.nodeId);
    assert.deepEqual(read.bytes, original.bytes);
    assert.deepEqual(read.descriptor.toJSON(), original.descriptor.toJSON());
    assert.deepEqual(read.document.toJSON(), original.document.toJSON());
  }
  assert.equal(scenario.manager.artifactCatalog(scenario.specId).verify(scenario.manager.specLocation(scenario.specId))
    .artifacts.filter((entry) => entry.logicalKey === "activity.evidence").length, 3);
  assert.deepEqual(scenario.protectedState(), beforeReadback);
});
