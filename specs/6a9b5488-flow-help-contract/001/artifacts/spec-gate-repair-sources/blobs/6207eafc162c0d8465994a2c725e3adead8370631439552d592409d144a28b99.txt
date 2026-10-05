import { repairJson } from "../../lib/json-parse.js";
import { PromptBuilder } from "../../lib/prompt-builder.js";
import {
  GLOBAL_PROMPT_ELEMENT_HARD_MAX,
  LinearPromptBatchTopology,
  PromptBatchExecutor,
  PromptBatchPlan,
  PromptBatchReducer,
  PromptExecutionLimit,
  PromptInputBuilder,
  PromptReductionLevel,
  PromptReductionPlan,
  PromptRequestEnvelope,
  PromptRequestLimit,
  PromptResponseCoverageInvalidFailure,
  PromptResponseInvalidFailure,
  PromptScopedBinding,
  ScopedCartesianPromptBatchTopology,
} from "../../lib/prompt-batching.js";
import { DocumentationAgent } from "./documentation-agent.js";
import {
  DocumentationContextPromptElement,
  DocumentationDirectivePromptElement,
  documentationSourceRevision,
} from "./prompt-elements.js";

export class DocumentationTextPromptEnvelope extends PromptRequestEnvelope {
  constructor({ systemPrompt, fileName, lang } = {}) {
    super({ revision: "docs-text-v2" });
    this.systemPrompt = systemPrompt;
    this.fileName = fileName;
    this.lang = lang;
    Object.freeze(this);
  }

  build(elements, chunkContext) {
    const directives = elements.filter((element) => element instanceof DocumentationDirectivePromptElement);
    const contexts = elements.filter((element) => element instanceof DocumentationContextPromptElement);
    const completeRequest = chunkContext.count === 1;
    const pb = new PromptBuilder();
    if (this.systemPrompt) pb.setRole(this.systemPrompt);
    pb.setRules([
      completeRequest
        ? `Produce coherent final Markdown for every directive in ${this.fileName}.`
        : `Draft concise, non-overlapping evidence for every directive in ${this.fileName}.`,
      `Write in ${this.lang || "the requested language"}.`,
      "Use every supplied range; inspect current-project files in the working directory for missing facts. Never infer absence from one range or emit context-placeholder prose.",
      "Return exactly one non-empty JSON string per directive ID and no foreign IDs.",
      "No horizontal rules or commentary.",
    ].join("\n"));
    pb.addUserPrompt("## Directives", directives.map((directive) => directive.toPromptText()).join("\n\n"));
    pb.addUserPrompt(
      `## Context ranges (batch ${chunkContext.index + 1}/${chunkContext.count})`,
      contexts.map((context) => context.toPromptText()).join("\n\n"),
    );
    const properties = Object.fromEntries(directives.map((directive) => [directive.directiveId, { type: "string", minLength: 1 }]));
    pb.setJsonSchema({
      type: "object",
      properties,
      required: directives.map((directive) => directive.directiveId),
      additionalProperties: false,
    });
    pb.setFmtFallback("Return only a JSON object mapping every supplied directiveId to generated Markdown.");
    return pb.build();
  }
}

export class DocumentationDirectiveResult {
  constructor({ directiveId, text, batchDigest } = {}) {
    if (typeof directiveId !== "string" || directiveId === "") throw new TypeError("directive result ID is required");
    if (typeof text !== "string" || text.trim() === "") {
      throw new PromptResponseInvalidFailure(`Directive result must contain generated text: ${directiveId}`, { directiveId, batchDigest });
    }
    this.directiveId = directiveId;
    this.text = text;
    this.batchDigest = batchDigest;
    Object.freeze(this);
  }
}

