import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
/** Explicit human display for one closed canonical Flow artifact view. */

import { Command } from "../../lib/command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { FlowSpecId } from "../../lib/flow-spec-id.js";
import { FLOW_ARTIFACT_VIEW_REGISTRY } from "./artifact-view-registry.js";
import { ArtifactViewService } from "./artifact-view-service.js";
import {
  AcceptanceArtifactSummaryContract,
  ArtifactViewSummaryError,
  ArtifactViewSummaryService,
  SpecArtifactSummaryContract,
} from "./artifact-view-summary.js";
import { FlowCommand } from "./base-command.js";

const MODES = new Set(["full", "summary"]);
const ACTIVE_TARGET_GUARD_FIELDS = Object.freeze([
  "expectBinding", "expectIssue", "expectSpec", "expectRunId", "expectNoIssue",
]);

function nonEmptyText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ArtifactViewRequestError(`${field} is required`);
  }
  return value.trim();
}

function explicitVersion(value) {
  const raw = nonEmptyText(value, "--version");
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new ArtifactViewRequestError("--version must be a positive integer");
  }
  const version = Number(raw);
  if (!Number.isSafeInteger(version)) {
    throw new ArtifactViewRequestError("--version must be a positive safe integer");
  }
  return version;
}

function hasExplicitVersionSelector(input = {}) {
  return (input.specId !== null && input.specId !== undefined)
    || (input.version !== null && input.version !== undefined);
}

function activeGuardNames(input = {}) {
  return ACTIVE_TARGET_GUARD_FIELDS.filter((field) => input[field] !== null && input[field] !== undefined && input[field] !== false);
}

/** Safe input-boundary failure that becomes a standard Flow envelope. */
export class ArtifactViewRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArtifactViewRequestError";
    this.code = "ARGS_ERROR";
  }
}

/** Immutable CLI request; it never accepts an inferred historical target. */
export class ArtifactViewRequest {
  constructor(input = {}) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new ArtifactViewRequestError("artifact view input must be an object");
    }
    const logicalKey = nonEmptyText(input.logicalKey, "artifact logicalKey");
    try {
      this.logicalKey = FLOW_ARTIFACT_VIEW_REGISTRY.require(logicalKey).logicalKey;
    } catch {
      throw new ArtifactViewRequestError(`unsupported artifact logicalKey: ${logicalKey}`);
    }
    this.mode = nonEmptyText(input.mode, "--mode");
    if (!MODES.has(this.mode)) {
      throw new ArtifactViewRequestError("--mode must be full or summary");
    }
    const hasSpecId = input.specId !== null && input.specId !== undefined;
    const hasVersion = input.version !== null && input.version !== undefined;
    if (hasSpecId !== hasVersion) {
      throw new ArtifactViewRequestError("--spec-id and --version must be provided together");
    }
    this.historical = hasSpecId;
    if (this.historical) {
      try {
        this.specId = FlowSpecId.from(nonEmptyText(input.specId, "--spec-id")).toString();
      } catch {
        throw new ArtifactViewRequestError("--spec-id must be a literal specId");
      }
      this.version = explicitVersion(input.version);
      const guards = activeGuardNames(input);
      if (guards.length > 0) {
        throw new ArtifactViewRequestError(
          `completed Version views cannot use active Flow guards: ${guards.map((field) => `--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`).join(", ")}`,
        );
      }
    } else {
      this.specId = null;
      this.version = null;
    }
    Object.freeze(this);
  }

  static hasExplicitVersionSelector(input = {}) {
    return hasExplicitVersionSelector(input);
  }
}

function summaryContractFor(request, localizer) {
  if (request.logicalKey === "spec.record") {
    return new SpecArtifactSummaryContract({
      title: localizer.message("titleSpec"),
      headings: {
        purpose: localizer.message("purpose"),
        scope: localizer.message("scope"),
        constraints: localizer.message("constraints"),
        openQuestions: localizer.message("openQuestions"),
        requirements: localizer.message("requirements"),
        tasks: localizer.message("tasks"),
      },
    });
  }
  return new AcceptanceArtifactSummaryContract({
    title: localizer.message("titleAcceptance"),
    headings: {
      requirements: localizer.message("requirementJudgments"),
      mechanicalBlockers: localizer.message("mechanicalBlockers"),
      hardBlockers: localizer.message("hardBlockers"),
      deferredFindings: localizer.message("deferredFindings"),
      remainingRisks: localizer.message("remainingRisks"),
    },
  });
}

