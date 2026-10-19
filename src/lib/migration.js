/**
 * Shared public-migration vocabulary.
 *
 * Migration revisions are deliberately separate from runtime schema revisions:
 * a revision describes a one-way transformation route, while a schema revision
 * describes one persisted document.  The command layer only needs these small
 * immutable values to construct dry-run plans and to make completion /
 * incompletion unambiguous.
 */

import { LogicalRelativePath } from "./portable-path.js";

const COMPONENT = /^[a-z][a-z0-9-]*$/;
const CLASSIFICATIONS = new Set(["converted", "preserved", "omitted", "relocatedTransient", "missingTransient", "generated"]);

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function positiveRevision(value, field = "migration revision") {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function safePath(value, field) {
  return new LogicalRelativePath(value, field).toString();
}

/**
 * A JSON Pointer location. `null` denotes a whole-file mapping; the empty
 * string is the RFC 6901 root pointer and must remain distinguishable from it.
 */
function jsonPointer(value, field) {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a JSON Pointer or null`);
  if (value === "") return value;
  if (!value.startsWith("/")) throw new Error(`${field} must be a JSON Pointer or null`);
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "~") continue;
    const escaped = value[index + 1];
    if (escaped !== "0" && escaped !== "1") {
      throw new Error(`${field} must use RFC 6901 escaping`);
    }
    index += 1;
  }
  return value;
}

/** A public migration target, such as `layout` revision 1. */
export class MigrationRevision {
  constructor({ component, revision, apply } = {}) {
    this.component = requiredText(component, "migration component");
    if (!COMPONENT.test(this.component)) throw new Error("migration component is invalid");
    this.revision = positiveRevision(revision);
    if (typeof apply !== "function") throw new Error("migration revision requires an apply function");
    this.apply = apply;
    Object.freeze(this);
  }
}

/**
 * Component-owned transaction boundary for one complete revision route.
 * Individual revisions describe the route; only this executor receives the
 * full plan and is therefore allowed to stage, validate, and commit it.
 */
export class MigrationComponentExecutor {
  constructor({ component, executePlan } = {}) {
    this.component = requiredText(component, "migration component executor component");
    if (!COMPONENT.test(this.component)) throw new Error("migration component executor component is invalid");
    if (typeof executePlan !== "function") throw new Error("migration component executor requires an executePlan function");
    this.executePlan = executePlan;
    Object.freeze(this);
  }

  execute({ plan, ...context } = {}) {
    if (!(plan instanceof MigrationPlan)) throw new Error("migration component executor requires a MigrationPlan");
    if (plan.component !== this.component) throw new Error("migration component executor cannot execute another component");
    return this.executePlan({ plan, ...context });
  }
}

/** An explicit reason a requested migration cannot safely proceed. */
export class MigrationBlocker {
  constructor({ code, message, path = null } = {}) {
    this.code = requiredText(code, "migration blocker code");
    if (!/^[A-Z][A-Z0-9_]*$/.test(this.code)) throw new Error("migration blocker code is invalid");
    this.message = requiredText(message, "migration blocker message");
    this.path = path === null ? null : safePath(path, "migration blocker path");
    Object.freeze(this);
  }

  toString() {
    return this.path === null ? `${this.code}: ${this.message}` : `${this.code}: ${this.path}: ${this.message}`;
  }
}

/** A hash-bound source fact used to explain a generated migration output. */
export class MigrationInput {
  constructor({ source, pointer = null, hash } = {}) {
    this.source = safePath(source, "migration input source");
    this.pointer = jsonPointer(pointer, "migration input pointer");
    this.hash = requiredText(hash, "migration input hash");
    if (!/^[a-f0-9]{64}$/.test(this.hash)) throw new Error("migration input hash must be SHA-256");
    Object.freeze(this);
  }

  toJSON() {
    return { source: this.source, pointer: this.pointer, hash: this.hash };
  }
}

/** A single deterministic source-to-target decision in a migration plan. */
export class MigrationMapping {
  constructor({ classification, source = null, pointer = null, destination = null, reason, inputs = [], regenerationSource = null } = {}) {
    if (!CLASSIFICATIONS.has(classification)) throw new Error("migration mapping classification is invalid");
    this.classification = classification;
    this.source = source === null ? null : safePath(source, "migration mapping source");
    this.pointer = jsonPointer(pointer, "migration mapping pointer");
    this.destination = destination === null ? null : safePath(destination, "migration mapping destination");
    this.reason = requiredText(reason, "migration mapping reason");
    if (!Array.isArray(inputs) || inputs.some((entry) => !(entry instanceof MigrationInput))) {
      throw new Error("migration mapping inputs must be typed migration inputs");
    }
    if (regenerationSource !== null && !(regenerationSource instanceof MigrationInput)) {
      throw new Error("migration mapping regeneration source must be a typed migration input");
    }
    if (this.classification === "generated" && this.destination === null) {
      throw new Error("generated migration mapping requires a destination");
    }
    if (this.classification === "generated" && (this.source !== null || this.pointer !== null)) {
      throw new Error("generated migration mapping cannot classify a source pointer");
    }
    if (this.classification !== "generated" && this.source === null) {
      throw new Error("source migration mapping requires a source");
    }
    if (this.classification !== "generated" && inputs.length !== 0) {
      throw new Error("source migration mapping cannot carry generated-output inputs");
    }
    if (this.classification === "missingTransient" && regenerationSource === null) {
      throw new Error("missing transient migration mapping requires a regeneration source");
    }
    if (this.classification !== "missingTransient" && regenerationSource !== null) {
      throw new Error("only missing transient migration mappings carry a regeneration source");
    }
    this.inputs = Object.freeze([...inputs]);
    this.regenerationSource = regenerationSource;
    Object.freeze(this);
  }

  toJSON() {
    if (this.classification === "generated") {
      return {
        target: this.destination,
        reason: this.reason,
        inputs: this.inputs.map((input) => input.toJSON()),
      };
    }
    return {
      source: this.source,
      pointer: this.pointer,
      destination: this.destination,
      reason: this.reason,
      ...(this.regenerationSource === null ? {} : { regenerationSource: this.regenerationSource.toJSON() }),
    };
  }
}

/** An immutable plan for every revision crossed by one migration scope. */
export class MigrationPlan {
  constructor({ component, fromRevision = 0, toRevision, revisions, mappings = [], blockers = [] } = {}) {
    this.component = requiredText(component, "migration plan component");
    if (!COMPONENT.test(this.component)) throw new Error("migration plan component is invalid");
    if (!Number.isSafeInteger(fromRevision) || fromRevision < 0) throw new Error("migration plan source revision is invalid");
    this.fromRevision = fromRevision;
    this.toRevision = positiveRevision(toRevision, "migration plan target revision");
    if (!Array.isArray(revisions) || revisions.some((entry) => !(entry instanceof MigrationRevision))) {
      throw new Error("migration plan requires typed revisions");
    }
    if (revisions.some((entry) => entry.component !== this.component)) throw new Error("migration plan mixes components");
    const expected = [];
    for (let revision = fromRevision + 1; revision <= this.toRevision; revision += 1) expected.push(revision);
    if (JSON.stringify(revisions.map((entry) => entry.revision)) !== JSON.stringify(expected)) {
      throw new Error("migration plan revisions must form one contiguous route");
    }
    if (!Array.isArray(mappings) || mappings.some((entry) => !(entry instanceof MigrationMapping))) {
      throw new Error("migration plan requires typed mappings");
    }
    if (!Array.isArray(blockers) || blockers.some((entry) => !(entry instanceof MigrationBlocker))) {
      throw new Error("migration plan requires typed blockers");
    }
    this.revisions = Object.freeze([...revisions]);
    this.mappings = Object.freeze([...mappings]);
    this.blockers = Object.freeze([...blockers]);
    Object.freeze(this);
  }

  get executable() { return this.blockers.length === 0; }
}

/** Immutable report material suitable for one canonical migration report. */
export class MigrationReport {
  constructor({ schemaRevision = 1, migration, sourceFiles = [], target, mappings = [] } = {}) {
    if (schemaRevision !== 1) throw new Error("migration report schema revision is unsupported");
    if (!migration || typeof migration !== "object" || Array.isArray(migration)) throw new Error("migration report requires migration metadata");
    if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("migration report requires target metadata");
    if (!Array.isArray(sourceFiles) || sourceFiles.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
      throw new Error("migration report source files are invalid");
    }
    if (!Array.isArray(mappings) || mappings.some((entry) => !(entry instanceof MigrationMapping))) {
      throw new Error("migration report requires typed mappings");
    }
    const mappingPointers = new Set();
    const classificationsBySource = new Map();
    for (const mapping of mappings) {
      if (mapping.source === null) continue;
      const identity = `${mapping.source}\0${mapping.pointer === null ? "<whole-file>" : mapping.pointer}`;
      if (mappingPointers.has(identity)) throw new Error("migration report maps one source pointer more than once");
      mappingPointers.add(identity);
      const classifications = classificationsBySource.get(mapping.source) ?? new Set();
      classifications.add(mapping.classification);
      classificationsBySource.set(mapping.source, classifications);
    }
    for (const [source, classifications] of classificationsBySource) {
      if (classifications.size < 2) continue;
      const sourceMappings = mappings.filter((mapping) => mapping.source === source);
      if (sourceMappings.some((mapping) => mapping.pointer === null)) {
        throw new Error("multi-classification migration sources require explicit JSON pointers");
      }
    }
    this.schemaRevision = schemaRevision;
    this.migration = Object.freeze(structuredClone(migration));
    this.sourceFiles = Object.freeze(sourceFiles.map((entry) => Object.freeze(structuredClone(entry))));
    this.target = Object.freeze(structuredClone(target));
    this.mappings = Object.freeze([...mappings]);
    Object.freeze(this);
  }

  toJSON() {
    const byClassification = Object.fromEntries([...CLASSIFICATIONS].map((classification) => [classification, []]));
    for (const mapping of this.mappings) byClassification[mapping.classification].push(mapping.toJSON());
    return {
      schemaRevision: this.schemaRevision,
      migration: this.migration,
      sourceFiles: this.sourceFiles,
      target: this.target,
      converted: byClassification.converted,
      preserved: byClassification.preserved,
      omitted: byClassification.omitted,
      relocatedTransient: byClassification.relocatedTransient,
      missingTransient: byClassification.missingTransient,
      generated: byClassification.generated,
    };
  }
}

/** Resolves independent component revision routes without cross-component work. */
export class MigrationRegistry {
  #revisions;
  #executors;

  constructor({ revisions = [], executors = [] } = {}) {
    if (!Array.isArray(revisions) || revisions.some((entry) => !(entry instanceof MigrationRevision))) {
      throw new Error("migration registry requires typed revisions");
    }
    if (!Array.isArray(executors) || executors.some((entry) => !(entry instanceof MigrationComponentExecutor))) {
      throw new Error("migration registry requires typed component executors");
    }
    this.#revisions = new Map();
    for (const revision of revisions) {
      const key = `${revision.component}:${revision.revision}`;
      if (this.#revisions.has(key)) throw new Error(`duplicate migration revision: ${key}`);
      this.#revisions.set(key, revision);
    }
    this.#executors = new Map();
    for (const executor of executors) {
      if (this.#executors.has(executor.component)) throw new Error(`duplicate migration component executor: ${executor.component}`);
      this.#executors.set(executor.component, executor);
    }
    Object.freeze(this);
  }

  route(component, { fromRevision = 0, toRevision } = {}) {
    const normalized = requiredText(component, "migration component");
    if (!COMPONENT.test(normalized)) throw new Error("migration component is invalid");
    if (!Number.isSafeInteger(fromRevision) || fromRevision < 0) throw new Error("migration source revision is invalid");
    const target = positiveRevision(toRevision, "migration target revision");
    const revisions = [];
    for (let revision = fromRevision + 1; revision <= target; revision += 1) {
      const entry = this.#revisions.get(`${normalized}:${revision}`);
      if (!entry) throw new Error(`unsupported migration revision: ${normalized} -> ${target}`);
      revisions.push(entry);
    }
    return Object.freeze(revisions);
  }

  execute(plan, context = {}) {
    if (!(plan instanceof MigrationPlan)) throw new Error("migration registry execute requires a MigrationPlan");
    const executor = this.#executors.get(plan.component);
    if (!executor) throw new Error(`migration component has no plan executor: ${plan.component}`);
    return executor.execute({ plan, ...context });
  }
}

export function migrationSuccessLine(component, revision) {
  return `migrate ${requiredText(component, "migration component")} reached revision ${positiveRevision(revision)}`;
}
