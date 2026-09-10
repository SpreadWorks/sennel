import assert from "node:assert/strict";
import { test } from "node:test";
import RunAcceptanceReviewCommand, {
  AcceptanceEvidenceExecutionPlan,
  AcceptanceReviewResponseSource,
} from "../../../src/flow/lib/run-acceptance-review.js";
import { PromptExecutionLimit, PromptLogicalFootprint, PromptRequestLimit } from "../../../src/lib/prompt-batching.js";
import {
  AcceptanceRepairFindingSet,
  deriveAcceptanceReviewVerdict,
  validateAcceptanceReviewArtifact,
} from "../../../src/flow/lib/acceptance-review-artifacts.js";
import { CanonicalAcceptanceArtifactStore } from "../../../src/flow/lib/canonical-acceptance-artifacts.js";

class TestFixtureResponseSource extends AcceptanceReviewResponseSource {
  constructor(response) {
    super();
    this.response = response;
  }

  load(context) {
    assert.equal(context.marker, "test-context");
    return this.response;
  }
}

test("production acceptance response source does not read fixture environment variables", () => {
  const previous = process.env.SENNEL_ACCEPTANCE_REVIEW_ARTIFACT;
  process.env.SENNEL_ACCEPTANCE_REVIEW_ARTIFACT = "/tmp/untrusted-acceptance-fixture.json";
  try {
    assert.equal(new AcceptanceReviewResponseSource().load({ marker: "test-context" }), null);
  } finally {
    if (previous === undefined) delete process.env.SENNEL_ACCEPTANCE_REVIEW_ARTIFACT;
    else process.env.SENNEL_ACCEPTANCE_REVIEW_ARTIFACT = previous;
  }
});

test("fixture response requires an explicit injected test source", () => {
  const fixture = { requirementJudgments: [], deferredFindingDispositions: [] };
  const command = new RunAcceptanceReviewCommand({
    responseSource: new TestFixtureResponseSource(fixture),
  });
  assert.equal(command.responseSource.load({ marker: "test-context" }), fixture);
  assert.throws(() => new RunAcceptanceReviewCommand({ responseSource: {} }), /AcceptanceReviewResponseSource/);
});

test("acceptance has no Task Review handoff when no Task review artifact is a fourth repaired rejection", () => {
  const store = new CanonicalAcceptanceArtifactStore({
    state: { schemaRevision: 3, specId: "001", runId: "run", flowId: "flow", flowVersionId: "v1", request: "x" },
    flowManager: {
      readArtifact() { throw new Error("no task review should be read"); },
      readCatalogArtifact() {},
      artifactCatalog() { return { artifacts: [] }; },
      activityLedger() { return []; },
      specLocation() { return { specRoot: "specs", specId: "001", relativeDirectory: "specs/001" }; },
    },
  });
  assert.deepEqual(store.taskReviewHandoffs(), []);
});

test("rejects a retired root-artifact acceptance fixture", async () => {
  await assert.rejects(
    () => new RunAcceptanceReviewCommand().execute({
      flowManager: { load: () => ({ schemaRevision: 2 }) },
    }),
    /Version-1 Flow/,
  );
});

test("requires stable hard-blocker identities and binds all repair findings", () => {
  const hardBlockers = ["DF-1", "DF-2"].map((findingId) => ({ findingId }));
  const artifact = {
    version: 2,
    repairFingerprint: "a".repeat(64),
    mechanicalBlockers: [],
    hardBlockers,
    requirementJudgments: [{
      requirementId: "R-1",
      status: "notMet",
      requestRefs: ["flow.request"],
      requirementRefs: ["spec.json#R-1"],
      diffRefs: ["diff:product.js"],
      repairRefs: ["acceptance:no-repair"],
      testRefs: ["test-execute-result.json#R-1"],
      missingEvidence: [],
    }],
    deferredFindings: [],
    userDecision: null,
    verdict: "repair_required",
  };
  assert.equal(deriveAcceptanceReviewVerdict(artifact), "repair_required");
  validateAcceptanceReviewArtifact(artifact, { requirementIds: ["R-1"] });
  assert.deepEqual(new AcceptanceRepairFindingSet(artifact).toJSON(), [
    "requirement:R-1",
    "hard-blocker:DF-1",
    "hard-blocker:DF-2",
  ]);

  assert.throws(() => validateAcceptanceReviewArtifact({
    ...artifact,
    hardBlockers: [{ findingId: "DF-1" }, {}],
  }, { requirementIds: ["R-1"] }), /hardBlockers\[1\].findingId|schema validation/);
  assert.equal(deriveAcceptanceReviewVerdict({ ...artifact, requirementJudgments: [{
    ...artifact.requirementJudgments[0], status: "met",
  }] }), "user_decision_required");
});

