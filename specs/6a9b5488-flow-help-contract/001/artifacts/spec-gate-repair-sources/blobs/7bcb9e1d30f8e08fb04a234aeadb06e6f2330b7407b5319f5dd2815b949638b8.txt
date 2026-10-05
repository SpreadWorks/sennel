/**
 * Structured summaries for human Flow artifact views.
 *
 * A summary agent receives only a deterministic full view. Target-specific
 * contracts then validate every returned source reference and excerpt before
 * fixed Markdown rendering. This keeps the model out of Flow state, normal
 * prompt caching, and decision authority.
 */

import { validateSchema } from "../../lib/schema-validate.js";
import {
  AtomicPromptElement,
  PromptBatchExecutor,
  PromptBatchPlan,
  PromptBatchReducer,
  PromptExecutionLimit,
  PromptInputBuilder,
  PromptRequestEnvelope,
  PromptRequestLimit,
} from "../../lib/prompt-batching.js";
import { MAX_SAME_SPEC_CONTRACT_CONTEXT_CHARS } from "./flow-context-limit.js";
import {
  artifactViewSha256,
  immutableArtifactViewFingerprintInput,
  stableArtifactViewJson,
} from "./artifact-view-fingerprint.js";

const SUMMARY_SCHEMA_REVISION = "artifact-view-summary-v3";
const SUMMARY_CACHE_REVISION = "artifact-view-summary-cache-v3";

function plainText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredText(value, field) {
  try {
    return plainText(value, field);
  } catch (cause) {
    throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", cause.message, { cause });
  }
}

function requiredObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", `${field} must be an object`);
  }
  return value;
}

/** Error whose code is safe to expose through the Flow envelope boundary. */
export class ArtifactViewSummaryError extends Error {
  constructor(code, message, { cause = null, data = undefined } = {}) {
    super(message, cause == null ? undefined : { cause });
    this.name = "ArtifactViewSummaryError";
    this.code = plainText(code, "summary error code");
    if (data !== undefined) this.data = data;
  }
}

function metadataFor(value = {}) {
  const metadata = value.metadata;
  if (metadata == null) return {};
  return requiredObject(metadata, "semantic unit metadata");
}

function optionalText(value, field) {
  if (value == null) return null;
  return requiredText(value, field);
}

/** One immutable semantic range in a deterministic full view. */
export class ArtifactViewSemanticUnit {
  constructor(value = {}) {
    const metadata = metadataFor(value);
    this.id = requiredText(value.id ?? value.sourceRef ?? metadata.id, "semantic unit id");
    this.kind = requiredText(value.kind ?? value.type ?? metadata.kind, `semantic unit ${this.id} kind`);
    this.markdown = requiredText(value.markdown ?? value.text ?? metadata.markdown, `semantic unit ${this.id} Markdown`);
    this.identity = optionalText(
      value.identity ?? metadata.identity ?? value.requirementId ?? value.taskId ?? value.findingId ?? value.blockerId ?? value.riskId,
      `semantic unit ${this.id} identity`,
    );
    this.status = optionalText(value.status ?? metadata.status, `semantic unit ${this.id} status`);
    Object.freeze(this);
  }
}

/** A split-safe sequence of semantic ranges. */
export class ArtifactViewSummaryChunk {
  constructor(units = []) {
    if (!Array.isArray(units) || units.length === 0) {
      throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", "summary chunk requires semantic units");
    }
    this.units = Object.freeze(units.map((unit) => (
      unit instanceof ArtifactViewSemanticUnit ? unit : new ArtifactViewSemanticUnit(unit)
    )));
    // Renderer units include their exact separators. Adding any separator
    // here would give the agent text that is not a contiguous range of the
    // full view it is meant to summarize.
    this.markdown = this.units.map((unit) => unit.markdown).join("");
    Object.freeze(this);
  }
}

class ArtifactViewPromptElement extends AtomicPromptElement {
  constructor({ unit, sequence }) {
    super({
      id: unit.id,
      sourceRevision: artifactViewSha256(unit.markdown),
      sequence,
      text: unit.markdown,
    });
    this.unit = unit;
    Object.freeze(this);
  }
}

class ArtifactViewPromptEnvelope extends PromptRequestEnvelope {
  constructor(contract = null, { raw = false } = {}) {
    super({ revision: contract?.promptRevision || "artifact-view-raw-v1" });
    this.contract = contract;
    this.raw = raw;
  }

