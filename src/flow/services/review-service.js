import {
  CanonicalCommandAttemptArtifactHistory,
  CanonicalCommandResultArtifact,
  attachedCanonicalCommandResultArtifact,
  attachCanonicalCommandResultArtifact,
} from "../lib/canonical-command-result.js";
import {
  DraftReviewArtifactDocument,
  DraftReviewEvidenceSet,
} from "../lib/draft-review-artifacts.js";
import { draftReviewRouteForStepId } from "../lib/draft-review-routes.js";
import {
  DraftReviewStepBinding,
  DraftWorkerStepBinding,
} from "../engine/connectors/draft/draft-step-binding.js";

function jsonDocument(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("must be a JSON object");
    }
    return Object.freeze(structuredClone(value));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function reviewHistory(resolved, logicalKey) {
  return CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey, bytes: resolved.bytes });
}

/** Review-cycle evidence operations for a Connector-bound Flow step. */
export class ReviewService {
  constructor({ flowManager, binding }) {
    if (!flowManager || typeof flowManager.readArtifact !== "function"
      || typeof flowManager.publishCurrentAttemptResult !== "function"
      || typeof flowManager.publishArtifacts !== "function") {
      throw new TypeError("ReviewService requires canonical FlowManager artifact operations");
    }
    if (!(binding instanceof DraftReviewStepBinding) && !(binding instanceof DraftWorkerStepBinding)) {
      throw new TypeError("ReviewService requires a typed Draft review or worker binding");
    }
    const route = draftReviewRouteForStepId(binding.stepId);
    if (route === null) throw new Error(`ReviewService has no draft review route for ${binding.stepId}`);
    this.flowManager = flowManager;
    this.binding = binding;
    this.route = route;
    Object.freeze(this);
  }

  /** Read the Review result selected by the binding. */
  readReview() {
    const resolved = this.#readHistoryArtifact(this.route.reviewLogicalKey, true);
    if (resolved === null) return null;
    return DraftReviewArtifactDocument.fromStored(reviewHistory(resolved, this.route.reviewLogicalKey).current.payload);
  }

  /** Validate and publish a Review result with its reviewed source revision. */
  saveReview(review) {
    const state = this.#assertCurrent(this.route.reviewStepId);
    const document = DraftReviewArtifactDocument.fromStored(review);
    if (document.phase !== this.route.retryPhase || document.sourceDraft !== "draft.json") {
      throw new Error("draft review does not match the bound review route");
    }
    if (!(this.binding instanceof DraftReviewStepBinding)
      || JSON.stringify(document.sourceDraftRevision) !== JSON.stringify(this.binding.revision)) {
      throw new Error("draft review does not match the bound canonical Draft revision");
    }
    this.#validate({ state, review: document, through: this.route.reviewStepId });
    this.#publish(this.route.reviewLogicalKey, document.toJSON());
    return document;
  }

  /** Publish the existing command result, retaining its attached evidence. */
  inspectReviewResult(result) {
    const state = this.#assertCurrent(this.route.reviewStepId);
    const artifact = attachedCanonicalCommandResultArtifact(result);
    if (artifact?.logicalKey !== this.route.reviewLogicalKey) {
      throw new Error("draft review command result does not match the bound review route");
    }
    const document = DraftReviewArtifactDocument.fromStored(artifact.payload);
    if (!(this.binding instanceof DraftReviewStepBinding)
      || JSON.stringify(document.sourceDraftRevision) !== JSON.stringify(this.binding.revision)) {
      throw new Error("draft review command result does not match the bound canonical Draft revision");
    }
    this.#validate({ state, review: document, through: this.route.reviewStepId });
    return document;
  }

  /** Publish the existing command result, retaining its attached evidence. */
  publishReviewResult(result) {
    const document = this.inspectReviewResult(result);
    this.flowManager.publishCurrentAttemptResult({ specId: this.binding.specId, commandResult: result });
    return document;
  }

  /** Read the triage record associated with the selected Review result. */
  readTriage() {
    return this.#readDocument(this.#triageLogicalKey(), true);
  }

  /** Validate and publish a triage record linked to the selected Review. */
  saveTriage(triage) {
    const state = this.#assertCurrent(this.route.triageStepId);
    const review = this.readReview();
    if (review === null) throw new Error("draft triage requires the selected canonical review");
    const document = this.#document(triage, "draft triage");
    this.#validate({ state, review, triage: document, through: this.route.triageStepId });
    this.#publish(this.#triageLogicalKey(), document);
    return document;
  }

  /** Read the repair record associated with the selected triage. */
  readRepairRecord() {
    return this.#readDocument(this.#repairLogicalKey(), true);
  }

  /** Validate and publish a repair record linked to the selected triage. */
  saveRepairRecord(repairRecord) {
    const state = this.#assertCurrent(this.route.repairStepId);
    const review = this.readReview();
    const triage = this.readTriage();
    if (review === null || triage === null) {
      throw new Error("draft repair requires the selected canonical review and triage");
    }
    const document = this.#document(repairRecord, "draft repair");
    this.#validate({ state, review, triage, repair: document });
    this.#publish(this.#repairLogicalKey(), document);
    return document;
  }

  /** Read canonical Review attempt history without selecting a different revision. */
  readHistory() {
    const resolved = this.#readHistoryArtifact(this.route.reviewLogicalKey, true);
    return resolved === null ? null : reviewHistory(resolved, this.route.reviewLogicalKey);
  }

  #assertCurrent(expectedStepId) {
    if (this.binding.stepId !== expectedStepId) {
      throw new Error(`ReviewService ${expectedStepId} operation requires its bound Step`);
    }
    return this.binding.assertCurrent();
  }

  #readHistoryArtifact(logicalKey, optional) {
    this.binding.assertCurrent();
    return this.flowManager.readArtifact({
      specId: this.binding.specId,
      logicalKey,
      consumerNodeId: this.binding.stepId,
      optional,
    });
  }

  #readDocument(logicalKey, optional) {
    const resolved = this.#readHistoryArtifact(logicalKey, optional);
    return resolved === null ? null : jsonDocument(resolved.bytes, logicalKey);
  }

  #document(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return Object.freeze(structuredClone(value));
  }

  #validate({ state, review, triage = null, repair = null, through = this.route.repairStepId }) {
    const evidence = new DraftReviewEvidenceSet({
      route: this.route,
      state,
      reviewFile: { document: review.toJSON() },
      ...(triage === null ? {} : { triageFile: { document: triage } }),
      ...(repair === null ? {} : { repairFile: { document: repair } }),
    });
    const result = through === this.route.reviewStepId
      ? { issues: evidence.validateReview({ validateBinding: false }) }
      : evidence.validateThrough(through, { validateBinding: false });
    if (result.issues.length > 0) throw new Error(result.issues.join("; "));
  }

  #publish(logicalKey, payload) {
    if (logicalKey !== this.route.reviewLogicalKey) {
      this.flowManager.publishArtifacts({
        specId: this.binding.specId,
        nodeId: this.binding.stepId,
        artifactWrites: [{
          logicalKey,
          mediaType: "application/json",
          bytes: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"),
        }],
      });
      return;
    }
    const result = attachCanonicalCommandResultArtifact(
      {}, new CanonicalCommandResultArtifact({ logicalKey, payload }),
    );
    this.flowManager.publishCurrentAttemptResult({
      specId: this.binding.specId, commandResult: result,
    });
  }

  #triageLogicalKey() { return `draft.${this.route.key}.triage`; }
  #repairLogicalKey() { return `draft.${this.route.key}.repair`; }
}
