import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { DraftLifecycle } from "./draft-lifecycle.js";
import { DraftTransitionFacts } from "./draft-transition-facts.js";
import {
  createConditionalWorkerSettlementPlan,
  resolveDraftQuestionResolution,
  resolveDraftTransition,
} from "../definition.js";

function parseDraft(bytes) {
  try { return new DraftLifecycle(JSON.parse(bytes.toString("utf8"))); }
  catch (cause) { throw new Error(`canonical draft is invalid: ${cause.message}`, { cause }); }
}
function revision(value) {
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export default class SetDraftAnswerCommand extends FlowCommand {
  execute(ctx) {
    const dropping = ctx.drop === true;
    const questionRevision = revision(ctx.questionRevision);
    if (!ctx.questionId || questionRevision === null || (dropping && !ctx.droppedReason) || (!dropping && (!ctx.answer || !ctx.why))) {
      return Envelope.fail("set", "draft-answer", "INVALID_USAGE", "usage: flow set draft-answer <questionId> --question-revision <revision> (--answer <text> --why <text> [--considered <text>] | --drop --dropped-reason <text>)");
    }
    if (dropping && (ctx.answer || ctx.why || ctx.considered)) return Envelope.fail("set", "draft-answer", "INVALID_USAGE", "--drop cannot be combined with --answer, --why, or --considered");
    if (!dropping && ctx.droppedReason) return Envelope.fail("set", "draft-answer", "INVALID_USAGE", "--dropped-reason requires --drop");

    // Admission always reloads the only authority. A caller-held ctx is never
    // sufficient to mutate a question that may have changed after projection.
    const state = ctx.flowManager.loadReadOnly(ctx.specId ?? ctx.flowState.specId);
    if (state.currentNodeId !== "draft-refine" || state.autoApprove === true) {
      return Envelope.fail("set", "draft-answer", "DRAFT_ANSWER_NOT_SELECTED", "the Definition has not selected a manual draft answer action");
    }
    const source = ctx.flowManager.readArtifact({ specId: state.specId, logicalKey: "draft", consumerNodeId: "draft-refine" });
    let draft;
    try {
      draft = parseDraft(source.bytes);
      const ledger = draft.questionLedger;
      const plan = resolveDraftQuestionResolution({
        intent: dropping ? "discard" : "answer",
        questionId: ctx.questionId,
        questionRevision,
        facts: DraftTransitionFacts.fromDraft(draft),
        flowState: state,
        answer: ctx.answer,
        why: ctx.why,
        considered: ctx.considered || "",
        reason: ctx.droppedReason,
      });
      if (plan === null) {
        throw new Error("draft answer does not match the Definition-selected action");
      }
      const nextLedger = plan.apply(ledger);
      draft = draft.withQuestionLedger(nextLedger);
      draft.decisionMap.requiresUserJudgment = draft.decisionMap.requiresUserJudgment
        .filter((questionId) => questionId !== ctx.questionId);
    } catch (error) {
      return Envelope.fail("set", "draft-answer", "INVALID_DRAFT_ANSWER", error.message);
    }
    const artifactBaselines = [{ logicalKey: "draft", digest: source.descriptor.hash, byteLength: source.descriptor.size }];
    const artifactWrites = [{ logicalKey: "draft", mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(draft, null, 2)}\n`, "utf8") }];
    const nextFacts = DraftTransitionFacts.fromDraft(new DraftLifecycle(draft), { workerStatus: "in_progress" });
    const disposition = resolveDraftTransition({ stepId: "draft-refine", flowState: state, facts: nextFacts });
    try {
      if (disposition.operation === "complete-worker") {
        const plan = createConditionalWorkerSettlementPlan({
          disposition,
          flowState: ctx.flowManager.canonicalState(state.specId),
          evidenceDigest: source.descriptor.hash,
        });
        ctx.flowManager.settleConditionalWorker({
          specId: state.specId,
          plan,
          artifactBaselines,
          artifactWrites,
        });
      } else {
        ctx.flowManager.publishArtifacts({ specId: state.specId, nodeId: "draft-refine", artifactBaselines, artifactWrites });
      }
    } catch (error) {
      return Envelope.fail("set", "draft-answer", "DRAFT_ANSWER_STALE_PUBLICATION", error.message);
    }
    return {
      questionId: ctx.questionId,
      status: dropping ? "discarded" : "answered",
      nextQuestionId: new DraftLifecycle(draft).nextUnresolvedQuestion()?.id ?? null,
      draftRefineCompleted: disposition.operation === "complete-worker",
    };
  }
}