  chunkFor(elements) {
    return new ArtifactViewSummaryChunk(elements.map((element) => element.unit));
  }

  build(elements) {
    if (elements.length === 0) return { userPrompt: "" };
    const chunk = this.chunkFor(elements);
    if (this.raw) return { userPrompt: chunk.markdown };
    return {
      systemPrompt: null,
      userPrompt: this.contract.prompt(chunk),
      jsonSchema: this.contract.schemaForChunk(chunk),
      fmtFallback: this.contract.fmtFallback(chunk),
    };
  }
}

class ArtifactViewSummaryReducer extends PromptBatchReducer {
  constructor({ contract, units }) {
    super();
    this.contract = contract;
    this.units = units;
    Object.freeze(this);
  }

  reduce(completions) {
    return this.contract.createResult(
      this.units,
      completions.flatMap((completion) => completion.response),
    );
  }
}

function semanticUnits(fullView) {
  const values = fullView?.semanticUnits ?? fullView?.units;
  if (!Array.isArray(values) || values.length === 0) {
    throw new ArtifactViewSummaryError(
      "ARTIFACT_VIEW_SUMMARY_INVALID",
      "full artifact view must declare non-empty semantic units",
    );
  }
  const units = values.map((value) => new ArtifactViewSemanticUnit(value));
  const ids = units.map((unit) => unit.id);
  if (new Set(ids).size !== ids.length) {
    throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", "full artifact semantic unit ids must be unique");
  }
  const fullMarkdown = requiredText(fullView?.markdown, "full artifact Markdown");
  const reconstructed = units.map((unit) => unit.markdown).join("");
  if (reconstructed !== fullMarkdown) {
    throw new ArtifactViewSummaryError(
      "ARTIFACT_VIEW_SUMMARY_INVALID",
      "semantic units must reconstruct the full artifact Markdown exactly and contiguously",
    );
  }
  return units;
}

/** Split a full view only between renderer-declared semantic units. */
export function splitArtifactViewSummary(fullView) {
  const units = semanticUnits(fullView);
  const envelope = new ArtifactViewPromptEnvelope(null, { raw: true });
  const limit = new PromptRequestLimit({ maxCharacters: MAX_SAME_SPEC_CONTRACT_CONTEXT_CHARS });
  const builder = new PromptInputBuilder({ envelope, limit });
  units.forEach((unit, sequence) => builder.add(new ArtifactViewPromptElement({ unit, sequence })));
  try {
    const plan = PromptBatchPlan.create({ collection: builder.build(), envelope, limit });
    return Object.freeze(plan.batches.map((batch) => envelope.chunkFor(batch.payloadElements)));
  } catch (cause) {
    throw new ArtifactViewSummaryError(
      "ARTIFACT_VIEW_INPUT_LIMIT",
      `artifact summary semantic units cannot fit within ${MAX_SAME_SPEC_CONTRACT_CONTEXT_CHARS} characters`,
      { cause },
    );
  }
}

function excerptSchema(units) {
  return {
    type: "object",
    required: ["sourceRefs", "excerpt"],
    additionalProperties: false,
    properties: {
      sourceRefs: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: { type: "string", enum: units.map((unit) => unit.id) },
      },
      excerpt: { type: "string", enum: units.map((unit) => unit.markdown) },
    },
  };
}

function identifiedExcerptSchema(identityName, identities, units, { status = false } = {}) {
  const excerpt = excerptSchema(units);
  const properties = {
    [identityName]: { type: "string", enum: identities },
    sourceRefs: excerpt.properties.sourceRefs,
    excerpt: excerpt.properties.excerpt,
  };
  const required = [identityName, "sourceRefs", "excerpt"];
  if (status) {
    properties.status = { type: "string", minLength: 1 };
    required.push("status");
  }
  return { type: "object", required, additionalProperties: false, properties };
}

function uniqueIdentities(units, kind) {
  const identities = units.map((unit) => {
    if (unit.identity === null) {
      throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", `${kind} semantic unit ${unit.id} requires an identity`);
    }
    return unit.identity;
  });
  if (new Set(identities).size !== identities.length) {
    throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", `${kind} semantic unit identities must be unique`);
  }
  return identities;
}

