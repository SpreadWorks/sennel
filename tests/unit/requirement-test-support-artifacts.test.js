import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";

import {
  RequirementTestCandidateBundle,
  RequirementTestCandidateSource,
  RequirementTestSupportArtifact,
} from "../../src/flow/lib/requirement-test-artifacts.js";
import {
  RequirementTestBundleLineage,
  RequirementTestBundleRevision,
} from "../../src/flow/lib/requirement-test-lifecycle.js";
import { RequirementTestArtifactStore } from "../../src/flow/lib/requirement-test-store.js";

const SPEC_REVISION = {
  specId: "support-contract",
  revision: 1,
  digest: "a".repeat(64),
  byteLength: 100,
};

function candidate({ support = [], requirementId = "R1", testPath = null } = {}) {
  const primaryPath = testPath ?? `tests/${requirementId.toLowerCase()}.test.js`;
  const sourceBytes = Buffer.from(`import test from 'node:test';\ntest('${requirementId}: behavior', () => {});\n`);
  const source = RequirementTestCandidateSource.fromBytes({ testPath: primaryPath, bytes: sourceBytes });
  const bundle = new RequirementTestBundleRevision({
    requirementId,
    specRevision: SPEC_REVISION,
    revision: 1,
    paths: [source.testPath],
    lineage: new RequirementTestBundleLineage({
      requirementId,
      specRevision: SPEC_REVISION,
      bundleRevision: 1,
      predecessorRevision: null,
      sourceAttempt: { id: "generate-r1", sequence: 1 },
      sourceFindingFingerprints: [],
    }),
  });
  return {
    source,
    sourceBytes,
    bundle: new RequirementTestCandidateBundle({ bundle, sources: [source], support }),
  };
}

function manager({
  active = [],
  supportBytes = null,
  bundleBytes = null,
  sourceBytes = null,
  candidateManifests = [],
  readCounts = null,
} = {}) {
  const descriptors = active.map((entry) => ({
    logicalKey: "tests.source",
    relativePath: `artifacts/tests/${entry.testPath}`,
    hash: crypto.createHash("sha256").update(entry.bytes).digest("hex"),
    size: entry.bytes.length,
  }));
  const manifests = bundleBytes === null
    ? candidateManifests
    : [{ requirementId: "R1", revision: 1, bytes: bundleBytes }, ...candidateManifests];
  for (const manifest of manifests) descriptors.push({
    logicalKey: "test.requirement.candidate.bundle",
    relativePath: `artifacts/test-candidates/${manifest.requirementId}/revision-${manifest.revision}/bundle.json`,
    hash: crypto.createHash("sha256").update(manifest.bytes).digest("hex"),
    size: manifest.bytes.length,
  });
  return {
    readArtifact({ logicalKey, parameters }) {
      if (logicalKey === "test.requirement.candidate.bundle") {
        if (readCounts) readCounts.candidateBundle = (readCounts.candidateBundle ?? 0) + 1;
        const manifest = manifests.find((entry) => entry.requirementId === parameters.requirementId
          && String(entry.revision) === String(parameters.bundleRevision));
        if (!manifest) throw new Error(`missing candidate bundle: ${parameters.requirementId}`);
        return {
          bytes: manifest.bytes,
          descriptor: {
            logicalKey,
            hash: crypto.createHash("sha256").update(manifest.bytes).digest("hex"),
            size: manifest.bytes.length,
          },
        };
      }
      if (logicalKey === "test.requirement.candidate.source") {
        return {
          bytes: sourceBytes,
          descriptor: { logicalKey, hash: crypto.createHash("sha256").update(sourceBytes).digest("hex"), size: sourceBytes.length },
        };
      }
      if (logicalKey === "tests.source") {
        const activeEntry = active.find((entry) => entry.testPath === parameters.testPath);
        if (!activeEntry) throw new Error(`missing active source: ${parameters.testPath}`);
        return {
          bytes: activeEntry.bytes,
          relativePath: `artifacts/tests/${parameters.testPath}`,
          descriptor: {
            logicalKey,
            relativePath: `artifacts/tests/${parameters.testPath}`,
            hash: crypto.createHash("sha256").update(activeEntry.bytes).digest("hex"),
            size: activeEntry.bytes.length,
          },
        };
      }
      if (logicalKey !== "test.requirement.support") throw new Error(`unexpected artifact read: ${logicalKey}`);
      if (readCounts) readCounts.support = (readCounts.support ?? 0) + 1;
      return {
        bytes: supportBytes,
        descriptor: {
          logicalKey,
          relativePath: `artifacts/test-support/${parameters.ownerRequirementId}/${parameters.supportPath}/${parameters.supportDigest}`,
          hash: crypto.createHash("sha256").update(supportBytes).digest("hex"),
          size: supportBytes.length,
        },
      };
    },
    artifactCatalog() { return { artifacts: descriptors }; },
    writeRuntimeArtifact() {},
    readRuntimeArtifact() {},
    activityLedger() { return []; },
    specLocation() { return { repositoryRoot: "/repo", resolve: (...parts) => ["/repo", ...parts].join("/") }; },
  };
}

