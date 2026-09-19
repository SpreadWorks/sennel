import {
  DraftRefineAwaitBinding,
  DraftStepBinding,
} from "../engine/connectors/draft/draft-step-binding.js";
import { STEP_OUTPUT_TYPE, StepOutput } from "../engine/step-output.js";
import { DraftStepPersistenceFailure, isDraftStepPersistenceFailure } from "../lib/definition-lifecycle-failure.js";

/** Access the sealed worker request for one Connector-bound Draft Step. */
export class DraftService {
  #workerOutcome = null;

  constructor({ flowManager, binding, workerFacts = null, workerExecutor = null, workerErrorCommitter = null }) {
    if (!(binding instanceof DraftStepBinding)) {
      throw new TypeError("DraftService requires a typed Draft step binding");
    }
    if (binding.flowManager !== flowManager) {
      throw new Error("DraftService binding belongs to a different FlowManager");
    }
    this.binding = binding;
    if (workerExecutor !== null && typeof workerExecutor !== "function") {
      throw new TypeError("DraftService worker executor must be a function");
    }
    if (workerErrorCommitter !== null && typeof workerErrorCommitter !== "function") {
      throw new TypeError("DraftService worker error committer must be a function");
    }
    if (workerFacts !== null && (typeof workerFacts !== "object" || Array.isArray(workerFacts))) {
      throw new TypeError("DraftService worker facts must be an object");
    }
    if (workerFacts !== null && workerExecutor === null) {
      throw new TypeError("DraftService worker facts require a worker executor");
    }
    this.workerExecutor = workerExecutor;
    this.workerErrorCommitter = workerErrorCommitter;
    this.workerFacts = workerFacts;
  }

  /** Confirm that this bound refine Step is waiting for its stored question. */
  awaitingUserInput() {
    if (!(this.binding instanceof DraftRefineAwaitBinding)) return false;
    this.binding.assertCurrent();
    return true;
  }

  inspectWorkerFacts() {
    if (this.workerFacts === null) throw new Error("Draft worker has no prepared facts");
    this.binding.assertCurrent();
    return this.workerFacts;
  }

  async commitWorker(stepOutput) {
    let outcome;
    try {
      outcome = await this.workerExecutor(stepOutput);
    } catch (error) {
      if (isDraftStepPersistenceFailure(error)) throw error;
      throw new DraftStepPersistenceFailure(error);
    }
    this.#workerOutcome = outcome;
    if (outcome.error !== null) throw outcome.error;
    return outcome.stepOutput;
  }

  async commitWorkerError(stepOutput) {
    if (!(stepOutput instanceof StepOutput) || stepOutput.type !== STEP_OUTPUT_TYPE.ERROR) {
      throw new TypeError("Draft worker error commit requires an Error StepOutput");
    }
    if (this.workerErrorCommitter === null) throw stepOutput.error;
    let outcome;
    try {
      outcome = await this.workerErrorCommitter(stepOutput);
    } catch (error) {
      if (isDraftStepPersistenceFailure(error)) throw error;
      throw new DraftStepPersistenceFailure(error);
    }
    this.#workerOutcome = outcome;
    if (outcome.error !== null) throw outcome.error;
    return outcome.stepOutput;
  }

  get workerOutcome() {
    return this.#workerOutcome;
  }
}