/** One accepted source-exact output value. */
export class ArtifactViewSummaryExcerpt {
  constructor({ sourceRefs, excerpt } = {}, { freeze = true } = {}) {
    if (!Array.isArray(sourceRefs) || sourceRefs.length === 0) {
      throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", "summary sourceRefs must be a non-empty array");
    }
    this.sourceRefs = Object.freeze(sourceRefs.map((sourceRef, index) => (
      requiredText(sourceRef, `summary sourceRefs[${index}]`)
    )));
    if (new Set(this.sourceRefs).size !== this.sourceRefs.length) {
      throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", "summary sourceRefs must not contain duplicates");
    }
    this.excerpt = requiredText(excerpt, "summary excerpt");
    if (freeze) Object.freeze(this);
  }
}

/** One target-specific summary item retained in source order. */
export class ArtifactViewSummaryEntry extends ArtifactViewSummaryExcerpt {
  constructor({ kind, identity = null, status = null, sourceRefs, excerpt } = {}) {
    super({ sourceRefs, excerpt }, { freeze: false });
    this.kind = requiredText(kind, "summary entry kind");
    this.identity = identity == null ? null : requiredText(identity, "summary entry identity");
    this.status = status == null ? null : requiredText(status, "summary entry status");
    Object.freeze(this);
  }
}

function parseResponse(rawResponse) {
  if (typeof rawResponse !== "string" || rawResponse.trim() === "") {
    throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", "summary agent response must be non-empty JSON");
  }
  try {
    return JSON.parse(rawResponse);
  } catch (cause) {
    throw new ArtifactViewSummaryError(
      "ARTIFACT_VIEW_SUMMARY_INVALID",
      `summary agent response is not JSON: ${cause.message}`,
      { cause },
    );
  }
}

function assertExactExcerpt(unit, value) {
  const excerpt = new ArtifactViewSummaryExcerpt(value);
  if (excerpt.sourceRefs.length !== 1 || excerpt.sourceRefs[0] !== unit.id) {
    throw new ArtifactViewSummaryError(
      "ARTIFACT_VIEW_SUMMARY_INVALID",
      `summary sourceRefs must retain exact source ${unit.id}`,
    );
  }
  if (excerpt.excerpt !== unit.markdown) {
    throw new ArtifactViewSummaryError(
      "ARTIFACT_VIEW_SUMMARY_INVALID",
      `summary excerpt does not exactly match source section ${unit.id}`,
    );
  }
  return excerpt;
}

function validateSingular(value, property, expected, kind) {
  if (expected.length === 0) return [];
  if (expected.length !== 1) {
    throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", `${kind} full view must contain one ${property} unit`);
  }
  const excerpt = assertExactExcerpt(expected[0], value[property]);
  return [new ArtifactViewSummaryEntry({ kind, sourceRefs: excerpt.sourceRefs, excerpt: excerpt.excerpt })];
}

function validateCollection(value, property, expected, kind, identityName, { status = false } = {}) {
  if (expected.length === 0) return [];
  const returned = value[property];
  if (!Array.isArray(returned) || returned.length !== expected.length) {
    throw new ArtifactViewSummaryError(
      "ARTIFACT_VIEW_SUMMARY_INVALID",
      `summary ${property} must retain every source item`,
    );
  }
  return returned.map((item, index) => {
    const unit = expected[index];
    if (item?.[identityName] !== unit.identity) {
      throw new ArtifactViewSummaryError(
        "ARTIFACT_VIEW_SUMMARY_INVALID",
        `summary ${property} must retain source order at ${unit.id}`,
      );
    }
    if (status && item.status !== unit.status) {
      throw new ArtifactViewSummaryError(
        "ARTIFACT_VIEW_SUMMARY_INVALID",
        `summary ${property} status must match source at ${unit.id}`,
      );
    }
    const excerpt = assertExactExcerpt(unit, item);
    return new ArtifactViewSummaryEntry({
      kind,
      identity: unit.identity,
      ...(status ? { status: unit.status } : {}),
      sourceRefs: excerpt.sourceRefs,
      excerpt: excerpt.excerpt,
    });
  });
}

function schemaFailure(errors) {
  throw new ArtifactViewSummaryError(
    "ARTIFACT_VIEW_SUMMARY_INVALID",
    `summary agent response failed schema validation: ${errors.join("; ")}`,
  );
}

