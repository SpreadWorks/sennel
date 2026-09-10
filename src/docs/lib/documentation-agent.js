import { FlowAttributionPolicy } from "../../lib/flow-attribution.js";

/**
 * Agent boundary for documentation generation.
 *
 * Documentation commands are repository maintenance operations, not Flow
 * workers. Their provider calls must therefore never inherit an unrelated
 * ambient Flow or append metrics to its canonical state.
 */
export class DocumentationAgent {
  #agent;
  #flowAttribution = new FlowAttributionPolicy("none");

  constructor(agent) {
    if (!agent || typeof agent.call !== "function") {
      throw new Error("documentation agent requires a call API");
    }
    this.#agent = agent;
    Object.freeze(this);
  }

  static from(agent) {
    return agent instanceof DocumentationAgent ? agent : new DocumentationAgent(agent);
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

  projectInvocation(prompt, options = {}) {
    if (typeof this.#agent.projectInvocation !== "function") {
      throw new Error("documentation agent does not expose a projectInvocation API");
    }
    return this.#agent.projectInvocation(prompt, {
      ...options,
      flowAttribution: this.#flowAttribution.mode,
    });
  }

  call(prompt, options = {}) {
    return this.#agent.call(prompt, {
      ...options,
      flowAttribution: this.#flowAttribution.mode,
    });
  }
}
