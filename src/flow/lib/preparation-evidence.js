import { isGitObjectId } from "../../lib/git-snapshot.js";
import { immutableArtifactViewFingerprintInput } from "./artifact-view-fingerprint.js";

/** Immutable evidence acquired before a preparation Step selects its Result. */
export class PreparationEvidence {
  constructor(value = {}) {
    const fields = ["mode", "baseOid", "branch", "worktree", "creationActivityId", "catalog",
      "request", "issueSnapshot", "mandatory", "bindingIdentity"];
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
      throw new TypeError("Preparation evidence requires its exact serialized fields");
    }
    const { mode, baseOid, branch, worktree, creationActivityId, catalog,
      request, issueSnapshot, mandatory, bindingIdentity } = value;
    if (!["direct", "branch", "worktree"].includes(mode)
      || !isGitObjectId(baseOid)
      || typeof creationActivityId !== "string" || creationActivityId === ""
      || typeof request !== "string" || !Array.isArray(catalog)
      || (mode === "direct" ? branch !== null : typeof branch !== "string" || branch === "")
      || (mode === "worktree" ? typeof worktree !== "string" || worktree === "" : worktree !== null)) {
      throw new TypeError("Preparation evidence requires its exact creation and execution identity");
    }
    if (issueSnapshot !== null && (!Number.isSafeInteger(issueSnapshot?.number)
      || issueSnapshot.number < 1 || typeof issueSnapshot.body !== "string")) {
      throw new TypeError("Preparation evidence requires a captured Issue snapshot or null");
    }
    if (mandatory !== null && (!Array.isArray(mandatory?.plugins)
      || !/^[a-f0-9]{64}$/.test(mandatory?.analysis?.hash ?? "")
      || !Number.isSafeInteger(mandatory?.analysis?.size) || mandatory.analysis.size < 0)) {
      throw new TypeError("Ready preparation requires mandatory plugin and analysis evidence");
    }
    if ((mandatory !== null && mode === "worktree") !== (bindingIdentity !== null)) {
      throw new TypeError("Ready worktree preparation requires its binding identity");
    }
    const serialized = JSON.parse(JSON.stringify({ mode, baseOid, branch, worktree,
      creationActivityId, catalog, request, issueSnapshot, mandatory, bindingIdentity }));
    Object.assign(this, immutableArtifactViewFingerprintInput(serialized));
    Object.freeze(this);
  }

  assertStep(stepId) {
    if (!["branch", "prepare-spec"].includes(stepId)
      || (stepId === "branch") !== (this.mandatory === null)) {
      throw new TypeError("Preparation evidence does not belong to this Step");
    }
    return this;
  }

  toJSON() {
    return structuredClone({ mode: this.mode, baseOid: this.baseOid, branch: this.branch,
      worktree: this.worktree, creationActivityId: this.creationActivityId, catalog: this.catalog,
      request: this.request, issueSnapshot: this.issueSnapshot, mandatory: this.mandatory,
      bindingIdentity: this.bindingIdentity });
  }
}
