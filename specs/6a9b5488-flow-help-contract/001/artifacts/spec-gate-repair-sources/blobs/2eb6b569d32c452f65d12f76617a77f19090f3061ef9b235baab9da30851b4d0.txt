import path from "node:path";

import { flowStateSpecLocation } from "../../lib/flow-workspace.js";
import { CanonicalDraftReviewSource } from "./canonical-review-artifacts.js";
import { buildRepairFingerprint } from "./repair-fingerprint.js";
import { ReviewTargetState } from "./review-convergence.js";
import { resolveCurrentReviewTreeSha } from "./review-evidence-store.js";

function requireRoot(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty path`);
  }
  return path.resolve(value);
}

/**
 * Binds review code identity to the execution checkout while keeping mutable
 * Flow artifacts under the base-side artifact authority.
 */
export class ReviewTargetAuthority {
  constructor({ executionRoot, artifactRoot, flowState, flowManager, specPath = null } = {}) {
    if (!flowState || typeof flowState !== "object" || Array.isArray(flowState)) {
      throw new Error("review target authority requires flowState");
    }
    this.executionRoot = requireRoot(executionRoot, "executionRoot");
    this.artifactRoot = requireRoot(artifactRoot, "artifactRoot");
    this.flowState = flowState;
    this.flowManager = flowManager;
    const location = flowStateSpecLocation(flowState);
    if (location === null && (typeof specPath !== "string" || specPath.trim() === "")) {
      throw new Error("review target authority requires a manager-bound Version location");
    }
    this.specPath = location?.relativeSpecFile ?? specPath;
    Object.freeze(this);
  }

  static fromContext(ctx = {}) {
    return new ReviewTargetAuthority({
      executionRoot: ctx.executionRoot || ctx.root,
      artifactRoot: ctx.root,
      flowState: ctx.flowState,
      flowManager: ctx.flowManager,
    });
  }

  resolveTreeSha() {
    return resolveCurrentReviewTreeSha(this.executionRoot, this.specPath);
  }

  captureFingerprint() {
    return buildRepairFingerprint({
      root: this.executionRoot,
      artifactRoot: this.artifactRoot,
      specPath: this.specPath,
      state: this.flowState,
    });
  }

  captureTargetState(fingerprint = this.captureFingerprint()) {
    return ReviewTargetState.fromRepairFingerprint(fingerprint);
  }

  captureTargetStateForPhase(phase, fingerprint = null) {
    if (String(phase || "").startsWith("draft-")) {
      return new CanonicalDraftReviewSource({
        flowManager: this.flowManager,
        state: this.flowState,
        phase,
      }).targetState();
    }
    return this.captureTargetState(fingerprint || this.captureFingerprint());
  }
}
