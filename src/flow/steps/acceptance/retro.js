import { Step } from "../../engine/step.js";
import { RetroAggregatedResult, RetroIncompleteResult, RetroEvidenceRefreshResult } from "../../engine/step-result.js";
import { RetroService } from "../../services/retro-service.js";
export function retroResult(input) {
  if (input.evidence.staleFacts !== null) return new RetroEvidenceRefreshResult({ evidence: input.evidence });
  return input.evidence.notDone > 0 ? new RetroIncompleteResult({ evidence: input.evidence })
    : new RetroAggregatedResult({ evidence: input.evidence });
}
export class RetroStep extends Step {
  static dependencies = [RetroService];
  #service;
  constructor(service) { super(); this.#service = service; }
  async _execute() {
    const result = retroResult(this.#service.inspectInput());
    await result.persist(this.#service);
    return result;
  }
}
