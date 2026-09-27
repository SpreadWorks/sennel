import { createHash } from "node:crypto";
import { PromptBuilder } from "../../lib/prompt-builder.js";
import {
  RangedTextPromptElement,
  PromptBatchCompletion,
  PromptInputBuilder,
  PromptRequestEnvelope,
  PromptRequestLimit,
  PromptBatchPlan,
  PromptBatchExecutor,
  PromptBatchReducer,
  PromptLogicalFootprint,
  PromptBatchingError,
  PromptExecutionLimit,
  PromptResponseTooLargeFailure,
  GroupedPromptBatchTopology,
  PromptBatchGroup,
  PromptReductionPlan,
  PromptReductionLevel,
} from "../../lib/prompt-batching.js";

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function observationResponseFootprint(elements, rules, { reduction = false } = {}) {
  const required = elements.flatMap((range) => rules.map((rule) => ({
      requirementId: rule.id, sourceRef: range.id,
      ...(reduction ? { coveredSourceRefs: range.coveredSourceRefs } : {}),
      support: [], contradictions: [], unresolved: [],
    })));
  return { items: required.length, characters: JSON.stringify({ observations: required }).length };
}

function responseFits(elements, rules, executionLimit, options) {
  const required = observationResponseFootprint(elements, rules, options);
  return required.items <= executionLimit.maxAggregateItemCount
    && required.characters <= executionLimit.maxResponseCharacters;
}

export function planObservationBatches({ collection, envelope, limit, rules, executionLimit, reduction = false }) {
  const groups = [];
  let pending = [];
  for (const element of collection.payloadElements) {
    const candidate = [...pending, element];
    if (responseFits(candidate, rules, executionLimit, { reduction })) {
      pending = candidate;
      continue;
    }
    if (pending.length === 0) {
      throw new PromptResponseTooLargeFailure("One rule-range response structure exceeds its execution budget", {
        sourceRef: element.id,
      });
    }
    groups.push(new PromptBatchGroup({ id: `response:${groups.length}`, payloadElements: pending }));
    pending = [element];
    if (!responseFits(pending, rules, executionLimit, { reduction })) {
      throw new PromptResponseTooLargeFailure("One rule-range response structure exceeds its execution budget", {
        sourceRef: element.id,
      });
    }
  }
  groups.push(new PromptBatchGroup({ id: `response:${groups.length}`, payloadElements: pending }));
  const topology = groups.length === 1 ? undefined : new GroupedPromptBatchTopology({ groups });
  const plan = PromptBatchPlan.create({ collection, envelope, limit, ...(topology ? { topology } : {}) });
  for (const batch of plan.batches) {
    if (!responseFits(batch.payloadElements, rules, executionLimit, { reduction })) {
      throw new PromptResponseTooLargeFailure("The required rule-range response structure exceeds its execution budget", {
        batchDigest: batch.digest,
      });
    }
  }
  return plan;
}

export class GateResultCollection {
  constructor(completions) {
    this.results = Object.freeze(completions.map((completion) => completion.response));
    this.completions = Object.freeze([...completions]);
    Object.freeze(this);
  }
}

export class GateResultReducer extends PromptBatchReducer {
  reduce(completions) {
    return new GateResultCollection(completions);
  }
}

/** A cited observation is evidence for a later judgment, never a partial PASS/FAIL. */
export class RequirementSourceObservation {
  constructor(value, { requirementId, allowedIds, coveredSourceRefs }) {
    if (!value || value.requirementId !== requirementId
      || typeof value.sourceRef !== "string" || !allowedIds.has(value.sourceRef)) {
      throw new PromptBatchingError("PROMPT_RESPONSE_COVERAGE_INVALID", "Requirement observation has a foreign requirement or source reference");
    }
    this.requirementId = requirementId;
    this.sourceRef = value.sourceRef;
    if (coveredSourceRefs) {
      const actual = value.coveredSourceRefs;
      if (!Array.isArray(actual) || actual.length !== coveredSourceRefs.length
        || new Set(actual).size !== actual.length || actual.some((ref) => !coveredSourceRefs.includes(ref))) {
        throw new PromptBatchingError("PROMPT_RESPONSE_COVERAGE_INVALID", "Reduced observation must retain its exact original source references");
      }
      this.coveredSourceRefs = Object.freeze([...actual]);
    }
    for (const field of ["support", "contradictions", "unresolved"]) {
      if (!Array.isArray(value[field]) || value[field].some((text) => typeof text !== "string" || !text.trim())) {
        throw new PromptBatchingError("PROMPT_RESPONSE_INVALID", `Requirement observation ${field} must contain non-empty strings`);
      }
      this[field] = Object.freeze([...value[field]]);
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      requirementId: this.requirementId, sourceRef: this.sourceRef,
      ...(this.coveredSourceRefs ? { coveredSourceRefs: this.coveredSourceRefs } : {}),
      support: this.support, contradictions: this.contradictions, unresolved: this.unresolved,
    };
  }
}

