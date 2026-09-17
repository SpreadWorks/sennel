import { FlowExecutionError } from "./flow-execution-error.js";

export const STEP_OUTPUT_TYPE = Object.freeze({
  COMPLETED: "completed",
  BRANCH_REQUIRED: "branch-required",
  LOOP_REQUIRED: "loop-required",
  USER_INPUT_REQUIRED: "user-input-required",
  ERROR: "error",
});

const NON_ERROR_OUTPUT_TYPES = new Set([
  STEP_OUTPUT_TYPE.COMPLETED,
  STEP_OUTPUT_TYPE.BRANCH_REQUIRED,
  STEP_OUTPUT_TYPE.LOOP_REQUIRED,
  STEP_OUTPUT_TYPE.USER_INPUT_REQUIRED,
]);

/** Immutable control result returned by an executable Flow step. */
export class StepOutput {
  /** @type {string} */
  #type;

  /** @type {Error | null} */
  #error;

  /** @param {string | Error} result A non-error output type or an Error. */
  constructor(result) {
    if (arguments.length !== 1) {
      throw new TypeError("StepOutput requires one result");
    }
    if (result instanceof Error) {
      this.#type = STEP_OUTPUT_TYPE.ERROR;
      this.#error = result instanceof FlowExecutionError
        ? result
        : Object.freeze(new Error(result.message));
    } else if (NON_ERROR_OUTPUT_TYPES.has(result)) {
      this.#type = result;
      this.#error = null;
    } else {
      throw new TypeError("StepOutput requires a non-error type or an Error");
    }
    Object.freeze(this);
  }

  /** @returns {string} */
  get type() {
    return this.#type;
  }

  /** @returns {Error | null} */
  get error() {
    return this.#error;
  }

  toJSON() {
    if (this.#error === null) return { type: this.#type };
    return {
      type: STEP_OUTPUT_TYPE.ERROR,
      error: this.#error instanceof FlowExecutionError
        ? { kind: "flow", ...this.#error.toJSON() }
        : { kind: "generic", message: this.#error.message },
    };
  }

  static fromStored(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("stored StepOutput must be an object");
    }
    if (NON_ERROR_OUTPUT_TYPES.has(value.type) && Object.keys(value).length === 1) {
      return new StepOutput(value.type);
    }
    if (value.type !== STEP_OUTPUT_TYPE.ERROR || Object.keys(value).sort().join(",") !== "error,type"
      || value.error === null || typeof value.error !== "object" || Array.isArray(value.error)) {
      throw new TypeError("stored StepOutput is invalid");
    }
    const { kind, ...details } = value.error;
    if (kind === "flow") {
      return new StepOutput(FlowExecutionError.fromStored(details));
    }
    if (kind === "generic" && Object.keys(details).join(",") === "message" && typeof details.message === "string") {
      return new StepOutput(new Error(details.message));
    }
    throw new TypeError("stored StepOutput error is invalid");
  }
}
