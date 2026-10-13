import { isDeepStrictEqual } from "node:util";
import { Observation, NextAction } from "./lib/observation.js";
import { canonicalSourceFindingObservations, CanonicalSourceFindingObservation } from "./lib/flow-finding-source.js";
import { parseSpecGateRepairPermissions } from "./lib/spec-repair-operations.js";

/** Read a complete saved Observation without applying producer normalization. */
export function validateRecordedGateObservation(value) {
  const saved = value instanceof Observation ? value.toJSON() : value;
  const observation = Observation.fromJSON(saved);
  if (!isDeepStrictEqual(saved, observation.toJSON())) {
    throw new TypeError("Gate observation differs from its complete stored type");
  }
  if (observation.specRevision !== undefined) {
    const permissions = parseSpecGateRepairPermissions(observation.allowedTargets, "stored Gate finding");
    if (!isDeepStrictEqual(observation.allowedTargets, permissions.map((permission) => permission.toJSON()))) {
      throw new TypeError("Gate observation repair permissions differ from their stored type");
    }
  }
  return observation;
}

/** One Gate finding at its canonical source position, with its established identity. */
export class GateFindingObservation {
  constructor(source) {
    if (!(source instanceof CanonicalSourceFindingObservation)) {
      throw new TypeError("Gate finding requires its canonical source observation");
    }
    this.observation = validateRecordedGateObservation(source.finding);
    this.identity = source.identity;
    this.finding = source.finding;
    this.jsonPointer = source.jsonPointer;
    Object.freeze(this);
  }
}

/** Validate duplicate saved facets, then enumerate the single observation authority. */
export function canonicalGateFindingObservations({ artifact, sourceStep, sourceArtifact }) {
  if (!sourceStep.endsWith("-gate")) throw new TypeError("Gate findings require their canonical Gate source Step");
  const payload = artifact?.artifacts ?? artifact;
  let primary = [];
  if (payload.nextAction !== undefined) {
    const next = NextAction.fromJSON(payload.nextAction);
    if (!isDeepStrictEqual(next.toJSON(), payload.nextAction)) {
      throw new TypeError("Gate next action differs from its complete stored type");
    }
    primary = payload.nextAction.diagnosis.observations;
  } else if (payload.observations !== undefined) {
    if (!Array.isArray(payload.observations)) throw new TypeError("Gate observations must be a saved array");
    primary = payload.observations;
  }
  primary.forEach(validateRecordedGateObservation);
  if (payload.observations !== undefined && !isDeepStrictEqual(payload.observations, primary)) {
    throw new TypeError("Gate observation mirror differs from its saved diagnosis");
  }
  for (const criterion of payload.evaluations ?? []) {
    if (criterion.observations === undefined) continue;
    if (!Array.isArray(criterion.observations)) throw new TypeError("Gate criterion observations must be a saved array");
    for (const value of criterion.observations) {
      const observation = validateRecordedGateObservation(value);
      if (observation.requirementRef !== criterion.guardrail_id
        || !primary.some((saved) => isDeepStrictEqual(saved, observation.toJSON()))) {
        throw new TypeError("Gate criterion observation does not match its saved diagnosis and criterion");
      }
    }
  }
  return Object.freeze(canonicalSourceFindingObservations({ artifact, sourceStep, sourceArtifact })
    .filter((source) => /\/(?:nextAction\/diagnosis\/observations|observations)\/\d+$/.test(source.jsonPointer))
    .map((source) => new GateFindingObservation(source)));
}

/** Closed public meaning of a retained Gate observation; no execution authority. */
export class GateFindingSpecific {
  constructor(value) {
    this.observation = value instanceof GateFindingObservation ? value.observation : validateRecordedGateObservation(value);
    Object.freeze(this);
  }
  toJSON() {
    const value = this.observation;
    return { schemaId: "gate-finding@1", kind: value.kind, failureMode: value.failureMode,
      requirementRef: value.requirementRef, where: structuredClone(value.where), refs: [...value.refs],
      specRevision: value.specRevision ?? null, targets: value.targets === undefined ? null : structuredClone(value.targets),
      allowedTargets: value.allowedTargets === undefined ? null : structuredClone(value.allowedTargets) };
  }
}

const text = { type: "string", minLength: 1 };
const object = (properties) => ({ type: "object", required: Object.keys(properties), properties, additionalProperties: false });
const target = { oneOf: [
  object({ entity: { type: "string", enum: ["spec"] }, field: text }),
  object({ entity: { type: "string", enum: ["requirement", "task"] }, id: text, field: text }),
  object({ collection: text }),
  object({ collection: text, position: { type: "integer", minimum: 0 } }),
] };
const permission = object({ target, operationKinds: { type: "array", minItems: 1, uniqueItems: true,
  items: { type: "string", enum: ["replace-field", "replace-entity-field", "edit-text-field", "add-array-element",
    "replace-array-element", "delete-array-element", "delete-entity-field", "add-entity-field"] } } });
const location = { type: ["object", "null"], required: ["file"], properties: { file: text, locator: text }, additionalProperties: false };

/** Single source for the Gate-specific fragment in the generated response Schema. */
export const FLOW_QUERY_GATE_FINDING_SPECIFIC_SCHEMA = Object.freeze({ ...object({
  schemaId: { type: "string", enum: ["gate-finding@1"] }, kind: { type: "string", enum: ["violation"] },
  failureMode: { type: "string", enum: ["spec-impl-mismatch", "guardrail-violation", "process-evidence-missing"] },
  requirementRef: { type: "string" }, where: location, refs: { type: "array", items: text },
  specRevision: { type: ["string", "null"], pattern: "^sha256:[a-f0-9]{64}$" },
  targets: { type: ["array", "null"], minItems: 1, items: { oneOf: [...target.oneOf, object({ document: { type: "string", enum: ["spec"] } })] } },
  allowedTargets: { type: ["array", "null"], minItems: 1, items: permission },
}), oneOf: [
  { type: "object", properties: { specRevision: { type: "null" }, targets: { type: "null" }, allowedTargets: { type: "null" } } },
  { type: "object", properties: { specRevision: { type: "string" }, targets: { type: "array" }, allowedTargets: { type: "array" } } },
] });
