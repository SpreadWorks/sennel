import { createHash } from "node:crypto";

function jsonClone(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new Error(`${field} must be JSON-serializable: ${error.message}`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Validated, prospective Draft Gate observation used before any canonical write. */
export class DraftGateProspectiveFacts {
  constructor({
    result,
    failureCategory = null,
    sameEvidence = false,
    retryExhausted = false,
    retryUsed = 0,
    retryMaximum = 1,
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
    };
  }
}

/** The one source Gate issue entry owned by a Draft Gate settlement. */
export class DraftGateIssuePublication {
  constructor({ binding, entry } = {}) {
    if (binding?.stepId !== "draft-gate" || typeof binding?.runId !== "string"
      || typeof binding?.specId !== "string" || typeof binding?.attempt?.id !== "string"
      || !Number.isSafeInteger(binding?.attempt?.sequence)) {
      throw new Error("Draft Gate issue publication requires its exact Attempt binding");
    }
    const source = jsonClone(entry, "Draft Gate issue publication entry");
    if (source.step !== "draft-gate" || source.phase !== "draft"
      || source.trigger !== "gate post hook (auto)" || !Number.isFinite(Date.parse(source.timestamp))) {
      throw new Error("Draft Gate issue publication entry is invalid");
    }
    delete source.issueLogId;
    const issueLogId = `draft-gate-result-${createHash("sha256").update(stableJson({
      runId: binding.runId,
      specId: binding.specId,
      attempt: { id: binding.attempt.id, sequence: binding.attempt.sequence },
      entry: source,
    })).digest("hex")}`;
    this.binding = Object.freeze({
      runId: binding.runId,
      specId: binding.specId,
      stepId: binding.stepId,
      attemptId: binding.attempt.id,
      attemptSequence: binding.attempt.sequence,
    });
    this.entry = Object.freeze({ ...source, issueLogId });
    Object.freeze(this);
  }

  matches(binding) {
    return binding?.runId === this.binding.runId
      && binding?.specId === this.binding.specId
      && binding?.stepId === this.binding.stepId
      && binding?.attempt?.id === this.binding.attemptId
      && binding?.attempt?.sequence === this.binding.attemptSequence;
  }

  toJSON() {
    return {
      binding: { ...this.binding },
      entry: structuredClone(this.entry),
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
