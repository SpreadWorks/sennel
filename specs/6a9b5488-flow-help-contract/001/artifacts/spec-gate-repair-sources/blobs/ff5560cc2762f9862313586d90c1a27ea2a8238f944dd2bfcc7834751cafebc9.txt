import { createI18n } from "../../lib/i18n.js";
import { guardedCommand } from "./guarded-command.js";
import {
  UserActionChoice,
  UserActionImpact,
  UserActionPrompt,
} from "./user-action-prompt.js";

const APPROVAL_MESSAGE_NAMES = Object.freeze([
  "question",
  "approve",
  "reviewSummary",
  "reviewFull",
  "requestChanges",
  "other",
  "approvalRecord",
  "approvalState",
  "recommendationReason",
]);

export class FlowDecisionMessages {
  constructor({ root, config, decision, names }) {
    if (typeof decision !== "string" || decision.trim() === "") {
      throw new Error("FlowDecisionMessages decision is required");
    }
    if (!Array.isArray(names) || names.length === 0) {
      throw new Error("FlowDecisionMessages names are required");
    }
    const translate = createI18n(config?.lang || "en", {
      domain: "messages",
      projectRoot: root,
      presetTypes: config?.type ?? [],
    });
    this.decision = decision;
    this.values = Object.freeze(Object.fromEntries(names.map((name) => [
      name,
      translate(`flow.${decision}.${name}`),
    ])));
    Object.freeze(this);
  }

  get(name) {
    if (!Object.hasOwn(this.values, name)) {
      throw new Error(`FlowDecisionMessages ${this.decision}.${name} is not defined`);
    }
    return this.values[name];
  }
}

/**
 * The approval scene has one locale-backed definition. It can be projected as
 * the dispatcher UserActionPrompt or as the legacy get-prompt data shape
 * without allowing their labels or recommended choice to drift apart.
 */
export class ApprovalDecisionPrompt {
  constructor({ root, config }) {
    this.messages = new FlowDecisionMessages({
      root,
      config,
      decision: "approvalDecision",
      names: APPROVAL_MESSAGE_NAMES,
    });
    Object.freeze(this);
  }

  toUserActionPrompt({ state = null, binding = null } = {}) {
    const messages = this.messages;
    const command = (value) => guardedCommand(value, state, binding);
    return new UserActionPrompt({
      question: messages.get("question"),
      choices: [
        new UserActionChoice({
          actionId: "APPROVE_SPECIFICATION",
          label: messages.get("approve"),
          stateTransition: "resume-current-approval-boundary",
          impact: new UserActionImpact({ changes: [messages.get("approvalRecord")] }),
        }),
        new UserActionChoice({
          actionId: "REVIEW_SPECIFICATION_SUMMARY",
          label: messages.get("reviewSummary"),
          nextAction: command("sennel flow get artifact spec.record --mode summary"),
          impact: new UserActionImpact({ retains: [messages.get("approvalState")] }),
        }),
        new UserActionChoice({
          actionId: "REVIEW_SPECIFICATION_FULL",
          label: messages.get("reviewFull"),
          nextAction: command("sennel flow get artifact spec.record --mode full"),
          impact: new UserActionImpact({ retains: [messages.get("approvalState")] }),
        }),
        new UserActionChoice({
          actionId: "REQUEST_SPECIFICATION_CHANGES",
          label: messages.get("requestChanges"),
          stateTransition: "request-specification-changes",
          impact: new UserActionImpact({ retains: [messages.get("approvalState")] }),
        }),
        new UserActionChoice({
          actionId: "OTHER_APPROVAL_RESPONSE",
          label: messages.get("other"),
          stateTransition: "collect-other-approval-response",
          impact: new UserActionImpact({ retains: [messages.get("approvalState")] }),
        }),
      ],
      recommendedActionId: "REVIEW_SPECIFICATION_SUMMARY",
      recommendationReason: messages.get("recommendationReason"),
    });
  }

  toPromptData({ state = null, binding = null } = {}) {
    const prompt = this.toUserActionPrompt({ state, binding });
    return {
      phase: "plan",
      step: "approval",
      description: prompt.question,
      recommendation: prompt.recommendationReason,
      choices: prompt.choices.map((choice, index) => ({
        id: index + 1,
        label: choice.label,
        description: choice.reason || "",
        recommended: choice.actionId === prompt.recommendedActionId,
      })),
    };
  }
}
