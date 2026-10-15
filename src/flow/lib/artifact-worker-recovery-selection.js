import { isDeepStrictEqual } from "node:util";

/** Acquired identities sufficient for a pure Step/Definition recovery decision. */
export class ArtifactWorkerRecoverySelection {
  constructor({ stepId, sourceContractId, targetContractId, episodeId, budgetId,
    sourceGeneration, targetGeneration, sourceRuntimeRevision, targetRuntimeRevision,
    sourcePolicyDigest, targetPolicyDigest, previewDigest }) {
    for (const value of [stepId, sourceRuntimeRevision, targetRuntimeRevision]) {
      if (typeof value !== "string" || !value) throw new TypeError("Artifact recovery selection requires its acquired identities");
    }
    for (const value of [sourceContractId, targetContractId, episodeId, budgetId, sourcePolicyDigest, targetPolicyDigest, previewDigest]) {
      if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError("Artifact recovery selection requires authenticated digests");
    }
    if (!Number.isSafeInteger(sourceGeneration) || sourceGeneration < 0 || targetGeneration !== sourceGeneration + 1
      || sourceContractId === targetContractId || sourcePolicyDigest !== targetPolicyDigest) {
      throw new TypeError("Artifact recovery selection must preserve policy and advance exactly one generation");
    }
    Object.assign(this, { stepId, sourceContractId, targetContractId, episodeId, budgetId,
      sourceGeneration, targetGeneration, sourceRuntimeRevision, targetRuntimeRevision,
      sourcePolicyDigest, targetPolicyDigest, previewDigest });
    Object.freeze(this);
  }
  toJSON() { return { ...this }; }
  static fromJSON(value) {
    const selection = new this(value);
    if (!isDeepStrictEqual(selection.toJSON(), value)) throw new TypeError("Artifact recovery selection has unknown or missing fields");
    return selection;
  }
}