export class DocumentationTextResponseContract {
  parse(raw, batch) {
    let parsed;
    try {
      parsed = JSON.parse(repairJson(raw));
    } catch (cause) {
      throw new PromptResponseInvalidFailure("Text response is not valid JSON", { batchId: batch.digest }, cause);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new PromptResponseInvalidFailure("Text response must be a JSON object", { batchId: batch.digest });
    }
    const directives = batch.elements.filter((element) => element instanceof DocumentationDirectivePromptElement);
    const expected = directives.map((directive) => directive.directiveId);
    const actual = Object.keys(parsed);
    if (actual.length !== expected.length || expected.some((id) => typeof parsed[id] !== "string") || actual.some((id) => !expected.includes(id))) {
      throw new PromptResponseCoverageInvalidFailure("Text response does not exactly cover directive IDs", { expected, actual });
    }
    return Object.freeze(expected.map((directiveId) => new DocumentationDirectiveResult({
      directiveId,
      text: parsed[directiveId],
      batchDigest: batch.digest,
    })));
  }
}

export class DocumentationDirectiveSynthesisReducer extends PromptBatchReducer {
  constructor(directiveId) {
    super();
    this.directiveId = directiveId;
    Object.freeze(this);
  }

  reduce(completions) {
    if (completions.length !== 1 || completions[0].response.length !== 1
      || completions[0].response[0].directiveId !== this.directiveId) {
      throw new PromptResponseCoverageInvalidFailure(`Final synthesis must produce exactly directive ${this.directiveId}`);
    }
    return completions[0].response[0].text;
  }
}

export class DocumentationTextResultReducer extends PromptBatchReducer {
  constructor(directiveIds) {
    super();
    this.directiveIds = Object.freeze([...directiveIds]);
    Object.freeze(this);
  }

  reduce(completions) {
    if (completions.length !== 1) {
      throw new PromptResponseCoverageInvalidFailure("Whole-document text generation must complete in one bounded request");
    }
    const results = completions[0].response;
    if (results.length !== this.directiveIds.length
      || results.some((result, index) => result.directiveId !== this.directiveIds[index])) {
      throw new PromptResponseCoverageInvalidFailure("Whole-document text result does not preserve directive order");
    }
    return Object.freeze(Object.fromEntries(results.map((result) => [result.directiveId, result.text])));
  }
}

class DocumentationTextSynthesisEnvelope extends PromptRequestEnvelope {
  constructor({ systemPrompt, fileName, lang, final }) {
    super({ revision: final ? "docs-text-synthesis-v2" : "docs-text-reduction-v2" });
    this.systemPrompt = systemPrompt;
    this.fileName = fileName;
    this.lang = lang;
    this.final = final;
    Object.freeze(this);
  }
  build(elements) {
    const directive = elements.find((element) => element instanceof DocumentationDirectivePromptElement);
    const evidence = elements.filter((element) => element instanceof DocumentationContextPromptElement);
    const pb = new PromptBuilder();
    if (this.systemPrompt) pb.setRole(this.systemPrompt);
    pb.setRules(this.final
      ? `Synthesize one coherent final Markdown section in ${this.lang} for the directive. Incorporate all evidence without duplication. Return exact directive ID coverage.`
      : "Compress all supplied typed evidence without dropping concrete facts or introducing duplication. Return exact directive ID coverage.");
    pb.addUserPrompt("## Directive", directive.toPromptText());
    pb.addUserPrompt("## Complete typed evidence", evidence.map((entry) => entry.toPromptText()).join("\n\n"));
    pb.setJsonSchema({ type: "object", properties: { [directive.directiveId]: { type: "string", minLength: 1 } }, required: [directive.directiveId], additionalProperties: false });
    pb.setFmtFallback(`{"${directive.directiveId}":"generated Markdown"}`);
    return pb.build();
  }
}

class DocumentationRepeatedDirectiveElement extends DocumentationDirectivePromptElement {
  isRepeatedContext() { return true; }
}