export class RequirementObservationResponse {
  constructor(value, requirementId, batch) {
    if (!value || !Array.isArray(value.observations)) {
      throw new PromptBatchingError("PROMPT_RESPONSE_INVALID", "Requirement source response must contain observations");
    }
    const allowedIds = new Set(batch.payloadElements.map((entry) => entry.id));
    const sourcesById = new Map(batch.payloadElements.map((entry) => [entry.id, entry.coveredSourceRefs]));
    const entries = value.observations.map((entry) => new RequirementSourceObservation(entry, {
      requirementId, allowedIds, coveredSourceRefs: sourcesById.get(entry?.sourceRef),
    }));
    const actualIds = new Set(entries.map((entry) => entry.sourceRef));
    if (actualIds.size !== entries.length || actualIds.size !== allowedIds.size) {
      throw new PromptBatchingError("PROMPT_RESPONSE_COVERAGE_INVALID", "Requirement observations must cover every supplied range exactly once");
    }
    this.observations = Object.freeze(entries);
    Object.freeze(this);
  }
}

/** A rule is repeated across every canonical source range in its group. */
export class GuardrailEvidenceRule {
  constructor(article) {
    if (!article || typeof article.id !== "string" || !article.id
      || typeof article.title !== "string" || typeof article.body !== "string") {
      throw new TypeError("Guardrail evidence rule requires an id, title and body");
    }
    this.id = article.id;
    this.title = article.title;
    this.body = article.body;
    Object.freeze(this);
  }

  toPromptText() {
    return `Guardrail ${this.id}: ${this.title}\n${this.body}`;
  }
}

export class GuardrailRangeObservation {
  constructor(value, rules, ranges) {
    if (!value || !rules.has(value.requirementId) || !ranges.has(value.sourceRef)) {
      throw new PromptBatchingError("PROMPT_RESPONSE_COVERAGE_INVALID", "Guardrail observation has a foreign rule or source reference");
    }
    this.requirementId = value.requirementId;
    this.sourceRef = value.sourceRef;
    for (const field of ["support", "contradictions", "unresolved"]) {
      if (!Array.isArray(value[field]) || value[field].some((text) => typeof text !== "string" || !text.trim())) {
        throw new PromptBatchingError("PROMPT_RESPONSE_INVALID", `Guardrail observation ${field} must contain non-empty strings`);
      }
      this[field] = Object.freeze([...value[field]]);
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      requirementId: this.requirementId, sourceRef: this.sourceRef,
      support: this.support, contradictions: this.contradictions, unresolved: this.unresolved,
    };
  }
}

export class GuardrailObservationResponse {
  constructor(value, rules, batch) {
    if (!value || !Array.isArray(value.observations)) {
      throw new PromptBatchingError("PROMPT_RESPONSE_INVALID", "Guardrail source response must contain observations");
    }
    const ruleIds = new Set(rules.map((rule) => rule.id));
    const rangeIds = new Set(batch.payloadElements.map((entry) => entry.id));
    const observations = value.observations.map((entry) => new GuardrailRangeObservation(entry, ruleIds, rangeIds));
    const pairs = observations.map((entry) => JSON.stringify([entry.requirementId, entry.sourceRef]));
    if (observations.length !== ruleIds.size * rangeIds.size || new Set(pairs).size !== pairs.length) {
      throw new PromptBatchingError("PROMPT_RESPONSE_COVERAGE_INVALID", "Guardrail observations must cover every rule and range pair exactly once");
    }
    this.observations = Object.freeze(observations);
    Object.freeze(this);
  }
}

class GuardrailObservationEnvelope extends PromptRequestEnvelope {
  constructor(rules) {
    super();
    this.rules = Object.freeze([...rules]);
  }