test("oversized acceptance evidence is fully mapped before one bounded final judgment", async () => {
  const configuredLimit = new PromptRequestLimit({ maxCharacters: 20_000 });
  const context = {
    requirementIds: ["R-1", "R-2"],
    deferredFindings: [{
      findingId: "DF-1",
      sourceArtifact: "impl.review",
      sourceFindingId: "source-1",
      finalDisposition: "still_open",
    }],
    evidence: {
      originalRequest: "Implement R-1.",
      requirements: [
        { id: "R-1", desc: `R1_DESCRIPTION_HEAD ${"a".repeat(12_000)} R1_DESCRIPTION_TAIL` },
        { id: "R-2", desc: `R2_DESCRIPTION_HEAD ${"b".repeat(12_000)} R2_DESCRIPTION_TAIL` },
      ],
      diff: `diff --git a/source.js b/source.js\n${"x".repeat(133_813)}`,
      repairEvidence: { kind: "no-repair", ref: "acceptance:no-repair", artifact: { reason: "none" } },
      upgradeEvidence: { required: false, requiredPaths: [], valid: true, ref: null, artifact: null, invalidReason: null },
      testEvidence: {},
      reviewEvidence: null,
      taskReviewHandoffs: [],
      deferredFindings: [{ findingId: "DF-1", finalDisposition: "still_open" }],
      deferredFindingEvidence: [{ findingId: "DF-1", sourceRef: "impl.review#source-1", sourceFinding: { issue: "check" } }],
    },
  };
  const calls = [];
  const agent = {
    async call(prompt, options) {
      calls.push({ prompt, options });
      if (options.jsonSchema?.properties?.observations) {
        const ids = options.jsonSchema.properties.observations.items.properties.sourceRef.enum;
        const ranges = prompt.split("## Canonical evidence ranges\n")[1]
          .split("\n").filter(Boolean).map((line) => JSON.parse(line));
        return JSON.stringify({ observations: ids.map((sourceRef, index) => ({
          sourceRef,
          facts: ["R1_DESCRIPTION_HEAD", "R1_DESCRIPTION_TAIL", "R2_DESCRIPTION_HEAD", "R2_DESCRIPTION_TAIL"]
            .filter((marker) => ranges[index].content.includes(marker)),
        })) });
      }
      if (options.jsonSchema?.properties?.sourceRefs) {
        const retainedMarkers = ["R1_DESCRIPTION_HEAD", "R1_DESCRIPTION_TAIL", "R2_DESCRIPTION_HEAD", "R2_DESCRIPTION_TAIL"]
          .filter((marker) => prompt.includes(marker));
        return JSON.stringify({
          sourceRefs: options.jsonSchema.properties.sourceRefs.items.enum,
          summary: `Retained facts: ${retainedMarkers.join(", ") || "none"}`,
        });
      }
      const requirementScope = options.jsonSchema.properties.requirementJudgments.maxItems === 1;
      if (requirementScope) {
        for (const marker of ["R1_DESCRIPTION_HEAD", "R1_DESCRIPTION_TAIL", "R2_DESCRIPTION_HEAD", "R2_DESCRIPTION_TAIL"]) {
          assert.match(prompt, new RegExp(marker));
        }
      }
      const requirementId = requirementScope
        ? options.jsonSchema.properties.requirementJudgments.items.properties.requirementId.enum[0]
        : null;
      return JSON.stringify({
        requirementJudgments: requirementScope ? [{
          requirementId,
          status: "met",
          requestRefs: ["flow.request"],
          requirementRefs: [`spec.json#${requirementId}`],
          diffRefs: ["diff:source.js"],
          repairRefs: ["acceptance:no-repair"],
          testRefs: [`test-execute-result.json#${requirementId}`, "test-result-review.json"],
          missingEvidence: [],
        }] : [],
        deferredFindingDispositions: requirementScope ? [] : [{
          findingId: "DF-1",
          finalDisposition: "fixed",
          evidenceRefs: ["impl.review#source-1"],
        }],
      });
    },
  };

  const response = await new AcceptanceEvidenceExecutionPlan(context, { limit: configuredLimit }).execute(agent);

  assert.ok(calls.filter((call) => call.options.jsonSchema?.properties?.observations).length >= 2);
  assert.equal(response.requirementJudgments[0].requirementId, "R-1");
  assert.equal(response.requirementJudgments[1].requirementId, "R-2");
  assert.equal(response.deferredFindingDispositions[0].findingId, "DF-1");
  assert.ok(calls.every((call) => PromptLogicalFootprint.measure({
    systemPrompt: call.options.systemPrompt,
    userPrompt: call.prompt,
    jsonSchema: call.options.jsonSchema,
    fmtFallback: call.options.fmtFallback,
  }).fits(configuredLimit)));

  let impossibleCalls = 0;
  const impossible = new AcceptanceEvidenceExecutionPlan(context, {
    limit: configuredLimit,
    executionLimit: new PromptExecutionLimit({ maxSynthesisCallCount: 1 }),
  });
  await assert.rejects(
    impossible.execute({ call: async () => { impossibleCalls += 1; return "unreachable"; } }),
    (error) => error.code === "PROMPT_CALL_LIMIT_EXCEEDED",
  );
  assert.equal(impossibleCalls, 0);
});
