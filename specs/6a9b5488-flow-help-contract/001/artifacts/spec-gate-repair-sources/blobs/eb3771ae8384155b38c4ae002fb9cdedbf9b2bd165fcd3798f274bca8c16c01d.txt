const CONDITIONAL_DRAFT_WORKER_STEP_IDS = new Set([
  "draft-refine",
  "draft-gate-repair",
]);

export const DRAFT_CONDITIONAL_WORKER_STEP_IDS = Object.freeze([
  ...CONDITIONAL_DRAFT_WORKER_STEP_IDS,
]);

export function isConditionalDraftWorkerStep(stepId) {
  return CONDITIONAL_DRAFT_WORKER_STEP_IDS.has(stepId);
}
