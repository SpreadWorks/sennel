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

/** Catalog-only access to the Requirement test plan and staged candidates. */
export class RequirementTestArtifactStore {
  constructor({ flowManager, state } = {}) {
    this.flowManager = requiredManager(flowManager);
    this.state = requiredState(state);
    this.specId = this.state.specId;
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
      });
    });
    return Object.freeze({
      candidate,
      descriptor: manifestResolved.descriptor,
      sources: Object.freeze(sources),
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
      || !Array.isArray(candidateRead.sources)) {
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
    const replacements = new Map(candidateRead.sources.map((entry) => [entry.targetRelativePath, entry]));
    for (const source of activeStore.testSources("test-gate")) {
      const targetRelativePath = `tests/${source.testPath}`;
      if (replacements.has(targetRelativePath)) {
        throw new Error(`Requirement test candidate path collides with a promoted test source: ${targetRelativePath}`);
      }
      replacements.set(targetRelativePath, Object.freeze({
        targetRelativePath,
        bytes: Buffer.from(source.bytes),
        mediaType: mediaTypeForPath(targetRelativePath),
      }));
    }
    const replacement = new CanonicalWorkerTestTree([...replacements.values()]).replacement(baseline);
    return Object.freeze({
      ...replacement,
      artifactBaselines: Object.freeze([...(candidateRead.baselines ?? [])]),
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