function expectedFor(chunk, kind) {
  return chunk.units.filter((unit) => unit.kind === kind);
}

function assertDeclaredSummaryKinds(units, { target, modeled, ignored }) {
  const declared = new Set([...modeled, ...ignored]);
  for (const unit of units) {
    if (!declared.has(unit.kind)) {
      throw new ArtifactViewSummaryError(
        "ARTIFACT_VIEW_SUMMARY_INVALID",
        `${target} full view has an undeclared summary semantic unit: ${unit.id}/${unit.kind}`,
      );
    }
  }
}

const SPEC_MODELED_KINDS = Object.freeze([
  "purpose", "scope", "constraints", "openQuestions", "requirement", "task",
]);
// These ranges remain in the deterministic full display. The reviewed summary
// contract deliberately does not synthesize a second interpretation of them.
const SPEC_NON_SUMMARY_KINDS = Object.freeze([
  "header", "background", "designPrinciples", "overview", "clarifications",
  "alternatives", "approval", "requirementsHeading", "acceptanceCriteria",
  "implementationTargets", "keywords", "tasksHeading", "emptyTasks",
]);

const ACCEPTANCE_MODELED_KINDS = Object.freeze([
  "requirementJudgment", "mechanicalBlocker", "hardBlocker", "deferredFinding", "remainingRisk",
]);
const ACCEPTANCE_NON_SUMMARY_KINDS = Object.freeze([
  "header", "decision", "judgmentsHeading", "mechanicalBlockersHeading",
  "emptyMechanicalBlockers", "hardBlockersHeading", "emptyHardBlockers",
  "deferredFindingsHeading", "emptyDeferredFindings",
]);

/** Abstract fixed contract for one registered artifact-view target. */
export class ArtifactViewSummaryContract {
  constructor({ logicalKey, commandId, title, headings, revision = SUMMARY_SCHEMA_REVISION } = {}) {
    if (new.target === ArtifactViewSummaryContract) {
      throw new Error("ArtifactViewSummaryContract is abstract");
    }
    this.logicalKey = requiredText(logicalKey, "summary logicalKey");
    this.commandId = requiredText(commandId, "summary commandId");
    this.title = requiredText(title, "summary title");
    this.headings = Object.freeze(requiredObject(headings, "summary headings"));
    this.revision = requiredText(revision, "summary contract revision");
    this.promptRevision = `${this.revision}:${this.logicalKey}:exact-source`;
    Object.freeze(this);
  }

  cacheIdentity() {
    return { revision: this.revision, promptRevision: this.promptRevision, logicalKey: this.logicalKey };
  }

  validateFullView(fullView) {
    const units = semanticUnits(fullView);
    this.assertFullCoverage(units);
    return units;
  }

  // Subclasses declare the meaningful content they require from their target.
  assertFullCoverage(_units) { throw new Error("summary contract must implement assertFullCoverage"); }
  schemaForChunk(_chunk) { throw new Error("summary contract must implement schemaForChunk"); }
  parseChunk(_chunk, _rawResponse) { throw new Error("summary contract must implement parseChunk"); }
  createResult(_units, _entries) { throw new Error("summary contract must implement createResult"); }

  prompt(chunk) {
    const schema = this.schemaForChunk(chunk);
    const allowed = this.relevantUnits(chunk).map((unit) => (
      `- ${unit.id} (${unit.kind}${unit.identity == null ? "" : `: ${unit.identity}`})`
    ));
    return [
      "Return only JSON that satisfies the supplied schema.",
      "Every returned excerpt must copy its cited source section exactly. Do not paraphrase, judge, recommend, merge, omit, or reorder items.",
      "A source section is its complete renderer-declared Markdown range. Include its first Markdown heading and every trailing newline exactly; headings are content, not delimiters.",
      "Return only categories present in this section and retain every listed source item in order.",
      "Allowed source sections:",
      ...allowed,
      "",
      "Full artifact view section:",
      chunk.markdown,
    ].join("\n");
  }

  fmtFallback(chunk) {
    return [
      "Return only JSON that satisfies this schema:",
      JSON.stringify(this.schemaForChunk(chunk)),
      "Copy cited source sections exactly without paraphrase.",
    ].join("\n");
  }
}