  build(elements, context) {
    const ids = elements.map((entry) => entry.id);
    return new PromptBuilder()
      .setRole("Collect evidence for every listed rule from each supplied canonical source range.")
      .setRules([
        "This is evidence collection, not a partial judgment. Do not issue PASS, FAIL or SKIP.",
        "Evaluate every rule against every supplied range. Return exactly one observation for each rule and sourceRef pair, including empty observations.",
        "Keep support, explicit contradictions and unresolved questions separate. Do not infer a document-level omission from one range.",
        "Preserve exact source locations, distinct occurrences, rule exceptions and their conditions, later-step ownership, and executed evidence.",
        "At the Spec stage, evaluate whether a concrete confirmation method and observable acceptance condition are stated for each applicable rule.",
        "Identify the owner of later implementation and test execution evidence. A planned check is not evidence that a later implementation or test has run.",
      ].join("\n"))
      .setJsonSchema({
        type: "object", additionalProperties: false, required: ["observations"],
        properties: { observations: { type: "array", minItems: ids.length * this.rules.length,
          maxItems: ids.length * this.rules.length, items: {
            type: "object", additionalProperties: false,
            required: ["requirementId", "sourceRef", "support", "contradictions", "unresolved"],
            properties: {
              requirementId: { type: "string", enum: this.rules.map((rule) => rule.id) },
              sourceRef: { type: "string", enum: ids },
              support: { type: "array", items: { type: "string" } },
              contradictions: { type: "array", items: { type: "string" } },
              unresolved: { type: "array", items: { type: "string" } },
            },
          } } },
      })
      .setFmtFallback('Return JSON {"observations":[{"requirementId":"...","sourceRef":"...","support":[],"contradictions":[],"unresolved":[]}]} only. Include every rule and range pair.')
      .addUserPrompt("## Guardrail rules", this.rules.map((rule) => rule.toPromptText()).join("\n\n"))
      .addUserPrompt("## Batch", JSON.stringify({ index: context.index, count: context.count }))
      .addUserPrompt("## Canonical input ranges", JSON.stringify(elements.map((entry) => ({
        sourceRef: entry.id, revision: entry.sourceRevision, start: entry.start, end: entry.end,
        ...(entry.sourcePath ? { sourcePath: entry.sourcePath, recordId: entry.recordId, fields: entry.fields,
          members: entry.members.map((member) => member.toJSON()) } : {}),
        content: entry.toPromptText(),
      }))))
      .build();
  }
}

/** Plans one source scan for a rule group; all rules see every planned range. */
export class GuardrailEvidencePlan {
  static createGrouped({ articles, inputs, limit = new PromptRequestLimit(), executionLimit = new PromptExecutionLimit() }) {
    const plans = [];
    let pending = [];
    for (const article of articles) {
      const candidate = [...pending, new GuardrailEvidenceRule(article)];
      try {
        new GuardrailEvidencePlan({ rules: candidate, inputs, limit, executionLimit });
        pending = candidate;
      } catch (error) {
        if (!(error instanceof PromptBatchingError)) throw error;
        if (pending.length > 0) plans.push(new GuardrailEvidencePlan({ rules: pending, inputs, limit, executionLimit }));
        const rule = candidate.at(-1);
        pending = [rule];
        try {
          new GuardrailEvidencePlan({ rules: pending, inputs, limit, executionLimit });
        } catch (singleError) {
          if (!(singleError instanceof PromptBatchingError)) throw singleError;
          plans.push(new RequirementEvidencePlan({ requirement: rule, inputs, limit, phase: "spec", executionLimit }));
          pending = [];
        }
      }
    }
    if (pending.length > 0) plans.push(new GuardrailEvidencePlan({ rules: pending, inputs, limit, executionLimit }));
    return Object.freeze(plans);
  }

  constructor({ rules, inputs, limit = new PromptRequestLimit(), executionLimit = new PromptExecutionLimit() }) {
    if (!Array.isArray(rules) || rules.length === 0 || rules.some((rule) => !(rule instanceof GuardrailEvidenceRule))) {
      throw new TypeError("Guardrail evidence plan requires typed rules");
    }
    if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
      throw new PromptBatchingError("PROMPT_COVERAGE_INVALID", "Guardrail rule IDs must be unique");
    }
    const envelope = new GuardrailObservationEnvelope(rules);
    const builder = new PromptInputBuilder({ envelope, limit });
    inputs.forEach((input, sequence) => {
      if (!(input instanceof RequirementEvidenceInput)) throw new TypeError("Guardrail evidence plan requires typed inputs");
      builder.add(guardrailSourceElement(input, sequence));
    });
    this.plan = planObservationBatches({
      collection: builder.build(), envelope, limit, rules, executionLimit,
    });
    this.rules = Object.freeze([...rules]);
    Object.freeze(this);
  }

  async execute({ callAgent, projectInvocation, protocolPolicy, executionBudget }) {
    const completions = await new PromptBatchExecutor({ executionBudget }).executeCompletions({
      plan: this.plan, callAgent, projectInvocation, protocolPolicy,
      responseContract: { itemCount: (response) => response.observations.length, parse: (response) => {
        if (!(response instanceof GuardrailObservationResponse)) {
          throw new PromptBatchingError("PROMPT_RESPONSE_INVALID", "Guardrail protocol did not produce typed observations");
        }
        return response;
      } },
    });
    return new GuardrailObservationCollection(completions, this.rules);
  }
}

