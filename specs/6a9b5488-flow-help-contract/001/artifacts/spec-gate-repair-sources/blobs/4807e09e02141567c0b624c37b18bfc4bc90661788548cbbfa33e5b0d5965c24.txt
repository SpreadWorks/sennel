import { createHash } from "node:crypto";

const SHA256_DIGEST = /^[a-f0-9]{64}$/;

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredDigest(value, field) {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    throw new TypeError(`${field} must be a SHA-256 digest`);
  }
  return value;
}

function requireExactFields(value, fields, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new TypeError(`${field} has invalid fields`);
  }
  return value;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

/** Normalized identity of the user's one answer or discard decision. */
export class DraftQuestionResolutionIdentity {
  constructor({ kind, answer = null, why = null, considered = "", reason = null } = {}) {
    if (!new Set(["answer", "discard"]).has(kind)) {
      throw new TypeError("Draft question resolution kind is invalid");
    }
    this.kind = kind;
    if (kind === "answer") {
      this.answer = requiredText(answer, "Draft answer");
      this.why = requiredText(why, "Draft answer rationale");
      this.considered = typeof considered === "string" ? considered.trim() : "";
      this.reason = null;
    } else {
      this.answer = null;
      this.why = null;
      this.considered = null;
      this.reason = requiredText(reason, "Draft discard reason");
    }
    Object.freeze(this);
  }

  static answer({ answer, why, considered = "" } = {}) {
    return new DraftQuestionResolutionIdentity({ kind: "answer", answer, why, considered });
  }

  static discard(reason) {
    return new DraftQuestionResolutionIdentity({ kind: "discard", reason });
  }

  static fromJSON(value) {
    if (value?.kind === "answer") {
      requireExactFields(
        value,
        ["kind", "answer", "why", "considered"],
        "stored Draft answer resolution",
      );
    } else if (value?.kind === "discard") {
      requireExactFields(value, ["kind", "reason"], "stored Draft discard resolution");
    } else {
      throw new TypeError("stored Draft question resolution is invalid");
    }
    return new DraftQuestionResolutionIdentity(value);
  }

  equals(other) {
    return other instanceof DraftQuestionResolutionIdentity
      && stableJson(this.toJSON()) === stableJson(other.toJSON());
  }

  apply(planFactory) {
    return this.kind === "answer"
      ? planFactory.answer({ answer: this.answer, why: this.why, considered: this.considered })
      : planFactory.discard({ reason: this.reason });
  }

  toJSON() {
    return this.kind === "answer"
      ? { kind: this.kind, answer: this.answer, why: this.why, considered: this.considered }
      : { kind: this.kind, reason: this.reason };
  }
}

/** Durable authority to re-enter one draft-refine Attempt after one exact answer. */
export class DraftQuestionResumeReceipt {
  constructor({
    binding,
    awaitReceiptId,
    questionId,
    questionRevision,
    resolution,
    sourceDigest,
    sourceByteLength,
    outputDigest,
  } = {}) {
    if (binding?.stepId !== "draft-refine") {
      throw new TypeError("Draft resume receipt must bind draft-refine");
    }
    for (const field of ["runId", "specId", "attemptId"]) {
      requiredText(binding?.[field], `Draft resume binding ${field}`);
    }
    if (!Number.isSafeInteger(binding?.attemptSequence) || binding.attemptSequence < 1) {
      throw new TypeError("Draft resume Attempt sequence is invalid");
    }
    if (!Number.isSafeInteger(questionRevision) || questionRevision < 0) {
      throw new TypeError("Draft resume question revision is invalid");
    }
    if (!(resolution instanceof DraftQuestionResolutionIdentity)) {
      throw new TypeError("Draft resume receipt requires a typed resolution identity");
    }
    if (!Number.isSafeInteger(sourceByteLength) || sourceByteLength < 0) {
      throw new TypeError("Draft resume source byte length is invalid");
    }
    this.binding = Object.freeze({
      runId: binding.runId,
      specId: binding.specId,
      stepId: binding.stepId,
      attemptId: binding.attemptId,
      attemptSequence: binding.attemptSequence,
    });
    this.awaitReceiptId = requiredDigest(awaitReceiptId, "Draft Await receipt ID");
    this.questionId = requiredText(questionId, "Draft resume question ID");
    this.questionRevision = questionRevision;
    this.resolution = resolution;
    this.sourceDigest = requiredDigest(sourceDigest, "Draft resume source digest");
    this.sourceByteLength = sourceByteLength;
    this.outputDigest = requiredDigest(outputDigest, "Draft resume output digest");
    this.id = createHash("sha256").update(stableJson(this.identity())).digest("hex");
    Object.freeze(this);
  }

  static fromJSON(value) {
    requireExactFields(value, [
      "id",
      "binding",
      "awaitReceiptId",
      "questionId",
      "questionRevision",
      "resolution",
      "sourceDigest",
      "sourceByteLength",
      "outputDigest",
    ], "stored Draft resume receipt");
    requireExactFields(value.binding, [
      "runId",
      "specId",
      "stepId",
      "attemptId",
      "attemptSequence",
    ], "stored Draft resume binding");
    const receipt = new DraftQuestionResumeReceipt({
      ...value,
      resolution: DraftQuestionResolutionIdentity.fromJSON(value.resolution),
    });
    if (value.id !== receipt.id) throw new TypeError("stored Draft resume receipt identity is invalid");
    return receipt;
  }

  identity() {
    return {
      binding: { ...this.binding },
      awaitReceiptId: this.awaitReceiptId,
      questionId: this.questionId,
      questionRevision: this.questionRevision,
      resolution: this.resolution.toJSON(),
      sourceDigest: this.sourceDigest,
      sourceByteLength: this.sourceByteLength,
      outputDigest: this.outputDigest,
    };
  }

  matchesRequest({ binding, questionId, questionRevision, resolution } = {}) {
    return binding?.runId === this.binding.runId
      && binding?.specId === this.binding.specId
      && binding?.stepId === this.binding.stepId
      && binding?.attemptId === this.binding.attemptId
      && binding?.attemptSequence === this.binding.attemptSequence
      && questionId === this.questionId
      && questionRevision === this.questionRevision
      && this.resolution.equals(resolution);
  }

  toJSON() { return { id: this.id, ...this.identity() }; }
}
