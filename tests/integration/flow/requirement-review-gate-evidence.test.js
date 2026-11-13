import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CanonicalReviewPromotion } from "../../../src/flow/lib/canonical-review-artifacts.js";
import { ReviewWorkUnit, REVIEW_WORK_UNIT_MANIFEST_ENV } from "../../../src/flow/lib/review-work-unit.js";
import { ReviewWorkUnitOutput } from "../../../src/flow/lib/review-work-unit-values.js";
import { RequirementTestGateObservation, RequirementTestGateFinding, RequirementTestReviewGateEvidence,
  RequirementTestReviewSource } from "../../../src/flow/lib/requirement-test-artifacts.js";
import { attachedCanonicalCommandResultArtifact, attachedCanonicalCommandResultPublications } from "../../../src/flow/lib/canonical-command-result.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

for (const mode of ["new-gate-finding", "existing-gate-finding", "no-gate-finding"]) {
  test(`sealed Requirement Review promotion preserves its exact Gate evidence: ${mode}`, t => {
    const root = createTmpDir("requirement-review-gate-evidence-");
    t.after(() => removeTmpDir(root));
    const sourceIdentity = { runId: "review-run", requirementId: "R1",
      specRevision: { specId: "001-review-work-unit", revision: 1, digest: "c".repeat(64), byteLength: 1 },
      bundleRevision: 1, candidateDigest: "e".repeat(64),
      sourceAttempt: { id: "test-generate-attempt", sequence: 1 }, candidatePaths: ["tests/a.test.js"] };
    const observation = new RequirementTestGateObservation({ ...sourceIdentity,
      kind: "assertion_passed", testName: "R1: required behavior" });
    const finding = RequirementTestGateFinding.fromObservation(observation);
    const gateEvidence = mode === "no-gate-finding" ? null : new RequirementTestReviewGateEvidence({ attempt: 1, observation, finding });
    const source = new RequirementTestReviewSource({ ...sourceIdentity, gateEvidence });
    const work = new ReviewWorkUnit({ executionRoot: root, runId: "review-run", specId: "001-review-work-unit",
      phase: "test", nodeId: "test-review", attemptId: "review-attempt",
      target: { treeSha: "a".repeat(40), targetStateDigest: "b".repeat(64) },
      output: new ReviewWorkUnitOutput({ logicalKey: "test.requirement.review", basename: "requirement-test-review.json", mediaType: "application/json" }) });
    const surface = work.finalize();
    const worker = { generatedAt: "2026-11-06T00:00:00.000Z", verdict: mode === "existing-gate-finding" ? "REJECTED" : "PASS",
      blockingFindings: mode === "existing-gate-finding" ? [{ findingId: finding.findingId, fingerprint: finding.fingerprint,
        requirementId: "R1", title: "Retained Gate mismatch", target: "GLOBAL", issue: finding.reason,
        requiredChange: finding.reason, origin: "requirement-test-gate" }] : [], advisoryFindings: [] };
    const bytes = Buffer.from(JSON.stringify(worker) + "\n");
    fs.writeFileSync(surface.outputPath, bytes);
    const sealed = ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath });
    sealed.seal();
    const before = source.toJSON();
    const promotion = new CanonicalReviewPromotion({ workUnit: sealed, phase: "test", requirementTestReviewSource: source,
      treeSha: "a".repeat(40), targetStateDigest: "b".repeat(64) });
    const result = promotion.promote(promotion.resultFromSealedArtifact());
    const artifact = attachedCanonicalCommandResultArtifact(result).payload;
    const publications = attachedCanonicalCommandResultPublications(result);
    const evidence = publications.find(value => value.logicalKey === "review.evidence").payload;
    assert.equal(artifact.requirementId, "R1");
    assert.equal(artifact.candidateDigest, source.candidateDigest);
    assert.deepEqual(artifact.sourceAttempt, source.sourceAttempt.toJSON());
    assert.equal(artifact.verdict, gateEvidence === null ? "PASS" : "REJECTED");
    assert.equal(result.artifacts.canonicalVerdict, artifact.verdict);
    assert.deepEqual(evidence.blockingFindings.map(value => value.fingerprint), gateEvidence === null ? [] : [finding.fingerprint]);
    assert.deepEqual(artifact.blockingFindings.map(value => value.fingerprint), gateEvidence === null ? [] : [finding.fingerprint]);
    assert.deepEqual(artifact.canonicalEvidence.blockingFindings, evidence.blockingFindings);
    assert.deepEqual(sealed.readSealedOutput().bytes, bytes, "promotion cannot rewrite the immutable worker output");
    assert.deepEqual(source.toJSON(), before, "promotion cannot rewrite the bound Gate observation");
  });
}
