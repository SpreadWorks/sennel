import path from "node:path";
import { Agent } from "../../../src/lib/agent.js";
import { ProviderRegistry, ClaudeProvider } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { PromptBatchExecutor, PromptBatchPlan, PromptExecutionLimit, PromptExecutionBudget } from "../../../src/lib/prompt-batching.js";
import { PromptExecutionJournal, PromptExecutionScope } from "../../../src/lib/prompt-execution-journal.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { CanonicalPromptExecutionJournalWriter } from "../../../src/flow/lib/canonical-prompt-execution-writer.js";
import { FlowExecutionContract } from "../../../src/flow/lib/flow-execution-contract.js";
import { FlowProcessExecutionBinding } from "../../../src/flow/lib/flow-process-execution-binding.js";
import { DraftRefineWorkerRequiredResult } from "../../../src/flow/engine/step-result.js";
import { DraftWorkerExecutionClaim, settleDraftStepResult } from "../../../src/flow/definition.js";
import { FlowAtStepFixture } from "./flow-setup.js";
import { createTmpDir, removeTmpDir } from "../builders/tmp-dir.js";

/** Real canonical Agent/provider/process/journal producers; only the provider is a deterministic Node program. */
export async function createExecutionQueryScenario(t, { result = "received", inputTokens = 0, model = "reported-model", providerSequence = null, providerProgram = null, executionLimitOptions = {} } = {}) {
  const root = createTmpDir("execution-query-scenario-");
  let runtime = null;
  t.after(async () => { if (runtime && !runtime.closed) await runtime.close(); removeTmpDir(root); });
  const specId = "001-observation";
  const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const flowFixture = new FlowAtStepFixture({ flowManager, specId, runId: "observation-run", request: "Observe calls", targetStep: "draft-refine" }).create();
  const state = flowManager.canonicalState(specId);
  const binding = { runId: state.runId, specId, stepId: "draft-refine", attempt: state.attempt };
  const required = new DraftRefineWorkerRequiredResult();
  const settlement = settleDraftStepResult(required.stepId, required);
  const executionBinding = flowManager.draftStepExecutionState({ binding }).workerBinding({ inputDigest: "a".repeat(64), inputRevision: "b".repeat(64) });
  flowManager.checkpointDraftStepExecution({ binding, stepResult: required, settlement, executionBinding });
  const limit = new PromptExecutionLimit({ maxProviderCallCount: 4, ...executionLimitOptions });
  const contract = FlowExecutionContract.fromBinding({ binding, generation: executionBinding.executionGeneration,
    inputRevision: executionBinding.inputRevision, promptDigest: "c".repeat(64), schemaDigest: "d".repeat(64), executionLimit: { ...limit } });
  const claim = new DraftWorkerExecutionClaim({ dispatchInvocationId: "dispatch", generatedAt: "2026-10-16T01:02:03.000Z", actionDigest: "e".repeat(64), requestDigest: "f".repeat(64) });
  flowManager.claimDraftStepExecution({ binding, stepResult: required, settlement, executionBinding, executionClaim: claim, executionContract: contract });
  const scope = new PromptExecutionScope({ stage: "map" });
  const plan = PromptBatchPlan.fromRequest({ id: "input", request: { userPrompt: "input" } });
  const providerResponse = JSON.stringify({ result, usage: { input_tokens: inputTokens, output_tokens: 0 }, model, reasoning_effort: "low" });
  const sequenceProgram = providerSequence === null ? null : `
    const fs = require('node:fs');
    const counter = ${JSON.stringify(path.join(root, "provider-counter"))};
    const index = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(index + 1));
    const sequence = ${JSON.stringify(providerSequence)};
    const response = sequence[index];
    process.stdout.write(JSON.stringify({ result: response.result,
      usage: { input_tokens: response.inputTokens, output_tokens: 0 },
      model: ${JSON.stringify(model)}, reasoning_effort: 'low' }));
  `;
  const profile = { command: process.execPath, args: ["-e", providerProgram ?? sequenceProgram ?? `process.stdout.write(${JSON.stringify(providerResponse)})`, "{{PROMPT}}"], jsonOutputFlag: "--json" };
  class Registry extends ProviderRegistry { resolveByCommand() { return new ClaudeProvider(); } }
  const agent = new Agent({ config: { agent: { default: "fixture", providers: { fixture: profile } } },
    paths: { root, agentWorkDir: path.join(root, ".tmp") }, flowManager,
    registry: new Registry({ fixture: profile }), logger: new Logger({ logDir: root, enabled: false }) });
  runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root, runId: state.runId, specId });
  const run = (options = {}) => runtime.enter(() => agent.call("input", {
    commandId: "draft-test", retryCount: 0, processExecutionBinding: FlowProcessExecutionBinding.forContract(contract), ...options,
  }));
  const runPrompt = (manager = flowManager, options = {}) => runtime.enter(() => {
    const episode = manager.readPromptExecutionEpisode({ executionContract: contract, checkoutIdentity: runtime.checkoutIdentity });
    const snapshot = episode.scopes.find((entry) => entry.scope.stage === scope.stage) ?? null;
    return new PromptBatchExecutor({ executionLimit: limit, executionBudget: PromptExecutionBudget.fromSnapshot(limit, episode.budget) }).executeCompletions({ plan,
      executionJournal: new PromptExecutionJournal({ scope, snapshot,
        writer: new CanonicalPromptExecutionJournalWriter({ flowManager: manager, executionContract: contract, scope, snapshot, checkoutIdentity: runtime.checkoutIdentity }) }),
      callAgent: (request, _batch, _index, _context, providerCallAdmission) => agent.call(request.userPrompt, { commandId: "draft-test", providerCallAdmission, retryCount: 0, ...options }),
      responseContract: { parse: (raw) => raw },
    });
  });
  return { root, flowManager, manager: flowManager, specId, runId: state.runId, agent, flowFixture,
    contract, binding, scope, plan, runtime, run, runPrompt,
    shutdown: () => runtime.close(),
    reload: () => new FlowManager({ root, mainRoot: root, inWorktree: false }) };
}