function specChunkSchema(chunk) {
  const properties = {};
  const required = [];
  for (const [kind, property] of [["purpose", "purpose"], ["scope", "scope"], ["constraints", "constraints"], ["openQuestions", "openQuestions"]]) {
    const expected = expectedFor(chunk, kind);
    if (expected.length > 0) {
      properties[property] = excerptSchema(expected);
      required.push(property);
    }
  }
  const requirements = expectedFor(chunk, "requirement");
  if (requirements.length > 0) {
    properties.requirements = {
      type: "array",
      items: identifiedExcerptSchema(
        "requirementId",
        uniqueIdentities(requirements, "requirement"),
        requirements,
      ),
    };
    required.push("requirements");
  }
  const tasks = expectedFor(chunk, "task");
  if (tasks.length > 0) {
    properties.tasks = {
      type: "array",
      items: identifiedExcerptSchema("taskId", uniqueIdentities(tasks, "task"), tasks),
    };
    required.push("tasks");
  }
  return { type: "object", required, additionalProperties: false, properties };
}

/** Target-specific structured contract for spec.record summaries. */
export class SpecArtifactSummaryContract extends ArtifactViewSummaryContract {
  constructor({ title, headings, revision } = {}) {
    super({
      logicalKey: "spec.record",
      commandId: "flow.artifact.spec",
      title,
      headings,
      revision,
    });
  }

  assertFullCoverage(units) {
    assertDeclaredSummaryKinds(units, {
      target: "spec",
      modeled: SPEC_MODELED_KINDS,
      ignored: SPEC_NON_SUMMARY_KINDS,
    });
    for (const kind of ["purpose", "scope", "constraints", "openQuestions"]) {
      if (units.filter((unit) => unit.kind === kind).length !== 1) {
        throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", `spec full view must contain exactly one ${kind} unit`);
      }
    }
    uniqueIdentities(units.filter((unit) => unit.kind === "requirement"), "requirement");
    uniqueIdentities(units.filter((unit) => unit.kind === "task"), "task");
  }

  relevantUnits(chunk) {
    return chunk.units.filter((unit) => SPEC_MODELED_KINDS.includes(unit.kind));
  }

  schemaForChunk(chunk) { return specChunkSchema(chunk); }

  parseChunk(chunk, rawResponse) {
    const value = parseResponse(rawResponse);
    const errors = validateSchema(value, this.schemaForChunk(chunk));
    if (errors.length > 0) schemaFailure(errors);
    return [
      ...validateSingular(value, "purpose", expectedFor(chunk, "purpose"), "purpose"),
      ...validateSingular(value, "scope", expectedFor(chunk, "scope"), "scope"),
      ...validateSingular(value, "constraints", expectedFor(chunk, "constraints"), "constraints"),
      ...validateSingular(value, "openQuestions", expectedFor(chunk, "openQuestions"), "openQuestions"),
      ...validateCollection(value, "requirements", expectedFor(chunk, "requirement"), "requirement", "requirementId"),
      ...validateCollection(value, "tasks", expectedFor(chunk, "task"), "task", "taskId"),
    ];
  }

  createResult(units, entries) {
    return new SpecArtifactSummaryResult({ contract: this, units, entries });
  }
}

function acceptanceChunkSchema(chunk) {
  const properties = {};
  const required = [];
  const collections = [
    ["requirementJudgment", "requirements", "requirementId", true],
    ["mechanicalBlocker", "mechanicalBlockers", "blockerId", false],
    ["hardBlocker", "hardBlockers", "blockerId", false],
    ["deferredFinding", "deferredFindings", "findingId", false],
    ["remainingRisk", "remainingRisks", "riskId", false],
  ];
  for (const [kind, property, identityName, status] of collections) {
    const expected = expectedFor(chunk, kind);
    if (expected.length === 0) continue;
    properties[property] = {
      type: "array",
      items: identifiedExcerptSchema(identityName, uniqueIdentities(expected, kind), expected, { status }),
    };
    required.push(property);
  }
  return { type: "object", required, additionalProperties: false, properties };
}

/** Target-specific structured contract for acceptance.review summaries. */
export class AcceptanceArtifactSummaryContract extends ArtifactViewSummaryContract {
  constructor({ title, headings, revision } = {}) {
    super({
      logicalKey: "acceptance.review",
      commandId: "flow.artifact.acceptance",
      title,
      headings,
      revision,
    });
  }