export class GuardrailObservationCollection {
  constructor(completions, rules) {
    this.completions = Object.freeze([...completions]);
    this.rules = Object.freeze([...rules]);
    Object.freeze(this);
  }

  forRule(rule) {
    if (!this.rules.includes(rule)) throw new TypeError("Rule is not part of this collection");
    return new RequirementObservationCollection(this.completions.map((completion) => {
      const observations = completion.response.observations.filter((entry) => entry.requirementId === rule.id);
      const response = new RequirementObservationResponse({ observations }, rule.id, completion.batch);
      return new PromptBatchCompletion({
        batch: completion.batch, response,
        responseCharacters: JSON.stringify(response).length,
        responseItemCount: observations.length,
      });
    }));
  }
}

/** Evidence bound to its full canonical rule for complete judgment. */
export class GuardrailJudgmentInput {
  constructor({ article, facts, omitArticleBody = false }) {
    if (!article || typeof article.id !== "string" || !article.id || typeof facts !== "string") {
      throw new TypeError("Guardrail judgment requires a rule and its collected facts");
    }
    this.article = article;
    this.facts = facts;
    this.omitArticleBody = omitArticleBody;
    Object.freeze(this);
  }

  toPromptValue() {
    return { guardrailId: this.article.id, evidence: JSON.parse(this.facts) };
  }
}

export class GuardrailFileJudgmentInput {
  constructor(article) {
    if (!article || typeof article.id !== "string" || !article.id) {
      throw new TypeError("File judgment requires a guardrail article");
    }
    this.article = article;
    Object.freeze(this);
  }
}

/** Greedy stable grouping preserves one judgment when the complete input fits. */
export class GuardrailJudgmentPlan {
  constructor({ inputs, limit, buildRequest, projectInvocation = null }) {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.some((input) =>
      !(input instanceof GuardrailJudgmentInput) && !(input instanceof GuardrailFileJudgmentInput))) {
      throw new TypeError("Guardrail judgment plan requires typed inputs");
    }
    if (inputs.some((input) => input.constructor !== inputs[0].constructor)) {
      throw new TypeError("Guardrail judgment plan cannot mix evidence and file inputs");
    }
    if (typeof buildRequest !== "function") throw new TypeError("Guardrail judgment plan requires a request builder");
    const groups = [];
    let pending = [];
    let pendingPlan = null;
    for (const input of inputs) {
      const candidate = [...pending, input];
      const request = buildRequest(candidate);
      if (gatePromptFits(request, limit, projectInvocation)) {
        pending = candidate;
        pendingPlan = PromptBatchPlan.fromRequest({ request, limit, id: `guardrail-judgment:${groups.length}` });
        continue;
      }
      if (pending.length === 0) {
        throw new PromptBatchingError("PROMPT_ELEMENT_TOO_LARGE", "One guardrail cannot fit its final judgment");
      }
      groups.push(pendingPlan);
      pending = [input];
      const singleRequest = buildRequest(pending);
      if (!gatePromptFits(singleRequest, limit, projectInvocation)) {
        throw new PromptBatchingError("PROMPT_ELEMENT_TOO_LARGE", "One guardrail cannot fit its final judgment");
      }
      pendingPlan = PromptBatchPlan.fromRequest({ request: singleRequest, limit, id: `guardrail-judgment:${groups.length}` });
    }
    groups.push(pendingPlan);
    this.plans = Object.freeze(groups);
    Object.freeze(this);
  }
}

export function countDistinctGuardrailSourceRanges(plans) {
  const ranges = plans.flatMap((plan) => plan.batches.flatMap((batch) => batch.payloadElements))
    .filter((element) => element.originId.includes(":source"));
  return new Set(ranges.map((element) => JSON.stringify([
    element.sourceRevision, element.start, element.end,
  ]))).size;
}

