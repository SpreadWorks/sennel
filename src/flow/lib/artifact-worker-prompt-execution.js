import { PromptBatchPlan, PromptBatchExecutor, PromptExecutionLimit, PromptExecutionBudget,
  PromptBatchExecutionIncompleteFailure } from "../../lib/prompt-batching.js";
import { AgentFailure } from "../../lib/agent-failure.js";
import { WorkerArtifactHandoffError } from "./worker-artifact-handoff-error.js";
import { PromptExecutionJournal, PromptExecutionScope } from "../../lib/prompt-execution-journal.js";
import { FlowExecutionContract } from "./flow-execution-contract.js";
import { CanonicalPromptExecutionJournalWriter } from "./canonical-prompt-execution-writer.js";
import { captureProcessExecutionCheckoutIdentity } from "../../lib/process-execution-runtime.js";

/** Outer assembly reads the episode; the writer remains a save-only Store adapter. */
export async function executeArtifactWorkerPrompt({ flowManager, request, prompt, callOptions, agent, checkoutIdentity = null,
  reservationContinuation = null }) {
  const executionContract = request.executionContract;
  if (!(executionContract instanceof FlowExecutionContract)) throw new TypeError("Artifact worker Prompt execution requires its canonical contract");
  checkoutIdentity ??= captureProcessExecutionCheckoutIdentity({ mainRoot: request.mainRoot ?? flowManager._mainRoot,
    executionRoot: request.executionRoot ?? flowManager.executionRoot(flowManager.loadReadOnly(executionContract.specId)) });
  const episode = flowManager.readPromptExecutionEpisode({ executionContract, checkoutIdentity });
  const limit = new PromptExecutionLimit(executionContract.executionLimit ?? {});
  const plan = PromptBatchPlan.fromRequest({ id: "artifact-worker", sourceRevision: executionContract.inputRevision,
    limit: limit.requestLimit(), request: { userPrompt: prompt, systemPrompt: callOptions.systemPrompt ?? null,
      jsonSchema: callOptions.jsonSchema ?? null, fmtFallback: callOptions.fmtFallback ?? null } });
  const scope = new PromptExecutionScope({ stage: "artifact-worker" });
  const snapshot = episode.scopes.find((entry) => entry.scope.stage === scope.stage && entry.scope.round === scope.round) ?? null;
  const executionJournal = new PromptExecutionJournal({ scope, snapshot,
    writer: new CanonicalPromptExecutionJournalWriter({ flowManager, executionContract, scope, snapshot,
      processExecutionBinding: callOptions.processExecutionBinding ?? null, checkoutIdentity }) });
  const executor = new PromptBatchExecutor({ executionLimit: limit,
    executionBudget: PromptExecutionBudget.fromSnapshot(limit, episode.budget) });
  let completions;
  try { completions = await executor.executeCompletions({ plan, executionJournal, reservationContinuation,
    responseContract: { parse: (raw) => raw, itemCount: () => 1 },
    callAgent: (selected, _batch, _retry, _context, providerCallAdmission) => agent.call(selected.userPrompt,
      { ...callOptions, ...(reservationContinuation === null ? {} : { cacheMode: "bypass" }), providerCallAdmission }),
    ...(typeof agent.projectInvocation === "function" ? {
      projectInvocation: (selected) => agent.projectInvocation(selected.userPrompt, callOptions),
    } : {}),
  }); } catch (error) {
    // Retain the dispatcher's existing external-intervention and retry policy.
    if (error instanceof PromptBatchExecutionIncompleteFailure
      && (error.cause instanceof AgentFailure || error.cause instanceof WorkerArtifactHandoffError)) throw error.cause;
    throw error;
  }
  return completions[0].response;
}
