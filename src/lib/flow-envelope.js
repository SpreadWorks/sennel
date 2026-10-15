/**
 * src/lib/flow-envelope.js
 *
 * Envelope: result type for flow get/set/run commands.
 * Encapsulates ok/fail/warn construction, JSON serialization,
 * and stdout output + process.exitCode side effects.
 */

import { assertUserActionResultContract } from "../flow/lib/user-action-prompt.js";
import { NextActionDirective, assertNextActionDirective } from "../flow/lib/next-action-directive.js";
import { FlowStopGuidance, normalizeFlowStopResult, selectedFlowStopDirective, publicFlowStopValue, hasStoppedStepOutcome, flowStopDiagnosticCode } from "./flow-stop-guidance.js";

export class Envelope {
  constructor({ ok, type, key, data, errors, guidance = null }) {
    this.ok = ok;
    this.type = type;
    this.key = key;
    this.data = data;
    this.errors = errors;
    Object.defineProperty(this, "stopGuidanceOptions", { value: {}, writable: true });
    if (guidance !== null) {
      const directive = NextActionDirective.fromStored(data?.directive);
      this.data = { ...data, directive };
      this.guidance = FlowStopGuidance.fromStored(guidance, { directive });
    }
  }

  /**
   * @param {string} type - "get", "set", or "run"
   * @param {string} key - command key (e.g. "status", "step", "merge")
   * @param {*} data - response data
   */
  static ok(type, key, data) {
    return new Envelope({ ok: true, type, key, data, errors: [] });
  }

  /**
   * @param {string} type
   * @param {string} key
   * @param {string} code - machine-readable error code
   * @param {string|string[]} messages
   * @param {*} [data] - optional structured judgment data (score, hashes, …)
   */
  static fail(type, key, code, messages, data) {
    const msgs = Array.isArray(messages) ? messages : [messages];
    return new Envelope({
      ok: false, type, key, data: data ?? null,
      errors: [{ level: "fatal", code, messages: msgs }],
    });
  }

  /**
   * @param {string} type
   * @param {string} key
   * @param {*} data
   * @param {string} code - warning code
   * @param {string|string[]} messages
   */
  static warn(type, key, data, code, messages) {
    const msgs = Array.isArray(messages) ? messages : [messages];
    return new Envelope({
      ok: true, type, key, data,
      errors: [{ level: "warn", code, messages: msgs }],
    });
  }

  /**
   * Append a warn-level entry. Does not flip ok.
   */
  addWarning(code, messages) {
    const msgs = Array.isArray(messages) ? messages : [messages];
    this.errors.push({ level: "warn", code, messages: msgs });
  }

  /** Append a fatal entry and invalidate the envelope. */
  addFatal(code, messages) {
    const msgs = Array.isArray(messages) ? messages : [messages];
    this.ok = false;
    this.errors.push({ level: "fatal", code, messages: msgs });
  }

  /** Attach presentation only after the caller has acquired final execution facts. */
  attachStopGuidance(options = {}) {
    if (!["get", "set", "run", "report", "resume", "prepare", "query"].includes(this.type)) return this;
    this.stopGuidanceOptions = { ...this.stopGuidanceOptions, ...options };
    const { error = null, operation = null, exitCode = null, facts = null, t = null } = this.stopGuidanceOptions;
    const directive = selectedFlowStopDirective(this.data);
    const stop = !this.ok || exitCode !== null && exitCode !== 0
      || directive?.kind === "blocked" || directive?.requiresUserAction === true
      || directive?.kind === "await_task_review_filter" || this.data?.yieldsControl === true
      || this.data?.actionPrompt != null || hasStoppedStepOutcome(this.data)
      || this.data?.dispatch && !["completed", "aborted", "idle"].includes(this.data.dispatch.boundary);
    if (!stop) return this;
    const code = this.errors.find((entry) => entry.level === "fatal")?.code ?? this.errors[0]?.code
      ?? error?.code ?? this.guidance?.code ?? flowStopDiagnosticCode(this.data);
    if (this.guidance != null) {
      if (!(this.guidance instanceof FlowStopGuidance)) throw new TypeError("Flow guidance must be a FlowStopGuidance");
      this.guidance.assertDirective(directive);
      if (Object.keys(options).length === 0 && this.guidance.code === code) return this;
    }
    const result = normalizeFlowStopResult(this.data, {
      code,
      error, operation: operation ?? `flow ${this.type} ${this.key}`, facts, t,
    });
    this.data = result.data;
    this.guidance = result.guidance;
    return this;
  }

  toJSON() {
    this.attachStopGuidance();
    assertUserActionResultContract(this.data);
    assertNextActionDirective(this.data);
    return {
      ok: this.ok,
      type: this.type,
      key: this.key,
      data: this.guidance ? publicFlowStopValue(this.data, false, this.guidance.text) : this.data,
      errors: this.guidance ? publicFlowStopValue(this.errors, false, this.guidance.text) : this.errors,
      ...(this.guidance && { guidance: publicFlowStopValue(this.guidance.toJSON(), false, this.guidance.text) }),
    };
  }

  /**
   * Print envelope JSON to stdout and set process.exitCode.
   * Uses process.exitCode (not process.exit()) so post hooks and
   * finally blocks complete before exit.
   */
  output() {
    console.log(JSON.stringify(this.toJSON(), null, 2));
    process.exitCode = this.ok ? 0 : 1;
  }
}
