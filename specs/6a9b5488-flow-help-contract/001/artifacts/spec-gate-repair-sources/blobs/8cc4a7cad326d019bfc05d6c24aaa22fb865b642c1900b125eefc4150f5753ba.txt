/** Flow-specific failure information carried by an error StepResult. */
export class FlowExecutionError extends Error {
  constructor({ code, message, runId, stepId, attemptId = null, cause = null } = {}) {
    if (typeof code !== "string" || code.trim() === "") {
      throw new TypeError("FlowExecutionError code must be a non-empty string");
    }
    if (typeof message !== "string" || message.trim() === "") {
      throw new TypeError("FlowExecutionError message must be a non-empty string");
    }
    if (typeof runId !== "string" || runId.trim() === "") {
      throw new TypeError("FlowExecutionError runId must be a non-empty string");
    }
    if (typeof stepId !== "string" || stepId.trim() === "") {
      throw new TypeError("FlowExecutionError stepId must be a non-empty string");
    }
    if (attemptId !== null && (typeof attemptId !== "string" || attemptId.trim() === "")) {
      throw new TypeError("FlowExecutionError attemptId must be null or a non-empty string");
    }
    if (cause !== null && !(cause instanceof Error)) {
      throw new TypeError("FlowExecutionError cause must be an Error");
    }
    super(message, cause === null ? undefined : { cause });
    this.name = "FlowExecutionError";
    this.code = code;
    this.runId = runId;
    this.stepId = stepId;
    this.attemptId = attemptId;
    Object.freeze(this);
  }

  static fromStored(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "attemptId,code,message,runId,stepId") {
      throw new TypeError("stored FlowExecutionError is invalid");
    }
    return new FlowExecutionError(value);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      runId: this.runId,
      stepId: this.stepId,
      attemptId: this.attemptId,
    };
  }
}
