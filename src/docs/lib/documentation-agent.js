import { FlowAttributionPolicy } from "../../lib/flow-attribution.js";
import { PromptBatchExecutor, PromptExecutionLimit } from "../../lib/prompt-batching.js";

/**
 * Agent boundary for documentation generation.
 *
 * Documentation commands are repository maintenance operations, not Flow
 * workers. Their provider calls must therefore never inherit an unrelated
 * ambient Flow or append metrics to its canonical state.
 */
export class DocumentationAgent {
  #agent;
  #session;
  #commandId;
  #flowAttribution = new FlowAttributionPolicy("none");

  constructor(agent, { session = null, commandId = null } = {}) {
    if (!agent || typeof agent.call !== "function") {
      throw new Error("documentation agent requires a call API");
    }
    this.#agent = agent;
    this.#session = session;
    this.#commandId = commandId;
    Object.freeze(this);
  }

  static from(agent) {
    return agent instanceof DocumentationAgent ? agent : new DocumentationAgent(agent);
  }

  static createExecutionLimit(options = {}) {
    return new PromptExecutionLimit({ ...options, maxAggregateCharacters: null });
  }

  resolve(commandId, options = {}) {
    if (typeof this.#agent.resolve !== "function") {
      throw new Error("documentation agent does not expose a resolve API");
    }
    return this.#agent.resolve(commandId, options);
  }

  get promptCharacterLimit() {
    return this.#agent.promptCharacterLimit;
  }

  get session() { return this.#session; }
  get commandId() { return this.#commandId; }
  get supportsProjectInvocation() { return typeof this.#agent.projectInvocation === "function"; }
  get dryRun() { return this.#session?.dryRun || false; }

  withSession(session) { return new DocumentationAgent(this.#agent, { session, commandId: this.#commandId }); }

  forCommand(commandId, { files = [] } = {}) {
    this.#session?.registerFiles(commandId, files);
    return new DocumentationAgent(this.#agent, { session: this.#session, commandId });
  }

  createExecutionLimit(options = {}) {
    return this.#session ? this.#session.createExecutionLimit(options)
      : DocumentationAgent.createExecutionLimit(options);
  }

  createExecutor(options = {}) {
    this.#session?.assertActive();
    return new PromptBatchExecutor({
      ...options,
      executionLimit: options.executionLimit || this.createExecutionLimit(),
      executionAdmission: this.#session?.createExecutionAdmission(this.#commandId),
    });
  }

  async previewPlan({ plan, projectInvocation, executionLimit }) {
    const executor = this.createExecutor({ executionLimit });
    const prepared = await executor.prepareExecution({ plan, projectInvocation });
    if (this.#session) await this.#session.admit(prepared, this.#commandId);
    return prepared;
  }

  projectInvocation(prompt, options = {}) {
    if (typeof this.#agent.projectInvocation !== "function") {
      throw new Error("documentation agent does not expose a projectInvocation API");
    }
    return this.#agent.projectInvocation(prompt, {
      ...options,
      flowAttribution: this.#flowAttribution.mode,
    });
  }

  async call(prompt, options = {}) {
    this.#session?.assertActive();
    if (this.dryRun) throw new Error("Documentation dry-run cannot call an AI provider");
    return this.#agent.call(prompt, {
      ...options,
      flowAttribution: this.#flowAttribution.mode,
      ...(this.#session && {
        providerAttemptObserver: this.#session,
        abortSignal: this.#session.abortSignal,
        ...(!options.providerCallAdmission?.invocation && {
          providerAttemptAdmission: this.#session.createExecutionAdmission(options.commandId || this.#commandId),
        }),
      }),
    });
  }
}
