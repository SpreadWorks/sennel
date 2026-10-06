import fs from "node:fs";

import {
  CanonicalReviewPromotion,
  CanonicalReviewWorkUnit,
} from "../../src/flow/lib/canonical-review-artifacts.js";
import {
  REVIEW_WORK_UNIT_MANIFEST_ENV,
  ReviewWorkUnit,
} from "../../src/flow/lib/review-work-unit.js";

const TREE_SHA = "a".repeat(40);
const TARGET_STATE_DIGEST = "b".repeat(64);

/** Build a Review result from the same sealed canonical work-unit contract as the command. */
export function requirementTestReviewResult({
  flowManager,
  specId,
  executionRoot,
  verdict = "PASS",
  tooling = false,
  permissionRelated = false,
  findings = null,
} = {}) {
  const state = flowManager.canonicalState(specId);
  const workUnit = new CanonicalReviewWorkUnit({
    flowManager,
    state,
    phase: "test",
    executionRoot,
    treeSha: TREE_SHA,
    targetStateDigest: TARGET_STATE_DIGEST,
  });
  const manifest = workUnit.declareCanonicalInputs();
  const prepared = workUnit.prepare();
  workUnit.materializeSpecRecord();
  workUnit.materializeTestSources(prepared.directory);
  const surface = workUnit.finalize();

  const finding = {
    findingId: "requirement-test-review-finding",
    fingerprint: "e".repeat(64),
    requirementId: workUnit.requirementTestReviewSource.requirementId,
    category: tooling ? "tooling_failure" : "semantic_rejection",
    reason: tooling ? "review provider unavailable" : "assertion does not prove the Requirement",
    improvement: "Retain the current proof with an actionable improvement.",
    whyNonBlocking: "The observation does not prevent bounded continuation.",
  };
  const artifact = tooling
    ? {
      toolingOutcome: {
        kind: "TOOLING_ERROR",
        stage: "provider",
        attempt: 1,
        maxAttempts: 3,
        remainingAttempts: 2,
        reason: finding.reason,
        permissionRelated,
      },
    }
    : {
      verdict,
      blockingFindings: verdict === "REJECTED" ? (findings ?? [finding]) : [],
      advisoryFindings: verdict === "ADVISORY" ? [finding] : [],
    };
  fs.writeFileSync(surface.outputPath, `${JSON.stringify(artifact)}\n`, "utf8");
  const sealed = ReviewWorkUnit.fromEnvironment({
    [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath,
  }, {
    expectedManifest: manifest,
    expectedDirectory: surface.directory,
  });
  sealed.seal();
  const promotion = new CanonicalReviewPromotion({
    workUnit: sealed,
    phase: "test",
    treeSha: TREE_SHA,
    targetStateDigest: TARGET_STATE_DIGEST,
    requirementTestReviewSource: workUnit.requirementTestReviewSource,
  });
  const result = promotion.resultFromSealedArtifact();
  promotion.promote(result);
  return result;
}
