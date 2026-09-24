import { CURRENT_FLOW_SCHEMA_REVISION } from "../../src/lib/flow-schema-revision.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildDeferredSemanticFindingsPublication,
  CanonicalFlowFindingSourceArtifact,
  CanonicalFlowFindingsStore,
  FlowFindingSourceIdentity,
  canonicalSourceFindings,
} from "../../src/flow/lib/flow-findings.js";
import { FLOW_ARTIFACT_VIEW_REGISTRY } from "../../src/flow/lib/artifact-view-registry.js";

const SOURCE_PATH = "steps/draft/gate/result.json";
const FIRST_FINGERPRINT = "a".repeat(64);
const SECOND_FINGERPRINT = "b".repeat(64);

function sourcePayload() {
  return {
    observations: [
      {
        sourceFindingId: "shared-observation",
        fingerprint: FIRST_FINGERPRINT,
        severity: "blocking",
        issue: "The first observation.",
      },
      {
        sourceFindingId: "shared-observation",
        fingerprint: SECOND_FINGERPRINT,
        severity: "blocking",
        issue: "The second observation.",
      },
      {
        sourceFindingId: "distinct-observation",
        fingerprint: FIRST_FINGERPRINT,
        severity: "blocking",
        issue: "A distinct producer id reused the first fingerprint.",
      },
    ],
  };
}

function manager(flowFindings = null) {
  return {
    readArtifact({ logicalKey }) {
      if (logicalKey !== "flow.findings" || flowFindings === null) return null;
      const bytes = Buffer.from(`${JSON.stringify(flowFindings)}\n`, "utf8");
      return { bytes, descriptor: { hash: "c".repeat(64), size: bytes.length } };
    },
    readCatalogArtifact() { throw new Error("source payload is supplied by the producer fixture"); },
    readProducerArtifact() { return null; },
    publishArtifacts() {},
    activityLedger() { return []; },
  };
}