  assertFullCoverage(units) {
    assertDeclaredSummaryKinds(units, {
      target: "acceptance",
      modeled: ACCEPTANCE_MODELED_KINDS,
      ignored: ACCEPTANCE_NON_SUMMARY_KINDS,
    });
    const judgments = units.filter((unit) => unit.kind === "requirementJudgment");
    uniqueIdentities(judgments, "requirement judgment");
    for (const unit of judgments) {
      if (unit.status === null) {
        throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", `acceptance judgment ${unit.id} requires a status`);
      }
    }
    for (const [kind, name] of [["mechanicalBlocker", "mechanical blocker"], ["hardBlocker", "hard blocker"], ["deferredFinding", "deferred finding"], ["remainingRisk", "remaining risk"]]) {
      uniqueIdentities(units.filter((unit) => unit.kind === kind), name);
    }
  }

  relevantUnits(chunk) {
    return chunk.units.filter((unit) => ACCEPTANCE_MODELED_KINDS.includes(unit.kind));
  }

  schemaForChunk(chunk) { return acceptanceChunkSchema(chunk); }

  parseChunk(chunk, rawResponse) {
    const value = parseResponse(rawResponse);
    const errors = validateSchema(value, this.schemaForChunk(chunk));
    if (errors.length > 0) schemaFailure(errors);
    return [
      ...validateCollection(value, "requirements", expectedFor(chunk, "requirementJudgment"), "requirementJudgment", "requirementId", { status: true }),
      ...validateCollection(value, "mechanicalBlockers", expectedFor(chunk, "mechanicalBlocker"), "mechanicalBlocker", "blockerId"),
      ...validateCollection(value, "hardBlockers", expectedFor(chunk, "hardBlocker"), "hardBlocker", "blockerId"),
      ...validateCollection(value, "deferredFindings", expectedFor(chunk, "deferredFinding"), "deferredFinding", "findingId"),
      ...validateCollection(value, "remainingRisks", expectedFor(chunk, "remainingRisk"), "remainingRisk", "riskId"),
    ];
  }

  createResult(units, entries) {
    return new AcceptanceArtifactSummaryResult({ contract: this, units, entries });
  }
}

function entriesFor(entries, kind) {
  return entries.filter((entry) => entry.kind === kind);
}

function assertGlobalCoverage(units, entries, kind) {
  const expected = units.filter((unit) => unit.kind === kind);
  const actual = entriesFor(entries, kind);
  if (expected.length !== actual.length) {
    throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", `summary omitted ${kind} source coverage`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const source = expected[index];
    const item = actual[index];
    if (item.identity !== source.identity || item.excerpt !== source.markdown) {
      throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", `summary changed ${kind} source order or text`);
    }
  }
}

/** Strict, fixed Markdown result for a spec.record summary. */
export class SpecArtifactSummaryResult {
  constructor({ contract, units, entries } = {}) {
    if (!(contract instanceof SpecArtifactSummaryContract)) {
      throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", "spec summary result requires SpecArtifactSummaryContract");
    }
    this.contract = contract;
    this.units = Object.freeze([...units]);
    this.entries = Object.freeze(entries.map((entry) => (
      entry instanceof ArtifactViewSummaryEntry ? entry : new ArtifactViewSummaryEntry(entry)
    )));
    for (const kind of ["purpose", "scope", "constraints", "openQuestions", "requirement", "task"]) {
      assertGlobalCoverage(this.units, this.entries, kind);
    }
    Object.freeze(this);
  }

  toMarkdown() {
    const one = (kind) => entriesFor(this.entries, kind)[0].excerpt;
    const many = (kind) => entriesFor(this.entries, kind).map((entry) => entry.excerpt);
    return [
      `# ${this.contract.title}\n\n`,
      one("purpose"),
      one("scope"),
      one("constraints"),
      one("openQuestions"),
      `## ${this.contract.headings.requirements}\n\n`,
      ...many("requirement"),
      `## ${this.contract.headings.tasks}\n\n`,
      ...many("task"),
    ].join("");
  }
}

