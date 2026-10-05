import { PromptBuilder } from "../../lib/prompt-builder.js";
import {
  LinearPromptBatchTopology,
  PromptBatchExecutor,
  PromptBatchPlan,
  PromptBatchReducer,
  PromptInputBuilder,
  PromptReductionLevel,
  PromptReductionPlan,
  PromptRequestEnvelope,
  PromptResponseCoverageInvalidFailure,
  PromptResponseInvalidFailure,
} from "../../lib/prompt-batching.js";
import { repairJson } from "../../lib/json-parse.js";
import { DocumentationAgent } from "./documentation-agent.js";
import {
  DocumentationAnalysisPromptElement,
  DocumentationContextPromptElement,
  DocumentationRepeatedContextElement,
  documentationSourceRevision,
} from "./prompt-elements.js";

const ROLE_VALUES = ["controller", "model", "lib", "config", "cli", "middleware", "test", "migration", "route", "view", "other"];
const ENRICHMENT_FIELDS = ["elementId", "category", "index", "summary", "detail", "chapter", "role", "keywords", "app"];

function enrichmentSchema(elementIds, categories, indexes) {
  return {
    type: "object",
    properties: {
      elementId: { type: "string", enum: elementIds },
      category: { type: "string", enum: categories },
      index: { type: "integer", enum: indexes },
      summary: { type: "string" },
      detail: { type: "string" },
      chapter: { type: "string" },
      role: { type: "string", enum: ROLE_VALUES },
      keywords: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 10 },
      app: { type: ["string", "null"] },
    },
    required: ENRICHMENT_FIELDS,
    additionalProperties: false,
  };
}

function identityMismatch(expected, actual) {
  return new PromptResponseCoverageInvalidFailure(
    `Enrichment response identity mismatch: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    { expected, actual },
  );
}

function validateEnrichmentValue(value, { elementId, category, index }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PromptResponseInvalidFailure(`Enrichment result is invalid: ${elementId}`);
  const fields = Object.keys(value);
  if (fields.length !== ENRICHMENT_FIELDS.length || fields.some((field) => !ENRICHMENT_FIELDS.includes(field))) {
    throw new PromptResponseInvalidFailure(`Enrichment result fields are invalid: ${elementId}`);
  }
  if (value.elementId !== elementId || value.category !== category || value.index !== index) {
    throw identityMismatch({ elementId, category, index }, {
      elementId: value.elementId, category: value.category, index: value.index,
    });
  }
  for (const field of ["summary", "detail", "chapter", "role"]) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      throw new PromptResponseInvalidFailure(`Enrichment result ${field} is invalid: ${elementId}`);
    }
  }
  if (!ROLE_VALUES.includes(value.role)) throw new PromptResponseInvalidFailure(`Enrichment result role is invalid: ${elementId}`);
  if (!Array.isArray(value.keywords) || value.keywords.length < 3 || value.keywords.length > 10
    || value.keywords.some((keyword) => typeof keyword !== "string" || keyword.trim() === "")) {
    throw new PromptResponseInvalidFailure(`Enrichment result keywords are invalid: ${elementId}`);
  }
  if (value.app !== null && typeof value.app !== "string") throw new PromptResponseInvalidFailure(`Enrichment result app is invalid: ${elementId}`);
  return Object.freeze({ ...value, keywords: Object.freeze([...value.keywords]) });
}

export class DocumentationEnrichPromptEnvelope extends PromptRequestEnvelope {
  constructor({ chapters, monorepoApps = [], lang = "en", fmtFallback } = {}) {
    super({ revision: "docs-enrich-v2" });
    this.chapters = Object.freeze([...chapters]);
    this.monorepoApps = Object.freeze([...monorepoApps]);
    this.lang = lang;
    this.fmtFallback = fmtFallback;
    Object.freeze(this);
  }

  build(elements, chunkContext) {
    const entries = elements.filter((element) => element instanceof DocumentationAnalysisPromptElement);
    const elementIds = entries.map((entry) => entry.id);
    const categories = [...new Set(entries.map((entry) => entry.category))];
    const indexes = [...new Set(entries.map((entry) => entry.index))];
    const pb = new PromptBuilder();
    pb.setRole("Analyze the following source code extracts and add structured metadata.");
    pb.addUserPrompt(
      `## Target source ranges (batch ${chunkContext.index + 1}/${chunkContext.count})`,
      entries.map((entry) => entry.toPromptText()).join("\n\n"),
    );
    const chapterLines = ["Each result should be assigned to one of these chapters:"];
    for (const chapter of this.chapters) {
      const fileName = typeof chapter === "string" ? chapter : chapter.chapter;
      const name = fileName.replace(/\.md$/, "");
      chapterLines.push(typeof chapter === "string" || !chapter.desc ? `- ${name}` : `- ${name}: ${chapter.desc}`);
    }
    pb.addUserPrompt("## Available chapters", chapterLines.join("\n"));
    if (this.monorepoApps.length > 0) {
      pb.addUserPrompt("## Monorepo apps", this.monorepoApps.map((app) => `- ${app.name}: ${app.path}`).join("\n"));
    }
    pb.setRules([
      "- Return exactly one result for every target elementId and no foreign IDs.",
      "- Base each result only on its supplied source range.",
      "- Copy elementId, category and index from each target's JSON identity exactly, including all prefixes and range suffixes. Do not derive category or index by splitting elementId.",
      `- Write summary and detail strictly in ${this.lang}.`,
      "- keywords must be 3-10 English search terms.",
    ].join("\n"));
    pb.setJsonSchema({
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: enrichmentSchema(elementIds, categories, indexes),
        },
      },
      required: ["entries"],
      additionalProperties: false,
    });
    pb.setFmtFallback(this.fmtFallback);
    return pb.build();
  }
}