describe("canonical flow finding source identity", () => {
  it("keeps the active Task Gate producer read when its source is a catalog path", () => {
    const sourceArtifact = "steps/impl/T1/gate/result.json";
    const payload = { artifacts: { evaluations: [{
      guardrail_id: "TASK-SHARED", fingerprint: FIRST_FINGERPRINT, result: "fail",
    }] } };
    const flowManager = {
      readArtifact() { throw new Error("active producer must not use consumer access"); },
      readCatalogArtifact() { throw new Error("active producer must not use catalog consumer access"); },
      readProducerArtifact({ nodeId, logicalKey, parameters }) {
        assert.equal(nodeId, "T1-gate");
        assert.equal(logicalKey, "task.gate");
        assert.deepEqual(parameters, { taskId: "T1" });
        return {
          bytes: Buffer.from(JSON.stringify(payload)),
          relativePath: sourceArtifact,
          descriptor: { relativePath: sourceArtifact },
        };
      },
      publishArtifacts() {},
      activityLedger() { return []; },
    };
    const source = new CanonicalFlowFindingsStore({
      flowManager,
      flowState: { schemaRevision: CURRENT_FLOW_SCHEMA_REVISION, specId: "001", runId: "run-1", currentTaskId: "T1", currentNodeId: "T1-gate" },
      nodeId: "T1-gate",
    }).sourceArtifact(sourceArtifact);
    assert.equal(source.relativePath, sourceArtifact);
    assert.equal(source.resolveFinding(new FlowFindingSourceIdentity({
      sourceArtifact, sourceStep: "task-gate", sourceFindingId: "TASK-SHARED", fingerprint: FIRST_FINGERPRINT,
    })).guardrail_id, "TASK-SHARED");
  });

  it("resolves exact stored Spec Gate identities from every source facet without changing publication selection", () => {
    const sourceArtifact = "steps/spec-gate/result.json";
    const evaluation = {
      guardrail_id: "G-1", fingerprint: FIRST_FINGERPRINT,
      result: "fail", reason: "The prior Gate evaluation failed.",
    };
    const observation = {
      sourceFindingId: "R-1", fingerprint: SECOND_FINGERPRINT,
      severity: "blocking", observed: "The precise requirement is missing.",
    };
    const review = {
      sourceFindingId: "review-1", fingerprint: "c".repeat(64),
      issue: "The review found another blocking issue.",
    };
    const payload = {
      artifacts: {
        evaluations: [evaluation], blockingFindings: [review],
        nextAction: { diagnosis: { observations: [observation] } },
      },
    };
    const source = CanonicalFlowFindingSourceArtifact.fromBytes({
      logicalKey: "spec.gate", relativePath: sourceArtifact,
      bytes: Buffer.from(JSON.stringify(payload), "utf8"),
    });
    const published = canonicalSourceFindings({
      artifact: payload, sourceStep: "spec-gate", sourceArtifact,
    });

    assert.deepEqual(published.map(({ identity }) => identity.sourceFindingId), ["R-1"]);
    for (const [finding, sourceFindingId, fingerprint] of [
      [evaluation, "G-1", FIRST_FINGERPRINT],
      [review, "review-1", "c".repeat(64)],
      [observation, "R-1", SECOND_FINGERPRINT],
    ]) {
      assert.deepEqual(source.resolveFinding(new FlowFindingSourceIdentity({
        sourceArtifact, sourceStep: "spec-gate", sourceFindingId, fingerprint,
      })), finding);
    }
    assert.equal(source.resolveFinding(new FlowFindingSourceIdentity({
      sourceArtifact, sourceStep: "spec-gate", sourceFindingId: "G-1",
      fingerprint: SECOND_FINGERPRINT,
    })), null);
  });

  it("publishes observations with one producer id and distinct fingerprints as separate exact identities", () => {
    const publication = buildDeferredSemanticFindingsPublication({
      flowManager: manager(),
      flowState: { schemaRevision: CURRENT_FLOW_SCHEMA_REVISION, specId: "001", runId: "run-1" },
      nodeId: "draft-gate",
      sourceStep: "draft-gate",
      sourceArtifact: SOURCE_PATH,
      sourcePayload: sourcePayload(),
      sourceRelativePath: SOURCE_PATH,
      attempts: 5,
    });

    assert.equal(publication.changed, true);
    assert.equal(publication.artifact.entries.length, 3);
    assert.deepEqual(
      publication.artifact.entries.map((entry) => entry.sourceIdentity().toJSON()),
      [
        {
          sourceArtifact: SOURCE_PATH,
          sourceStep: "draft-gate",
          sourceFindingId: "shared-observation",
          fingerprint: FIRST_FINGERPRINT,
        },
        {
          sourceArtifact: SOURCE_PATH,
          sourceStep: "draft-gate",
          sourceFindingId: "shared-observation",
          fingerprint: SECOND_FINGERPRINT,
        },
        {
          sourceArtifact: SOURCE_PATH,
          sourceStep: "draft-gate",
          sourceFindingId: "distinct-observation",
          fingerprint: FIRST_FINGERPRINT,
        },
      ],
    );
    assert.equal(publication.artifact.entries[0].sourceIdentity().equals(
      publication.artifact.entries[1].sourceIdentity(),
    ), false);

    const otherSource = "steps/impl/gate/result.json";
    const nextPublication = buildDeferredSemanticFindingsPublication({
      flowManager: manager(publication.artifact.toJSON()),
      flowState: { schemaRevision: CURRENT_FLOW_SCHEMA_REVISION, specId: "001", runId: "run-1" },
      nodeId: "impl-gate",
      sourceStep: "impl-gate",
      sourceArtifact: otherSource,
      sourcePayload: {
        observations: [{
          sourceFindingId: "shared-observation",
          fingerprint: FIRST_FINGERPRINT,
          severity: "blocking",
          issue: "A different source reused the fingerprint.",
        }],
      },
      sourceRelativePath: otherSource,
      attempts: 5,
    });
    assert.equal(nextPublication.artifact.entries.length, 4);
    assert.deepEqual(nextPublication.artifact.entries.at(-1).sourceIdentity().toJSON(), {
      sourceArtifact: otherSource,
      sourceStep: "impl-gate",
      sourceFindingId: "shared-observation",
      fingerprint: FIRST_FINGERPRINT,
    });
  });

  it("resolves only the exact id and fingerprint across retained producer attempts", () => {
    const history = {
      attempts: [
        {
          attempt: 1,
          artifact: {
            logicalKey: "draft.gate",
            payload: sourcePayload(),
          },
        },
        {
          attempt: 2,
          artifact: {
            logicalKey: "draft.gate",
            payload: { verdict: "PASS", observations: [] },
          },
        },
      ],
    };
    const source = CanonicalFlowFindingSourceArtifact.fromBytes({
      logicalKey: "draft.gate",
      relativePath: SOURCE_PATH,
      bytes: Buffer.from(JSON.stringify(history), "utf8"),
    });

    assert.equal(
      source.resolveFinding(new FlowFindingSourceIdentity({
        sourceArtifact: SOURCE_PATH,
        sourceStep: "draft-gate",
        sourceFindingId: "shared-observation",
        fingerprint: SECOND_FINGERPRINT,
      })).issue,
      "The second observation.",
    );
    assert.equal(source.resolveFinding(new FlowFindingSourceIdentity({
      sourceArtifact: SOURCE_PATH,
      sourceStep: "draft-gate",
      sourceFindingId: "shared-observation",
      fingerprint: "d".repeat(64),
    })), null);
    assert.throws(
      () => new FlowFindingSourceIdentity({
        sourceArtifact: SOURCE_PATH,
        sourceStep: "draft-gate",
        sourceFindingId: "shared-observation",
      }),
      /fingerprint must be a non-empty string/,
    );
    assert.throws(
      () => new FlowFindingSourceIdentity({
        sourceArtifact: SOURCE_PATH,
        sourceStep: "draft-gate",
        sourceFindingId: "shared-observation",
        fingerprint: "wrong",
      }),
      /lowercase SHA-256/,
    );
  });

  it("binds artifact view references to all four source identity fields", () => {
    const rule = FLOW_ARTIFACT_VIEW_REGISTRY.require("acceptance.review")
      .referenceRule("deferredFindingSource");
    const reference = {
      sourceArtifact: "steps/impl/review/result.json",
      sourceStep: "impl-review",
      sourceFindingId: "shared-source-id",
      fingerprint: FIRST_FINGERPRINT,
    };

    assert.deepEqual(rule.assertReference(reference).toJSON(), reference);
    assert.throws(
      () => rule.assertReference({ ...reference, fingerprint: undefined }),
      /fingerprint must be a non-empty string/,
    );
  });
});
