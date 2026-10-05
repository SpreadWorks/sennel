/**
 * src/lib/flow-envelope.js
 *
 * Envelope: result type for flow get/set/run commands.
 * Encapsulates ok/fail/warn construction, JSON serialization,
 * and stdout output + process.exitCode side effects.
 */

import { assertUserActionResultContract } from "../flow/lib/user-action-prompt.js";
import { assertNextActionDirective } from "../flow/lib/next-action-directive.js";

export class Envelope {
  constructor({ ok, type, key, data, errors }) {
    this.ok = ok;
    this.type = type;
    this.key = key;
    this.data = data;
    this.errors = errors;
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

  toJSON() {
    assertUserActionResultContract(this.data);
    assertNextActionDirective(this.data);
    return {
      ok: this.ok,
      type: this.type,
      key: this.key,
      data: this.data,
      errors: this.errors,
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
