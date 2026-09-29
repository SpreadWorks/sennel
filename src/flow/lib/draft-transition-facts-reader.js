/** Read canonical Draft and lifecycle state for transition selection. */
import { DraftLifecycle } from "./draft-lifecycle.js";
import { DraftTransitionFacts } from "./draft-transition-facts.js";
import { findStepById } from "./step-tree.js";

export class DraftTransitionFactsError extends Error { constructor(code, message) { super(message); this.name = "DraftTransitionFactsError"; this.code = code; } }

export function readDraftTransitionFacts({ flowManager, flowState } = {}) {
  const source = flowManager.readArtifact({ specId: flowState.specId, logicalKey: "draft", consumerNodeId: "draft-refine", optional: true });
  if (source === null) return null;
  const workerStatus = findStepById(flowState.steps, "draft-refine")?.status ?? null;
  if (!["pending", "invalidated", "in_progress"].includes(workerStatus)) {
    throw new DraftTransitionFactsError(
      "DRAFT_TRANSITION_STATE_INVALID",
      "canonical draft-refine lifecycle state is unavailable for transition selection",
    );
  }
  try { return DraftTransitionFacts.fromDraft(new DraftLifecycle(JSON.parse(source.bytes.toString("utf8"))), { workerStatus, sourceDigest: source.descriptor.hash, sourceByteLength: source.descriptor.size }); }
  catch (cause) { throw new DraftTransitionFactsError("DRAFT_SCHEMA_INVALID", `canonical draft question ledger is invalid: ${cause.message}; run reopen-draft to regenerate a valid questionLedger`); }
}
