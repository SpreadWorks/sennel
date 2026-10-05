import { DraftGateIssuePublication } from "./gate-issue-publication.js";
import { AgentResponseProtocolEvidence } from "../../lib/agent-response-protocol.js";
export { DraftGateIssuePublication } from "./gate-issue-publication.js";

/** Validated, prospective Draft Gate observation used before any canonical write. */
export class DraftGateProspectiveFacts {
  constructor({
    result,
    failureCategory = null,
    sameEvidence = false,
    retryExhausted = false,
    retryUsed = 0,
    retryMaximum = 1,
    failureCode = null,
    failureReason = null,
    failureMode = null,
    responseProtocolEvidence = null,
  } = {}) {
    if (!["pass", "fail"].includes(result)) throw new Error("prospective Draft Gate result is invalid");
    if ((result === "fail") !== (typeof failureCategory === "string" && failureCategory !== "")) {
      throw new Error("prospective Draft Gate failure classification is invalid");
    }
    if (typeof sameEvidence !== "boolean" || typeof retryExhausted !== "boolean") {
      throw new Error("prospective Draft Gate convergence facts are invalid");
    }
    if (!Number.isSafeInteger(retryUsed) || retryUsed < 0
      || !Number.isSafeInteger(retryMaximum) || retryMaximum < 1
      || retryUsed > retryMaximum) {
      throw new Error("prospective Draft Gate retry usage is invalid");
    }
    this.result = result;
    this.failureCategory = failureCategory;
    this.sameEvidence = sameEvidence;
    this.retryExhausted = retryExhausted;
    this.retryUsed = retryUsed;
    this.retryMaximum = retryMaximum;
    for (const [field, value] of Object.entries({ failureCode, failureReason, failureMode })) {
      if (value !== null && (typeof value !== "string" || value.trim() === "")) {
        throw new TypeError(`prospective Draft Gate ${field} must be non-empty`);
      }
      if (result === "pass" && value !== null) {
        throw new TypeError("passing Draft Gate cannot have failure diagnostics");
      }
      this[field] = value;
    }
    this.responseProtocolEvidence = responseProtocolEvidence === null
      ? null
      : AgentResponseProtocolEvidence.from(responseProtocolEvidence);
    Object.freeze(this);
  }

  toJSON() {
    return {
      result: this.result,
      failureCategory: this.failureCategory,
      sameEvidence: this.sameEvidence,
      retryExhausted: this.retryExhausted,
      retryUsed: this.retryUsed,
      retryMaximum: this.retryMaximum,
      ...(this.failureCode === null ? {} : { failureCode: this.failureCode }),
      ...(this.failureReason === null ? {} : { failureReason: this.failureReason }),
      ...(this.failureMode === null ? {} : { failureMode: this.failureMode }),
      ...(this.responseProtocolEvidence === null ? {} : {
        responseProtocolEvidence: this.responseProtocolEvidence.toJSON(),
      }),
    };
  }
}

/** Facts and exactly the durable issue evidence allowed by the Gate disposition. */
export class DraftGatePublicationIntent {
  constructor({ facts, issue = null } = {}) {
    if (!(facts instanceof DraftGateProspectiveFacts)) {
      throw new Error("Draft Gate publication intent requires typed facts");
    }
    if (facts.result === "pass" && issue !== null) {
      throw new Error("passing Draft Gate publication must not contain issue evidence");
    }
    if (facts.result === "fail" && !(issue instanceof DraftGateIssuePublication)) {
      throw new Error("failing Draft Gate publication requires typed issue evidence");
    }
    this.facts = facts;
    this.issue = issue;
    Object.freeze(this);
  }

  toJSON() {
    return { facts: this.facts.toJSON(), issue: this.issue?.toJSON() ?? null };
  }
}
