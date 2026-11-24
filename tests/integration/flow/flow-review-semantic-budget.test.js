import assert from "node:assert/strict";
import { test } from "node:test";
import { AcceptancePhaseScenario } from "../../support/acceptance-phase-scenario.js";
import { implementationFinding } from "../../support/impl-phase-scenario.js";
import { CanonicalCommandAttemptArtifactHistory } from "../../../src/flow/lib/canonical-command-result.js";
import { FlowFindingsArtifact } from "../../../src/flow/lib/flow-findings.js";
import { canonicalSourceFindings } from "../../../src/flow/lib/flow-finding-source.js";

test("four real rejected Flow Reviews consume their own budget and retain every finding for Gate and Acceptance", async (t) => {
  const findings = [implementationFinding(), {
    ...implementationFinding({ key: "second-required-branch" }),
    title: "Another mandatory branch is missing",
    issue: "A second independent required behavior branch is missing.",
  }];
  const flow = AcceptancePhaseScenario.create(t, {
    implReviewResponse: (stage) => ({
      blockingFindings: stage === "impl-review" ? findings : [],
      nonBlockingImprovements: [],
    }),
  });
  await flow.advanceTo("impl-review");
  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    const priorCalls = flow.phaseReviews.filter((entry) => entry.stage === "impl-review").length;
    do {
      await flow.executeCurrent();
      flow.reload();
    } while (flow.phaseReviews.filter((entry) => entry.stage === "impl-review").length === priorCalls);
    const saved = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "impl-review", completed: true });
    assert.equal(saved.result.evidence.review.disposition.value, "REJECTED");
    assert.equal(saved.result.evidence.retry.used, ordinal - 1,
      "completed semantic publications consume the budget even when optional display metrics are absent");
    assert.equal(saved.result.evidence.retry.maximum, 4);
    assert.equal(flow.phaseReviews.filter((entry) => entry.stage === "impl-review").length, ordinal);
    assert.equal(flow.manager.loadReadOnly(flow.specId).metrics.filter((entry) =>
      entry.phase === "impl" && entry.counter === "reviewRetry").length, 0);
    if (ordinal < 4) {
      assert.equal(saved.result.kind, "impl-review-rejected");
      assert.equal(flow.current(), "impl-triage");
      await flow.advanceTo("impl-review");
    } else {
      assert.equal(saved.result.kind, "impl-review-deferred");
      assert.equal(saved.settlement.targetStepId, "impl-gate");
      assert.equal(flow.current(), "impl-gate");
    }
  }
  const source = flow.manager.readArtifact({ specId: flow.specId, logicalKey: "impl.review", consumerNodeId: "system" });
  const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: "impl.review", bytes: source.bytes });
  assert.equal(history.attempts.length, 4);
  assert.ok(history.attempts.every((entry) => entry.payload.verdict === "REJECTED"));
  const selected = canonicalSourceFindings({ artifact: history.current.payload,
    sourceStep: "impl-review", sourceArtifact: source.descriptor.relativePath });
  assert.equal(selected.length, 2);
  const retained = new FlowFindingsArtifact(JSON.parse(flow.manager.readArtifact({
    specId: flow.specId, logicalKey: "flow.findings", consumerNodeId: "system" }).bytes));
  for (const sourceFinding of selected) {
    const matching = retained.entries.filter((entry) => entry.sourceIdentity().equals(sourceFinding.identity));
    assert.equal(matching.length, 1);
    assert.equal(matching[0].retryExhausted, true);
    assert.equal(matching[0].attempts, 4);
    assert.equal(matching[0].round, 4);
  }
  await flow.advanceTo("final-regression");
  assert.equal(flow.phaseReviews.filter((entry) => entry.stage === "impl-review").length, 4,
    "the exhausted Review must not launch a fifth provider");
  assert.deepEqual(flow.manager.readArtifact({ specId: flow.specId,
    logicalKey: "impl.review", consumerNodeId: "system" }).bytes, source.bytes);
  const acceptance = flow.acceptanceContexts.find((entry) => entry.evidence.reviewEvidence?.disposition === "REJECTED");
  assert.ok(acceptance, "Acceptance must see the real rejected Review");
  for (const { identity } of selected) {
    assert.ok(acceptance.evidence.deferredFindingEvidence.some((entry) =>
      entry.sourceRef === identity.sourceArtifact + "#" + identity.sourceFindingId
      && entry.sourceFinding.fingerprint === identity.fingerprint));
  }
  assert.equal(flow.manager.readCurrentStepSettlement({ specId: flow.specId,
    stepId: "acceptance-review", completed: true }).result.kind, "acceptance-review-passed");
});
