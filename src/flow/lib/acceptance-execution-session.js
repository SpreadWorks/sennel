import { PromptExecutionBudget, PromptExecutionLimit, PromptRequestLimit } from "../../lib/prompt-batching.js";
import { AgentInvocationConfiguration } from "../../lib/agent.js";
import { PromptExecutionJournal, PromptExecutionScope, PromptExecutionJournalError } from "../../lib/prompt-execution-journal.js";
import { CanonicalPromptExecutionEpisode } from "./canonical-prompt-execution.js";
import { FlowExecutionContract, FlowExecutionContractRefusal, executionValueDigest } from "./flow-execution-contract.js";
import { AcceptanceExecutionContinuationEvidence } from "../steps/acceptance/acceptance-review-values.js";

/** Non-secret identity selected before the generation is claimed. */
export class AcceptanceExecutionProfile {
  constructor({ providerKey, profileKey, invocationConfiguration }) {
    if (typeof providerKey !== "string" || !providerKey || typeof profileKey !== "string" || !profileKey) {
      throw new TypeError("Acceptance execution requires a resolved provider and profile identity");
    }
    this.providerKey = providerKey;
    this.profileKey = profileKey;
    if (!(invocationConfiguration instanceof AgentInvocationConfiguration)) throw new TypeError("Acceptance profile requires effective invocation configuration");
    this.configurationDigest = executionValueDigest(invocationConfiguration.toJSON());
    Object.freeze(this);
  }
  toJSON() { return { providerKey: this.providerKey, profileKey: this.profileKey, configurationDigest: this.configurationDigest }; }
  get digest() { return executionValueDigest(this.toJSON()); }
  get agentOptions() { return { provider: this.profileKey }; }
}

/** Pure fixed execution policy; no reader, provider or runtime callback. */
export class AcceptanceExecutionSpecification {
  constructor({ executionMode, executionLimit, profile, promptDigest, schemaDigest }) {
    if (!["direct", "map-reduce"].includes(executionMode) || !(executionLimit instanceof PromptExecutionLimit)
      || !(profile instanceof AcceptanceExecutionProfile) || !/^[a-f0-9]{64}$/.test(promptDigest)
      || !/^[a-f0-9]{64}$/.test(schemaDigest)) throw new TypeError("Acceptance execution specification is invalid");
    Object.assign(this, { executionMode, executionLimit, profile, promptDigest, schemaDigest });
    Object.freeze(this);
  }
  get requestLimit() { return new PromptRequestLimit({ maxCharacters: this.executionLimit.maxRequestCharacters }); }
  contract({ binding, generation, context, budgetOwner }) {
    return FlowExecutionContract.fromBinding({ binding, generation, inputRevision: context.fingerprint.hash,
      promptDigest: this.promptDigest, schemaDigest: this.schemaDigest, budgetOwner,
      executionLimit: this.executionLimit, executionMode: this.executionMode, inputBaselines: context.executionInputBaselines });
  }
}

/** Physical execution consumes only acquired frontiers and save-only journals. */
export class AcceptanceExecutionSession {
  constructor({ specification, episode, journals }) {
    if (!(specification instanceof AcceptanceExecutionSpecification) || !(episode instanceof CanonicalPromptExecutionEpisode)
      || !Array.isArray(journals) || journals.some((journal) => !(journal instanceof PromptExecutionJournal))) {
      throw new TypeError("Acceptance execution session requires acquired typed inputs");
    }
    const identities = journals.map((journal) => executionValueDigest(journal.scope.toJSON()));
    if (new Set(identities).size !== identities.length) throw new TypeError("Acceptance journal scopes must be unique");
    this.specification = specification;
    this.executionContract = episode.executionContract;
    this.budget = PromptExecutionBudget.fromSnapshot(specification.executionLimit, episode.budget);
    this.journals = Object.freeze([...journals]);
    Object.freeze(this);
  }
  journal(stage, round = 0) {
    const scope = new PromptExecutionScope({ stage, round });
    const journal = this.journals.find((entry) => entry.scope.stage === scope.stage && entry.scope.round === scope.round);
    if (journal === undefined) throw new PromptExecutionJournalError("PROMPT_EXECUTION_IDENTITY_MISMATCH", "Acceptance execution scope was not acquired");
    return journal;
  }
  options(stage, round = 0, synthesisCallCount = 0) {
    return { executionJournal: this.journal(stage, round), synthesisCallCount };
  }
}

