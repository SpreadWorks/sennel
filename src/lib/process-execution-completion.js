import { ProcessExecutionControlFailure, ProcessExecutionFailureDiagnostic, ProcessExecutionStopReceipt } from "./process-execution-values.js";

/** Keep physical completion separate from publication or reporting failures. */
export function retainExecutionCompletion(target, source) {
  if (source?.processExecutionHistory !== undefined) target.processExecutionHistory = source.processExecutionHistory;
  if (source?.processExecutionStopReceipt == null) return;
  const receipt = source.processExecutionStopReceipt instanceof ProcessExecutionStopReceipt
    ? source.processExecutionStopReceipt : new ProcessExecutionStopReceipt(source.processExecutionStopReceipt);
  for (const key of ["stdout", "stderr", "signal", "killed", "timing", "providerStarted"]) {
    if (Object.hasOwn(source, key)) target[key] = source[key];
  }
  target.processExecutionStopReceipt = receipt;
  target.stopEvidence = receipt.stopEvidence;
}

/** Retain a selected control cause and its wrapper's complete diagnostics. */
export function processExecutionControlFailureFromCause(wrapper, primary = wrapper.cause) {
  if (!(primary instanceof ProcessExecutionControlFailure)) return null;
  const failure = primary.withCause(wrapper);
  retainExecutionCompletion(failure, primary);
  return failure;
}

/** Publication failure never replaces an observed child result with an exit status. */
export function processExecutionPublicationFailure(error, completion, { executionId = null, callId = null, role = "executor" } = {}) {
  executionId ??= completion?.processExecutionStopReceipt?.executionId ?? completion?.executionId ?? null;
  callId ??= completion?.processExecutionStopReceipt?.callId ?? completion?.callId ?? null;
  const typedPublication = error instanceof ProcessExecutionControlFailure;
  if (typedPublication) { executionId = error.executionId ?? executionId; callId = error.callId ?? callId; }
  const bodyFailure = completion instanceof ProcessExecutionControlFailure
    && (completion.primaryCause.executionId === null || completion.primaryCause.executionId === executionId)
    && (completion.primaryCause.callId === null || completion.primaryCause.callId === callId) ? completion : null;
  const combined = completion instanceof Error && completion !== error
    && !(error instanceof AggregateError && error.errors[0] === completion)
    ? combineProcessExecutionFailures(completion, error) : error;
  // Keep the ordered causes without implicitly inheriting a foreign body's
  // typed provenance through the ControlFailure constructor.
  const cause = combined !== error && combined instanceof ProcessExecutionControlFailure ? combined.cause : combined;
  let failure = new ProcessExecutionControlFailure(
    typedPublication ? error.reason : "activity-pending",
    typedPublication ? error.message : "Registered process events still lack durable canonical publication", {
      cause, executionId, callId,
      primaryCause: bodyFailure?.primaryCause ?? (typedPublication ? error.primaryCause : null),
      diagnostic: bodyFailure?.diagnostic ?? (typedPublication ? error.diagnostic : null),
      communication: bodyFailure?.communication ?? (typedPublication ? error.communication : null),
    });
  retainExecutionCompletion(failure, completion);
  const receipt = failure.processExecutionStopReceipt;
  if (receipt !== undefined && failure.diagnostic === null
    && failure.primaryCause.executionId === receipt.executionId && failure.primaryCause.callId === receipt.callId) {
    const diagnosed = new ProcessExecutionControlFailure(failure.reason, failure.message, {
      cause: failure.cause, executionId: failure.executionId, callId: failure.callId,
      primaryCause: failure.primaryCause, communication: failure.communication,
      diagnostic: new ProcessExecutionFailureDiagnostic({ executionId: receipt.executionId, callId: receipt.callId,
        operation: "execute", role, phase: "stopped",
        executor: { executorId: receipt.executor.executorId, executorSession: receipt.executor.executorSession },
        primaryCause: { code: failure.primaryCause.code, message: failure.primaryCause.message } }),
    });
    retainExecutionCompletion(diagnosed, failure);
    failure = diagnosed;
  }
  return failure;
}

/** Preserve both failures without erasing control-failure semantics. */
export function combineProcessExecutionFailures(primary, completion) {
  if (primary === undefined) return completion;
  if (completion === undefined) return primary;

  const messages = [primary, completion].map(failure => failure instanceof Error ? failure.message : String(failure));
  const causes = new AggregateError([primary, completion],
    `Operation and managed-process completion both failed: ${messages.join("; ")}`, { cause: primary });
  const selected = processExecutionControlFailureFromCause(causes)
    ?? processExecutionControlFailureFromCause(causes, completion);
  if (selected !== null) return selected;
  // No typed control failure selected another completion. Keep the original
  // body's actual receipt rather than losing it in the generic aggregate.
  retainExecutionCompletion(causes, primary);
  return causes;
}

/** Run mandatory completion after an operation and preserve the operation's failure first. */
export async function completeManagedOperation(operation, completion) {
  let result;
  let operationFailed = false;
  let primary;
  try { result = await operation(); }
  catch (error) { operationFailed = true; primary = error; }

  let completionFailed = false;
  let completionFailure;
  try { await completion(); }
  catch (error) { completionFailed = true; completionFailure = error; }

  if (operationFailed || completionFailed) {
    throw combineProcessExecutionFailures(primary, completionFailure);
  }
  return result;
}

/** A synchronous boundary cannot retain work after its owner releases authority. */
export function synchronousManagedResult(value, message = "Synchronous managed operations cannot return a thenable") {
  if (value !== null && value !== undefined && typeof value.then === "function") throw new TypeError(message);
  return value;
}

/** Blocking counterparts must finish on this stack, including mandatory disposal. */
export function completeManagedOperationSync(operation, completion) {
  let result;
  let operationFailed = false;
  let primary;
  try { result = synchronousManagedResult(operation()); }
  catch (error) { operationFailed = true; primary = error; }
  let completionFailed = false;
  let completionFailure;
  try { synchronousManagedResult(completion(!operationFailed)); }
  catch (error) { completionFailed = true; completionFailure = error; }
  if (operationFailed || completionFailed) throw combineProcessExecutionFailures(primary, completionFailure);
  return result;
}