export class RequirementObservationCollection {
  constructor(completions) {
    this.completions = Object.freeze([...completions]);
    this.observations = Object.freeze(completions.flatMap((completion) => completion.response.observations));
    Object.freeze(this);
  }

  toPromptText() {
    return JSON.stringify(this.observations.map((entry) => entry.toJSON()));
  }
}

class RequirementObservationReducer extends PromptBatchReducer {
  reduce(completions) {
    return new RequirementObservationCollection(completions);
  }
}

export class RequirementObservationEnvelope extends PromptRequestEnvelope {
  constructor(requirement, { reduction = false, phase = null } = {}) {
    super();
    this.requirement = requirement;
    this.reduction = reduction;
    this.phase = phase;
  }

  build(elements, context) {
    const ids = elements.map((entry) => entry.id);
    const pb = new PromptBuilder()
      .setRole("Collect evidence for one obligation from the supplied canonical source and contract ranges.")
      .setRules([
        ...(this.reduction ? [
          "This is an evidence reduction round, not another source scan. Strictly compress the supplied observation groups by merging redundant facts and removing repeated JSON structure.",
          "Preserve all distinct support, contradictions and unresolved questions, including their original source citations and exception/ownership relationships. Do not turn an unresolved question into a negative finding.",
          "For each observation return coveredSourceRefs exactly as supplied for that input range, even if its evidence is empty. These references are immutable coverage metadata, not evidence of compliance.",
        ] : []),
        "Do not issue PASS, FAIL or SKIP. These ranges are only part of the complete input.",
        "Do not infer missing implementation or missing requirements from the absence of another range.",
        "Record supporting facts, explicit contradictions, and unresolved questions separately; cite the supplied sourceRef.",
        "Contract/context ranges define obligations; source ranges supply implementation evidence. Do not treat a requested behavior as proof of its implementation.",
        "Return one observation for each supplied range, with empty lists when it contains no relevant facts.",
        "Preserve exact names, source references, later-step ownership, preservation/replacement clauses, and execution evidence in your facts.",
        "Preserve every distinct occurrence and its original file/location, quoted text, and diff added/removed status; do not collapse separate actionable occurrences.",
        "Retain document-level structural facts and applicable exception clauses with their acknowledgment rationale so the final judgment can reconcile all ranges.",
        ...(this.phase === "spec" ? [
          "At the Spec stage, identify the confirmation method and acceptance condition; later implementation or test execution is owned by a later step unless explicit execution evidence is supplied.",
          "Do not turn a planned later check into executed evidence or treat missing later execution as a present Spec violation.",
        ] : []),
      ].join("\n"))
      .setJsonSchema({
        type: "object", additionalProperties: false, required: ["observations"],
        properties: { observations: { type: "array", minItems: ids.length, maxItems: ids.length, items: {
          type: "object", additionalProperties: false,
          required: ["requirementId", "sourceRef", "support", "contradictions", "unresolved", ...(this.reduction ? ["coveredSourceRefs"] : [])],
          properties: {
            requirementId: { type: "string", enum: [this.requirement.id] },
            sourceRef: { type: "string", enum: ids },
            ...(this.reduction ? { coveredSourceRefs: { type: "array", uniqueItems: true, items: { type: "string" } } } : {}),
            support: { type: "array", items: { type: "string" } },
            contradictions: { type: "array", items: { type: "string" } },
            unresolved: { type: "array", items: { type: "string" } },
          },
        } } },
      })
      .setFmtFallback('Return JSON {"observations":[{"requirementId":"...","sourceRef":"...","support":[],"contradictions":[],"unresolved":[]}]} only.')
      .addUserPrompt("## Obligation identity", this.requirement.id)
      .addUserPrompt("## Batch", JSON.stringify({ index: context.index, count: context.count }))
      .addUserPrompt("## Canonical input ranges", JSON.stringify(elements.map((entry) => ({
        sourceRef: entry.id, revision: entry.sourceRevision, start: entry.start, end: entry.end,
        ...(entry.sourcePath ? { sourcePath: entry.sourcePath, recordId: entry.recordId, fields: entry.fields,
          members: entry.members.map((member) => member.toJSON()) } : {}),
        ...(entry.coveredSourceRefs ? { coveredSourceRefs: entry.coveredSourceRefs } : {}),
        content: entry.toPromptText(),
      }))));
    return pb.build();
  }
}

