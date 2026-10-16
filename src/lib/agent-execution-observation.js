import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { FlowExecutionObservationSession } from "./flow-execution-observation.js";
import { ProcessExecutionControlFailure } from "./process-execution-values.js";

const callers = new AsyncLocalStorage();

class AgentExecutionCaller {
  #flowVersionId;
  constructor(id, flowVersionId = null) {
    if (typeof id !== "string" || !id) throw new TypeError("Agent caller identity is required");
    this.id = id;
    this.#flowVersionId = flowVersionId;
  }
  get flowVersionId() { return this.#flowVersionId; }
  bind(flowVersionId) {
    if (this.#flowVersionId !== null && this.#flowVersionId !== flowVersionId) throw new TypeError("Agent caller Version is already fixed");
    this.#flowVersionId = flowVersionId;
  }
  toJSON() { return { kind: this.kind, id: this.id, flowVersionId: this.flowVersionId }; }
}
class StepAttemptExecutionCaller extends AgentExecutionCaller {
  constructor(id, flowVersionId) { super(id, flowVersionId); this.kind = "step-attempt"; Object.freeze(this); }
}
class AgentInvocationExecutionCaller extends AgentExecutionCaller {
  constructor(id) { super(id); this.kind = "agent-invocation"; Object.freeze(this); }
}

/** The logical caller is captured at entry, independently of physical parents. */
export class AgentExecutionObservation {
  #session;
  #started = performance.now();
  constructor({ session, logicalInvocationId, requestId, caller, role, requested, promptIdentity = null }) {
    if (!(session instanceof FlowExecutionObservationSession)) throw new TypeError("Agent observation requires a typed session");
    this.#session = session;
    this.logicalInvocationId = logicalInvocationId;
    this.requestId = requestId;
    this.binding = session.binding;
    this.caller = caller ?? new StepAttemptExecutionCaller(session.binding.attemptId, session.binding.flowVersionId);
    callers.getStore()?.bind(session.binding.flowVersionId);
    this.role = role;
    this.requested = Object.freeze({ ...requested });
    this.promptIdentity = promptIdentity;
    this.append("agent-started", logicalInvocationId, { logicalInvocationId, requestId,
      caller: this.caller, role, commandId: role, requested, responseMode: "return-to-caller", promptIdentity });
  }

  static currentCaller() { const caller = callers.getStore(); return caller?.flowVersionId ? caller : null; }
  static run(logicalInvocationId, callback) {
    return callers.run(new AgentInvocationExecutionCaller(logicalInvocationId), callback);
  }

  append(kind, entityId, data, outcome = null) {
    try { return this.#session.append({ kind, entityId, data }); }
    catch (cause) {
      const receipt = outcome?.processExecutionStopReceipt ?? null;
      const error = new ProcessExecutionControlFailure("observation-save-failed", "Execution observation could not be saved", {
        cause, executionId: receipt?.executionId ?? null, callId: receipt?.callId ?? null,
      });
      // Retain the actual response/receipt; an observation failure never permits
      // Agent's retry loop to repeat an external operation.
      error.providerOutcome = outcome;
      error.processExecutionStopReceipt = receipt;
      error.providerCompletionEvidence = outcome?.providerCompletionEvidence ?? null;
      error.stopEvidence = outcome?.stopEvidence ?? null;
      throw error;
    }
  }

  providerStarted(context) {
    this.append("provider-started", context.attemptId, { logicalInvocationId: this.logicalInvocationId,
      providerAttemptId: context.attemptId, measurementId: context.measurementId,
      attemptIndex: context.attemptIndex, maxAttempts: context.maxAttempts, provider: context.provider, profileKey: context.profileKey,
      providerStarted: null, requested: this.requested });
  }

  providerSettled(record, outcome) {
    this.append("provider-settled", record.attemptId, { logicalInvocationId: this.logicalInvocationId,
      providerAttemptId: record.attemptId, measurementId: record.measurementId,
      providerStarted: record.providerStarted, status: record.status, usage: record.usage,
      reported: record.reported, startedAt: record.startedAt, endedAt: record.endedAt, durationMs: record.durationMs,
      attemptIndex: record.attemptIndex, maxAttempts: record.maxAttempts,
      failure: record.status === "failed" ? { code: outcome?.code == null ? null : String(outcome.code), reason: outcome instanceof ProcessExecutionControlFailure ? outcome.reason : null } : null,
      measurementScope: "provider-attempt" }, outcome);
  }

  ready({ cacheOutcome, result }) {
    this.append("agent-response-ready", this.logicalInvocationId, { logicalInvocationId: this.logicalInvocationId,
      requestId: this.requestId, cacheOutcome, responseCharacters: result.text.length,
      reported: result.reported ?? { model: null, effort: null },
      durationMs: Math.max(0, Math.round(performance.now() - this.#started)),
      measurementScope: "final-logical-response", measurementId: `logical:${this.logicalInvocationId}` }, result);
  }

  failed(error) {
    if (error?.reason === "observation-save-failed") return;
    this.append("agent-failed", this.logicalInvocationId, { logicalInvocationId: this.logicalInvocationId,
      requestId: this.requestId, code: error?.code == null ? null : String(error.code),
      failure: { code: error?.code == null ? null : String(error.code),
        reason: error instanceof ProcessExecutionControlFailure ? error.reason : null },
      durationMs: Math.max(0, Math.round(performance.now() - this.#started)) }, error);
  }

  diagnosticReference() {
    return { binding: this.binding.toJSON(), logicalInvocationId: this.logicalInvocationId,
      requestId: this.requestId, measurementId: `logical:${this.logicalInvocationId}`,
      measurementScope: "final-logical-response" };
  }
}
