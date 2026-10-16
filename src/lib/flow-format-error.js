import { inspectFlowMigrationRequirements } from "./specs-migration.js";
import { FlowTargetRecoveryError } from "./flow-target-identity-authority.js";
import { SingleUserActionDirective } from "../flow/lib/next-action-directive.js";

/** A persisted-format refusal never grants permission to execute a Flow. */
class FlowFormatError extends Error {
  constructor(code, assessment, cause) {
    super(assessment.message, { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.data = assessment.toJSON();
  }
}

export class FlowMigrationRequiredError extends FlowFormatError {
  constructor(assessment, cause) {
    super("FLOW_MIGRATION_REQUIRED", assessment, cause);
    this.data.directive = new SingleUserActionDirective({
      actionId: "PREVIEW_FLOW_MIGRATION",
      instruction: `Preview the required migration without changing persisted data: ${this.data.dryRunCommand}. Review and explicitly apply migrations in revision order (${assessment.requiredRevisions.join(", ")}).`,
      reason: assessment.message,
      category: "single_user_action",
    });
  }
}

export class FlowFormatUnsupportedError extends FlowFormatError {
  constructor(assessment, cause) {
    super("FLOW_FORMAT_UNSUPPORTED", assessment, cause);
  }
}

export class FlowFormatIntegrityError extends FlowFormatError {
  constructor(assessment, cause) {
    super(assessment.code ?? "FLOW_INTEGRITY_ERROR", assessment, cause);
  }
}

export function isFlowFormatError(error) {
  return error instanceof FlowFormatError;
}

export function isFlowFormatGuidance(error) {
  return error instanceof FlowMigrationRequiredError || error instanceof FlowFormatUnsupportedError;
}

/** Diagnose a failed strict read using the explicit migration's source rules. */
export function diagnoseFlowFormat({ location, definition, cause = null, allowAbsent = false, formatIntegrity = false }) {
  const assessment = inspectFlowMigrationRequirements({
    root: location.repositoryRoot,
    specRoot: location.specRoot,
    specId: location.specId.toString(),
    version: location.version.value,
    definition,
  });
  switch (assessment.classification) {
    case "migratable": return new FlowMigrationRequiredError(assessment, cause);
    case "unsupported": return new FlowFormatUnsupportedError(assessment, cause);
    case "integrity-error": return cause !== null && !formatIntegrity
      ? cause : new FlowFormatIntegrityError(assessment, cause);
    case "absent": return allowAbsent ? null : cause;
    default: return cause;
  }
}

/** Project persisted-format diagnostics only at the CLI context boundary.
 * Strict Store callers retain their original integrity exception and command
 * owners retain their own recovery decisions. */
export function formatFlowReadFailureForCli({ cause, flowManager, targetResolution = false }) {
  if (isFlowFormatError(cause)) return cause;
  // A failed target selection is not proof that its state was read. Preserve
  // mismatch, missing-target and authority failures without diagnosing a
  // different bound or ambient Flow.
  if (targetResolution && !(cause instanceof FlowTargetRecoveryError)) return cause;
  if (cause instanceof FlowTargetRecoveryError && cause.data.specId === null) return cause;
  let location;
  try {
    location = flowManager.specLocation(cause.data?.specId);
  } catch {
    // A missing or ambiguous target cannot acquire diagnostic authority.
    return cause;
  }
  const formatted = diagnoseFlowFormat({ location, cause, formatIntegrity: true });
  if (!(formatted instanceof FlowFormatIntegrityError)) return cause;
  if (cause instanceof FlowTargetRecoveryError) {
    // Keep the native recovery classification and selected identity intact.
    cause.data = { ...formatted.data, ...cause.data };
    return cause;
  }
  return formatted;
}
