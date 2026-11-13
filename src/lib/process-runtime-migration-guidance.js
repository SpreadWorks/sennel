/** Semantic CLI projection only; never imported by generic runtime startup. */
import { NativeExecutableInvocation } from "./command-invocation.js";
import { ProcessExecutionControlFailure, PROCESS_RUNTIME_RECORD_MIGRATION_REQUIRED } from "./process-execution-values.js";
import { PRODUCT } from "./product.js";
import { SingleUserActionDirective } from "../flow/lib/next-action-directive.js";
import { flowStopTranslator } from "./flow-stop-guidance.js";
import path from "node:path";

/** Nominal presentation metadata; the process failure remains the carrier. */
export class RuntimeRecordMigrationPreviewSelection {
  #failure;
  constructor(failure, { mainRoot, executionRoot = mainRoot }, t = null) {
    if (!RuntimeRecordMigrationPreviewSelection.accepts(failure)) {
      throw new TypeError("Runtime migration preview requires a typed version refusal and exact selected roots");
    }
    this.#failure = failure;
    this.code = PROCESS_RUNTIME_RECORD_MIGRATION_REQUIRED;
    this.previewInvocation = new NativeExecutableInvocation({ executable: PRODUCT.machineName,
      args: ["migrate", "runtime", "--to", "10", "--execution-root", path.resolve(executionRoot), "--dry-run"], cwd: path.resolve(mainRoot) });
    // Read owners select from acquired input only; locale discovery belongs to
    // the outer output boundary. An injected translator can localize the action.
    const text = flowStopTranslator(t ?? (() => undefined));
    this.directive = new SingleUserActionDirective({ actionId: "PREVIEW_RUNTIME_RECORD_MIGRATION", category: "single_user_action",
      instruction: text("runtimeRecordPreview", { cwd: this.previewInvocation.cwd, executable: this.previewInvocation.executable,
        args: JSON.stringify(this.previewInvocation.args) }),
      reason: failure.message, preconditions: [text("runtimeRecordUnconfirmed")] });
    Object.freeze(this);
  }
  static accepts(failure) {
    return failure instanceof ProcessExecutionControlFailure && failure.primaryCause.code === PROCESS_RUNTIME_RECORD_MIGRATION_REQUIRED;
  }
  get data() {
    return { processExecutionControlFailure: this.#failure.toJSON(), previewInvocation: this.previewInvocation, directive: this.directive };
  }
}

/** The caller supplies the actual selected namespace at its existing read boundary. */
export function selectRuntimeRecordMigrationPreview(error, roots, t = null) {
  if (selectedRuntimeRecordMigrationPreview(error) !== null || !RuntimeRecordMigrationPreviewSelection.accepts(error)) return error;
  error.data = new RuntimeRecordMigrationPreviewSelection(error, roots, t);
  return error;
}

/** Preserve synchronous reads and asynchronous acquisition behind one boundary. */
export function withRuntimeRecordMigrationPreview(roots, operation) {
  try {
    const result = operation();
    return result instanceof Promise ? result.catch(error => { throw selectRuntimeRecordMigrationPreview(error, roots); }) : result;
  } catch (error) { throw selectRuntimeRecordMigrationPreview(error, roots); }
}

/** Forward an already selected diagnostic action through existing error wrappers. */
export function selectedRuntimeRecordMigrationPreview(error) {
  const seen = new Set();
  const pending = [error];
  let primaryProcessCauseSeen = false;
  while (pending.length > 0) {
    const cause = pending.shift();
    if (!cause || seen.has(cause)) continue;
    seen.add(cause);
    if (cause instanceof ProcessExecutionControlFailure) {
      if (!primaryProcessCauseSeen) {
        primaryProcessCauseSeen = true;
        if (!RuntimeRecordMigrationPreviewSelection.accepts(cause)) return null;
      }
      if (RuntimeRecordMigrationPreviewSelection.accepts(cause) && cause.data instanceof RuntimeRecordMigrationPreviewSelection) return cause.data;
    }
    if (cause.cause !== undefined) pending.unshift(cause.cause);
    if (cause instanceof AggregateError) pending.push(...cause.errors);
  }
  return null;
}
