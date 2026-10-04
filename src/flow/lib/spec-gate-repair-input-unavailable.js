import { isDeepStrictEqual } from "node:util";
import { FlowFindingSourceIdentity } from "./flow-finding-source.js";
import { SpecGateRepairBundle } from "./spec-gate-repair-bundle.js";

const STAGE = "spec-gate-repair-input-unavailable";
const REASONS = Object.freeze(["file-read-failed", "context-limit", "context-unavailable"]);
const BINDING_FIELDS = Object.freeze(["runId", "specId", "stepId", "attemptId", "attemptSequence",
  "inputDigest", "inputRevision", "requestDigest"]);

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) {
    throw new TypeError(`${label} has an invalid shape`);
  }
}

/** The immutable input identity is readable even when the selected body is unavailable. */
export class SpecGateRepairSelectedInputIdentity {
  static selectionFromDocument(document, selectionDigest) {
    const selections = document.mode === "repair" ? SpecGateRepairBundle.fromJSON(document.bundle).selections() : [];
    return new SpecGateRepairSelectedContentIdentity({ baseRevision: document.baseRevision, selectionDigest,
      mode: document.mode, unitIds: selections.map((selection) => selection.unit.id),
      findingIdentities: document.mode === "locate" ? [document.finding.identity]
        : selections.flatMap((selection) => selection.unit.findings.map((finding) => finding.identity)) });
  }

  constructor({ binding, baseRevision, selectionDigest, mode, unitIds, findingIdentities }) {
    exactKeys(binding, BINDING_FIELDS, "Gate repair input binding");
    if (binding.stepId !== "spec-gate-repair"
      || !BINDING_FIELDS.filter((key) => key !== "attemptSequence").every((key) => (
        typeof binding[key] === "string" && binding[key].length > 0
      )) || !Number.isSafeInteger(binding.attemptSequence) || binding.attemptSequence < 1) {
      throw new TypeError("Gate repair selected input identity is invalid");
    }
    const content = new SpecGateRepairSelectedContentIdentity({ baseRevision, selectionDigest, mode,
      unitIds, findingIdentities });
    this.binding = Object.freeze({ ...binding });
    this.baseRevision = content.baseRevision;
    this.selectionDigest = content.selectionDigest;
    this.mode = content.mode;
    this.unitIds = content.unitIds;
    this.findingIdentities = content.findingIdentities;
    Object.freeze(this);
  }

  static fromRequest(request) {
    const input = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json");
    if (input === undefined) throw new TypeError("Gate repair request has no selected input");
    const locator = input.descriptor.canonicalLocator;
    const content = input.descriptor.selectedIdentity;
    return new SpecGateRepairSelectedInputIdentity({
      binding: { runId: request.runId, specId: request.specId, stepId: request.stepId,
        attemptId: locator.attemptId, attemptSequence: locator.attemptSequence,
        inputDigest: request.inputDigest, inputRevision: request.inputRevision, requestDigest: request.requestDigest },
      ...content.toJSON(),
    });
  }

  toJSON() {
    return { binding: this.binding, baseRevision: this.baseRevision, selectionDigest: this.selectionDigest,
      mode: this.mode, unitIds: this.unitIds,
      findingIdentities: this.findingIdentities.map((identity) => identity.toJSON()) };
  }
}

/** Selection metadata belongs in the bounded manifest, independently of its request binding. */
export class SpecGateRepairSelectedContentIdentity {
  constructor({ baseRevision, selectionDigest, mode, unitIds, findingIdentities }) {
    if (!/^sha256:[a-f0-9]{64}$/.test(baseRevision) || !/^[a-f0-9]{64}$/.test(selectionDigest)
      || !["repair", "locate"].includes(mode)
      || !Array.isArray(unitIds) || unitIds.some((id) => typeof id !== "string" || !id)
      || new Set(unitIds).size !== unitIds.length
      || !Array.isArray(findingIdentities) || findingIdentities.length === 0
      || mode === "locate" && unitIds.length !== 0 || mode === "repair" && unitIds.length === 0) {
      throw new TypeError("Gate repair selected content identity is invalid");
    }
    const identities = findingIdentities.map((value) => new FlowFindingSourceIdentity(value));
    if (new Set(identities.map((value) => value.toString())).size !== identities.length) {
      throw new TypeError("Gate repair selected input has duplicate findings");
    }
    this.baseRevision = baseRevision;
    this.selectionDigest = selectionDigest;
    this.mode = mode;
    this.unitIds = Object.freeze([...unitIds]);
    this.findingIdentities = Object.freeze(identities);
    Object.freeze(this);
  }
  toJSON() { return { baseRevision: this.baseRevision, selectionDigest: this.selectionDigest,
    mode: this.mode, unitIds: this.unitIds,
    findingIdentities: this.findingIdentities.map((identity) => identity.toJSON()) }; }
}

/** A typed, exclusive worker disposition; it never grants mutation or retry authority. */
export class SpecGateRepairInputUnavailable {
  constructor({ version, stage, binding, baseRevision, selectionDigest, mode, unitIds, findingIdentities,
    reason, explanation }) {
    if (version !== 1 || stage !== STAGE || !REASONS.includes(reason)
      || typeof explanation !== "string" || explanation.trim() === "") {
      throw new TypeError("Gate repair input unavailable response is invalid");
    }
    this.identity = new SpecGateRepairSelectedInputIdentity({ binding, baseRevision, selectionDigest,
      mode, unitIds, findingIdentities });
    this.reason = reason;
    this.explanation = explanation;
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, ["version", "stage", "binding", "baseRevision",
      "selectionDigest", "mode", "unitIds", "findingIdentities", "reason", "explanation"],
    "Gate repair input unavailable response");
    return new SpecGateRepairInputUnavailable(value);
  }

  static fromRequest(request, { reason, explanation }) {
    return new SpecGateRepairInputUnavailable({ version: 1, stage: STAGE,
      ...SpecGateRepairSelectedInputIdentity.fromRequest(request).toJSON(), reason, explanation });
  }

  assertRequest(request) {
    if (!isDeepStrictEqual(this.identity.toJSON(), SpecGateRepairSelectedInputIdentity.fromRequest(request).toJSON())) {
      throw new TypeError("Gate repair input unavailable response differs from its exact selected request");
    }
    return this;
  }

  toJSON() { return { version: 1, stage: STAGE, ...this.identity.toJSON(),
    reason: this.reason, explanation: this.explanation }; }

  toError() {
    const error = new Error(`Spec Gate repair input unavailable (${this.reason}): ${this.explanation}`);
    error.code = "FLOW_SPEC_GATE_REPAIR_INPUT_UNAVAILABLE";
    error.data = { ...this.identity.toJSON(), reason: this.reason, explanation: this.explanation };
    return error;
  }
}
