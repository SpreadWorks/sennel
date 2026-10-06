/** Durable identity of one trusted, Definition-selected Requirement-test settlement. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DraftStepSettlementReceiptValue } from "./draft-step-settlement-receipt.js";
import { RequirementTestSourceAttempt } from "./requirement-test-lifecycle.js";
import { StepResult, STEP_RESULT_REGISTRY, stepResultDigest } from "../engine/step-result.js";

const LEAVES = new Set(["approval", "test-generate", "test-review", "test-repair", "test-gate"]);
const READBACK_TOKEN = Symbol("Requirement test receipt readback");
const RECEIPT_FIELDS = ["id", "binding", "resultKind", "resultType", "resultDigest", "settlementKind", "settlementDigest", "targetStepId", "connectorName", "publicationDigest", "requestDigest"];

function exactFields(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) {
    throw new TypeError(`${label} has invalid fields`);
  }
}

function text(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} requires text`);
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${label} requires a SHA-256 digest`);
  return value;
}

function jsonDigest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

/** Exact Flow/Step/Attempt identity, with the same flat wire fields as existing receipts. */
export class RequirementTestSettlementBinding {
  constructor(value) {
    exactFields(value, ["runId", "specId", "stepId", "attemptId", "attemptSequence"], "Requirement test receipt binding");
    this.runId = text(value.runId, "receipt runId");
    this.specId = text(value.specId, "receipt specId");
    if (!LEAVES.has(value.stepId)) throw new TypeError("Requirement test receipt Step is invalid");
    this.stepId = value.stepId;
    const attempt = new RequirementTestSourceAttempt({ id: value.attemptId, sequence: value.attemptSequence });
    this.attemptId = attempt.id;
    this.attemptSequence = attempt.sequence;
    Object.freeze(this);
  }
  static capture(binding) {
    return new RequirementTestSettlementBinding({ runId: binding?.runId, specId: binding?.specId, stepId: binding?.stepId,
      attemptId: binding?.attempt?.id, attemptSequence: binding?.attempt?.sequence });
  }
  static fromJSON(value) { return new RequirementTestSettlementBinding(value); }
  toJSON() { return { runId: this.runId, specId: this.specId, stepId: this.stepId, attemptId: this.attemptId, attemptSequence: this.attemptSequence }; }
}

function selectedIdentity(settlement, result) {
  if (settlement === null || typeof settlement !== "object" || settlement.constructor === Object
    || typeof settlement.toJSON !== "function" || settlement.sourceStepId !== result.stepId
    || settlement.resultKind !== result.kind || settlement.resultType !== result.type
    || !["target-connection", "execution", "await", "failure"].includes(settlement.kind)) {
    throw new TypeError("Requirement test receipt requires the exact typed Result and selected Settlement");
  }
  const target = settlement.kind === "target-connection";
  if (target ? typeof settlement.connector !== "function" : ("connector" in settlement || "targetStepId" in settlement)) {
    throw new TypeError("Requirement test receipt Settlement connector does not match its kind");
  }
  return {
    settlementKind: settlement.kind,
    settlementDigest: jsonDigest(settlement.toJSON()),
    targetStepId: target ? text(settlement.targetStepId, "receipt target Step") : null,
    connectorName: target ? text(settlement.connector.name, "receipt Connector name") : null,
  };
}

