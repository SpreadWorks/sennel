import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { missingExactTargetGuardNames } from "../../lib/flow-target-guard.js";
import { flattenSteps } from "./step-tree.js";

const MAX_REASON_LENGTH = 500;
const SPEC_CORRECTION_CATEGORY = "spec-correction";
const REOPEN_CATEGORIES = new Set([undefined, "task-addition", SPEC_CORRECTION_CATEGORY]);
const PREIMPLEMENTATION_STAGES = new Set([
  "draft-refine",
  "draft-gate-repair",
  "draft-questions-review",
  "draft-questions-triage",
  "draft-questions-repair",
  "draft-coverage-review",
  "draft-coverage-triage",
  "draft-coverage-repair",
  "draft-gate",
  "spec",
  "spec-review",
  "spec-triage",
  "spec-repair",
  "spec-gate",
  "approval",
  "test-generate",
  "test-review",
  "test-repair",
  "test-gate",
]);
const SPEC_CORRECTION_STAGES = new Set([
  "implement",
  "impl-review",
  "impl-gate",
  "retro",
  "acceptance-review",
  "final-regression",
]);

function reasonFrom(value) {
  if (value == null) return "";
  if (typeof value !== "string" || value.includes("\0")) throw new Error("--reason must be a valid string");
  const reason = value.trim();
  if (reason.length > MAX_REASON_LENGTH) throw new Error(`--reason exceeds ${MAX_REASON_LENGTH} characters`);
  return reason;
}

function correctionGuardFailure(ctx, state) {
  const missing = missingExactTargetGuardNames(ctx, state);
  return missing.length === 0 ? null : Envelope.fail(
    "run",
    "reopen-draft",
    "TARGET_GUARDS_REQUIRED",
    `spec-correction requires explicit target guards: ${missing.join(", ")}`,
  );
}

function activeStep(state) {
  if (typeof state?.currentNodeId !== "string" || state.currentNodeId === "") {
    throw new Error("canonical draft reopen requires an active Attempt");
  }
  return state.currentNodeId;
}

function completedTaskCount(state) {
  return Array.isArray(state.tasks) ? state.tasks.filter((task) => task.status === "done").length : 0;
}

function routeFor({ category, state }) {
  const current = activeStep(state);
  const doneTaskCount = completedTaskCount(state);
  if (category === SPEC_CORRECTION_CATEGORY) {
    if (!SPEC_CORRECTION_STAGES.has(current)) {
      throw new Error("spec-correction reopen is only available from a supported implementation stage");
    }
    return "spec-correction";
  }
  if (category === "task-addition" || doneTaskCount > 0) {
    if (doneTaskCount === 0) {
      throw new Error("cannot reopen draft: no done task exists. Reopen is only for adding tasks mid-implementation");
    }
    return "task-addition";
  }
  if (current.startsWith("task-")) {
    throw new Error("cannot reopen draft: no done task exists. Reopen is only for adding tasks mid-implementation");
  }
  if (!PREIMPLEMENTATION_STAGES.has(current)) {
    throw new Error("reopen draft is unavailable from the active stage");
  }
  return "preimplementation";
}

/** Catalog-owned proof required only for the guarded correction route. */
export class DraftSpecCorrectionEvidence {
  constructor({ draft, specRecord } = {}) {
    if (!Buffer.isBuffer(draft) || draft.length === 0) throw new Error("canonical draft artifact is required");
    if (!Buffer.isBuffer(specRecord) || specRecord.length === 0) throw new Error("canonical spec.record artifact is required");
    this.draftBytes = draft.length;
    this.specRecordBytes = specRecord.length;
    Object.freeze(this);
  }
}

function correctionEvidence(flowManager, specId) {
  const draft = flowManager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-questions-review" });
  const specRecord = flowManager.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "draft-questions-review" });
  return new DraftSpecCorrectionEvidence({ draft: draft.bytes, specRecord: specRecord.bytes });
}

function issueEntry({ route, reason, previousActiveStep, evidence = null }) {
  return {
    step: "draft",
    reason: `reopen-draft ${route}${reason ? `: ${reason}` : ""}`,
    trigger: "user invoked sennel flow reopen-draft",
    resolution: `definition-owned draft replacement started after ${previousActiveStep}`,
    ...(evidence === null ? {} : {
      evidence: { draftBytes: evidence.draftBytes, specRecordBytes: evidence.specRecordBytes },
    }),
  };
}

export class RunReopenDraftCommand extends FlowCommand {
  async execute(ctx) {
    if (!REOPEN_CATEGORIES.has(ctx.category)) {
      return Envelope.fail("run", "reopen-draft", "ARGS_ERROR", "--category must be task-addition or spec-correction");
    }
    const state = ctx.flowState;
    if (!state) return Envelope.fail("run", "reopen-draft", "NO_ACTIVE_FLOW", "no active flow found");
    let reason;
    try { reason = reasonFrom(ctx.reason); } catch (error) {
      return Envelope.fail("run", "reopen-draft", "INVALID_REASON", error.message);
    }
    if (ctx.category === SPEC_CORRECTION_CATEGORY) {
      if (!reason) return Envelope.fail("run", "reopen-draft", "INVALID_REASON", "--reason is required for spec-correction");
      const guardFailure = correctionGuardFailure(ctx, state);
      if (guardFailure) return guardFailure;
    }
    try {
      const previousActiveStep = activeStep(state);
      const route = routeFor({ category: ctx.category, state });
      const evidence = route === "spec-correction" ? correctionEvidence(ctx.flowManager, state.specId) : null;
      const doneTaskCount = completedTaskCount(state);
      ctx.flowManager.reopenDraft({ specId: state.specId, route });
      ctx.flowManager.appendIssueLog({
        specId: state.specId,
        entry: issueEntry({ route, reason, previousActiveStep, evidence }),
        idempotencyKey: `reopen-draft:${state.runId}:${route}:${reason || "default"}`,
      });
      const resetSteps = flattenSteps(ctx.flowManager.loadReadOnly(state.specId).steps)
        .filter((step) => step.status === "invalidated")
        .map((step) => step.id);
      return Envelope.ok("run", "reopen-draft", {
        reopened: true,
        mode: route === "task-addition" ? "implementation" : route === "spec-correction" ? SPEC_CORRECTION_CATEGORY : "pre-implementation",
        previousActiveStep,
        destinationStep: "draft",
        resetSteps: ["draft", ...resetSteps],
        doneTaskCount,
        taskCount: Array.isArray(state.tasks) ? state.tasks.length : 0,
        ...(evidence === null ? {} : { evidence: { draftBytes: evidence.draftBytes, specRecordBytes: evidence.specRecordBytes } }),
      });
    } catch (error) {
      const code = error.message.startsWith("cannot reopen draft") ? "NO_DONE_TASK" : "REOPEN_DRAFT_REJECTED";
      return Envelope.fail("run", "reopen-draft", code, error.message);
    }
  }
}

export default RunReopenDraftCommand;