/** Strict, fixed Markdown result for an acceptance.review summary. */
export class AcceptanceArtifactSummaryResult {
  constructor({ contract, units, entries } = {}) {
    if (!(contract instanceof AcceptanceArtifactSummaryContract)) {
      throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", "acceptance summary result requires AcceptanceArtifactSummaryContract");
    }
    this.contract = contract;
    this.units = Object.freeze([...units]);
    this.entries = Object.freeze(entries.map((entry) => (
      entry instanceof ArtifactViewSummaryEntry ? entry : new ArtifactViewSummaryEntry(entry)
    )));
    for (const kind of ["requirementJudgment", "mechanicalBlocker", "hardBlocker", "deferredFinding", "remainingRisk"]) {
      assertGlobalCoverage(this.units, this.entries, kind);
    }
    Object.freeze(this);
  }

  toMarkdown() {
    const section = (heading, kind) => {
      const entries = entriesFor(this.entries, kind);
      return [
        "",
        `## ${heading}`,
        ...(entries.length === 0
          ? []
          : ["", ...entries.flatMap((entry, index) => (
            index === 0 ? [entry.excerpt] : ["", entry.excerpt]
          ))]),
      ];
    };
    return [
      `# ${this.contract.title}`,
      ...section(this.contract.headings.requirements, "requirementJudgment"),
      ...section(this.contract.headings.mechanicalBlockers, "mechanicalBlocker"),
      ...section(this.contract.headings.hardBlockers, "hardBlocker"),
      ...section(this.contract.headings.deferredFindings, "deferredFinding"),
      ...section(this.contract.headings.remainingRisks, "remainingRisk"),
    ].join("\n");
  }
}

function resolvedAgentIdentity(resolved) {
  if (resolved === null || typeof resolved !== "object") {
    throw new ArtifactViewSummaryError("ARTIFACT_VIEW_AGENT_UNAVAILABLE", "no agent profile is resolved for artifact summary");
  }
  return {
    providerKey: requiredText(resolved.providerKey, "resolved summary providerKey"),
    profileKey: requiredText(resolved.profileKey, "resolved summary profileKey"),
    profile: requiredObject(resolved.profile, "resolved summary profile"),
  };
}

/** Fingerprint value for one summary cache identity. */
export class ArtifactViewSummaryFingerprint {
  constructor({ fullMarkdown, contract, resolved, lang = "en", i18nRevision } = {}) {
    this.fullHash = artifactViewSha256(requiredText(fullMarkdown, "summary full Markdown"));
    if (!(contract instanceof ArtifactViewSummaryContract)) {
      throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", "summary fingerprint requires a contract");
    }
    this.contract = immutableArtifactViewFingerprintInput(contract.cacheIdentity());
    this.agent = immutableArtifactViewFingerprintInput(resolvedAgentIdentity(resolved));
    this.lang = requiredText(String(lang || "en"), "summary language");
    this.i18nRevision = requiredText(i18nRevision, "summary i18n revision");
    this.value = artifactViewSha256(stableArtifactViewJson({
      fullHash: this.fullHash,
      contract: this.contract,
      agent: this.agent,
      lang: this.lang,
      i18nRevision: this.i18nRevision,
      cacheRevision: SUMMARY_CACHE_REVISION,
    }));
    Object.freeze(this);
  }

  toString() { return this.value; }
}

/**
 * Generate a strict summary from a full-view value. Cache plumbing is passed
 * in explicitly so this class cannot write Flow state or normal agent cache.
 */
export class ArtifactViewSummaryService {
  constructor({ agent, cache = null, lang = "en", i18nRevision, cacheWarningMessage = null } = {}) {
    if (!agent || typeof agent.resolve !== "function" || typeof agent.call !== "function") {
      throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", "summary service requires the shared agent surface");
    }
    this.agent = agent;
    this.cache = cache;
    this.lang = requiredText(String(lang || "en"), "summary language");
    this.i18nRevision = requiredText(i18nRevision, "summary i18n revision");
    this.cacheWarningMessage = cacheWarningMessage === null
      ? null
      : requiredText(cacheWarningMessage, "summary cache warning message");
    Object.freeze(this);
  }

