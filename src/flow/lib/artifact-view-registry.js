/**
 * Closed, human-facing artifact view registry.
 *
 * This is deliberately separate from FLOW_ARTIFACT_CONTRACTS.  The catalog
 * knows every durable Flow artifact; a human view is only permitted for an
 * explicitly reviewed singleton and its renderer-declared dependencies.
 */

import { FlowFindingSourceIdentity } from "./flow-findings.js";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]*$/;

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function logicalKey(value, field = "artifact logicalKey") {
  const key = text(value, field);
  if (!/^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*)*$/.test(key)) {
    throw new Error(`${field} must be a canonical logicalKey`);
  }
  return key;
}

function uniqueLogicalKeys(values, field) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
  const resolved = values.map((value, index) => logicalKey(value, `${field}[${index}]`));
  if (new Set(resolved).size !== resolved.length) throw new Error(`${field} must not contain duplicates`);
  return Object.freeze(resolved);
}

function relativeMarkdownPath(value, field) {
  const result = text(value, field);
  if (result.includes("\\") || result.startsWith("/") || result.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${field} must be a normalized relative Markdown path`);
  }
  if (!result.endsWith(".md")) throw new Error(`${field} must name a Markdown file`);
  return result;
}

function semanticUnitPattern(value, field) {
  const pattern = text(value, field);
  if (!/^[a-z][a-z0-9]*(?:[.-][a-zA-Z0-9_-]+)*(?:\.\*)?$/.test(pattern)) {
    throw new Error(`${field} must be a semantic-unit id or terminal wildcard`);
  }
  return pattern;
}

/** A closed set of full-view semantic unit ranges represented by one legacy view. */
export class ArtifactViewSemanticRange {
  constructor({ unitPatterns } = {}) {
    if (!Array.isArray(unitPatterns) || unitPatterns.length === 0) {
      throw new Error("artifact view semantic range requires unitPatterns");
    }
    this.unitPatterns = Object.freeze(unitPatterns.map((pattern, index) => (
      semanticUnitPattern(pattern, `artifact view semantic range unitPatterns[${index}]`)
    )));
    if (new Set(this.unitPatterns).size !== this.unitPatterns.length) {
      throw new Error("artifact view semantic range unitPatterns must not contain duplicates");
    }
    Object.freeze(this);
  }

  includes(unitId) {
    const id = text(unitId, "artifact view semantic unit id");
    return this.unitPatterns.some((pattern) => (
      pattern.endsWith(".*") ? id.startsWith(pattern.slice(0, -1)) : id === pattern
    ));
  }

  toJSON() { return { unitPatterns: [...this.unitPatterns] }; }
}

/** The catalog-verified artifact from which a replacement view can be regenerated. */
export class ArtifactViewRegenerationSource {
  constructor({ logicalKey: key } = {}) {
    this.logicalKey = logicalKey(key, "artifact view regeneration source logicalKey");
    Object.freeze(this);
  }

  toJSON() { return { logicalKey: this.logicalKey, verification: "catalog-verified" }; }
}

/** Typed declaration for an obsolete regenerable human Markdown scene. */
export class ArtifactViewLegacyMarkdownReplacement {
  constructor({ relativePath, scene, logicalKey: key, fullRange, regenerationSource } = {}) {
    this.relativePath = relativeMarkdownPath(relativePath, "artifact view legacy Markdown relativePath");
    this.scene = text(scene, "artifact view legacy Markdown scene");
    if (!IDENTIFIER.test(this.scene)) throw new Error("artifact view legacy Markdown scene must be an identifier");
    this.logicalKey = logicalKey(key, "artifact view legacy Markdown logicalKey");
    if (!(fullRange instanceof ArtifactViewSemanticRange)) {
      throw new Error("artifact view legacy Markdown replacement requires an ArtifactViewSemanticRange");
    }
    if (!(regenerationSource instanceof ArtifactViewRegenerationSource)) {
      throw new Error("artifact view legacy Markdown replacement requires an ArtifactViewRegenerationSource");
    }
    if (regenerationSource.logicalKey !== this.logicalKey) {
      throw new Error("artifact view legacy Markdown regeneration source must match logicalKey");
    }
    this.fullRange = fullRange;
    this.regenerationSource = regenerationSource;
    Object.freeze(this);
  }

  toJSON() {
    return {
      relativePath: this.relativePath,
      scene: this.scene,
      logicalKey: this.logicalKey,
      fullRange: this.fullRange.toJSON(),
      regenerationSource: this.regenerationSource.toJSON(),
    };
  }
}

/** One catalog dependency that a renderer is permitted to read. */
export class ArtifactViewDependency {
  constructor({ logicalKey: key, required = true } = {}) {
    this.logicalKey = logicalKey(key);
    if (required !== true && required !== false) throw new Error("artifact view dependency required must be boolean");
    this.required = required;
    Object.freeze(this);
  }

  toJSON() {
    return { logicalKey: this.logicalKey, required: this.required };
  }
}

/**
 * A dynamic catalog reference carried by the primary artifact itself.
 * It is intentionally declarative: callers can only use the named fields and
 * one of the declared source logical keys; they cannot turn the reader into an
 * arbitrary catalog browser.
 */
export class ArtifactViewReferenceRule {
  constructor({
    name,
    sourceArtifactField,
    sourceStepField,
    sourceFindingIdField,
    fingerprintField,
    allowedLogicalKeys,
  } = {}) {
    this.name = text(name, "artifact view reference rule name");
    if (!IDENTIFIER.test(this.name)) throw new Error("artifact view reference rule name must be an identifier");
    this.sourceArtifactField = text(sourceArtifactField, "artifact view reference sourceArtifactField");
    this.sourceStepField = text(sourceStepField, "artifact view reference sourceStepField");
    this.sourceFindingIdField = text(sourceFindingIdField, "artifact view reference sourceFindingIdField");
    this.fingerprintField = text(fingerprintField, "artifact view reference fingerprintField");
    this.allowedLogicalKeys = uniqueLogicalKeys(allowedLogicalKeys, "artifact view reference allowedLogicalKeys");
    Object.freeze(this);
  }

  assertReference(reference = {}) {
    if (reference === null || typeof reference !== "object" || Array.isArray(reference)) {
      throw new Error(`${this.name} reference must be an object`);
    }
    return new FlowFindingSourceIdentity({
      sourceArtifact: reference[this.sourceArtifactField],
      sourceStep: reference[this.sourceStepField],
      sourceFindingId: reference[this.sourceFindingIdField],
      fingerprint: reference[this.fingerprintField],
    });
  }

  assertSourceLogicalKey(value) {
    const key = logicalKey(value, `${this.name} source logicalKey`);
    if (!this.allowedLogicalKeys.includes(key)) {
      throw new Error(`${this.name} reference is not allowed to read ${key}`);
    }
    return key;
  }

  toJSON() {
    return {
      name: this.name,
      sourceArtifactField: this.sourceArtifactField,
      sourceStepField: this.sourceStepField,
      sourceFindingIdField: this.sourceFindingIdField,
      fingerprintField: this.fingerprintField,
      allowedLogicalKeys: [...this.allowedLogicalKeys],
    };
  }
}

/** One closed renderer contract. */
export class ArtifactViewRegistryEntry {
  constructor({ logicalKey: key, rendererRevision, dependencies = [], referenceRules = [], legacyMarkdownReplacements = [] } = {}) {
    this.logicalKey = logicalKey(key);
    this.rendererRevision = text(rendererRevision, `${this.logicalKey} rendererRevision`);
    if (!Array.isArray(dependencies)) throw new Error(`${this.logicalKey} dependencies must be an array`);
    this.dependencies = Object.freeze(dependencies.map((dependency) => (
      dependency instanceof ArtifactViewDependency ? dependency : new ArtifactViewDependency(dependency)
    )));
    if (new Set(this.dependencies.map((dependency) => dependency.logicalKey)).size !== this.dependencies.length) {
      throw new Error(`${this.logicalKey} dependencies must not contain duplicate logicalKeys`);
    }
    if (!Array.isArray(referenceRules)) throw new Error(`${this.logicalKey} referenceRules must be an array`);
    this.referenceRules = Object.freeze(referenceRules.map((rule) => (
      rule instanceof ArtifactViewReferenceRule ? rule : new ArtifactViewReferenceRule(rule)
    )));
    if (new Set(this.referenceRules.map((rule) => rule.name)).size !== this.referenceRules.length) {
      throw new Error(`${this.logicalKey} referenceRules must not contain duplicate names`);
    }
    if (!Array.isArray(legacyMarkdownReplacements)) {
      throw new Error(`${this.logicalKey} legacyMarkdownReplacements must be an array`);
    }
    this.legacyMarkdownReplacements = Object.freeze(legacyMarkdownReplacements.map((replacement) => (
      replacement instanceof ArtifactViewLegacyMarkdownReplacement
        ? replacement
        : new ArtifactViewLegacyMarkdownReplacement(replacement)
    )));
    if (this.legacyMarkdownReplacements.some((replacement) => replacement.logicalKey !== this.logicalKey)) {
      throw new Error(`${this.logicalKey} legacy Markdown replacement logicalKey must match the registry entry`);
    }
    if (new Set(this.legacyMarkdownReplacements.map((replacement) => replacement.relativePath)).size !== this.legacyMarkdownReplacements.length) {
      throw new Error(`${this.logicalKey} legacy Markdown replacements must not contain duplicate paths`);
    }
    Object.freeze(this);
  }

  dependency(logicalKeyValue) {
    const key = logicalKey(logicalKeyValue);
    const dependency = this.dependencies.find((entry) => entry.logicalKey === key) ?? null;
    if (dependency === null) throw new Error(`${this.logicalKey} renderer has no declared dependency: ${key}`);
    return dependency;
  }

  referenceRule(name) {
    const ruleName = text(name, "artifact view reference rule name");
    const rule = this.referenceRules.find((entry) => entry.name === ruleName) ?? null;
    if (rule === null) throw new Error(`${this.logicalKey} renderer has no declared reference rule: ${ruleName}`);
    return rule;
  }

  specification() {
    return {
      logicalKey: this.logicalKey,
      rendererRevision: this.rendererRevision,
      dependencies: this.dependencies.map((dependency) => dependency.toJSON()),
      referenceRules: this.referenceRules.map((rule) => rule.toJSON()),
      legacyMarkdownReplacements: this.legacyMarkdownReplacements.map((replacement) => replacement.toJSON()),
    };
  }
}

/** Closed lookup table for the two initial human review targets. */
export class ArtifactViewRegistry {
  #byLogicalKey = new Map();
  constructor(entries = []) {
    if (!Array.isArray(entries) || entries.length === 0) throw new Error("artifact view registry requires entries");
    this.entries = Object.freeze(entries.map((entry) => (
      entry instanceof ArtifactViewRegistryEntry ? entry : new ArtifactViewRegistryEntry(entry)
    )));
    for (const entry of this.entries) {
      if (this.#byLogicalKey.has(entry.logicalKey)) throw new Error(`duplicate artifact view logicalKey: ${entry.logicalKey}`);
      this.#byLogicalKey.set(entry.logicalKey, entry);
    }
    Object.freeze(this);
  }

  require(logicalKeyValue) {
    const key = logicalKey(logicalKeyValue);
    const entry = this.#byLogicalKey.get(key) ?? null;
    if (entry === null) throw new Error(`artifact view target is not registered: ${key}`);
    return entry;
  }

  has(logicalKeyValue) {
    try {
      return this.#byLogicalKey.has(logicalKey(logicalKeyValue));
    } catch {
      return false;
    }
  }

  targets() {
    return Object.freeze(this.entries.map((entry) => entry.logicalKey));
  }
}

const DEFERRED_FINDING_SOURCE_KEYS = Object.freeze([
  "draft.questions.review",
  "draft.coverage.review",
  "draft.gate",
  "spec.review",
  "spec.gate",
  "scenario.validity",
  "test.review",
  "test.result.review",
  "task.review",
  "task.gate",
  "impl.review",
  "impl.gate",
  "retro",
  "nonblocking.handoffs",
]);

export const FLOW_ARTIFACT_VIEW_REGISTRY = new ArtifactViewRegistry([
  new ArtifactViewRegistryEntry({
    logicalKey: "spec.record",
    rendererRevision: "1",
    legacyMarkdownReplacements: [
      new ArtifactViewLegacyMarkdownReplacement({
        relativePath: "spec.md",
        scene: "approval",
        logicalKey: "spec.record",
        fullRange: new ArtifactViewSemanticRange({
          unitPatterns: [
            "spec.header",
            "spec.purpose",
            "spec.background",
            "spec.scope",
            "spec.constraints",
            "spec.design-principles",
            "spec.overview",
            "spec.clarifications",
            "spec.alternatives",
            "spec.approval",
            "spec.requirements-heading",
            "spec.requirement.*",
            "spec.acceptance-criteria",
            "spec.implementation-targets",
            "spec.keywords",
            "spec.open-questions",
            "spec.tasks-heading",
            "spec.tasks.empty",
            "spec.task.*",
          ],
        }),
        regenerationSource: new ArtifactViewRegenerationSource({ logicalKey: "spec.record" }),
      }),
    ],
  }),
  new ArtifactViewRegistryEntry({
    logicalKey: "acceptance.review",
    rendererRevision: "1",
    dependencies: [
      new ArtifactViewDependency({ logicalKey: "spec.record", required: true }),
      new ArtifactViewDependency({ logicalKey: "acceptance.decision", required: false }),
      // acceptance.review copies only a bounded disposition projection. The
      // cataloged finding record remains the authority for source path,
      // fingerprint, and original finding linkage.
      new ArtifactViewDependency({ logicalKey: "flow.findings", required: false }),
    ],
    referenceRules: [
      new ArtifactViewReferenceRule({
        name: "deferredFindingSource",
        sourceArtifactField: "sourceArtifact",
        sourceStepField: "sourceStep",
        sourceFindingIdField: "sourceFindingId",
        fingerprintField: "fingerprint",
        allowedLogicalKeys: DEFERRED_FINDING_SOURCE_KEYS,
      }),
    ],
  }),
]);

export const FLOW_ARTIFACT_VIEW_TARGETS = Object.freeze(FLOW_ARTIFACT_VIEW_REGISTRY.targets());
