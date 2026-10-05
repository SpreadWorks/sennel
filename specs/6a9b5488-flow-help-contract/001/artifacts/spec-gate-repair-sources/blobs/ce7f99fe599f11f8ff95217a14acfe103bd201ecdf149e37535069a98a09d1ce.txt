import path from "node:path";

import { CanonicalTaskRequirementMap } from "../../lib/canonical-task-requirement-map.js";

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function repositoryPath(value, field) {
  const candidate = requiredText(value, field).replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(candidate)
    || path.posix.normalize(candidate) !== candidate
    || candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${field} must be a normalized repository-relative path`);
  }
  return candidate;
}

function specRequirementIds(spec) {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("canonical file-map Spec must be an object");
  }
  if (!Array.isArray(spec.requirements)) {
    throw new Error("canonical file-map Spec requirements must be an array");
  }
  return new Set(spec.requirements.map((entry) => (
    entry?.id == null ? null : requiredText(entry.id, "canonical Spec requirement id")
  )).filter(Boolean));
}

function canonicalRequirementIds(requirements, field) {
  if (!Array.isArray(requirements)) throw new Error(`${field} must be an array`);
  const ids = requirements.map((entry, index) => (
    requiredText(entry?.id, `${field}[${index}].id`)
  ));
  if (ids.length === 0) throw new Error(`${field} must not be empty`);
  if (new Set(ids).size !== ids.length) throw new Error(`${field} ids must be unique`);
  return ids;
}

/** One canonical Requirement bound to every mutation in the current Attempt. */
export class CanonicalRequirementMutationBinding {
  constructor({ requirementId, mutationIds } = {}) {
    this.requirementId = requiredText(requirementId, "canonical source requirement id");
    if (!Array.isArray(mutationIds) || mutationIds.length === 0) {
      throw new Error("canonical source requirement mutationIds must be a non-empty array");
    }
    this.mutationIds = Object.freeze(mutationIds.map((mutationId, index) => (
      requiredText(mutationId, `canonical source requirement mutationIds[${index}]`)
    )));
    if (new Set(this.mutationIds).size !== this.mutationIds.length) {
      throw new Error("canonical source requirement mutationIds must be unique");
    }
    Object.freeze(this);
  }

  toJSON() {
    return { requirementId: this.requirementId, mutationIds: [...this.mutationIds] };
  }
}

/** Compact all-to-all source scope for review and gate consumers. */
export class CanonicalSourceRequirementScope {
  constructor({ requirementIds, paths } = {}) {
    if (!Array.isArray(requirementIds)) {
      throw new Error("canonical source scope requirementIds must be an array");
    }
    this.requirementIds = Object.freeze(requirementIds.map((requirementId, index) => (
      requiredText(requirementId, `canonical source scope requirementIds[${index}]`)
    )));
    if (new Set(this.requirementIds).size !== this.requirementIds.length) {
      throw new Error("canonical source scope requirementIds must be unique");
    }
    if (!Array.isArray(paths)) throw new Error("canonical source scope paths must be an array");
    this.paths = Object.freeze(paths.map((entry) => repositoryPath(entry, "canonical source scope path")));
    if (new Set(this.paths).size !== this.paths.length) {
      throw new Error("canonical source scope paths must be unique");
    }
    this.relation = "all-to-all";
    Object.freeze(this);
  }

  toJSON() {
    return {
      requirementIds: [...this.requirementIds],
      paths: [...this.paths],
      relation: this.relation,
    };
  }

  toPromptText() {
    return [
      `relation: ${this.relation}`,
      `requirementIds: ${JSON.stringify(this.requirementIds)}`,
      `paths: ${JSON.stringify(this.paths)}`,
    ].join("\n");
  }
}

/**
 * Canonical authority for attributing an observed source Attempt. Every
 * observed mutation contributes to every Requirement in the current scope.
 */
export class CanonicalSourceRequirementAuthority {
  constructor(requirementIds) {
    if (!Array.isArray(requirementIds)) {
      throw new Error("canonical source requirement authority must be an array");
    }
    this.requirementIds = Object.freeze(requirementIds.map((requirementId, index) => (
      requiredText(requirementId, `canonical source requirement authority[${index}]`)
    )));
    if (this.requirementIds.length === 0) {
      throw new Error("canonical source requirement authority must not be empty");
    }
    if (new Set(this.requirementIds).size !== this.requirementIds.length) {
      throw new Error("canonical source requirement authority must not duplicate Requirement ids");
    }
    Object.freeze(this);
  }

  static fromSpec(spec, { taskId = null } = {}) {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error("canonical source requirement Spec must be an object");
    }
    const requirements = taskId === null
      ? spec.requirements
      : new CanonicalTaskRequirementMap(spec).forTask(taskId);
    return new CanonicalSourceRequirementAuthority(
      canonicalRequirementIds(requirements, taskId === null
        ? "canonical source requirements"
        : `canonical Task ${taskId} source requirements`),
    );
  }

  static fromTaskRequirements(requirements) {
    return new CanonicalSourceRequirementAuthority(
      canonicalRequirementIds(requirements, "canonical Task source requirements"),
    );
  }

  bindMutationIds(mutationIds) {
    if (!Array.isArray(mutationIds)) {
      throw new Error("canonical source mutationIds must be an array");
    }
    if (mutationIds.length === 0) return Object.freeze([]);
    return Object.freeze(this.requirementIds.map((requirementId) => (
      new CanonicalRequirementMutationBinding({ requirementId, mutationIds })
    )));
  }

  bindPaths(paths) {
    if (!Array.isArray(paths)) throw new Error("canonical source paths must be an array");
    if (paths.length === 0) return new CanonicalFileMap();
    return new CanonicalFileMap(Object.fromEntries(
      this.requirementIds.map((requirementId) => [requirementId, paths]),
    ));
  }

  bindSourceScope(paths) {
    return new CanonicalSourceRequirementScope({ requirementIds: this.requirementIds, paths });
  }

  assertBindings(bindings, mutationIds) {
    if (!Array.isArray(bindings)) throw new Error("canonical source effect bindings must be an array");
    const expected = this.bindMutationIds(mutationIds).map((entry) => entry.toJSON());
    const actual = bindings.map((entry) => ({
      requirementId: entry?.requirementId,
      mutationIds: Array.isArray(entry?.mutationIds) ? [...entry.mutationIds] : entry?.mutationIds,
    }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("canonical source effect must bind every current-scope Requirement to every current Attempt mutation");
    }
    return this;
  }
}

/**
 * The structured, cataloged requirement-to-file authority shared by
 * implementation, review, gate, and report consumers.
 */
export class CanonicalFileMap {
  constructor(value = {}) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("canonical file-map must be an object");
    }
    const entries = [];
    for (const [rawRequirementId, rawPaths] of Object.entries(value)) {
      const requirementId = requiredText(rawRequirementId, "canonical file-map requirement id");
      if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
        throw new Error(`canonical file-map ${requirementId} paths must be a non-empty array`);
      }
      const paths = [...new Set(rawPaths.map((entry) => (
        repositoryPath(entry, `canonical file-map ${requirementId} path`)
      )))];
      entries.push(Object.freeze([requirementId, Object.freeze(paths)]));
    }
    this.entries = Object.freeze(entries);
    Object.freeze(this);
  }

  static fromBytes(bytes) {
    if (!Buffer.isBuffer(bytes)) throw new Error("canonical file-map bytes must be a Buffer");
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`canonical file-map must be JSON: ${error.message}`);
    }
    return new CanonicalFileMap(parsed);
  }

  assertAgainstSpec(spec) {
    const known = specRequirementIds(spec);
    for (const [requirementId] of this.entries) {
      if (!known.has(requirementId)) {
        throw new Error(`requirement id not found: ${requirementId}`);
      }
    }
    return this;
  }

  withRequirement(requirementId, paths) {
    const id = requiredText(requirementId, "canonical file-map requirementId");
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error("canonical file-map paths must be a non-empty array");
    }
    const next = this.toJSON();
    next[id] = [...new Set([
      ...(next[id] ?? []),
      ...paths.map((entry) => repositoryPath(entry, "canonical file-map path")),
    ])];
    return new CanonicalFileMap(next);
  }

  get empty() {
    return this.entries.length === 0;
  }

  toJSON() {
    return Object.fromEntries(this.entries.map(([requirementId, paths]) => [requirementId, [...paths]]));
  }
}

/** One typed, append-only-in-meaning update to the shared file-map. */
export class CanonicalFileMapUpdate {
  constructor({ requirementId, paths } = {}) {
    this.requirementId = requiredText(requirementId, "canonical file-map requirementId");
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error("canonical file-map paths must be a non-empty array");
    }
    this.paths = Object.freeze(paths.map((entry) => repositoryPath(entry, "canonical file-map path")));
    Object.freeze(this);
  }

  apply({ spec, fileMap }) {
    const known = specRequirementIds(spec);
    if (!known.has(this.requirementId)) {
      throw new Error(`requirement id not found: ${this.requirementId}`);
    }
    return new CanonicalFileMap(fileMap)
      .assertAgainstSpec(spec)
      .withRequirement(this.requirementId, this.paths)
      .toJSON();
  }
}
