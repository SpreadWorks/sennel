/**
 * Single orchestration contract returned by `flow get next-action`.
 *
 * Domain subsystems may expose diagnostics, but only a NextActionDirective is
 * allowed to tell an agent what to do next. This prevents step outcomes,
 * reviews, gates, recovery, and the dispatcher from competing as
 * independent routing authorities.
 */

import {
  FlowContinuation,
  UserActionPrompt,
} from "./user-action-prompt.js";
import { guardedCommand } from "./guarded-command.js";
import { CurrentNextActionDescriptor } from "./current-flow-state.js";
import { PlanGateRepairRoute } from "./plan-gate-repair.js";
import { MissingProducerArtifactRoute } from "./producer-artifact-readiness.js";

const ACTION_ID = /^[A-Z][A-Z0-9_]{2,79}$/;
const MAX_TEXT_LENGTH = 4000;
const DIRECTIVE_KINDS = new Set([
  "execute_step",
  "execute_command",
  "repair_evidence",
  "await_user_decision",
  "await_draft_question",
  "blocked",
  "completed",
  "aborted",
  "idle",
]);

function requireString(value, field, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function requireActionId(value, field = "actionId") {
  const actionId = requireString(value, field, 80);
  if (!ACTION_ID.test(actionId)) {
    throw new Error(`${field} must be a stable uppercase action token`);
  }
  return actionId;
}

export class NextActionDirective {
  constructor({ kind, terminal, requiresUserAction }) {
    if (new.target === NextActionDirective) {
      throw new Error("NextActionDirective is abstract");
    }
    if (!DIRECTIVE_KINDS.has(kind)) {
      throw new Error(`unknown next-action directive kind: ${kind}`);
    }
    if (typeof terminal !== "boolean") {
      throw new Error("next-action directive terminal must be boolean");
    }
    if (typeof requiresUserAction !== "boolean") {
      throw new Error("next-action directive requiresUserAction must be boolean");
    }
    this.kind = kind;
    this.terminal = terminal;
    this.requiresUserAction = requiresUserAction;
  }

  toJSON() {
    return {
      kind: this.kind,
      terminal: this.terminal,
      requiresUserAction: this.requiresUserAction,
    };
  }

  static fromStored(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("stored next-action directive must be an object");
    }
    if (value.kind === "execute_step") return new ExecuteStepDirective(value);
    if (value.kind === "execute_command") return new ExecuteCommandDirective(value);
    if (value.kind === "repair_evidence") return new RepairEvidenceDirective(value);
    if (value.kind === "await_user_decision") return new AwaitUserDecisionDirective(value);
    if (value.kind === "await_draft_question") return new AwaitDraftQuestionDirective(value);
    if (value.kind === "blocked") return new BlockedDirective(value);
    if (value.kind === "completed") return new CompletedDirective();
    if (value.kind === "aborted") return new AbortedDirective(value);
    if (value.kind === "idle") return new IdleDirective();
    throw new Error(`unknown stored next-action directive: ${value.kind}`);
  }
}

export class ExecuteStepDirective extends NextActionDirective {
  constructor({ action, nextAction = null, actionPrompt = null } = {}) {
    const prompt = actionPrompt == null ? null : UserActionPrompt.fromStored(actionPrompt);
    // A dispatch approval remains a continuation: the dispatcher owns its
    // authorization boundary.  The optional prompt only exposes the explicit
    // choices available while that boundary is waiting for the user.
    super({ kind: "execute_step", terminal: false, requiresUserAction: prompt !== null });
    this.action = requireString(action, "directive.action", 200);
    this.nextAction = nextAction == null
      ? null
      : requireString(nextAction, "directive.nextAction");
    this.prompt = prompt;
    Object.freeze(this);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      action: this.action,
      ...(this.nextAction && { nextAction: this.nextAction }),
      ...(this.prompt && { actionPrompt: this.prompt.toJSON() }),
    };
  }
}

export class ExecuteCommandDirective extends NextActionDirective {
  constructor({ actionId, nextAction, instruction, reason } = {}) {
    super({ kind: "execute_command", terminal: false, requiresUserAction: false });
    this.continuation = new FlowContinuation({
      actionId: requireActionId(actionId, "directive.actionId"),
      nextAction,
      instruction,
      reason,
    });
    Object.freeze(this);
  }

  get actionId() { return this.continuation.actionId; }
  get nextAction() { return this.continuation.nextAction; }
  get instruction() { return this.continuation.instruction; }
  get reason() { return this.continuation.reason; }

  toJSON() {
    return { ...super.toJSON(), ...this.continuation.toJSON() };
  }
}