  async summarize({ fullView, contract } = {}) {
    if (!(contract instanceof ArtifactViewSummaryContract)) {
      throw new ArtifactViewSummaryError("ARTIFACT_VIEW_SUMMARY_INVALID", "summary requires an ArtifactViewSummaryContract");
    }
    const fullMarkdown = requiredText(fullView?.markdown, "full artifact Markdown");
    const units = contract.validateFullView(fullView);
    let resolved;
    try {
      resolved = this.agent.resolve(contract.commandId);
    } catch (cause) {
      throw new ArtifactViewSummaryError("ARTIFACT_VIEW_AGENT_UNAVAILABLE", `artifact summary agent is unavailable: ${cause.message || cause}`, { cause });
    }
    const fingerprint = new ArtifactViewSummaryFingerprint({
      fullMarkdown,
      contract,
      resolved,
      lang: this.lang,
      i18nRevision: this.i18nRevision,
    });
    const cacheHit = this.cache?.read?.({
      logicalKey: contract.logicalKey,
      mode: "summary",
      revision: SUMMARY_CACHE_REVISION,
      fingerprint: fingerprint.toString(),
    }) ?? null;
    if (cacheHit?.markdown != null) {
      return Object.freeze({ markdown: cacheHit.markdown, fingerprint, cache: { hit: true, warning: null } });
    }

    // Summary contracts explicitly distinguish modeled excerpt sources from
    // validated, non-summary full-view sections. Keep the latter in the
    // fingerprint and coverage validation, but do not send them to a model
    // that is forbidden to reason about or return them.
    const relevant = units.filter((unit) => contract.relevantUnits(new ArtifactViewSummaryChunk([unit])).length > 0);
    const envelope = new ArtifactViewPromptEnvelope(contract);
    const limit = new PromptRequestLimit({ maxCharacters: this.agent.promptCharacterLimit });
    const builder = new PromptInputBuilder({ envelope, limit });
    relevant.forEach((unit, sequence) => builder.add(new ArtifactViewPromptElement({ unit, sequence })));
    let result;
    if (relevant.length === 0) result = contract.createResult(units, []);
    try {
      if (result === undefined) {
        const plan = PromptBatchPlan.create({
          collection: builder.build(),
          envelope,
          limit,
          executionLimit: new PromptExecutionLimit(),
        });
        result = await new PromptBatchExecutor().execute({
          plan,
          callAgent: (request, _batch, _protocolRetryIndex, _attemptContext, providerCallAdmission) => this.agent.call(request.userPrompt, {
            commandId: contract.commandId,
            jsonSchema: request.jsonSchema,
            fmtFallback: request.fmtFallback,
            flowAttribution: "none",
            cacheMode: "bypass",
            providerCallAdmission,
          }),
          ...(typeof this.agent.projectInvocation === "function" ? {
            projectInvocation: (request) => this.agent.projectInvocation(request.userPrompt, {
              commandId: contract.commandId,
              jsonSchema: request.jsonSchema,
              fmtFallback: request.fmtFallback,
              flowAttribution: "none",
              cacheMode: "bypass",
            }),
          } : {}),
          responseContract: {
            parse: (response, batch) => contract.parseChunk(envelope.chunkFor(batch.payloadElements), response),
            itemCount: (entries) => entries.length,
          },
          reducer: new ArtifactViewSummaryReducer({ contract, units }),
        });
      }
    } catch (cause) {
      let domainCause = cause;
      while (domainCause && !(domainCause instanceof ArtifactViewSummaryError)) domainCause = domainCause.cause;
      if (domainCause instanceof ArtifactViewSummaryError) throw domainCause;
      throw new ArtifactViewSummaryError(
        cause?.code === "PROMPT_ELEMENT_TOO_LARGE" || cause?.code === "PROMPT_FIXED_CONTEXT_TOO_LARGE"
          ? "ARTIFACT_VIEW_INPUT_LIMIT"
          : "ARTIFACT_VIEW_SUMMARY_FAILED",
        `artifact summary agent failed: ${cause.message || cause}`,
        { cause },
      );
    }
    const markdown = result.toMarkdown();
    let warning = null;
    if (this.cache?.write) {
      const saved = this.cache.write({
        logicalKey: contract.logicalKey,
        mode: "summary",
        revision: SUMMARY_CACHE_REVISION,
        fingerprint: fingerprint.toString(),
        markdown,
        ...(this.cacheWarningMessage === null ? {} : { warningMessage: this.cacheWarningMessage }),
      });
      if (saved?.warning) warning = saved.warning;
    }
    return Object.freeze({ markdown, fingerprint, cache: { hit: false, warning } });
  }
}

export const ARTIFACT_VIEW_SUMMARY_REVISIONS = Object.freeze({
  schema: SUMMARY_SCHEMA_REVISION,
  cache: SUMMARY_CACHE_REVISION,
});