function failureFor(error, mode) {
  if (error instanceof ArtifactViewRequestError || error instanceof ArtifactViewSummaryError) {
    return Envelope.fail("get", "artifact", error.code, error.message);
  }
  const code = typeof error?.code === "string" && error.code !== ""
    ? error.code
    : (mode === "summary" ? "ARTIFACT_VIEW_SUMMARY_FAILED" : "ARTIFACT_VIEW_FULL_FAILED");
  return Envelope.fail("get", "artifact", code, error?.message || String(error));
}

function activeContextReadFailure(error) {
  // Active target resolution reconstructs the canonical Flow state before the
  // view service can read the requested artifact.  A corrupt attempt history
  // at that boundary is still a canonical artifact read failure, never an AI
  // summary failure.  Keep its original error as the cause for diagnostics
  // while presenting the closed public view error taxonomy.
  if (error?.code === "ARTIFACT_VIEW_READ_FAILED") return error;
  const wrapped = new Error(error?.message || String(error), { cause: error });
  wrapped.name = "ArtifactViewActiveContextReadError";
  wrapped.code = "ARTIFACT_VIEW_READ_FAILED";
  return wrapped;
}

function appendCacheWarning(envelope, warning) {
  if (warning !== null && warning !== undefined) {
    envelope.addWarning(warning.code || "ARTIFACT_VIEW_CACHE_NOT_SAVED", warning.message || String(warning));
  }
}

/** `flow get artifact` with an intentionally isolated completed-Version path. */
export default class GetArtifactCommand extends FlowCommand {
  constructor() {
    // Read resolution permits an identity match before the binding authority
    // check below. That turns a stale same-id binding into the public
    // ACTIVE_FLOW_MISMATCH boundary instead of treating the active flow as
    // absent; targetGuard then validates the complete captured authority
    // before the reader, cache, or summary agent can run.
    super({
      requiresFlow: false,
      explicitTargetResolution: true,
      mismatchTargetResolution: true,
      targetGuard: true,
    });
  }

  async run(container, input = {}) {
    // FlowCommand.run() resolves ambient Flow authority even for optional
    // commands. Historical selectors must not do that: their exact pair is
    // independently authoritative and active guards are rejected above.
    if (ArtifactViewRequest.hasExplicitVersionSelector(input)) {
      return Command.prototype.run.call(this, container, input);
    }
    try {
      return await super.run(container, { ...input, _artifactViewRequestInput: input });
    } catch (error) {
      return failureFor(activeContextReadFailure(error), input.mode);
    }
  }

  async execute(ctx) {
    const input = ctx._artifactViewRequestInput || ctx;
    let request;
    try {
      request = new ArtifactViewRequest(input);
      if (!request.historical && !ctx.flowState) {
        return Envelope.fail("get", "artifact", "NO_ACTIVE_FLOW", "an active canonical Flow is required when --spec-id/--version are omitted");
      }
      if (!request.historical && (ctx.flowState?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || typeof ctx.flowState.specId !== "string")) {
        return Envelope.fail("get", "artifact", "CANONICAL_FLOW_REQUIRED", "active Flow must be backed by the canonical Version Store");
      }

      const flowManager = request.historical
        ? this.container.get("flowManager")
        : ctx.flowManager;
      const root = request.historical
        ? this.container.get("mainRoot")
        : ctx.root;
      const config = this.container.get("config") || {};
      const viewService = new ArtifactViewService({ config, root, flowManager });
      const full = viewService.full({
        logicalKey: request.logicalKey,
        ...(request.historical
          ? { specId: request.specId, version: request.version }
          : { activeState: ctx.flowState }),
      });

      let markdown = full.markdown;
      let summaryWarning = null;
      if (request.mode === "summary") {
        const localizer = viewService.renderer.localizer;
        const summary = await new ArtifactViewSummaryService({
          agent: this.container.get("agent"),
          cache: full.cacheStore,
          lang: full.fullView.language,
          i18nRevision: full.fullView.i18nRevision,
          cacheWarningMessage: localizer.message("cacheNotSaved"),
        }).summarize({
          fullView: full.fullView,
          contract: summaryContractFor(request, localizer),
        });
        markdown = summary.markdown;
        summaryWarning = summary.cache.warning;
      }

      const envelope = Envelope.ok("get", "artifact", { markdown });
      appendCacheWarning(envelope, full.cacheWarning);
      appendCacheWarning(envelope, summaryWarning);
      return envelope;
    } catch (error) {
      return failureFor(error, request?.mode || input.mode);
    }
  }
}

export { summaryContractFor };
