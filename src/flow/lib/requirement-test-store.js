import crypto from "node:crypto";

import {
  CanonicalFlowArtifactBaseline,
} from "./current-flow-state.js";
import {
  CanonicalWorkerTestTree,
  mediaTypeForPath,
} from "./canonical-worker-artifacts.js";
import {
  CanonicalTestArtifactStore,
} from "./canonical-test-artifacts.js";
import {
  RequirementTestCandidateBundle,
  RequirementTestDeferredReceipt,
  RequirementTestPlanArtifact,
} from "./requirement-test-artifacts.js";

function requiredManager(value) {
  if (!value || typeof value.readArtifact !== "function" || typeof value.artifactCatalog !== "function") {
    throw new Error("Requirement test store requires the canonical FlowManager artifact surface");
  }
  return value;
}

function requiredState(value) {
  if (value?.schemaRevision !== 3 || typeof value.specId !== "string" || value.specId === "") {
    throw new Error("Requirement test store requires a Version-1 Flow state");
  }
  return value;
}

function parseJson(bytes, field) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${field} must be valid JSON: ${error.message}`);
  }
}

function bundleParameters(bundle) {
  return Object.freeze({
    requirementId: bundle.requirementId,
    bundleRevision: String(bundle.revision),
  });
}

function supportParameters(support) {
  return Object.freeze({
    ownerRequirementId: support.ownerRequirementId,
    supportPath: support.supportPath.slice("tests/".length),
    supportDigest: support.digest,
  });
}

const PROVENANCE_INDEX_TOKEN = Symbol("requirement-test-provenance-index");

export function candidateBundleParameters(relativePath) {
  const match = /^artifacts\/test-candidates\/([^/]+)\/revision-([1-9][0-9]*)\/bundle\.json$/.exec(relativePath);
  return match === null ? null : { requirementId: match[1], bundleRevision: match[2] };
}

class RequirementTestSupportPublication {
  constructor({ support, bytes, descriptor, baseline } = {}) {
    this.support = support;
    this.bytes = Buffer.from(bytes);
    this.descriptor = descriptor;
    this.baseline = baseline;
    Object.freeze(this);
  }
}

/**
 * Immutable provenance index for one publication transaction. Candidate
 * manifests are read once; all primary-path and support ownership checks then
 * use this index rather than re-scanning the catalog for every submitted file.
 */
export class RequirementTestCandidateProvenanceIndex {
  #specId;

  #storeToken;

  #primaryClaims;

  #supportClaims;

  constructor({ primaryClaims, supportClaims, specId, storeToken, token } = {}) {
    if (token !== PROVENANCE_INDEX_TOKEN
      || !(primaryClaims instanceof Map)
      || !(supportClaims instanceof Map)
      || typeof storeToken !== "symbol"
      || typeof specId !== "string"
      || specId === "") {
      throw new Error("Requirement test provenance index is an internal Store value");
    }
    this.#specId = specId;
    this.#storeToken = storeToken;
    this.#primaryClaims = primaryClaims;
    this.#supportClaims = supportClaims;
    Object.freeze(this);
  }

  primaryRequirementIds(testPath) {
    return Object.freeze([...(this.#primaryClaims.get(testPath) ?? [])]);
  }

  supportPublications(supportPath) {
    return Object.freeze([...(this.#supportClaims.get(supportPath) ?? [])]);
  }

  belongsTo(specId, storeToken) {
    return this.#specId === specId && this.#storeToken === storeToken;
  }
}

/** Catalog-only access to the Requirement test plan and staged candidates. */
export class RequirementTestArtifactStore {
  #provenanceToken;

  constructor({ flowManager, state } = {}) {
    this.flowManager = requiredManager(flowManager);
    this.state = requiredState(state);
    this.specId = this.state.specId;
    this.#provenanceToken = Symbol("requirement-test-artifact-store");
    Object.freeze(this);
  }

  readPlan(consumerNodeId) {
    const resolved = this.flowManager.readArtifact({
      specId: this.specId,
      logicalKey: "test.requirement.plan",
      consumerNodeId,
    });
    const artifact = RequirementTestPlanArtifact.fromJSON(parseJson(resolved.bytes, "Requirement test plan"));
    return Object.freeze({
      artifact,
      descriptor: resolved.descriptor,
      baseline: new CanonicalFlowArtifactBaseline({
        logicalKey: "test.requirement.plan",
        digest: resolved.descriptor.hash,
        byteLength: resolved.descriptor.size,
      }),
    });
  }

  readCandidate({ bundle, consumerNodeId = "test-gate" } = {}) {
    const parameters = bundleParameters(bundle);
    const manifestResolved = this.flowManager.readArtifact({
      specId: this.specId,
      logicalKey: "test.requirement.candidate.bundle",
      parameters,
      consumerNodeId,
    });
    const candidate = RequirementTestCandidateBundle.fromJSON(parseJson(
      manifestResolved.bytes,
      "Requirement test candidate bundle",
    ));
    if (candidate.bundle.requirementId !== bundle.requirementId
      || candidate.bundle.revision !== bundle.revision
      || !candidate.bundle.specRevision.equals(bundle.specRevision)) {
      throw new Error("Requirement test candidate bundle does not match the selected work item");
    }
    const baselines = [new CanonicalFlowArtifactBaseline({
      logicalKey: "test.requirement.candidate.bundle",
      parameters,
      digest: manifestResolved.descriptor.hash,
      byteLength: manifestResolved.descriptor.size,
    })];
    const sources = candidate.sources.map((source) => {
      const sourceParameters = {
        ...parameters,
        testPath: source.testPath.slice("tests/".length),
      };
      const resolved = this.flowManager.readArtifact({
        specId: this.specId,
        logicalKey: "test.requirement.candidate.source",
        parameters: sourceParameters,
        consumerNodeId,
      });
      if (resolved.descriptor.hash !== source.digest || resolved.descriptor.size !== source.byteLength) {
        throw new Error(`Requirement test candidate source does not match its manifest: ${source.testPath}`);
      }
      baselines.push(new CanonicalFlowArtifactBaseline({
        logicalKey: "test.requirement.candidate.source",
        parameters: sourceParameters,
        digest: source.digest,
        byteLength: source.byteLength,
      }));
      return Object.freeze({
        targetRelativePath: source.testPath,
        bytes: Buffer.from(resolved.bytes),
        mediaType: mediaTypeForPath(source.testPath),
        descriptor: resolved.descriptor,
        kind: "candidate",
      });
    });
    const support = candidate.support.map((entry) => {
      const parameters = supportParameters(entry);
      const resolved = this.flowManager.readArtifact({
        specId: this.specId,
        logicalKey: "test.requirement.support",
        parameters,
        consumerNodeId,
      });
      if (resolved.descriptor.hash !== entry.digest || resolved.descriptor.size !== entry.byteLength) {
        throw new Error(`Requirement test support does not match its manifest: ${entry.supportPath}`);
      }
      if (!entry.matchesBytes(resolved.bytes)) {
        throw new Error(`Requirement test support bytes do not match its digest: ${entry.supportPath}`);
      }
      baselines.push(new CanonicalFlowArtifactBaseline({
        logicalKey: "test.requirement.support",
        parameters,
        digest: entry.digest,
        byteLength: entry.byteLength,
      }));
      return Object.freeze({
        targetRelativePath: entry.supportPath,
        bytes: Buffer.from(resolved.bytes),
        mediaType: mediaTypeForPath(entry.supportPath),
        descriptor: resolved.descriptor,
        support: entry,
        kind: "support",
      });
    });
    return Object.freeze({
      candidate,
      descriptor: manifestResolved.descriptor,
      sources: Object.freeze(sources),
      support: Object.freeze(support),
      baselines: Object.freeze(baselines),
    });
  }

  /**
   * Compose the complete next active tree so the existing Store collection
   * CAS preserves prior Requirement and shared files while Gate overwrites
   * only paths present in this candidate.
   */
  promotion(candidateRead) {
    if (!(candidateRead?.candidate instanceof RequirementTestCandidateBundle)
      || !Array.isArray(candidateRead.sources)
      || !Array.isArray(candidateRead.support)) {
      throw new Error("Requirement test promotion requires a canonical candidate read");
    }
    const activeStore = new CanonicalTestArtifactStore({
      flowManager: this.flowManager,
      state: this.state,
    });
    const baseline = CanonicalWorkerTestTree.catalogSnapshot({
      flowManager: this.flowManager,
      specId: this.specId,
    });
    const replacements = new Map();
    let provenanceIndex = null;
    for (const entry of [...candidateRead.sources, ...candidateRead.support]) {
      if (replacements.has(entry.targetRelativePath)) {
        throw new Error(`Requirement test candidate path collision: ${entry.targetRelativePath}`);
      }
      replacements.set(entry.targetRelativePath, entry);
    }
    for (const source of activeStore.testSources("test-gate")) {
      const targetRelativePath = `tests/${source.testPath}`;
      if (replacements.has(targetRelativePath)) {
        const candidate = replacements.get(targetRelativePath);
        const supportCollision = candidate.kind === "support"
          && targetRelativePath.startsWith("tests/support/")
          && this.#activeSupportOwner(
            targetRelativePath,
            candidate.support,
            source.bytes,
            provenanceIndex ?? (provenanceIndex = this.candidateProvenanceIndex()),
          );
        if (!supportCollision) {
          throw new Error(`Requirement test candidate path collides with a promoted test source: ${targetRelativePath}`);
        }
        // The immutable support artifact has already been promoted.  Keep the
        // prior active member and avoid manufacturing a second publication.
        replacements.delete(targetRelativePath);
      }
      replacements.set(targetRelativePath, Object.freeze({
        targetRelativePath,
        bytes: Buffer.from(source.bytes),
        mediaType: mediaTypeForPath(targetRelativePath),
        kind: targetRelativePath.startsWith("tests/support/") ? "support" : "active",
      }));
    }
    const replacement = new CanonicalWorkerTestTree([...replacements.values()]).replacement(baseline);
    return Object.freeze({
      ...replacement,
      artifactBaselines: Object.freeze([...(candidateRead.baselines ?? [])]),
    });
  }

  /**
   * Reject a primary candidate path already claimed by another Requirement's
   * immutable candidate manifest.  This check is intentionally separate from
   * active-tree promotion: a deferred candidate has no active source yet, but
   * its primary path must still be reserved before publication.  A later
   * revision/repair of the same Requirement may retain its paths.
   */
  assertCandidatePrimaryPathsAvailable(candidate, provenanceIndex = null) {
    if (!(candidate instanceof RequirementTestCandidateBundle)) {
      throw new Error("Requirement test candidate path validation requires a canonical candidate bundle");
    }
    const index = this.#requireProvenanceIndex(provenanceIndex);
    for (const source of candidate.sources) {
      const owners = index.primaryRequirementIds(source.testPath)
        .filter((requirementId) => requirementId !== candidate.bundle.requirementId);
      if (owners.length > 0) {
        throw new Error(
          `Requirement test candidate primary path collides with another Requirement: ${source.testPath}`,
        );
      }
    }
    return candidate;
  }

  /** Build the immutable manifest provenance view once for this transaction. */
  candidateProvenanceIndex({ consumerNodeId = "test-gate" } = {}) {
    const primaryClaims = new Map();
    const supportClaims = new Map();
    const supportRead = new Map();
    for (const { bundle } of this.#candidateBundles(consumerNodeId)) {
      const requirementId = bundle.bundle.requirementId;
      for (const source of bundle.sources) {
        const claims = primaryClaims.get(source.testPath) ?? [];
        if (!claims.includes(requirementId)) claims.push(requirementId);
        primaryClaims.set(source.testPath, claims);
      }
      for (const support of bundle.support) {
        const key = `${support.ownerRequirementId}\0${support.supportPath}\0${support.digest}`;
        let publication = supportRead.get(key) ?? null;
        if (publication === null) {
          const parameters = supportParameters(support);
          const resolved = this.flowManager.readArtifact({
            specId: this.specId,
            logicalKey: "test.requirement.support",
            parameters,
            consumerNodeId,
          });
          if (resolved.descriptor.hash !== support.digest || resolved.descriptor.size !== support.byteLength
            || !support.matchesBytes(resolved.bytes)) {
            throw new Error(`Requirement test support does not match its immutable publication: ${support.supportPath}`);
          }
          publication = new RequirementTestSupportPublication({
            support,
            bytes: resolved.bytes,
            descriptor: resolved.descriptor,
            baseline: new CanonicalFlowArtifactBaseline({
              logicalKey: "test.requirement.support",
              parameters,
              digest: resolved.descriptor.hash,
              byteLength: resolved.descriptor.size,
            }),
          });
          supportRead.set(key, publication);
        }
        const claims = supportClaims.get(support.supportPath) ?? [];
        if (!claims.some((entry) => entry.support.ownerRequirementId === support.ownerRequirementId
          && entry.support.digest === support.digest)) claims.push(publication);
        supportClaims.set(support.supportPath, claims);
      }
    }
    for (const claims of primaryClaims.values()) Object.freeze(claims);
    for (const claims of supportClaims.values()) Object.freeze(claims);
    return new RequirementTestCandidateProvenanceIndex({
      primaryClaims,
      supportClaims,
      specId: this.specId,
      storeToken: this.#provenanceToken,
      token: PROVENANCE_INDEX_TOKEN,
    });
  }

  /**
   * Resolve an already-published shared helper and its immutable descriptor.
   * The descriptor is part of the returned baseline so a publication that
   * reuses the helper still participates in the same CAS transaction as its
   * new candidate manifest.
   */
  resolveExistingSupport({
    supportPath,
    bytes,
    consumerNodeId = "test-gate",
    provenanceIndex = null,
  } = {}) {
    if (typeof supportPath !== "string" || !Buffer.isBuffer(bytes)) {
      throw new Error("Requirement test support resolution requires a path and Buffer");
    }
    const matches = this.#requireProvenanceIndex(provenanceIndex, consumerNodeId)
      .supportPublications(supportPath);
    if (matches.length === 0) return null;
    const wantedDigest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (matches.some(({ support }) => support.digest !== wantedDigest || support.byteLength !== bytes.length)) {
      throw new Error(`shared Requirement test support conflicts with immutable bytes: ${supportPath}`);
    }
    const owners = new Set(matches.map(({ support }) => support.ownerRequirementId));
    if (owners.size !== 1) {
      throw new Error(`shared Requirement test support has ambiguous owners: ${supportPath}`);
    }
    const publication = matches[0];
    return Object.freeze({
      support: publication.support,
      bytes: Buffer.from(publication.bytes),
      descriptor: publication.descriptor,
      baseline: publication.baseline,
    });
  }

  /**
   * Active test-source bytes do not carry support ownership themselves.  The
   * immutable candidate manifests are therefore the provenance authority for
   * reusing a promoted helper. The active bytes identify the prior immutable
   * publication, and owner/path/digest/length must all remain identical.
   */
  #activeSupportOwner(targetRelativePath, candidateSupport, activeBytes, provenanceIndex) {
    const activeDigest = crypto.createHash("sha256").update(activeBytes).digest("hex");
    const owners = [];
    for (const publication of provenanceIndex.supportPublications(targetRelativePath)) {
      const { support } = publication;
      if (support.digest === activeDigest && support.byteLength === activeBytes.length) owners.push(support);
    }
    if (owners.length === 0) {
      throw new Error(`Requirement test candidate path collides with a promoted test source without owner provenance: ${targetRelativePath}`);
    }
    if (owners.some((owner) => owner.ownerRequirementId !== candidateSupport.ownerRequirementId
      || owner.supportPath !== candidateSupport.supportPath)) {
      throw new Error(`Requirement test support owner or digest collides with an active helper: ${targetRelativePath}`);
    }
    if (candidateSupport.digest !== activeDigest || candidateSupport.byteLength !== activeBytes.length) {
      throw new Error(`Requirement test support owner or digest collides with an active helper: ${targetRelativePath}`);
    }
    return true;
  }

  #requireProvenanceIndex(provenanceIndex, consumerNodeId = "test-gate") {
    const index = provenanceIndex === null || provenanceIndex === undefined
      ? this.candidateProvenanceIndex({ consumerNodeId })
      : provenanceIndex;
    if (!(index instanceof RequirementTestCandidateProvenanceIndex)
      || !index.belongsTo(this.specId, this.#provenanceToken)) {
      throw new Error("Requirement test provenance index belongs to a different Store");
    }
    return index;
  }

  #candidateBundles(consumerNodeId = "test-gate") {
    return this.flowManager.artifactCatalog(this.specId).artifacts
      .filter((descriptor) => descriptor.logicalKey === "test.requirement.candidate.bundle")
      .map((descriptor) => {
        const parameters = candidateBundleParameters(descriptor.relativePath);
        if (parameters === null) throw new Error("Requirement test candidate bundle has an invalid catalog path");
        const resolved = this.flowManager.readArtifact({
          specId: this.specId,
          logicalKey: "test.requirement.candidate.bundle",
          parameters,
          consumerNodeId,
        });
        const bundle = RequirementTestCandidateBundle.fromJSON(parseJson(
          resolved.bytes,
          "Requirement test candidate bundle",
        ));
        if (bundle.bundle.requirementId !== parameters.requirementId
          || String(bundle.bundle.revision) !== parameters.bundleRevision) {
          throw new Error("Requirement test candidate bundle identity does not match its catalog path");
        }
        return Object.freeze({ bundle, parameters, descriptor });
      });
  }

  deferredReceipts(consumerNodeId) {
    const prefix = "steps/test-gate/deferred/";
    return Object.freeze(this.flowManager.artifactCatalog(this.specId).artifacts
      .filter((descriptor) => descriptor.logicalKey === "test.requirement.deferred")
      .map((descriptor) => {
        if (!descriptor.relativePath.startsWith(prefix) || !descriptor.relativePath.endsWith(".json")) {
          throw new Error("Requirement test deferred receipt has an invalid catalog path");
        }
        const requirementId = descriptor.relativePath.slice(prefix.length, -".json".length);
        const resolved = this.flowManager.readArtifact({
          specId: this.specId,
          logicalKey: "test.requirement.deferred",
          parameters: { requirementId },
          consumerNodeId,
        });
        const receipt = RequirementTestDeferredReceipt.fromJSON(parseJson(
          resolved.bytes,
          "Requirement test deferred receipt",
        ));
        if (receipt.requirementId !== requirementId) {
          throw new Error("Requirement test deferred receipt identity does not match its catalog path");
        }
        return receipt;
      })
      .sort((left, right) => left.requirementId.localeCompare(right.requirementId)));
  }
}