export class DocumentationEnrichmentResult {
  constructor({ element, value } = {}) {
    if (!(element instanceof DocumentationAnalysisPromptElement)) throw new TypeError("enrichment result requires its analysis element");
    this.element = element;
    this.value = validateEnrichmentValue(value, {
      elementId: element.id,
      category: element.category,
      index: element.index,
    });
    Object.freeze(this);
  }
}

export class DocumentationEnrichmentResponseContract {
  parse(raw, batch) {
    let parsed;
    try {
      parsed = JSON.parse(repairJson(raw));
    } catch (cause) {
      throw new PromptResponseInvalidFailure("Enrichment response is not valid JSON", { batchId: batch.digest }, cause);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.entries)) {
      throw new PromptResponseInvalidFailure("Enrichment response must contain only an entries array", { batchId: batch.digest });
    }
    const expected = batch.payloadElements;
    const values = new Map();
    for (const value of parsed.entries) {
      if (!value || typeof value.elementId !== "string" || values.has(value.elementId)) {
        throw identityMismatch(expected.map((element) => element.id), parsed.entries.map((entry) => entry?.elementId ?? null));
      }
      values.set(value.elementId, value);
    }
    if (values.size !== expected.length || expected.some((element) => !values.has(element.id))) {
      throw identityMismatch(expected.map((element) => element.id), [...values.keys()]);
    }
    return Object.freeze(expected.map((element) => new DocumentationEnrichmentResult({ element, value: values.get(element.id) })));
  }
}

export class DocumentationResultReducer extends PromptBatchReducer {
  reduce(completions) {
    const grouped = groupEnrichmentResults(completions);
    const results = [];
    for (const entries of grouped.values()) {
      assertEnrichmentSourceCoverage(entries);
      if (entries.length !== 1) {
        throw new PromptResponseInvalidFailure("Split enrichment results require bounded semantic synthesis");
      }
      results.push(new DocumentationAggregatedEnrichmentResult(entries[0].result.element, entries[0].result.value));
    }
    return this.reduceResults(results);
  }

  reduceResults(results) {
    if (!Array.isArray(results) || results.some((result) => !(result instanceof DocumentationAggregatedEnrichmentResult))) {
      throw new TypeError("Documentation enrichment reducer requires typed aggregate results");
    }
    const enrichment = {};
    for (const result of results) {
      if (!enrichment[result.category]) enrichment[result.category] = [];
      enrichment[result.category].push({
        index: result.index,
        summary: result.value.summary,
        detail: result.value.detail,
        chapter: result.value.chapter,
        role: result.value.role,
        keywords: [...result.value.keywords],
        ...(result.value.app ? { app: result.value.app } : {}),
      });
    }
    return enrichment;
  }
}

