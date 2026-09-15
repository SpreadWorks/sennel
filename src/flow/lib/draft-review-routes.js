/**
 * Shared draft review route metadata.
 *
 * Review records findings, triage records disposition, and repair records the
 * draft mutation audit. Keep the workflow step ids and artifact names together
 * so routing, migration, gate validation, and docs cannot drift independently.
 */

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid draft review route: ${field} must be non-empty`);
  }
  return value;
}

export class DraftReviewRoute {
  constructor({
    key,
    label,
    retryPhase,
    reviewStepId,
    triageStepId,
    repairStepId,
    reviewArtifact,
    reviewLogicalKey,
    triageArtifact,
    repairArtifact,
    passNextStepId,
    sourceStepIds,
  }) {
    this.key = requireNonEmptyString(key, "key");
    this.label = requireNonEmptyString(label, "label");
    this.retryPhase = requireNonEmptyString(retryPhase, "retryPhase");
    this.reviewStepId = requireNonEmptyString(reviewStepId, "reviewStepId");
    this.triageStepId = requireNonEmptyString(triageStepId, "triageStepId");
    this.repairStepId = requireNonEmptyString(repairStepId, "repairStepId");
    this.reviewArtifact = requireNonEmptyString(reviewArtifact, "reviewArtifact");
    this.reviewLogicalKey = requireNonEmptyString(reviewLogicalKey, "reviewLogicalKey");
    this.triageArtifact = requireNonEmptyString(triageArtifact, "triageArtifact");
    this.repairArtifact = requireNonEmptyString(repairArtifact, "repairArtifact");
    this.passNextStepId = requireNonEmptyString(passNextStepId, "passNextStepId");
    if (!Array.isArray(sourceStepIds) || sourceStepIds.length === 0) {
      throw new Error("invalid draft review route: sourceStepIds must be a non-empty array");
    }
    this.sourceStepIds = Object.freeze(sourceStepIds.map((stepId) => requireNonEmptyString(stepId, "sourceStepIds entry")));
    if (new Set(this.sourceStepIds).size !== this.sourceStepIds.length) {
      throw new Error("invalid draft review route: sourceStepIds must be unique");
    }
    Object.freeze(this);
  }
}

export const DRAFT_REVIEW_ROUTES = Object.freeze([
  new DraftReviewRoute({
    key: "questions",
    label: "Draft questions",
    retryPhase: "draft-questions",
    reviewStepId: "draft-questions-review",
    triageStepId: "draft-questions-triage",
    repairStepId: "draft-questions-repair",
    reviewArtifact: "draft-review-questions.json",
    reviewLogicalKey: "draft.questions.review",
    triageArtifact: "draft-questions-triage.json",
    repairArtifact: "draft-questions-repair.json",
    passNextStepId: "draft-refine",
    sourceStepIds: ["draft", "draft-questions-repair"],
  }),
  new DraftReviewRoute({
    key: "coverage",
    label: "Draft coverage",
    retryPhase: "draft-coverage",
    reviewStepId: "draft-coverage-review",
    triageStepId: "draft-coverage-triage",
    repairStepId: "draft-coverage-repair",
    reviewArtifact: "draft-review-coverage.json",
    reviewLogicalKey: "draft.coverage.review",
    triageArtifact: "draft-coverage-triage.json",
    repairArtifact: "draft-coverage-repair.json",
    passNextStepId: "draft-gate",
    sourceStepIds: ["draft", "draft-questions-repair", "draft-refine", "draft-gate-repair", "draft-coverage-repair"],
  }),
]);

export const DRAFT_REVIEW_ARTIFACT_LIMIT = 20;
export const DRAFT_TRIAGE_REPAIR_ARTIFACT_LIMIT = 40;

const ROUTE_BY_RETRY_PHASE = new Map(DRAFT_REVIEW_ROUTES.map((route) => [route.retryPhase, route]));
const ROUTE_BY_KEY = new Map(DRAFT_REVIEW_ROUTES.map((route) => [route.key, route]));
const ROUTE_BY_STEP_ID = new Map(DRAFT_REVIEW_ROUTES.flatMap((route) => [
  [route.reviewStepId, route],
  [route.triageStepId, route],
  [route.repairStepId, route],
]));

export function draftReviewRouteForRetryPhase(retryPhase) {
  return ROUTE_BY_RETRY_PHASE.get(retryPhase) || null;
}

/** Immutable definition-owned draft producers permitted to feed one review phase. */
export function draftReviewSourceStepIds(retryPhase) {
  return draftReviewRouteForRetryPhase(retryPhase)?.sourceStepIds ?? null;
}

export function draftReviewRouteForKey(key) {
  return ROUTE_BY_KEY.get(key) || null;
}

export function draftReviewRouteForStepId(stepId) {
  return ROUTE_BY_STEP_ID.get(stepId) || null;
}