export class RepairEvidenceDirective extends NextActionDirective {
  constructor({
    actionId,
    evidenceKind,
    phase,
    instruction,
    reason,
    nextAction,
  } = {}) {
    super({ kind: "repair_evidence", terminal: false, requiresUserAction: false });
    this.actionId = requireActionId(actionId, "directive.actionId");
    this.evidenceKind = requireString(evidenceKind, "directive.evidenceKind", 100);
    this.phase = requireString(phase, "directive.phase", 100);
    this.instruction = requireString(instruction, "directive.instruction");
    this.reason = requireString(reason, "directive.reason");
    this.nextAction = requireString(nextAction, "directive.nextAction");
    Object.freeze(this);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      actionId: this.actionId,
      evidenceKind: this.evidenceKind,
      phase: this.phase,
      instruction: this.instruction,
      reason: this.reason,
      nextAction: this.nextAction,
    };
  }
}

export class AwaitUserDecisionDirective extends NextActionDirective {
  constructor({ prompt = null, actionPrompt = null, reason = null } = {}) {
    super({ kind: "await_user_decision", terminal: false, requiresUserAction: true });
    this.prompt = UserActionPrompt.fromStored(prompt || actionPrompt);
    this.reason = reason == null
      ? this.prompt.recommendationReason
      : requireString(reason, "directive.reason");
    Object.freeze(this);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      actionPrompt: this.prompt.toJSON(),
      reason: this.reason,
    };
  }
}

export class AwaitDraftQuestionDirective extends NextActionDirective {
  constructor({ questionId, question, questionRevision, reason = "Draft refinement requires an explicit user answer before its worker can run." } = {}) {
    super({ kind: "await_draft_question", terminal: false, requiresUserAction: true });
    this.questionId = requireString(questionId, "directive.questionId", 100);
    this.question = requireString(question, "directive.question");
    if (!Number.isSafeInteger(questionRevision) || questionRevision < 0) throw new Error("directive.questionRevision must be a non-negative integer");
    this.questionRevision = questionRevision;
    this.reason = requireString(reason, "directive.reason");
    Object.freeze(this);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      questionId: this.questionId,
      question: this.question,
      questionRevision: this.questionRevision,
      reason: this.reason,
    };
  }
}

export class BlockedDirective extends NextActionDirective {
  constructor({ code, reason, resumeInstruction } = {}) {
    super({ kind: "blocked", terminal: true, requiresUserAction: false });
    this.code = requireString(code, "directive.code", 200);
    this.reason = requireString(reason, "directive.reason");
    this.resumeInstruction = requireString(
      resumeInstruction || reason,
      "directive.resumeInstruction",
    );
    Object.freeze(this);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      code: this.code,
      reason: this.reason,
      resumeInstruction: this.resumeInstruction,
    };
  }
}

export class CompletedDirective extends NextActionDirective {
  constructor() {
    super({ kind: "completed", terminal: true, requiresUserAction: false });
    Object.freeze(this);
  }
}

export class AbortedDirective extends NextActionDirective {
  constructor({ reason = "The Flow was aborted." } = {}) {
    super({ kind: "aborted", terminal: true, requiresUserAction: false });
    this.reason = requireString(reason, "directive.reason");
    Object.freeze(this);
  }

  toJSON() {
    return { ...super.toJSON(), reason: this.reason };
  }
}

export class IdleDirective extends NextActionDirective {
  constructor() {
    super({ kind: "idle", terminal: true, requiresUserAction: false });
    Object.freeze(this);
  }
}

/**
 * The canonical runtime has one typed source for lifecycle decisions:
 * CurrentNextActionDescriptor.  This resolver translates that descriptor
 * into the sole public routing contract.  It intentionally does not inspect
 * legacy review/gate projections, so a V1 Flow cannot select a second route
 * from stale compatibility state.
 */
