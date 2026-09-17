/**
 * Base class for executable Flow steps, independent of CLI commands.
 * @abstract
 */
import { StepOutput } from "./step-output.js";

export class Step {
  static dependencies = [];

  constructor() {
    if (new.target === Step) throw new TypeError("Step is abstract");
  }

  /** Common execution boundary; subclasses implement _execute(). */
  async execute() {
    const output = await this._execute();
    if (!(output instanceof StepOutput)) {
      throw new TypeError("Step._execute() must return a StepOutput");
    }
    return output;
  }

  /** @abstract */
  _execute() {
    throw new Error("Step._execute() must be implemented by subclass");
  }
}
