import { FlowArtifactCatalog } from "../../lib/flow-version.js";
import { FLOW_ARTIFACT_CONTRACTS, ResolvedFlowArtifact } from "../../lib/flow-artifact-contract.js";
import { CurrentFlowStateConflictError } from "./current-flow-state-conflict-error.js";
import { CurrentFlowStateInvariantError } from "./current-flow-state-invariant-error.js";
import { isPlainObject, requireString } from "./current-flow-value-validation.js";

export class CanonicalFlowArtifactBaseline {
  constructor({ logicalKey, parameters = {}, relativePath = null, digest = null, byteLength = 0 } = {}) {
    if (!isPlainObject(parameters)) {
      throw new CurrentFlowStateInvariantError("canonical artifact baseline parameters must be an object");
    }
    const key = requireString(logicalKey, "canonical artifact baseline logicalKey");
    if (relativePath === null) this.artifact = FLOW_ARTIFACT_CONTRACTS.resolve(key, parameters);
    else {
      const contract = FLOW_ARTIFACT_CONTRACTS.require(key);
      if (!contract.matchesCanonicalPath(relativePath) || Object.keys(parameters).length !== 0) {
        throw new CurrentFlowStateInvariantError("canonical artifact baseline path differs from its logical contract");
      }
      this.artifact = new ResolvedFlowArtifact(contract, relativePath);
    }
    if (["flow.state", "flow.activities", "artifact.catalog"].includes(this.artifact.logicalKey)) {
      throw new CurrentFlowStateInvariantError("canonical Store authorities cannot be artifact baselines");
    }
    if (!this.artifact.contract.cataloged) {
      throw new CurrentFlowStateInvariantError("canonical artifact baseline must target cataloged storage");
    }
    if (digest !== null && (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) {
      throw new CurrentFlowStateInvariantError("canonical artifact baseline digest must be null or a SHA-256 digest");
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || (digest === null && byteLength !== 0)) {
      throw new CurrentFlowStateInvariantError("canonical artifact baseline byteLength is invalid");
    }
    this.digest = digest;
    this.byteLength = byteLength;
    Object.freeze(this);
  }

  static from(value) {
    return value instanceof CanonicalFlowArtifactBaseline
      ? value
      : new CanonicalFlowArtifactBaseline(value);
  }

  assertCatalog(catalog) {
    if (!(catalog instanceof FlowArtifactCatalog)) {
      throw new CurrentFlowStateInvariantError("canonical artifact baseline requires a FlowArtifactCatalog");
    }
    const actual = catalog.artifacts.find((entry) => entry.relativePath === this.artifact.relativePath) ?? null;
    const unchanged = this.digest === null
      ? actual === null
      : actual !== null
        && actual.logicalKey === this.artifact.logicalKey
        && actual.hash === this.digest
        && actual.size === this.byteLength;
    if (!unchanged) {
      throw new CurrentFlowStateConflictError(
        `canonical artifact changed after baseline capture: ${this.artifact.relativePath}`,
      );
    }
  }
}