/** Domain bindings are declared before the shared planner can subdivide them. */
export class RequirementEvidenceInput {
  constructor({ id, text }) {
    if (typeof id !== "string" || !id || typeof text !== "string") throw new Error("Requirement evidence requires an identity and text");
    this.id = id;
    this.text = text;
    if (new.target === RequirementEvidenceInput) Object.freeze(this);
  }
}

export class GuardrailStructuredSourceInput extends RequirementEvidenceInput {
  constructor({ id, text, sourceRevision, sourceLength, start, sourcePath, recordId = null, fields = [], members = null }) {
    super({ id, text });
    if (typeof sourceRevision !== "string" || !sourceRevision || !Number.isSafeInteger(start)
      || !Number.isSafeInteger(sourceLength) || start < 0 || start + text.length > sourceLength
      || typeof sourcePath !== "string" || !sourcePath) {
      throw new TypeError("Structured guardrail source requires a path, revision and exact source range");
    }
    this.sourceRevision = sourceRevision;
    this.sourceLength = sourceLength;
    this.start = start;
    this.sourcePath = sourcePath;
    this.recordId = recordId;
    this.fields = Object.freeze([...fields]);
    this.members = Object.freeze(members ?? [new GuardrailSourceMember({ sourcePath, recordId, fields,
      start, end: start + text.length, sourceRevision })]);
    Object.freeze(this);
  }
}

/** Original canonical record inside a coalesced source range. */
export class GuardrailSourceMember {
  constructor({ sourcePath, recordId = null, fields = [], start, end, sourceRevision }) {
    if (typeof sourcePath !== "string" || !sourcePath
      || (recordId !== null && typeof recordId !== "string")
      || !Array.isArray(fields) || fields.some((field) => typeof field !== "string")
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
      || typeof sourceRevision !== "string" || !sourceRevision) {
      throw new TypeError("Guardrail source member requires a canonical path, revision and range");
    }
    this.sourcePath = sourcePath;
    this.recordId = recordId;
    this.fields = Object.freeze([...fields]);
    this.start = start;
    this.end = end;
    this.sourceRevision = sourceRevision;
    Object.freeze(this);
  }
  toJSON() {
    return { sourcePath: this.sourcePath, recordId: this.recordId, fields: [...this.fields],
      start: this.start, end: this.end, sourceRevision: this.sourceRevision };
  }
}

class GuardrailSourceRangeElement extends RangedTextPromptElement {
  constructor({ sourcePath, recordId, fields, members, ...options }) {
    super(options);
    this.sourcePath = sourcePath;
    this.recordId = recordId;
    this.fields = Object.freeze([...fields]);
    this.members = Object.freeze([...members]);
    Object.freeze(this);
  }

  createRange(range) {
    return new GuardrailSourceRangeElement({
      ...super.createRange(range), sourcePath: this.sourcePath,
      recordId: this.recordId, fields: this.fields,
      members: this.members.filter((member) => member.start < range.end && member.end > range.start),
    });
  }
}

function guardrailSourceElement(input, sequence) {
  if (input instanceof GuardrailStructuredSourceInput) {
    return new GuardrailSourceRangeElement({
      id: input.id, sequence, text: input.text,
      start: input.start, end: input.start + input.text.length,
      sourceLength: input.sourceLength, sourceRevision: input.sourceRevision,
      sourcePath: input.sourcePath, recordId: input.recordId, fields: input.fields,
      members: input.members,
    });
  }
  return new RangedTextPromptElement({
    id: input.id, text: input.text, sourceRevision: digest(input.text), sequence,
  });
}

function skipJsonWhitespace(text, start) {
  let cursor = start;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function scanJsonString(text, start) {
  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] === "\\") cursor += 2;
    else if (text[cursor++] === '"') return cursor;
  }
  throw new Error("JSON string is incomplete");
}