export class NextActionDirectiveResolver {
  constructor({
    state,
    binding = null,
    action,
    descriptor,
    recoveryCommand = null,
    missingProducerArtifactRoute = null,
    planGateRepairRoute = null,
    planGateRepairReason = null,
  } = {}) {
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("directive resolver state is required");
    }
    this.state = state;
    if (binding != null && typeof binding.guardCommand !== "function") {
      throw new Error("directive resolver binding.guardCommand is required");
    }
    this.binding = binding;
    this.action = requireString(action, "directive resolver action", 200);
    if (!(descriptor instanceof CurrentNextActionDescriptor)) {
      throw new Error("directive resolver requires a typed current next-action descriptor");
    }
    this.descriptor = descriptor;
    this.recoveryCommand = recoveryCommand == null
      ? null
      : requireString(recoveryCommand, "directive resolver recovery command");
    if (missingProducerArtifactRoute !== null
      && !(missingProducerArtifactRoute instanceof MissingProducerArtifactRoute)) {
      throw new Error("directive resolver requires a typed missing producer artifact route");
    }
    this.missingProducerArtifactRoute = missingProducerArtifactRoute;
    if (planGateRepairRoute !== null) {
      if (!(planGateRepairRoute instanceof PlanGateRepairRoute)) {
        throw new Error("directive resolver requires a typed plan gate repair route");
      }
      if (typeof planGateRepairReason !== "string" || planGateRepairReason.trim() === "") {
        throw new Error("directive resolver plan gate repair reason is required");
      }
    }
    this.planGateRepairRoute = planGateRepairRoute;
    this.planGateRepairReason = planGateRepairReason;
  }

  resolve() {
    if (this.missingProducerArtifactRoute !== null) {
      if (["historical-consumer", "historical-gap"].includes(this.missingProducerArtifactRoute.kind)) {
        const reason = this.missingProducerArtifactRoute.kind === "historical-consumer"
          ? `The active ${this.missingProducerArtifactRoute.consumerNodeId} Attempt was historically claimed before ${this.missingProducerArtifactRoute.producerNodeId} published its required canonical result.`
          : `The recorded ${this.missingProducerArtifactRoute.producerNodeId} failure was interrupted before its consumer could be claimed, without the required canonical result.`;
        return new ExecuteCommandDirective({
          actionId: "RECOVER_MISSING_PRODUCER_ARTIFACT",
          nextAction: guardedCommand("sennel flow run recover-missing-producer-artifact", this.state, this.binding),
          instruction: "Restore the exact producer Attempt through the catalog-checked recovery transition, then refresh next-action. Do not resume the consumer or create an artifact manually.",
          reason,
        });
      }
      if (this.recoveryCommand !== null) {
        return new ExecuteCommandDirective({
          actionId: "RECOVER_EXHAUSTED_TOOLING_RETRY",
          nextAction: this.recoveryCommand,
          instruction: "Apply the single audited tooling recovery after parent-derived evidence changed, then refresh next-action.",
          reason: this.descriptor.failureDisposition?.reason
            ?? "The exhausted tooling Attempt has changed canonical evidence.",
        });
      }
      const reason = `The failed ${this.missingProducerArtifactRoute.producerNodeId} Attempt did not publish the required canonical result for ${this.missingProducerArtifactRoute.consumerNodeId}; settlement is intentionally unavailable.`;
      return new BlockedDirective({
        code: "CANONICAL_PRODUCER_ARTIFACT_NOT_READY",
        reason,
        resumeInstruction: "No automatic recovery is admitted. Inspect the failed producer and its durable baseline before choosing a recovery. For an orphaned recovered Task Review without a result or baseline, inspect reconcile-task-review --dry-run with the exact target guards. recover-missing-producer-artifact is only for a historical consumer claim or gap. Do not create an artifact manually.",
      });
    }
    const reviewDisposition = this.descriptor.reviewDisposition;
    if (reviewDisposition?.operation === "repair-test-review") {
      return new RepairEvidenceDirective({
        actionId: "REPAIR_TEST_REVIEW",
        evidenceKind: "test",
        phase: "test",
        instruction: "Run the guarded test-review repair transition. It binds the rejected review Attempt and current cataloged test revision, then starts a replacement test worker Attempt.",
        reason: "The definition selected the repair route from the current canonical test-review evidence.",
        nextAction: guardedCommand("sennel flow run repair-test-review", this.state, this.binding),
      });
    }
    if (reviewDisposition?.operation === "repair-evidence-blocked") {
      return new BlockedDirective({
        code: "TEST_REVIEW_REPAIR_EVIDENCE_INVALID",
        reason: "The definition rejected the current test-review evidence as structurally unavailable for repair.",
        resumeInstruction: "Produce a canonical REJECTED test-review result with typed blocking findings and a current test revision; do not rerun or repair stale evidence directly.",
      });
    }
    if (reviewDisposition?.operation === "repair-no-change-task-impl") {
      return new ExecuteCommandDirective({
        actionId: "REPAIR_NO_CHANGE_TASK_IMPLEMENTATION",
        nextAction: guardedCommand("sennel flow run settle-review-transition", this.state, this.binding),
        instruction: "Apply the definition-selected no-change correction transition. It re-admits the rejected Task Review evidence and starts the bounded Task implementation round; do not edit source or retry Review directly.",
        reason: "The canonical Task Review rejected an empty source declaration for a mapped Requirement.",
      });
    }
    if (reviewDisposition?.operation === "task-rounds-exhausted") {
      return new BlockedDirective({
        code: "TASK_IMPLEMENTATION_ROUNDS_EXHAUSTED",
        reason: `The no-change Task correction exhausted its bounded implementation rounds (${reviewDisposition.attempts}/${reviewDisposition.maxAttempts}).`,
        resumeInstruction: "Revise the canonical Task or mapped Requirement evidence before starting another Flow; do not create a third Task implementation round.",
      });
    }
    if (reviewDisposition?.operation === "task-review-gate-handoff") {
      return new ExecuteCommandDirective({
        actionId: "SETTLE_TASK_REVIEW_GATE_HANDOFF",
        nextAction: guardedCommand("sennel flow run settle-review-transition", this.state, this.binding),
        instruction: "Settle the already-published fourth Task Review repair into Task Gate. This records no new review and is safe to repeat after an interrupted post lifecycle.",
        reason: "The definition selected the fourth Task Review Gate handoff from canonical review and mutation-lineage evidence.",
      });
    }
    if (reviewDisposition?.operation === "blocked") {
      const reason = `The definition exhausted ${reviewDisposition.phase} review retries (${reviewDisposition.attempts}/${reviewDisposition.maxAttempts}) for the current canonical evidence.`;
      return new BlockedDirective({
        code: "REVIEW_MAX_ATTEMPTS_EXCEEDED",
        reason,
        resumeInstruction: "Record changed canonical evidence and use the definition-owned retry recovery; do not rerun or repair this rejected review directly.",
      });
    }
    if (reviewDisposition?.operation === "defer") {
      return new ExecuteCommandDirective({
        actionId: "SETTLE_REVIEW_DEFER",
        nextAction: guardedCommand("sennel flow run settle-review-transition", this.state, this.binding),
        instruction: "Persist the definition-selected exhausted-review deferral and its canonical finding handoff, then refresh next-action. Do not rerun the active review.",
        reason: `The definition selected deferred disposition for exhausted ${reviewDisposition.phase} review evidence.`,
      });
    }
    if (reviewDisposition?.operation === "external-blocked") {
      const reason = `The definition classified the current ${reviewDisposition.phase} review result as an external tooling stop.`;
      return new BlockedDirective({
        code: "REVIEW_TOOLING_EXTERNAL_BLOCKED",
        reason,
        resumeInstruction: "Resolve the review tooling failure through its existing guarded recovery; do not treat it as a successful review decision.",
      });
    }
    if (this.planGateRepairRoute !== null) {
      return new RepairEvidenceDirective({
        actionId: "REPAIR_PLAN_GATE_EVIDENCE",
        evidenceKind: "gate",
        phase: this.planGateRepairRoute.phase,
        instruction: "Run the guarded plan-gate repair transition. It freezes the canonical blocking observations and rewinds to the mapped worker-artifact handoff step; do not edit canonical spec artifacts directly.",
        reason: this.planGateRepairReason,
        nextAction: guardedCommand("sennel flow run repair-plan-gate", this.state, this.binding),
      });
    }
    if (["start", "recover", "resume", "retry"].includes(this.descriptor.operation)) {
      return new ExecuteStepDirective({ action: this.action });
    }
    if (this.recoveryCommand !== null) {
      return new ExecuteCommandDirective({
        actionId: "RECOVER_EXHAUSTED_TOOLING_RETRY",
        nextAction: this.recoveryCommand,
        instruction: "Apply the single audited tooling recovery after parent-derived evidence changed, then refresh next-action.",
        reason: this.descriptor.failureDisposition?.reason
          ?? "The exhausted tooling Attempt has changed canonical evidence.",
      });
    }
    const disposition = this.descriptor.failureDisposition ?? null;
    const operation = disposition?.operation ?? this.descriptor.operation;
    if (["record", "rewind"].includes(operation)) {
      return new ExecuteCommandDirective({
        actionId: "SETTLE_CANONICAL_FAILURE",
        nextAction: guardedCommand("sennel flow run settle-failure", this.state, this.binding),
        instruction: operation === "record"
          ? "Record the exact failed Attempt through its definition-owned terminal transition, then refresh next-action."
          : "Rewind only through the definition-owned failed Attempt transition, then refresh next-action.",
        reason: disposition?.reason
          ?? "The current canonical Attempt has a definition-owned terminal transition.",
      });
    }
    const code = operation === "blocked"
      ? "CANONICAL_ATTEMPT_BLOCKED"
      : "CANONICAL_ATTEMPT_RECOVERY_REQUIRED";
    const reason = disposition?.reason
      ?? "The current canonical Attempt requires an explicit lifecycle recovery.";
    return new BlockedDirective({ code, reason, resumeInstruction: reason });
  }
}

export function assertNextActionDirective(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  if (data.directive == null) return;
  NextActionDirective.fromStored(data.directive);
  const competingFields = [
    "continuation",
    "actionPrompt",
    "reviewAction",
    "retryRecovery",
    "gateStop",
    "halt",
    "yieldsControl",
    "requiresUserAction",
  ].filter((field) => Object.hasOwn(data, field));
  if (competingFields.length > 0) {
    throw new Error(
      `NEXT_ACTION_DIRECTIVE_CONFLICT: directive cannot coexist with ${competingFields.join(", ")}`,
    );
  }
}
