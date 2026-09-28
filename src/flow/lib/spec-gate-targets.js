import { SpecRepairTarget, specRepairTargetEntries,
  validateSpecGateRepairPermissions } from "./spec-repair-operations.js";

const REVISION = /^sha256:[a-f0-9]{64}$/;

function key(value) { return JSON.stringify(value); }

function targetSchema(entries, { document = true } = {}) {
  const choices = entries.map((entry) => entry.target.toJSON());
  const object = (properties) => ({ type: "object", properties,
    required: Object.keys(properties), additionalProperties: false });
  const single = (value) => ({ type: typeof value, enum: [value] });
  const alternatives = [];
  if (document) alternatives.push(object({ document: single("spec") }));
  const roots = choices.filter((target) => target.entity === "spec");
  if (roots.length) alternatives.push(object({ entity: single("spec"),
    field: { type: "string", enum: roots.map((target) => target.field) } }));
  for (const entity of ["requirement", "task"]) {
    const entityChoices = choices.filter((target) => target.entity === entity);
    const fields = [...new Set(entityChoices.map((target) => target.field))];
    const groups = new Map();
    for (const field of fields) {
      const ids = [...new Set(entityChoices.filter((target) => target.field === field)
        .map((target) => target.id))].sort();
      const idSet = key(ids);
      if (!groups.has(idSet)) groups.set(idSet, { ids, fields: [] });
      groups.get(idSet).fields.push(field);
    }
    for (const group of groups.values()) alternatives.push(object({ entity: single(entity),
      id: { type: "string", enum: group.ids }, field: { type: "string", enum: group.fields } }));
  }
  const anchors = choices.filter((target) => Object.hasOwn(target, "collection")
    && !Object.hasOwn(target, "position")).map((target) => target.collection);
  if (anchors.length) alternatives.push(object({ collection: { type: "string", enum: anchors } }));
  const collections = [...new Set(choices.filter((target) => Object.hasOwn(target, "position"))
    .map((target) => target.collection))];
  const positionGroups = new Map();
  for (const collection of collections) {
    const positions = choices.filter((target) => target.collection === collection
      && Object.hasOwn(target, "position")).map((target) => target.position).sort((a, b) => a - b);
    const positionSet = key(positions);
    if (!positionGroups.has(positionSet)) positionGroups.set(positionSet, { positions, collections: [] });
    positionGroups.get(positionSet).collections.push(collection);
  }
  for (const group of positionGroups.values()) alternatives.push(object({
    collection: { type: "string", enum: group.collections },
    position: { type: "integer", enum: group.positions },
  }));
  return { anyOf: alternatives };
}

/** The document selection is an explicit request for every canonical repair location. */
export class SpecGateDocumentTarget {
  constructor(value) {
    if (key(value) !== key({ document: "spec" })) throw new Error("Spec Gate document target is invalid");
    Object.freeze(this);
  }
  toJSON() { return { document: "spec" }; }
}

/** Validate AI-selected locations against the exact Spec shown to the Gate. */
export class SpecGateTargetSelection {
  constructor({ targets, allowedTargets, spec, specRevision }) {
    if (!REVISION.test(specRevision)) throw new Error("Spec Gate target selection requires a canonical revision");
    if (!Array.isArray(targets) || targets.length === 0) throw new Error("Spec Gate observation requires targets");
    const entries = specRepairTargetEntries(spec);
    const inventory = new Map();
    for (const entry of entries) {
      const identity = key(entry.target.toJSON());
      if (inventory.has(identity)) throw new Error("Spec Gate target inventory has ambiguous identities");
      inventory.set(identity, entry);
    }
    const selected = new Map();
    for (const value of targets) {
      const target = Object.hasOwn(value ?? {}, "document")
        ? new SpecGateDocumentTarget(value)
        : SpecRepairTarget.fromJSON(value, "Spec Gate observation target");
      const json = target.toJSON();
      const identity = key(json);
      if (selected.has(identity)) throw new Error("Spec Gate observation has duplicate targets");
      if (!(target instanceof SpecGateDocumentTarget) && !inventory.has(identity)) {
        throw new Error("Spec Gate observation target is absent or ambiguous in the canonical Spec");
      }
      selected.set(identity, target);
    }
    const documentSelected = selected.has(key({ document: "spec" }));
    if (documentSelected && selected.size !== 1) throw new Error("Spec Gate whole-document target must stand alone");
    if (!Array.isArray(allowedTargets) || allowedTargets.length === 0) {
      throw new Error("Spec Gate observation requires explicit allowedTargets");
    }
    const permissions = validateSpecGateRepairPermissions(allowedTargets, spec);
    for (const permission of permissions) {
      const identity = key(permission.target.toJSON());
      if (!documentSelected && !selected.has(identity)) {
        throw new Error("Spec Gate observation allowedTargets must be among its targets");
      }
    }
    this.targets = Object.freeze([...selected.values()]);
    this.allowedTargets = Object.freeze(permissions.map((permission) => Object.freeze({
      target: Object.freeze(permission.target.toJSON()),
      operationKinds: Object.freeze([...permission.operationKinds]),
    })));
    this.specRevision = specRevision;
    Object.freeze(this);
  }

  static choices(spec) {
    return [{ document: "spec" }, ...specRepairTargetEntries(spec).map((entry) => entry.target.toJSON())];
  }

  static schema(spec, { document = true } = {}) {
    return targetSchema(specRepairTargetEntries(spec), { document });
  }

  static permissionSchema(spec) {
    const groups = new Map();
    for (const entry of specRepairTargetEntries(spec)) {
      const operationKinds = [...entry.operationKinds].sort();
      const operationSet = key(operationKinds);
      if (!groups.has(operationSet)) groups.set(operationSet, { operationKinds, entries: [] });
      groups.get(operationSet).entries.push(entry);
    }
    const alternatives = [];
    for (const group of groups.values()) {
      for (const target of targetSchema(group.entries, { document: false }).anyOf) {
        alternatives.push({ type: "object", properties: {
          target, operationKinds: { type: "array", minItems: 1,
            items: { type: "string", enum: group.operationKinds } },
        }, required: ["target", "operationKinds"], additionalProperties: false });
      }
    }
    return { anyOf: alternatives };
  }

  toJSON() { return this.targets.map((target) => target.toJSON()); }
}
