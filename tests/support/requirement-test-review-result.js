import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import RunReviewCommand from "../../src/flow/lib/run-review.js";
import { ReviewWorkUnit } from "../../src/flow/lib/review-work-unit.js";
import { installReviewProcessFake } from "./infrastructure/review-process-fake.js";

/** Produce the saved candidate's Review through its normal checkpoint, claim and seal. */
export async function requirementTestReviewResult({
  flowManager, specId, executionRoot, verdict = "PASS",
  tooling = false, permissionRelated = false, findings = null,
} = {}) {
  let calls = 0;
  const provider = installReviewProcessFake((_command, _args, options) => {
    calls += 1;
    const work = ReviewWorkUnit.fromEnvironment(options.env);
    const revision = JSON.parse(options.env.SENNEL_REVIEW_TEST_ARTIFACT_REVISION);
    const finding = {
      findingId: "requirement-test-review-finding", fingerprint: "e".repeat(64),
      requirementId: revision.requirementId,
      category: tooling ? "tooling_failure" : "semantic_rejection",
      reason: tooling ? "review provider unavailable" : "assertion does not prove the Requirement",
      improvement: "Retain the current proof with an actionable improvement.",
      whyNonBlocking: "The observation does not prevent bounded continuation.",
    };
    const artifact = tooling ? {
      toolingOutcome: {
        kind: "TOOLING_ERROR", stage: "provider", attempt: 1,
        maxAttempts: 3, remainingAttempts: 2, reason: finding.reason, permissionRelated,
      },
    } : {
      verdict, blockingFindings: verdict === "REJECTED" ? (findings ?? [finding]) : [],
      advisoryFindings: verdict === "ADVISORY" ? [finding] : [],
    };
    fs.writeFileSync(path.join(work.root, work.manifestDocument.output.basename),
      JSON.stringify(artifact) + "\n");
    work.seal();
    return { ok: true, status: 0, signal: null, killed: false, stdout: "", stderr: "" };
  });
  try {
    const result = await new RunReviewCommand().execute({
      root: executionRoot, executionRoot, mainRoot: flowManager.specLocation(specId).repositoryRoot,
      flowManager, specId, flowState: flowManager.loadReadOnly(specId), phase: "test", config: {},
    });
    assert.equal(calls, 1, "the actual Review parent must invoke its claimed external worker once");
    return result;
  } finally { provider.mock.restore(); }
}