/** Validate unfinished execution against freshly acquired inputs before any publication or provider planning. */
export function readAcceptanceExecutionContract({ flowManager, state, binding, context,
  execution = flowManager.draftStepExecutionState({ binding }) }) {
  const lifecycle = execution.lifecycle;
  if (!["checkpoint", "claimed"].includes(lifecycle?.phase)) return null;
  if (lifecycle.binding.inputDigest !== context.fingerprint.hash
    || lifecycle.binding.inputRevision !== context.fingerprint.hash) {
    throw new FlowExecutionContractRefusal("Acceptance unfinished execution evidence changed");
  }
  const stored = flowManager.readStoredExecutionContract({ binding,
    generation: lifecycle.binding.executionGeneration, optional: lifecycle.phase === "checkpoint" });
  if (stored === null) return null;
  const expected = FlowExecutionContract.fromBinding({ binding, generation: stored.generation,
    inputRevision: context.fingerprint.hash, promptDigest: stored.promptDigest, schemaDigest: stored.schemaDigest,
    budgetOwner: stored.budgetOwner, executionLimit: stored.executionLimit, executionMode: stored.executionMode,
    inputBaselines: context.executionInputBaselines });
  expected.assertExecutionBinding(binding, lifecycle.binding);
  expected.assertCurrent(state);
  flowManager.readExecutionContract({ executionContract: expected });
  return expected;
}

/** Read-only evidence acquisition for the existing Step/Definition continuation. */
export function readAcceptanceExecutionContinuation({ flowManager, state, saved }) {
  const evidence = saved.result.evidence;
  const identity = evidence.identity;
  const generation = evidence.executionGeneration;
  let contractId = null;
  let progressDigest = executionValueDigest({ identity: identity.toJSON(), generation, missing: true });
  let reasonCode = null;
  let uncertainCalls = [];
  try {
    const stored = flowManager.readStoredExecutionContract({ binding: identity, generation, optional: true });
    if (stored === null) {
      reasonCode = "FLOW_EXECUTION_CONTRACT_MISSING";
    } else {
      contractId = stored.id;
      const expected = FlowExecutionContract.fromBinding({ binding: identity, generation,
        inputRevision: evidence.fingerprint, promptDigest: stored.promptDigest, schemaDigest: stored.schemaDigest,
        budgetOwner: stored.budgetOwner, executionLimit: stored.executionLimit, executionMode: stored.executionMode,
        inputBaselines: stored.inputBaselines });
      expected.assertCurrent(state);
      flowManager.readExecutionContract({ executionContract: expected });
      const episode = flowManager.readPromptExecutionEpisode({ executionContract: expected });
      const scopes = [...episode.scopes].sort((left, right) => left.scope.stage.localeCompare(right.scope.stage) || left.scope.round - right.scope.round);
      progressDigest = executionValueDigest({ contractId, scopes: scopes.map((scope) => scope.toJSON()), budget: episode.budget });
      uncertainCalls = scopes.flatMap((scope) => scope.batches.filter((batch) => batch.claim !== null)
        .map((batch) => executionValueDigest({ contractId, scope: scope.scope.toJSON(), planDigest: scope.plan.digest,
          batchDigest: batch.batchDigest, claim: batch.claim })));
    }
  } catch (error) {
    reasonCode = error.code ?? "FLOW_EXECUTION_PROGRESS_INVALID";
  }
  return new AcceptanceExecutionContinuationEvidence({ identity, generation, contractId, progressDigest, uncertainCalls, reasonCode });
}
