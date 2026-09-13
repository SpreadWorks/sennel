import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { CanonicalMetricsFlowIndex } from "../../../src/metrics/lib/canonical-flow-metrics.js";
import {
  aggregateReviewMetrics,
  loadReviewMetricsArtifacts,
} from "../../../src/metrics/commands/review.js";
import {
  CanonicalCommandResultPublication,
  attachCanonicalCommandResultPublications,
} from "../../../src/flow/lib/canonical-command-result.js";
import { SpecReviewDelta, mergeSpecReviewDelta } from "../../../src/flow/lib/spec-review-artifacts.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const roots = [];

function root() {
  const value = createTmpDir("canonical-flow-metrics-");
  roots.push(value);
  return value;
}

function finalizeFixture(fixture, flowManager) {
  const leafIds = fixture.leaves().map((step) => step.id);
  for (const nodeId of leafIds) fixture.settle(nodeId);
  flowManager.finalizeFlow(fixture.specId);
}

afterEach(() => {
  while (roots.length > 0) removeTmpDir(roots.pop());
});

describe("CanonicalMetricsFlowIndex", () => {
  it("reads finalized V1 Flow observations and catalog inputs without a root-layout fallback", async () => {
    const repository = root();
    const flowManager = makeFlowManager(repository);
    const fixture = new CanonicalFlowFixture({
      flowManager,
      specId: "001-canonical-metrics",
      runId: "canonical-metrics-run",
      request: "Record canonical metrics.",
      execution: { mode: "direct" },
      specRecord: {
        goal: "Read metrics from the V1 catalog.",
        requirements: [],
      },
    }).create();
    flowManager.incrementMetric("draft", "question", { specId: fixture.specId });
    flowManager.accumulateAgentMetrics("draft", {
      specId: fixture.specId,
      provider: "test-provider",
      profileKey: "test-profile",
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        cache_read_tokens: 3,
        cache_creation_tokens: 2,
        cost_usd: 0.01,
      },
    });
    finalizeFixture(fixture, flowManager);

    const index = await CanonicalMetricsFlowIndex.read({
      flowManager,
      specRoot: path.join(repository, "specs"),
    });
    assert.equal(index.flows.length, 1);
    const [flow] = index.flows;
    assert.equal(flow.specId, fixture.specId);
    assert.equal(flow.specRecord().goal, "Read metrics from the V1 catalog.");
    assert.equal(flow.countMetric({ phase: "draft", counter: "question" }), 1);
    assert.equal(flow.metricEntries().find((entry) => entry.kind === "agent").tokens.input, 11);
    assert.match(flow.finalizedAt(), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(flow.artifacts.some((artifact) => artifact.relativePath === "spec.json"), true);
    assert.equal(flow.location.relativeSpecFile, `specs/${fixture.specId}/001/spec.json`);
    assert.equal(flow.revisionInput().relativePath, `specs/${fixture.specId}/001/metrics-input.json`);
  });

  it("projects cataloged review attempts, issue facts, and retry Activities without a legacy review path", async () => {
    const repository = root();
    const flowManager = makeFlowManager(repository);
    const fixture = new CanonicalFlowFixture({
      flowManager,
      specId: "002-canonical-review-metrics",
      runId: "canonical-review-metrics-run",
      request: "Aggregate the canonical review facts.",
      execution: { mode: "direct" },
      specRecord: {
        goal: "Read review metrics from the catalog.",
        requirements: [{ id: "R-2", desc: "Use cataloged review history." }],
      },
    }).create();

    fixture.activate("spec-review");
    flowManager.appendIssueLog({
      specId: fixture.specId,
      idempotencyKey: "review-metrics-issue",
      entry: {
        phase: "spec",
        guardrailId: "R-2",
        normalizedFindingId: "spec-finding-1",
        repairRef: { files: ["src/example.js"] },
      },
    });
    for (let count = 0; count < 5; count += 1) {
      flowManager.incrementMetric("spec", "reviewRetry", { specId: fixture.specId });
    }
    const currentReview = flowManager.readCurrentSpecReviewInput({
      specId: fixture.specId,
      consumerNodeId: "spec-review",
    });
    const delta = new SpecReviewDelta({
      version: 2,
      stage: "spec-review",
      identity: currentReview.review.identity.toJSON(),
      baseReviewDigest: currentReview.review.digest,
      findings: [{
        findingId: "spec-finding-1",
        kind: "blocking",
        title: "Cataloged finding",
        target: "R-2",
        body: "The review result is owned by its producer.",
        issue: "Cataloged review evidence must remain revision scoped.",
        requiredChange: "Preserve the canonical finding.",
        whyBlocking: "The metric projection depends on durable producer evidence.",
      }],
      operations: [],
    });
    const nextReview = mergeSpecReviewDelta({ review: currentReview.review, delta });
    const result = attachCanonicalCommandResultPublications({ result: "reviewed" }, [
      new CanonicalCommandResultPublication({
        logicalKey: "spec.review",
        parameters: { revision: String(currentReview.revision).padStart(3, "0") },
        mediaType: "application/json",
        payload: nextReview.toJSON(),
      }),
    ]);
    flowManager.updateStepStatus(
      { stepId: "spec-review", requestedStatus: "done" },
      { specId: fixture.specId, canonicalCommandResult: result },
    );

    // This retired sibling has no catalog descriptor and must not join the
    // review projection.
    const retiredPath = path.join(repository, "specs", fixture.specId, "spec-review.json");
    fs.mkdirSync(path.dirname(retiredPath), { recursive: true });
    fs.writeFileSync(retiredPath, JSON.stringify({
      verdict: "REJECTED",
      blockingFindings: [{ title: "Retired path must be ignored." }],
    }));

    const loaded = await loadReviewMetricsArtifacts(repository, "specs", { flowManager });
    const report = aggregateReviewMetrics(loaded);

    assert.equal(loaded.specs.length, 1);
    assert.deepEqual(loaded.findings.map((finding) => finding.toJSON()), [{
      id: "spec-finding-1",
      spec: fixture.specId,
      phase: "spec",
      sourceArtifact: "spec.review",
      attempt: 1,
      severity: "blocking",
      title: "Cataloged finding",
      body: "The review result is owned by its producer.",
      category: "unknown",
    }]);
    assert.deepEqual(report.guardrails, [{ guardrailId: "R-2", count: 1 }]);
    assert.deepEqual(report.repairMetrics.attemptLimitSpecs, [{
      spec: fixture.specId,
      phase: "spec",
      source: "activities.jsonl",
      count: 5,
    }]);
    assert.equal(report.missingData.count, 0);
  });
});