export async function generateDocumentationDirectives({
  cleanText,
  enrichedContext,
  analysisContext,
  textFills,
  fileName,
  systemPrompt,
  lang,
  agent,
  executionWorkDir,
  retryCount = 0,
  maxCharacters,
  concurrency = 1,
} = {}) {
  const docsAgent = DocumentationAgent.from(agent);
  const resolvedLimit = maxCharacters ?? docsAgent.promptCharacterLimit ?? GLOBAL_PROMPT_ELEMENT_HARD_MAX;
  const limit = new PromptRequestLimit({ maxCharacters: resolvedLimit });
  const envelope = new DocumentationTextPromptEnvelope({ systemPrompt, fileName, lang });
  const builder = new PromptInputBuilder({ envelope, limit });
  const directiveIds = [];
  textFills.forEach((directive, sequence) => {
    const directiveId = directive.params?.id || `d${sequence}`;
    if (directiveIds.includes(directiveId)) throw new PromptResponseCoverageInvalidFailure(`Duplicate directive ID in ${fileName}: ${directiveId}`);
    directiveIds.push(directiveId);
    builder.add(new DocumentationDirectivePromptElement({
      id: `${fileName}:directive:${directiveId}`,
      sourceRevision: documentationSourceRevision(directive.raw),
      sequence,
      directiveId,
      file: fileName,
      prompt: directive.prompt,
      params: directive.params,
    }));
  });
  const contexts = [
    ["Document source", cleanText],
    ["Enriched source analysis", enrichedContext || ""],
    ["Structured analysis context", analysisContext ? JSON.stringify(analysisContext, null, 2) : ""],
  ];
  contexts.forEach(([label, text], index) => {
    if (text === "") return;
    builder.add(new DocumentationContextPromptElement({
      id: `${fileName}:context:${index}`,
      sourceRevision: documentationSourceRevision(text),
      sequence: textFills.length + index,
      label,
      text,
    }));
  });
  const collection = builder.build();
  const executionLimit = new PromptExecutionLimit({ maxRequestCharacters: resolvedLimit, concurrency });
  const directiveElements = collection.elements.filter((element) => element instanceof DocumentationDirectivePromptElement);
  const contextElements = collection.elements.filter((element) => element instanceof DocumentationContextPromptElement);
  const wholeDocumentPlan = PromptBatchPlan.create({
    collection,
    envelope,
    limit,
    topology: new LinearPromptBatchTopology(),
    executionLimit,
  });
  const scopedPlan = PromptBatchPlan.create({
    collection,
    envelope,
    limit,
    topology: new ScopedCartesianPromptBatchTopology({
      bindings: directiveElements.map((directive) => new PromptScopedBinding({
        id: directive.directiveId,
        scopeElements: [directive],
        payloadElements: contextElements,
      })),
    }),
    executionLimit,
  });
  const callOptions = (request) => ({
    commandId: "docs.text",
    systemPrompt: request.systemPrompt,
    jsonSchema: request.jsonSchema,
    fmtFallback: request.fmtFallback,
    retryCount,
    executionWorkDir,
  });
  const executor = new PromptBatchExecutor({ executionLimit });
  const callAgent = (request, _batch, _retryIndex, _attemptContext, providerCallAdmission) => docsAgent.call(request.userPrompt, {
    ...callOptions(request),
    providerCallAdmission,
    validateResponseForCache: (response) => {
      try {
        const parsed = JSON.parse(repairJson(response));
        const ids = request.jsonSchema.required;
        return ids.every((id) => typeof parsed?.[id] === "string" && parsed[id].trim() !== "")
          && Object.keys(parsed).length === ids.length;
      } catch (_) {
        return false;
      }
    },
  });
  const projectInvocation = typeof agent.projectInvocation === "function"
    ? (request) => docsAgent.projectInvocation(request.userPrompt, callOptions(request))
    : undefined;
  if (wholeDocumentPlan.batches.length === 1) {
    return executor.execute({
      plan: wholeDocumentPlan,
      responseContract: new DocumentationTextResponseContract(),
      reducer: new DocumentationTextResultReducer(directiveIds),
      callAgent,
      projectInvocation,
    });
  }
  executor.executionBudget.assertCanExecute(scopedPlan.batches.length + directiveElements.length);
  executor.executionBudget.consumeSynthesisCalls(directiveElements.length);
  const completions = await executor.executeCompletions({
    plan: scopedPlan,
    responseContract: new DocumentationTextResponseContract(),
    callAgent,
    projectInvocation,
  });
  const finalEntries = [];
  for (const directive of directiveElements) {
    const partials = completions
      .filter((completion) => completion.batch.groupId === directive.directiveId)
      .flatMap((completion) => completion.response.map((result) => ({ result, completion })));
    const repeatedDirective = new DocumentationRepeatedDirectiveElement({
      id: `${directive.id}:synthesis`,
      sourceRevision: directive.sourceRevision,
      sequence: 0,
      directiveId: directive.directiveId,
      file: directive.file,
      prompt: directive.prompt,
      params: directive.params,
    });
    const evidenceElements = partials.map(({ result, completion }, index) => new DocumentationContextPromptElement({
      id: `${directive.id}:evidence:${index}`,
      sourceRevision: documentationSourceRevision(completion.batchDigest),
      sequence: index + 1,
      label: `Evidence fragment ${index + 1}`,
      text: result.text,
    }));
    const initialElements = [repeatedDirective, ...evidenceElements];
    const coverageDigest = documentationSourceRevision(partials.map(({ completion }) => completion.batchDigest).join("\n"));
    const buildSynthesisPlan = (elements, final) => {
      const synthesisEnvelope = new DocumentationTextSynthesisEnvelope({ systemPrompt, fileName, lang, final });
      const synthesisBuilder = new PromptInputBuilder({ envelope: synthesisEnvelope, limit });
      for (const element of elements) synthesisBuilder.add(element);
      const synthesisCollection = synthesisBuilder.build();
      return PromptBatchPlan.create({ collection: synthesisCollection, envelope: synthesisEnvelope, limit, topology: new LinearPromptBatchTopology(), executionLimit });
    };
    const reduction = new PromptReductionPlan({
      initialElements,
      coverageDigest,
      executionBudget: executor.executionBudget,
    });
    const text = await reduction.execute({
      isComplete(elements) { return buildSynthesisPlan(elements, true).batches.length === 1; },
      buildRound(elements) { return buildSynthesisPlan(elements, false); },
      executeRound(reductionPlan) {
        return executor.executeCompletions({
          plan: reductionPlan,
          responseContract: new DocumentationTextResponseContract(),
          callAgent: (request, _batch, _retryIndex, _attemptContext, providerCallAdmission) => docsAgent.call(request.userPrompt, {
            ...callOptions(request),
            providerCallAdmission,
          }),
          projectInvocation: typeof agent.projectInvocation === "function" ? (request) => docsAgent.projectInvocation(request.userPrompt, callOptions(request)) : undefined,
        });
      },
      toNextLevel(roundCompletions, depth) {
        const next = [repeatedDirective, ...roundCompletions.map((completion, index) => new DocumentationContextPromptElement({
          id: `${directive.id}:reduction:${depth}:${index}`,
          sourceRevision: documentationSourceRevision(`${coverageDigest}:${completion.batchDigest}`),
          sequence: index + 1,
          label: `Reduced evidence ${index + 1}`,
          text: completion.response[0].text,
        }))];
        return new PromptReductionLevel({ elements: next, coverageDigest });
      },
      async finalize(elements) {
        const finalPlan = buildSynthesisPlan(elements, true);
        return executor.execute({
          plan: finalPlan,
          responseContract: new DocumentationTextResponseContract(),
          reducer: new DocumentationDirectiveSynthesisReducer(directive.directiveId),
          callAgent: (request, _batch, _retryIndex, _attemptContext, providerCallAdmission) => docsAgent.call(request.userPrompt, {
            ...callOptions(request),
            providerCallAdmission,
          }),
          projectInvocation: typeof agent.projectInvocation === "function" ? (request) => docsAgent.projectInvocation(request.userPrompt, callOptions(request)) : undefined,
        });
      },
    });
    finalEntries.push([directive.directiveId, text]);
  }
  return Object.freeze(Object.fromEntries(finalEntries));
}