class DocumentationAggregatedEnrichmentResult {
  constructor(element, value) {
    if (!(element instanceof DocumentationAnalysisPromptElement)) throw new TypeError("Aggregate enrichment requires its source identity");
    this.category = element.category;
    this.index = element.index;
    this.value = value;
    Object.freeze(this);
  }
}

function groupEnrichmentResults(completions) {
  const grouped = new Map();
  for (const completion of completions) {
    for (const result of completion.response) {
      const key = `${result.element.category}:${result.element.index}`;
      const list = grouped.get(key) || [];
      list.push({ result, completion });
      grouped.set(key, list);
    }
  }
  return grouped;
}

function assertEnrichmentSourceCoverage(entries) {
  entries.sort((left, right) => left.result.element.start - right.result.element.start);
  const first = entries[0].result;
  let offset = 0;
  for (const { result } of entries) {
    if (result.element.start !== offset) throw new PromptResponseCoverageInvalidFailure(`Enrichment source range gap: ${first.element.originId}`);
    offset = result.element.end;
  }
  if (offset !== first.element.sourceLength) throw new PromptResponseCoverageInvalidFailure(`Enrichment source range incomplete: ${first.element.originId}`);
}

class EnrichmentIdentityPromptElement extends DocumentationRepeatedContextElement {
  constructor(element) {
    super({
      id: `${element.originId}:identity`,
      sourceRevision: element.sourceRevision,
      sequence: 0,
      text: `elementId: ${element.originId}\ncategory: ${element.category}\nindex: ${element.index}\nfile: ${element.file}`,
    });
    this.elementId = element.originId;
    this.category = element.category;
    this.index = element.index;
    Object.freeze(this);
  }
}

class DocumentationEnrichmentSynthesisEnvelope extends PromptRequestEnvelope {
  constructor({ lang, final }) {
    super({ revision: final ? "docs-enrich-synthesis-v2" : "docs-enrich-reduction-v2" });
    this.lang = lang;
    this.final = final;
    Object.freeze(this);
  }

  build(elements) {
    const identity = elements.find((element) => element instanceof EnrichmentIdentityPromptElement);
    const evidence = elements.filter((element) => element instanceof DocumentationContextPromptElement);
    const pb = new PromptBuilder();
    pb.setRole(this.final
      ? "Synthesize one coherent source enrichment from all typed range analyses."
      : "Semantically reduce typed source-range enrichment without dropping distinct facts.");
    pb.setRules([
      `Write summary and detail strictly in ${this.lang}.`,
      "Resolve conflicts using the complete evidence; do not concatenate duplicate or contradictory descriptions.",
      "Preserve concrete responsibilities and behavior from every supplied evidence range.",
      "Return exactly the canonical element identity and complete enrichment schema.",
      "keywords must contain 3-10 English search terms.",
    ].join("\n"));
    pb.addUserPrompt("## Canonical identity", identity.toPromptText());
    pb.addUserPrompt("## Complete typed range evidence", evidence.map((entry) => entry.toPromptText()).join("\n\n"));
    pb.setJsonSchema({
      type: "object",
      properties: {
        entry: enrichmentSchema([identity.elementId], [identity.category], [identity.index]),
      },
      required: ["entry"],
      additionalProperties: false,
    });
    pb.setFmtFallback('{"entry":{"elementId":"...","category":"...","index":0,"summary":"...","detail":"...","chapter":"...","role":"other","keywords":["...","...","..."],"app":null}}');
    return pb.build();
  }
}

class DocumentationEnrichmentSynthesisResult {
  constructor(value, identity) {
    this.value = validateEnrichmentValue(value, identity);
    Object.freeze(this);
  }
}

class DocumentationEnrichmentSynthesisContract {
  constructor(identity) { this.identity = identity; Object.freeze(this); }
  parse(raw, batch) {
    let parsed;
    try { parsed = JSON.parse(repairJson(raw)); } catch (cause) {
      throw new PromptResponseInvalidFailure("Enrichment synthesis response is not valid JSON", { batchId: batch.digest }, cause);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).length !== 1 || !("entry" in parsed)) {
      throw new PromptResponseInvalidFailure("Enrichment synthesis response must contain exactly one entry", { batchId: batch.digest });
    }
    return new DocumentationEnrichmentSynthesisResult(parsed.entry, this.identity);
  }
}