function scanJsonValue(text, start, path, level, semantic, boundaries) {
  let cursor = skipJsonWhitespace(text, start);
  if (text[cursor] === '"') return scanJsonString(text, cursor);
  if (text[cursor] === "{") {
    cursor = skipJsonWhitespace(text, cursor + 1);
    while (text[cursor] !== "}") {
      const keyStart = cursor;
      const keyEnd = scanJsonString(text, cursor);
      const key = JSON.parse(text.slice(keyStart, keyEnd));
      const childPath = `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (level === 0) boundaries.push({ start: keyStart, path: childPath, semantic: semantic[key] });
      cursor = skipJsonWhitespace(text, keyEnd);
      cursor = scanJsonValue(text, cursor + 1, childPath, level + 1, semantic[key], boundaries);
      cursor = skipJsonWhitespace(text, cursor);
      if (text[cursor] === ",") cursor = skipJsonWhitespace(text, cursor + 1);
    }
    return cursor + 1;
  }
  if (text[cursor] === "[") {
    cursor = skipJsonWhitespace(text, cursor + 1);
    let index = 0;
    while (text[cursor] !== "]") {
      const childPath = `${path}/${index}`;
      if (level === 1) boundaries.push({ start: cursor, path: childPath, semantic: semantic[index] });
      cursor = skipJsonWhitespace(text, scanJsonValue(text, cursor, childPath, level + 1, semantic[index], boundaries));
      if (text[cursor] === ",") cursor = skipJsonWhitespace(text, cursor + 1);
      index += 1;
    }
    return cursor + 1;
  }
  while (cursor < text.length && !/[\s,\]}]/.test(text[cursor])) cursor += 1;
  return cursor;
}

/** Preserve exact JSON bytes while labelling each top-level field and array record. */
export function structuredGuardrailSourceInputs(text, document, { maxGroupCharacters = null } = {}) {
  if (typeof text !== "string" || !document || typeof document !== "object" || Array.isArray(document)
    || `${JSON.stringify(document, null, 2)}\n` !== text) {
    return [new RequirementEvidenceInput({ id: "guardrail:source", text })];
  }
  const boundaries = [{ start: 0, path: "$", semantic: document }];
  scanJsonValue(text, 0, "", 0, document, boundaries);
  const revision = digest(text);
  const records = boundaries.map((entry, index) => {
    const value = entry.semantic;
    return new GuardrailSourceMember({
      sourcePath: entry.path,
      recordId: value && typeof value === "object" && typeof value.id === "string" ? value.id : null,
      fields: value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [],
      start: entry.start, end: boundaries[index + 1]?.start ?? text.length,
      sourceRevision: revision,
    });
  });
  if (maxGroupCharacters !== null && (!Number.isSafeInteger(maxGroupCharacters) || maxGroupCharacters < 1)) {
    throw new TypeError("Guardrail source group character limit must be a positive integer");
  }
  const groups = [];
  let pending = [];
  let parent = null;
  const flush = () => { if (pending.length) groups.push(pending); pending = []; parent = null; };
  for (const record of records) {
    const arrayParent = maxGroupCharacters === null ? null
      : /^\/(requirements|tasks)\/\d+$/.exec(record.sourcePath)?.[1] ?? null;
    if (arrayParent === null) {
      flush();
      groups.push([record]);
      continue;
    }
    if (pending.length > 0 && (parent !== arrayParent
      || record.end - pending[0].start > maxGroupCharacters)) flush();
    pending.push(record);
    parent = arrayParent;
  }
  flush();
  return groups.map((members, index) => {
    const first = members[0];
    const last = members.at(-1);
    const grouped = members.length > 1;
    return new GuardrailStructuredSourceInput({
      id: `guardrail:source:${index}`, text: text.slice(first.start, last.end),
      sourceRevision: revision, sourceLength: text.length, start: first.start,
      sourcePath: grouped ? `/${parentFor(members[0].sourcePath)}` : first.sourcePath,
      recordId: grouped ? null : first.recordId,
      fields: grouped ? [] : first.fields,
      members,
    });
  });
}

function parentFor(path) { return path.split("/").slice(1, -1).join("/"); }

export class RequirementEvidencePlan {
  constructor({ requirement, inputs, canonicalInput = null, limit = new PromptRequestLimit(), phase = null, executionLimit = new PromptExecutionLimit() }) {
    const envelope = new RequirementObservationEnvelope(requirement, { phase });
    const builder = new PromptInputBuilder({ envelope, limit });
    const canonicalInputs = [
      canonicalInput ?? new RequirementEvidenceInput({
        id: `${requirement.id}:canonical-obligation`,
        text: requirement.toPromptText(),
      }),
      ...inputs,
    ];
    canonicalInputs.forEach((input, sequence) => {
      if (!(input instanceof RequirementEvidenceInput)) throw new Error("Requirement evidence plan requires typed inputs");
      builder.add(guardrailSourceElement(input, sequence));
    });
    this.plan = planObservationBatches({
      collection: builder.build(), envelope, limit, rules: [requirement], executionLimit,
    });
    this.requirement = requirement;
    this.limit = limit;
    Object.freeze(this);
  }

  async execute({ callAgent, projectInvocation, protocolPolicy, executionBudget }) {
    return new PromptBatchExecutor({ executionBudget }).execute({
      plan: this.plan,
      callAgent,
      projectInvocation,
      protocolPolicy,
      responseContract: { itemCount: (response) => response.observations.length, parse: (response) => {
        if (!(response instanceof RequirementObservationResponse)) {
          throw new PromptBatchingError("PROMPT_RESPONSE_INVALID", "Gate protocol did not produce typed observations");
        }
        return response;
      } },
      reducer: new RequirementObservationReducer(),
    });
  }
}

export class RequirementReductionEvidenceElement extends RangedTextPromptElement {
  constructor({ coveredSourceRefs, ...options }) {
    super(options);
    this.coveredSourceRefs = Object.freeze([...new Set(coveredSourceRefs)]);
    Object.freeze(this);
  }

  createRange(range) {
    return new RequirementReductionEvidenceElement({ ...super.createRange(range), coveredSourceRefs: this.coveredSourceRefs });
  }
}

/** One reduction level keeps the exact completed source coverage separate from prose. */
export function requirementReductionElements({ completions, depth, requirementId, coverageDigest }) {
  return completions.map((completion, sequence) => {
    const text = JSON.stringify(completion.response.observations.map((observation) => observation.toJSON()));
    return new RequirementReductionEvidenceElement({
      id: `${requirementId}:observation:${depth}:${sequence}`, sequence, text, sourceRevision: coverageDigest,
      coveredSourceRefs: completion.response.observations.flatMap((observation) => observation.coveredSourceRefs ?? [observation.sourceRef]),
    });
  });
}

export function renderRequirementReduction(elements, coverageDigest) {
  return JSON.stringify({
    coverageDigest,
    observations: elements.map((element) => ({ coveredSourceRefs: element.coveredSourceRefs, content: element.toPromptText() })),
  });
}

/** Semantic evidence reduction retains the source-completion authority at every level. */
export async function reduceRequirementEvidence({ evidence, requirement, limit, buildFinalRequest, evaluateBatch, projectInvocation, protocolPolicy, executionBudget, phase = null }) {
  const coverageDigest = digest(JSON.stringify(evidence.completions.map((completion) => completion.batchDigest)));
  const initialElements = requirementReductionElements({
    completions: evidence.completions, depth: 0, requirementId: requirement.id, coverageDigest,
  });
  const reduction = new PromptReductionPlan({ initialElements, coverageDigest, executionBudget });
  return reduction.execute({
    isComplete: (elements) => gatePromptFits(buildFinalRequest(renderRequirementReduction(elements, coverageDigest)), limit),
    buildRound: (elements) => {
      const envelope = new RequirementObservationEnvelope(requirement, { reduction: true, phase });
      const builder = new PromptInputBuilder({ envelope, limit });
      elements.forEach((element) => builder.add(element));
      return planObservationBatches({
        collection: builder.build(), envelope, limit, rules: [requirement],
        executionLimit: executionBudget.limit, reduction: true,
      });
    },
    executeRound: (plan) => new PromptBatchExecutor({ executionBudget }).executeCompletions({
      plan, projectInvocation, protocolPolicy,
      callAgent: evaluateBatch,
      responseContract: { parse: (response) => {
        if (!(response instanceof RequirementObservationResponse)) {
          throw new PromptBatchingError("PROMPT_RESPONSE_INVALID", "Reduction requires typed requirement observations");
        }
        return response;
      } },
    }),
    toNextLevel: (completions, depth) => new PromptReductionLevel({
      elements: requirementReductionElements({
        completions, depth: depth + 1, requirementId: requirement.id, coverageDigest,
      }),
      coverageDigest,
    }),
    finalize: (elements) => {
      reduction.executionBudget.consumeSynthesisCalls(1);
      return buildFinalRequest(renderRequirementReduction(elements, coverageDigest));
    },
  });
}

export function gatePromptFits(request, limit = new PromptRequestLimit(), projectInvocation = null) {
  return PromptLogicalFootprint.measure(request).fits(limit)
    && (!projectInvocation || projectInvocation(request).fits(limit.maxCharacters));
}

export async function executeGatePlan({ plan, callAgent, parseResponse, projectInvocation, protocolPolicy, executionBudget }) {
  return new PromptBatchExecutor({ executionBudget }).execute({
    plan, callAgent, projectInvocation, protocolPolicy,
    responseContract: { parse: parseResponse }, reducer: new GateResultReducer(),
  });
}
