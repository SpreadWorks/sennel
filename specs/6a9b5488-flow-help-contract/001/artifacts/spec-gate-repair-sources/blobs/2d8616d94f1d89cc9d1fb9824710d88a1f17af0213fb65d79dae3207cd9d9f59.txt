import { DRAFT_REVIEW_ROUTES } from "./draft-review-routes.js";

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`review route ${field} must be a non-empty string`);
  }
  return value;
}

export class FlowReviewRoute {
  constructor({
    phase,
    reviewStepId,
    logicalKey,
    projectionFile,
  }) {
    this.phase = requireString(phase, "phase");
    this.reviewStepId = requireString(reviewStepId, "reviewStepId");
    this.logicalKey = requireString(logicalKey, "logicalKey");
    this.projectionFile = requireString(projectionFile, "projectionFile");
    this.historyPattern = new RegExp(`^${this.phase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-attempt-(\\d{3})\\.json$`);
    Object.freeze(this);
  }
}

const DRAFT_FLOW_REVIEW_ROUTES = DRAFT_REVIEW_ROUTES.map((route) => new FlowReviewRoute({
  phase: route.retryPhase,
  reviewStepId: route.reviewStepId,
  logicalKey: route.reviewLogicalKey,
  projectionFile: route.reviewArtifact,
}));

export const FLOW_REVIEW_ROUTES = Object.freeze([
  ...DRAFT_FLOW_REVIEW_ROUTES,
  new FlowReviewRoute({
    phase: "spec",
    reviewStepId: "spec-review",
    logicalKey: "spec.review",
    projectionFile: "review.delta.json",
  }),
  new FlowReviewRoute({
    phase: "test",
    reviewStepId: "test-review",
    logicalKey: "test.review",
    projectionFile: "test-review.json",
  }),
  new FlowReviewRoute({
    phase: "impl",
    reviewStepId: "impl-review",
    logicalKey: "impl.review",
    projectionFile: "impl-review.json",
  }),
]);

const ROUTE_BY_PHASE = new Map(FLOW_REVIEW_ROUTES.map((route) => [route.phase, route]));
const ROUTE_BY_STEP = new Map(FLOW_REVIEW_ROUTES.map((route) => [route.reviewStepId, route]));

export function flowReviewRouteForPhase(phase) {
  return ROUTE_BY_PHASE.get(phase) || null;
}

export function flowReviewRouteForStepId(stepId) {
  return ROUTE_BY_STEP.get(stepId) || null;
}

export function reviewPhaseForFlowStepId(stepId) {
  return flowReviewRouteForStepId(stepId)?.phase || null;
}

export function reviewProjectionFileForPhase(phase) {
  return flowReviewRouteForPhase(phase)?.projectionFile || null;
}