export class RequirementTestSettlementReceipt extends DraftStepSettlementReceiptValue {
  constructor(value, token = null) {
    super();
    if (token === READBACK_TOKEN) {
      exactFields(value, RECEIPT_FIELDS, "stored Requirement test settlement receipt");
      this.binding = RequirementTestSettlementBinding.fromJSON(value.binding);
      this.resultKind = text(value.resultKind, "receipt Result kind");
      this.resultType = text(value.resultType, "receipt Result type");
      for (const field of ["resultDigest", "settlementDigest", "publicationDigest", "requestDigest"]) this[field] = digest(value[field], `receipt ${field}`);
      if (!["target-connection", "execution", "await", "failure"].includes(value.settlementKind)) throw new TypeError("receipt Settlement kind is invalid");
      this.settlementKind = value.settlementKind;
      const target = this.settlementKind === "target-connection";
      if (!target && (value.targetStepId !== null || value.connectorName !== null)) throw new TypeError("receipt stop cannot carry target or Connector identity");
      this.targetStepId = target ? text(value.targetStepId, "receipt target Step") : null;
      this.connectorName = target ? text(value.connectorName, "receipt Connector name") : null;
      this.id = digest(value.id, "receipt id");
      if (this.id !== jsonDigest(this.#identity())) throw new TypeError("stored Requirement test settlement receipt identity is invalid");
    } else {
      exactFields(value, ["binding", "result", "settlement", "publicationDigest", "requestDigest"], "Requirement test settlement receipt input");
      if (!(value.result instanceof StepResult)) throw new TypeError("Requirement test receipt requires a typed StepResult");
      this.binding = value.binding instanceof RequirementTestSettlementBinding ? value.binding : RequirementTestSettlementBinding.capture(value.binding);
      this.resultKind = value.result.kind;
      this.resultType = value.result.type;
      this.resultDigest = stepResultDigest(value.result);
      Object.assign(this, selectedIdentity(value.settlement, value.result));
      this.publicationDigest = digest(value.publicationDigest, "receipt publication digest");
      this.requestDigest = digest(value.requestDigest, "receipt request digest");
      this.id = jsonDigest(this.#identity());
      this.assertMatches({ result: value.result, settlement: value.settlement });
    }
    Object.freeze(this);
  }

  static fromJSON(value, expected = {}) {
    const receipt = new RequirementTestSettlementReceipt(value, READBACK_TOKEN);
    const entry = STEP_RESULT_REGISTRY.find((candidate) => candidate.kind === receipt.resultKind);
    if (entry === undefined || entry.stepId !== receipt.binding.stepId || entry.type !== receipt.resultType) {
      throw new TypeError("stored Requirement test receipt Result kind/type/Step do not match");
    }
    receipt.assertMatches(expected);
    return receipt;
  }

  assertMatches({ binding = null, result = null, settlement = null, publicationDigest = null, requestDigest = null } = {}) {
    if (binding !== null) {
      const expected = binding instanceof RequirementTestSettlementBinding ? binding : RequirementTestSettlementBinding.capture(binding);
      if (!isDeepStrictEqual(this.binding.toJSON(), expected.toJSON())) throw new TypeError("Requirement test receipt binding is stale");
    }
    if (result !== null) {
      if (!(result instanceof StepResult) || result.stepId !== this.binding.stepId || result.kind !== this.resultKind
        || result.type !== this.resultType || stepResultDigest(result) !== this.resultDigest) throw new TypeError("Requirement test receipt Result does not match");
      const source = result.binding ?? result.evidence;
      if (source?.runId !== undefined && (source.runId !== this.binding.runId || source.specId !== this.binding.specId
        || source.attempt?.id !== this.binding.attemptId || source.attempt?.sequence !== this.binding.attemptSequence)) {
        throw new TypeError("Requirement test receipt source Attempt does not match Result evidence");
      }
    }
    if (settlement !== null) {
      if (!(result instanceof StepResult)) throw new TypeError("receipt selection validation requires its typed Result");
      const selected = selectedIdentity(settlement, result);
      if (Object.entries(selected).some(([field, expected]) => this[field] !== expected)) throw new TypeError("Requirement test receipt Settlement does not match");
    }
    if (publicationDigest !== null && this.publicationDigest !== publicationDigest) throw new TypeError("Requirement test receipt publication does not match");
    if (requestDigest !== null && this.requestDigest !== requestDigest) throw new TypeError("Requirement test receipt request does not match");
    return this;
  }

  #identity() { return { binding: this.binding.toJSON(), resultKind: this.resultKind, resultType: this.resultType,
    resultDigest: this.resultDigest, settlementKind: this.settlementKind, settlementDigest: this.settlementDigest,
    targetStepId: this.targetStepId, connectorName: this.connectorName, publicationDigest: this.publicationDigest,
    requestDigest: this.requestDigest }; }
  toJSON() { return { id: this.id, ...this.#identity() }; }
}