class DocumentationEnrichmentSynthesisReducer extends PromptBatchReducer {
  reduce(completions) {
    if (completions.length !== 1) throw new PromptResponseInvalidFailure("Enrichment final synthesis requires one bounded completion");
    return completions[0].response.value;
  }
}

function enrichmentSynthesisPlan(elements, envelope, limit, executionLimit) {
  const builder = new PromptInputBuilder({ envelope, limit });
  for (const element of elements) builder.add(element);
  const collection = builder.build();
  return PromptBatchPlan.create({ collection, envelope, limit, topology: new LinearPromptBatchTopology(), executionLimit });
}

export async function reduceDocumentationEnrichment({
  completions,
  agent,
  executor,
  limit,
  executionLimit,
  lang,
  callOptions,
  projectInvocation,
} = {}) {
  if (!(executor instanceof PromptBatchExecutor)) throw new TypeError("Enrichment reduction requires its shared executor");
  const docsAgent = DocumentationAgent.from(agent);
  const grouped = groupEnrichmentResults(completions);
  const finalResults = [];
  for (const entries of grouped.values()) {
    assertEnrichmentSourceCoverage(entries);
    const first = entries[0].result.element;
    let value;
    if (entries.length === 1) {
      value = entries[0].result.value;
    } else {
      const identity = new EnrichmentIdentityPromptElement(first);
      const evidence = entries.map(({ result, completion }, index) => new DocumentationContextPromptElement({
        id: `${first.originId}:enrichment-evidence:${index}`,
        sourceRevision: documentationSourceRevision(completion.batchDigest),
        sequence: index + 1,
        label: `Source range enrichment ${result.element.start}:${result.element.end}/${result.element.sourceLength}`,
        text: JSON.stringify(result.value),
      }));
      const coverageDigest = documentationSourceRevision(entries.map(({ completion }) => completion.batchDigest).join("\n"));
      const contract = new DocumentationEnrichmentSynthesisContract(identity);
      const reduction = new PromptReductionPlan({
        initialElements: [identity, ...evidence],
        coverageDigest,
        executionBudget: executor.executionBudget,
      });
      const callAgent = (request, _batch, _retryIndex, _attemptContext, providerCallAdmission) => docsAgent.call(request.userPrompt, {
        ...callOptions(request),
        providerCallAdmission,
      });
      value = await reduction.execute({
        isComplete(elements) {
          return enrichmentSynthesisPlan(
            elements,
            new DocumentationEnrichmentSynthesisEnvelope({ lang, final: true }),
            limit,
            executionLimit,
          ).batches.length === 1;
        },
        buildRound(elements) {
          const envelope = new DocumentationEnrichmentSynthesisEnvelope({ lang, final: false });
          return enrichmentSynthesisPlan(elements, envelope, limit, executionLimit);
        },
        executeRound(plan) {
          return executor.executeCompletions({ plan, responseContract: contract, callAgent, projectInvocation });
        },
        toNextLevel(roundCompletions, depth) {
          return new PromptReductionLevel({
            coverageDigest,
            elements: [identity, ...roundCompletions.map((completion, index) => new DocumentationContextPromptElement({
              id: `${first.originId}:enrichment-reduction:${depth}:${index}`,
              sourceRevision: documentationSourceRevision(`${coverageDigest}:${completion.batchDigest}`),
              sequence: index + 1,
              label: `Reduced enrichment evidence ${index + 1}`,
              text: JSON.stringify(completion.response.value),
            }))],
          });
        },
        finalize(elements) {
          const envelope = new DocumentationEnrichmentSynthesisEnvelope({ lang, final: true });
          const plan = enrichmentSynthesisPlan(elements, envelope, limit, executionLimit);
          return executor.execute({
            plan,
            responseContract: contract,
            reducer: new DocumentationEnrichmentSynthesisReducer(),
            callAgent,
            projectInvocation,
          });
        },
      });
    }
    finalResults.push(new DocumentationAggregatedEnrichmentResult(first, value));
  }
  return new DocumentationResultReducer().reduceResults(finalResults);
}
