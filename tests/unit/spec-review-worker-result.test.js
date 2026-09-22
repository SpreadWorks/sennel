import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validWorkerHandoffTaskSpec } from "../support/infrastructure/worker-artifact.js";
import { CanonicalSpecReview, SpecReviewDelta, mergeSpecReviewDelta } from "../../src/flow/lib/spec-review-artifacts.js";
import { SpecReviewWorkerFacts } from "../../src/flow/services/spec-worker-review-service.js";
import { specTriageSelection } from "../../src/flow/steps/spec/spec-triage.js";
import { specRepairSelection } from "../../src/flow/steps/spec/spec-repair.js";

const identity = { specId: "001-worker-result", revision: 1, digest: "a".repeat(64), byteLength: 1 };
const target = { entity: "requirement", id: "R1", field: "desc" };
const valueDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function reviewed() {
  return new CanonicalSpecReview({
    version: 2, identity, generation: 1,
    findings: [{
      kind: "blocking", findingId: "F-1", title: "Clarify R1", target: "R1",
      body: "The requirement is incomplete.", issue: "Missing behavior.",
      requiredChange: "State the behavior.", whyBlocking: "No observable basis.",
    }],
    audit: [],
  });
}

function facts(stepId, spec, review, findings = [], operations = []) {
  const delta = new SpecReviewDelta({
    version: 2, stage: stepId, identity,
    baseReviewDigest: review.digest, findings, operations,
  });
  return new SpecReviewWorkerFacts({
    stepId, spec, review, delta, reviewDigest: "b".repeat(64), reviewByteLength: 123,
  });
}

test("triage filters invalid permission and preserves the valid sibling in canonical Review", () => {
  const spec = validWorkerHandoffTaskSpec();
  const selection = specTriageSelection(facts("spec-triage", spec, reviewed(), [
    { findingId: "F-1", disposition: "apply", evidence: "Checked source.", allowedTargets: [
      { target, operationKinds: ["replace-entity-field"] },
    ] },
    { findingId: "F-unknown", disposition: "apply", evidence: "Checked source.", allowedTargets: [
      { target: { entity: "requirement", id: "absent", field: "desc" }, operationKinds: ["replace-entity-field"] },
    ] },
  ]));
  assert.equal(selection.result.kind, "spec-triage-completed");
  assert.equal(selection.review.findings.byId("F-1").disposition, "apply");
  assert.equal(selection.review.findings.byId("F-unknown"), null);
  assert.equal(selection.review.audit.at(-1).discardedOperations.length, 1);
});

test("repair selects changed or unchanged Result from canonical permissions and writes audit", () => {
  const spec = validWorkerHandoffTaskSpec();
  const review = mergeSpecReviewDelta({
    review: reviewed(),
    delta: facts("spec-triage", spec, reviewed(), [{
      findingId: "F-1", disposition: "apply", evidence: "Checked source.",
      allowedTargets: [{ target, operationKinds: ["replace-entity-field"] }],
    }]).delta,
  });
  const unchanged = specRepairSelection(facts("spec-repair", spec, review, [], [{
    findingIds: ["F-unknown"], kind: "replace-entity-field", target,
    expectedDigest: valueDigest(spec.requirements[0].desc), replacement: "Ignored.", reason: "Unpermitted.",
  }]));
  assert.equal(unchanged.result.kind, "spec-repair-unchanged");
  assert.equal(unchanged.specRecord, undefined);
  assert.equal(unchanged.review.audit.at(-1).discardedOperations[0].reason, "unauthorized operation");
  const changed = specRepairSelection(facts("spec-repair", spec, review, [], [{
    findingIds: ["F-1"], kind: "replace-entity-field", target,
    expectedDigest: valueDigest(spec.requirements[0].desc), replacement: "Corrected.", reason: "Permitted.",
  }]));
  assert.equal(changed.result.kind, "spec-repair-changed");
  assert.equal(changed.specRecord.document.requirements[0].desc, "Corrected.");
  assert.deepEqual(changed.review.audit.at(-1).appliedFindings, ["F-1"]);
});