describe("Requirement test shared support artifact", () => {
  it("binds helper ownership and exact bytes across serialization/restart", () => {
    const bytes = Buffer.from("export const helper = true;\n");
    const support = RequirementTestSupportArtifact.fromBytes({
      ownerRequirementId: "R1",
      supportPath: "tests/support/fixture.js",
      bytes,
    });
    const restored = RequirementTestSupportArtifact.fromJSON(JSON.parse(JSON.stringify(support.toJSON())));
    assert.deepEqual(restored.toJSON(), support.toJSON());
    assert.equal(restored.matchesBytes(bytes), true);
    assert.equal(restored.matchesBytes(Buffer.from("changed\n")), false);
    assert.throws(() => RequirementTestSupportArtifact.fromJSON({
      ...support.toJSON(),
      digest: "not-a-digest",
    }), /SHA-256 digest/);
    assert.throws(() => new RequirementTestSupportArtifact({
      ...support.toJSON(), supportPath: "tests/r1.test.js",
    }), /tests\/support/);
  });

  it("keeps support out of the isolated primary bundle and binds it into the candidate digest", () => {
    const support = RequirementTestSupportArtifact.fromBytes({
      ownerRequirementId: "R1",
      supportPath: "tests/support/fixture.js",
      bytes: Buffer.from("export const helper = true;\n"),
    });
    const withSupport = candidate({ support: [support] }).bundle;
    const restored = RequirementTestCandidateBundle.fromJSON(JSON.parse(JSON.stringify(withSupport.toJSON())));
    assert.equal(restored.support[0].ownerRequirementId, "R1");
    assert.equal(restored.support[0].digest, support.digest);
    assert.notEqual(restored.digest, candidate().bundle.digest);
    assert.throws(() => new RequirementTestCandidateSource({
      testPath: support.supportPath, digest: support.digest, byteLength: support.byteLength,
    }), /must not be a support artifact/);
    assert.throws(() => new RequirementTestCandidateBundle({
      bundle: withSupport.bundle,
      sources: [withSupport.sources[0]],
      support: [support, support],
    }), /support paths must be unique/);
  });

  it("reads support bytes after manager reconstruction and fails closed on a promoted-path collision", () => {
    const supportBytes = Buffer.from("export const helper = true;\n");
    const support = RequirementTestSupportArtifact.fromBytes({
      ownerRequirementId: "R1",
      supportPath: "tests/support/fixture.js",
      bytes: supportBytes,
    });
    const value = candidate({ support: [support] });
    const state = { schemaRevision: 3, specId: "support-contract" };
    const bundleBytes = Buffer.from(`${JSON.stringify(value.bundle.toJSON())}\n`);
    const restored = new RequirementTestArtifactStore({ flowManager: manager({
      supportBytes, bundleBytes, sourceBytes: value.sourceBytes,
    }), state })
      .readCandidate({ bundle: value.bundle.bundle, consumerNodeId: "test-gate" });
    assert.equal(restored.support[0].bytes.toString(), supportBytes.toString());
    assert.equal(restored.support[0].support.ownerRequirementId, "R1");
    const reused = new RequirementTestArtifactStore({
      flowManager: manager({ supportBytes, bundleBytes }),
      state,
    }).resolveExistingSupport({
      supportPath: support.supportPath,
      bytes: supportBytes,
      consumerNodeId: "test-generate",
    });
    assert.equal(reused.support.ownerRequirementId, "R1");
    assert.equal(reused.bytes.toString(), supportBytes.toString());
    assert.equal(reused.baseline.artifact.logicalKey, "test.requirement.support");
    assert.equal(reused.baseline.digest, support.digest);

    const sameSupport = new RequirementTestArtifactStore({
      flowManager: manager({ active: [{ testPath: "support/fixture.js", bytes: supportBytes }], supportBytes, bundleBytes }),
      state,
    });
    assert.doesNotThrow(() => sameSupport.promotion(restored));

    const conflicting = new RequirementTestArtifactStore({
      flowManager: manager({ active: [{ testPath: "support/fixture.js", bytes: Buffer.from("different\n") }], supportBytes, bundleBytes }),
      state,
    });
    assert.throws(() => conflicting.promotion(restored), /collides with a promoted test source/);

    const differentOwner = RequirementTestSupportArtifact.fromBytes({
      ownerRequirementId: "R2",
      supportPath: support.supportPath,
      bytes: supportBytes,
    });
    const otherCandidate = candidate({ support: [differentOwner] }).bundle;
    const ownerMismatch = new RequirementTestArtifactStore({
      flowManager: manager({ active: [{ testPath: "support/fixture.js", bytes: supportBytes }], supportBytes, bundleBytes }),
      state,
    });
    assert.throws(() => ownerMismatch.promotion({
      ...restored,
      candidate: otherCandidate,
      support: [{ ...restored.support[0], support: differentOwner }],
    }), /owner or digest collides/);

    const changedSupport = RequirementTestSupportArtifact.fromBytes({
      ownerRequirementId: "R1",
      supportPath: support.supportPath,
      bytes: Buffer.from("changed helper\n"),
    });
    const changedCandidate = candidate({ support: [changedSupport] }).bundle;
    assert.throws(() => ownerMismatch.promotion({
      ...restored,
      candidate: changedCandidate,
      support: [{ ...restored.support[0], support: changedSupport, bytes: changedSupport.bytes }],
    }), /owner or digest collides/);

    const primaryCollision = new RequirementTestArtifactStore({
      flowManager: manager({ active: [{ testPath: "r1.test.js", bytes: value.sourceBytes }], bundleBytes }),
      state,
    });
    assert.throws(() => primaryCollision.promotion(restored), /collides with a promoted test source/);
  });

  it("rejects a primary path reserved by another Requirement before publication, while allowing repair", () => {
    const r1 = candidate({ requirementId: "R1", testPath: "tests/shared.test.js" });
    const r2 = candidate({ requirementId: "R2", testPath: "tests/shared.test.js" });
    const r1Bytes = Buffer.from(`${JSON.stringify(r1.bundle.toJSON())}\n`);
    const store = new RequirementTestArtifactStore({
      flowManager: manager({
        candidateManifests: [{ requirementId: "R1", revision: 1, bytes: r1Bytes }],
      }),
      state: { schemaRevision: 3, specId: "support-contract" },
    });
    assert.throws(
      () => store.assertCandidatePrimaryPathsAvailable(r2.bundle),
      /collides with another Requirement: tests\/shared\.test\.js/,
    );
    assert.doesNotThrow(() => store.assertCandidatePrimaryPathsAvailable(r1.bundle));
  });

  it("reuses one provenance index without rereading manifests per support entry", () => {
    const supportBytes = Buffer.from("export const helper = true;\n");
    const supports = ["one.mjs", "two.mjs"].map((name) => RequirementTestSupportArtifact.fromBytes({
      ownerRequirementId: "R1",
      supportPath: `tests/support/${name}`,
      bytes: supportBytes,
    }));
    const value = candidate({ support: supports });
    const bundleBytes = Buffer.from(`${JSON.stringify(value.bundle.toJSON())}\n`);
    const readCounts = {};
    const store = new RequirementTestArtifactStore({
      flowManager: manager({ supportBytes, bundleBytes, readCounts }),
      state: { schemaRevision: 3, specId: "support-contract" },
    });
    const index = store.candidateProvenanceIndex({ consumerNodeId: "test-generate" });
    assert.equal(readCounts.candidateBundle, 1);
    store.resolveExistingSupport({
      supportPath: supports[0].supportPath,
      bytes: supportBytes,
      consumerNodeId: "test-generate",
      provenanceIndex: index,
    });
    store.resolveExistingSupport({
      supportPath: supports[1].supportPath,
      bytes: supportBytes,
      consumerNodeId: "test-generate",
      provenanceIndex: index,
    });
    store.assertCandidatePrimaryPathsAvailable(value.bundle, index);
    assert.equal(readCounts.candidateBundle, 1);
    assert.equal(readCounts.support, 2);
    const promotionReads = {};
    const promotionStore = new RequirementTestArtifactStore({
      flowManager: manager({
        active: [
          { testPath: "support/one.mjs", bytes: supportBytes },
          { testPath: "support/two.mjs", bytes: supportBytes },
        ],
        supportBytes,
        bundleBytes,
        sourceBytes: value.sourceBytes,
        readCounts: promotionReads,
      }),
      state: { schemaRevision: 3, specId: "support-contract" },
    });
    const candidateRead = promotionStore.readCandidate({ bundle: value.bundle.bundle });
    promotionReads.candidateBundle = 0;
    promotionReads.support = 0;
    promotionStore.promotion(candidateRead);
    assert.equal(promotionReads.candidateBundle, 1);
    assert.throws(
      () => store.assertCandidatePrimaryPathsAvailable(value.bundle, {}),
      /provenance index belongs to a different Store/,
    );
    const siblingStore = new RequirementTestArtifactStore({
      flowManager: manager({ supportBytes, bundleBytes }),
      state: { schemaRevision: 3, specId: "support-contract" },
    });
    assert.throws(
      () => siblingStore.assertCandidatePrimaryPathsAvailable(value.bundle, index),
      /provenance index belongs to a different Store/,
    );
  });
});
