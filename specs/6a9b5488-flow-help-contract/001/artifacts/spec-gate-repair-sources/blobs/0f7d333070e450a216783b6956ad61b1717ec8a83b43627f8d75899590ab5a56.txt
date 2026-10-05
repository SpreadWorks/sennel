import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { DraftLifecycle } from "./draft-lifecycle.js";
import { DraftQuestionResolutionIdentity } from "./draft-question-resume-receipt.js";

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
    let resolution;
    try {
      resolution = dropping
        ? DraftQuestionResolutionIdentity.discard(ctx.droppedReason)
        : DraftQuestionResolutionIdentity.answer({
          answer: ctx.answer,
          why: ctx.why,
          considered: ctx.considered || "",
        });
    } catch (error) {
      return Envelope.fail("set", "draft-answer", "INVALID_USAGE", error.message);
    }

    // Admission always reloads the only authority. A caller-held ctx is never
    // sufficient to mutate a question that may have changed after projection.
    const state = ctx.flowManager.loadReadOnly(ctx.specId ?? ctx.flowState.specId);
    const canonical = ctx.flowManager.canonicalState(state.specId);
    if (canonical.current?.at(-1) !== "draft-refine" || canonical.policy.autoApprove === true || canonical.attempt === null) {
      return Envelope.fail("set", "draft-answer", "DRAFT_ANSWER_NOT_SELECTED", "the Definition has not selected a manual draft answer action");
    }
    const binding = {
      runId: state.runId,
      specId: state.specId,
      stepId: "draft-refine",
      attempt: canonical.attempt,
    };
    const replay = ctx.flowManager.findDraftQuestionResumeReceipt({
      binding,
      questionId: ctx.questionId,
      questionRevision,
      resolution,
    });
    if (replay !== null) {
      return {
        questionId: replay.questionId,
        status: replay.resolution.kind === "discard" ? "discarded" : "answered",
        resumeReceiptId: replay.id,
        replayed: true,
      };
    }
    let projection;
    try {
      projection = ctx.flowManager.draftRefineStepState({ binding });
    } catch (error) {
      return Envelope.fail("set", "draft-answer", "DRAFT_ANSWER_NOT_SELECTED", error.message);
    }
    const awaitReceipt = projection.awaitReceiptFor({
      questionId: ctx.questionId,
      questionRevision,
    });
    if (awaitReceipt === null) {
      return Envelope.fail("set", "draft-answer", "DRAFT_ANSWER_NOT_SELECTED", "the persisted Draft Await receipt does not select this question");
    }
    const source = ctx.flowManager.readArtifact({ specId: state.specId, logicalKey: "draft", consumerNodeId: "draft-refine" });
    let draft;
    try {
      draft = parseDraft(source.bytes);
      const ledger = draft.questionLedger;
      const nextLedger = resolution.kind === "answer"
        ? ledger.answer(ctx.questionId, questionRevision, {
          answer: resolution.answer,
          why: resolution.why,
          considered: resolution.considered,
        })
        : ledger.discard(ctx.questionId, questionRevision, resolution.reason);
      draft = draft.withQuestionLedger(nextLedger);
      draft.decisionMap.requiresUserJudgment = draft.decisionMap.requiresUserJudgment
        .filter((questionId) => questionId !== ctx.questionId);
    } catch (error) {
      return Envelope.fail("set", "draft-answer", "INVALID_DRAFT_ANSWER", error.message);
    }
    const outputBytes = Buffer.from(`${JSON.stringify(draft, null, 2)}\n`, "utf8");
    let committed;
    try {
      committed = ctx.flowManager.recordDraftQuestionResume({
        binding,
        awaitReceipt,
        questionId: ctx.questionId,
        questionRevision,
        resolution,
        source,
        outputBytes,
      });
    } catch (error) {
      return Envelope.fail("set", "draft-answer", "DRAFT_ANSWER_STALE_PUBLICATION", error.message);
    }
    return {
      questionId: ctx.questionId,
      status: dropping ? "discarded" : "answered",
      nextQuestionId: new DraftLifecycle(draft).nextUnresolvedQuestion()?.id ?? null,
      resumeReceiptId: committed.receipt.id,
      replayed: false,
    };
  }
}
