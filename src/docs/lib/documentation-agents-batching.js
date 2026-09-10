import { repairJson } from "../../lib/json-parse.js";
import { PromptBuilder } from "../../lib/prompt-builder.js";
import {
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
  PromptResponseInvalidFailure,
} from "../../lib/prompt-batching.js";
import { DocumentationAgent } from "./documentation-agent.js";
import { DocumentationContextPromptElement, documentationSourceRevision } from "./prompt-elements.js";

class DocumentationContextSummary {
  constructor(text) {
    if (typeof text !== "string" || text.trim() === "") throw new PromptResponseInvalidFailure("Documentation context summary is empty");
    this.text = text;
    Object.freeze(this);
  }
}

class DocumentationContextSummaryContract {
  parse(raw) {
    let parsed;
    try { parsed = JSON.parse(repairJson(raw)); } catch (cause) {
      throw new PromptResponseInvalidFailure("Documentation context summary is not valid JSON", {}, cause);
    }
    return new DocumentationContextSummary(parsed?.summary);
  }
}

class DocumentationSummaryEnvelope extends PromptRequestEnvelope {
  constructor() { super({ revision: "docs-agents-map-v2" }); }
  build(elements, context) {
    const pb = new PromptBuilder();
    pb.setRole("Summarize documentation context for generation of repository instructions.");
    pb.setRules("Preserve concrete commands, paths, architecture, constraints, and operational rules. Do not invent facts. Return JSON only.");
    pb.addUserPrompt(`## Context ranges (${context.index + 1}/${context.count})`, elements.map((element) => element.toPromptText()).join("\n\n"));
    pb.setJsonSchema({ type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false });
    pb.setFmtFallback('{"summary":"bounded factual summary"}');
    return pb.build();
  }
}

class ProjectSynthesisEnvelope extends PromptRequestEnvelope {
  constructor({ rules }) {
    super({ revision: "docs-agents-synthesis-v2" });
    this.rules = rules;
    Object.freeze(this);
  }
  build(elements) {
    const pb = new PromptBuilder();
    pb.setRole("Produce the PROJECT section of AGENTS.md from the complete repository context.");
    pb.setRules(this.rules);
    pb.addUserPrompt("## Complete repository context", elements.map((element) => element.toPromptText()).join("\n\n"));
    return pb.build();
  }
}

class ProjectSectionResult {
  constructor(text) {
    if (typeof text !== "string" || text.trim() === "") throw new PromptResponseInvalidFailure("PROJECT synthesis response is empty");
    this.text = text.trim();
    Object.freeze(this);
  }
}

class ProjectSectionContract { parse(raw) { return new ProjectSectionResult(raw); } }
class ProjectSectionReducer extends PromptBatchReducer {
  reduce(completions) {
    if (completions.length !== 1) throw new PromptResponseInvalidFailure("PROJECT synthesis must complete in one bounded request");
    return completions[0].response.text;
  }
}

function planFor(elements, envelope, limit, executionLimit) {
  const builder = new PromptInputBuilder({ envelope, limit });
  for (const element of elements) builder.add(element);
  const collection = builder.build();
  return PromptBatchPlan.create({ collection, envelope, limit, topology: new LinearPromptBatchTopology(), executionLimit });
}

export async function synthesizeProjectInstructions({ contexts, rules, agent, maxCharacters, concurrency = 1 } = {}) {
  const docsAgent = DocumentationAgent.from(agent);
  const limit = new PromptRequestLimit({ maxCharacters });
  const executionLimit = new PromptExecutionLimit({
    maxRequestCharacters: maxCharacters,
    concurrency,
    maxReductionDepth: 8,
    maxSynthesisCallCount: 100,
  });
  const initialElements = contexts.filter((context) => context.text !== "").map((context, sequence) => new DocumentationContextPromptElement({
    id: `agents-context:${sequence}`,
    sourceRevision: documentationSourceRevision(context.text),
    sequence,
    label: context.label,
    text: context.text,
  }));
  const executor = new PromptBatchExecutor({ executionLimit });
  const callOptions = (request) => ({
    commandId: "docs.agents",
    systemPrompt: request.systemPrompt,
    jsonSchema: request.jsonSchema,
    fmtFallback: request.fmtFallback,
  });
  const callAgent = (request, _batch, _retryIndex, _attemptContext, providerCallAdmission) => docsAgent.call(request.userPrompt, {
    ...callOptions(request),
    providerCallAdmission,
  });
  const projectInvocation = typeof agent.projectInvocation === "function"
    ? (request) => docsAgent.projectInvocation(request.userPrompt, callOptions(request))
    : undefined;
  const synthesisEnvelope = new ProjectSynthesisEnvelope({ rules });
  let finalPlan = planFor(initialElements, synthesisEnvelope, limit, executionLimit);
  const executeFinal = (plan) => executor.execute({
    plan,
    responseContract: new ProjectSectionContract(),
    reducer: new ProjectSectionReducer(),
    callAgent,
    projectInvocation,
  });
  if (finalPlan.batches.length === 1) {
    executor.executionBudget.consumeSynthesisCalls(1);
    return executeFinal(finalPlan);
  }

  const summaryEnvelope = new DocumentationSummaryEnvelope();
  const initialSummaryPlan = planFor(initialElements, summaryEnvelope, limit, executionLimit);
  const coverageDigest = finalPlan.collection.digest;
  executor.executionBudget.assertCanExecute(initialSummaryPlan.batches.length + 1);
  executor.executionBudget.consumeSynthesisCalls(1);
  const executeSummary = (plan) => executor.executeCompletions({
    plan,
    responseContract: new DocumentationContextSummaryContract(),
    callAgent,
    projectInvocation,
  });
  const reduction = new PromptReductionPlan({
    initialElements,
    coverageDigest,
    executionBudget: executor.executionBudget,
  });
  return reduction.execute({
    isComplete(elements, depth) {
      if (depth > 0) finalPlan = planFor(elements, synthesisEnvelope, limit, executionLimit);
      return finalPlan.batches.length === 1;
    },
    buildRound(elements, depth) {
      return depth === 0
        ? initialSummaryPlan
        : planFor(elements, summaryEnvelope, limit, executionLimit);
    },
    executeRound: executeSummary,
    toNextLevel(completions, depth) {
      const elements = completions.map((completion, sequence) => {
        const text = completion.response.text;
        return new DocumentationContextPromptElement({
          id: `agents-summary:${depth}:${sequence}`,
          sourceRevision: documentationSourceRevision(`${coverageDigest}:${completion.batchDigest}`),
          sequence,
          label: `Summary level ${depth + 1}`,
          text,
        });
      });
      return new PromptReductionLevel({ elements, coverageDigest });
    },
    finalize() {
      return executeFinal(finalPlan);
    },
  });
}
