import {
  GLOBAL_PROMPT_ELEMENT_HARD_MAX,
  PromptBatchExecutor,
  PromptBatchPlan,
  PromptBatchReducer,
  PromptExecutionLimit,
  PromptRequestLimit,
  PromptResponseInvalidFailure,
} from "../../lib/prompt-batching.js";
import { PromptBuilder } from "../../lib/prompt-builder.js";
import { DocumentationAgent } from "./documentation-agent.js";

class ForgeAgentResponse {
  constructor(text) {
    if (typeof text !== "string" || text.trim() === "") {
      throw new PromptResponseInvalidFailure("Forge agent response is empty");
    }
    this.text = text;
    Object.freeze(this);
  }
}

class ForgeAgentResponseContract {
  parse(raw) {
    return new ForgeAgentResponse(raw);
  }
}

class ForgeAgentResponseReducer extends PromptBatchReducer {
  reduce(completions) {
    if (completions.length !== 1 || !(completions[0].response instanceof ForgeAgentResponse)) {
      throw new PromptResponseInvalidFailure("Forge execution requires one typed completion");
    }
    return completions[0].response.text;
  }
}

export async function executeForgeAgentPrompt({
  agent,
  prompt,
  systemPrompt,
  maxCharacters,
  onStdout,
  onStderr,
} = {}) {
  const docsAgent = DocumentationAgent.from(agent);
  const resolvedLimit = maxCharacters ?? docsAgent.promptCharacterLimit ?? GLOBAL_PROMPT_ELEMENT_HARD_MAX;
  const requestLimit = new PromptRequestLimit({ maxCharacters: resolvedLimit });
  const executionLimit = new PromptExecutionLimit({ maxRequestCharacters: resolvedLimit });
  const pb = new PromptBuilder();
  if (systemPrompt) pb.setRole(systemPrompt);
  pb.addUserPrompt("## Content", prompt);
  const plan = PromptBatchPlan.fromRequest({ request: pb.build(), limit: requestLimit, id: "docs-forge-request" });
  const callOptions = (request) => ({
    commandId: "docs.forge",
    systemPrompt: request.systemPrompt,
    jsonSchema: request.jsonSchema,
    fmtFallback: request.fmtFallback,
    onStdout,
    onStderr,
  });

  return new PromptBatchExecutor({ executionLimit }).execute({
    plan,
    responseContract: new ForgeAgentResponseContract(),
    reducer: new ForgeAgentResponseReducer(),
    callAgent: (request, _batch, _retryIndex, _attemptContext, providerCallAdmission) => docsAgent.call(request.userPrompt, {
      ...callOptions(request),
      providerCallAdmission,
    }),
    projectInvocation: typeof agent.projectInvocation === "function"
      ? (request) => docsAgent.projectInvocation(request.userPrompt, callOptions(request))
      : undefined,
  });
}
