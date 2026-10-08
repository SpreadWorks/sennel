/**
 * Base class for executable Flow steps, independent of CLI commands.
 * @abstract
 */
import { StepResult } from "./step-result.js";

export class Step {
  static dependencies = [];

  constructor() {
    if (new.target === Step) throw new TypeError("Step is abstract");
  }

  /** Common execution boundary; subclasses implement _execute(). */
  execute() {
    if (this.constructor.synchronous !== true) {
      return this.#executeAsync();
    }
    const output = this._execute();
    return output instanceof Promise
      ? output.then((result) => this.#validateResult(result))
      : this.#validateResult(output);
  }

  async #executeAsync() {
    const output = await this._execute();
    return this.#validateResult(output);
  }

  #validateResult(output) {
    if (!(output instanceof StepResult)) {
      throw new TypeError("Step._execute() must return a StepResult");
    }
    return output;
  }

  /** @abstract */
  _execute() {
    throw new Error("Step._execute() must be implemented by subclass");
  }
}
