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
  PromptRequestEnvelope,
  PromptRequestLimit,
  PromptResponseInvalidFailure,
} from "../../lib/prompt-batching.js";
import { DocumentationAgent } from "./documentation-agent.js";
import { DocumentationChapterPromptElement, DocumentationContextPromptElement, documentationSourceRevision } from "./prompt-elements.js";

class ChapterSelectionEnvelope extends PromptRequestEnvelope {
  constructor({ purpose }) { super({ revision: "docs-init-v2" }); this.purpose = purpose; Object.freeze(this); }
  build(elements, context) {
    const chapters = elements.filter((element) => element instanceof DocumentationChapterPromptElement);
    const analysis = elements.filter((element) => element instanceof DocumentationContextPromptElement);
    const pb = new PromptBuilder();
    pb.setRole("Select documentation chapters supported by the supplied project analysis ranges.");
    pb.setRules([
      this.purpose ? `Documentation purpose: ${this.purpose}.` : "",
      "Select a chapter only when this analysis range provides relevant evidence and the audience matches.",
      "Do not infer that a chapter is irrelevant merely because its evidence may occur in another batch.",
      "Return only known filenames in a JSON array.",
    ].filter(Boolean).join("\n"));
    pb.addUserPrompt("## Available chapters", chapters.map((chapter) => chapter.toPromptText()).join("\n"));
    pb.addUserPrompt(`## Analysis range ${context.index + 1}/${context.count}`, analysis.map((entry) => entry.toPromptText()).join("\n"));
    pb.setJsonSchema({
      type: "object",
      properties: {
        chapters: {
          type: "array",
          items: { type: "string", enum: chapters.map((chapter) => chapter.fileName) },
          uniqueItems: true,
        },
      },
      required: ["chapters"],
      additionalProperties: false,
    });
    pb.setFmtFallback('{"chapters":["chapter.md"]}');
    return pb.build();
  }
}

class ChapterSelectionContract {
  constructor(allowed) { this.allowed = allowed; }
  parse(raw) {
    let parsed;
    try { parsed = JSON.parse(repairJson(raw)); } catch (cause) { throw new PromptResponseInvalidFailure("Chapter selection response is invalid JSON", {}, cause); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.chapters)
      || parsed.chapters.some((name) => typeof name !== "string" || !this.allowed.has(name))) {
      throw new PromptResponseInvalidFailure("Chapter selection response contains an invalid chapter");
    }
    return Object.freeze([...new Set(parsed.chapters)]);
  }
}

class ChapterSelectionReducer extends PromptBatchReducer {
  reduce(completions) { return new Set(completions.flatMap((completion) => completion.response)); }
}

export async function selectDocumentationChapters({ chapters, analysisText, purpose, agent, maxCharacters } = {}) {
  const docsAgent = DocumentationAgent.from(agent);
  const resolvedLimit = maxCharacters ?? docsAgent.promptCharacterLimit ?? GLOBAL_PROMPT_ELEMENT_HARD_MAX;
  const limit = new PromptRequestLimit({ maxCharacters: resolvedLimit });
  const envelope = new ChapterSelectionEnvelope({ purpose });
  const builder = new PromptInputBuilder({ envelope, limit });
  chapters.forEach((chapter, sequence) => {
    const title = chapter.content.match(/^#\s+(.+)$/m)?.[1] || chapter.fileName;
    builder.add(new DocumentationChapterPromptElement({
      id: `chapter:${chapter.fileName}`,
      sourceRevision: documentationSourceRevision(chapter.content),
      sequence,
      fileName: chapter.fileName,
      title,
    }));
  });
  builder.add(new DocumentationContextPromptElement({
    id: "chapter-analysis",
    sourceRevision: documentationSourceRevision(analysisText),
    sequence: chapters.length,
    label: "Project analysis",
    text: analysisText,
  }));
  const collection = builder.build();
  const executionLimit = new PromptExecutionLimit({ maxRequestCharacters: resolvedLimit });
  const plan = PromptBatchPlan.create({ collection, envelope, limit, topology: new LinearPromptBatchTopology(), executionLimit });
  const options = (request) => ({ commandId: "docs.init", systemPrompt: request.systemPrompt, jsonSchema: request.jsonSchema, fmtFallback: request.fmtFallback });
  return new PromptBatchExecutor({ executionLimit }).execute({
    plan,
    responseContract: new ChapterSelectionContract(new Set(chapters.map((chapter) => chapter.fileName))),
    reducer: new ChapterSelectionReducer(),
    callAgent: (request, _batch, _retryIndex, _attemptContext, providerCallAdmission) => docsAgent.call(request.userPrompt, {
      ...options(request),
      providerCallAdmission,
    }),
    projectInvocation: typeof agent.projectInvocation === "function" ? (request) => docsAgent.projectInvocation(request.userPrompt, options(request)) : undefined,
  });
}
