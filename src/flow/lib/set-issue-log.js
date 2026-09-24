import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
/**
 * src/flow/lib/set-issue-log.js
 *
 * Record an issue-log entry under the configured spec root.
 *
 * ctx.step               — step ID (required)
 * ctx.reason             — why the entry was recorded (required)
 * ctx.trigger            — what triggered the issue (optional)
 * ctx.resolution         — how the issue was resolved (optional)
 * ctx.guardrailCandidate — potential guardrail article to add (optional)
 * ctx.normalizedFindingId — normalized review finding id addressed by repair (optional)
 * ctx.repairRef          — commit hash or changed file references (optional object)
 */

import crypto from "node:crypto";
import { FlowCommand, resolveExplicitTaskOption } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { IssueLogDocument, IssueLogStore } from "./issue-log-store.js";

/**
 * Load issue-log.json from the resolved spec directory.
 * @param {string} root - project root
 * @param {string} specPath - relative spec path
 * @returns {{ entries: Object[] }}
 */
export function issueLogStoreForVersion(location, options = {}) {
  return IssueLogStore.forVersion({ location, ...options });
}

function canonicalIssueLogIdempotencyKey(state, entry) {
  const stableEntry = structuredClone(entry);
  // The timestamp records when the user command was first observed; it must
  // not make a restart of that same command publish a second fact.
  delete stableEntry.timestamp;
  delete stableEntry.issueLogId;
  delete stableEntry.grantId;
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify({
      runId: state.runId,
      nodeId: state.currentNodeId,
      entry: stableEntry,
    }))
    .digest("hex");
  return `set-issue-log-${digest}`;
}

/**
 * Resolve the append-only issue log through the Version Store.  This is the
 * normal-runtime reader counterpart of `appendCanonicalIssueLogEntry`: it
 * accepts a Flow identity and a consumer Step, never a guessed spec path.
 */
export function loadCanonicalIssueLog(flowManager, state, { consumerNodeId = state?.currentNodeId } = {}) {
  if (state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || typeof state?.specId !== "string") {
    throw new Error("canonical issue-log read requires a Version-1 Flow state");
  }
  if (!flowManager || typeof flowManager.readArtifact !== "function") {
    throw new Error("canonical issue-log read requires FlowManager.readArtifact");
  }
  if (typeof consumerNodeId !== "string" || consumerNodeId === "") {
    throw new Error("canonical issue-log read requires a consumer Step");
  }
  const artifact = flowManager.readArtifact({
    specId: state.specId,
    logicalKey: "issue.log",
    consumerNodeId,
    optional: true,
  });
  if (artifact === null) return { entries: [] };
  try {
    return new IssueLogDocument(JSON.parse(artifact.bytes.toString("utf8"))).toJSON();
  } catch (error) {
    throw new Error(`canonical issue-log is invalid: ${error.message}`);
  }
}

/**
 * Append one user-visible issue fact through the active Attempt's Activity
 * transaction.  No normal command may reconstruct `issue-log.json` from a
 * spec path or use the retired independent writer.
 */
export function appendCanonicalIssueLogEntry(flowManager, state, entry, idempotencyKey = null, admission = undefined) {
  if (state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || typeof state?.specId !== "string") {
    throw new Error("canonical issue-log append requires a Version-1 Flow state");
  }
  if (!flowManager || typeof flowManager.appendIssueLog !== "function") {
    throw new Error("canonical issue-log append requires FlowManager.appendIssueLog");
  }
  return flowManager.appendIssueLog({
    specId: state.specId,
    entry,
    idempotencyKey: idempotencyKey || entry?.issueLogId || entry?.grantId
      || canonicalIssueLogIdempotencyKey(state, entry),
    admission,
  });
}

const MIN_REASON_LENGTH = 20;
const MIN_OPTIONAL_FIELD_LENGTH = 10;
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Issue-log scope is a command concern, not a reason to import the retired
 * mutable legacy state. The Version-1 command view already exposes Task ids
 * derived from canonical state/Activity records.
 */
function resolveTaskIdForIssueLog(state, options = {}) {
  if (Object.hasOwn(options, "taskId")) {
    if (options.taskId === null) return null;
    if (!(state.tasks || []).some((task) => task.id === options.taskId)) {
      throw new Error(`unknown task id: ${options.taskId}`);
    }
    return options.taskId;
  }
  return state.currentTaskId ?? null;
}

function validateReason(reason) {
  if ((reason ?? "").trim().length < MIN_REASON_LENGTH) {
    return Envelope.fail(
      "set",
      "issue-log",
      "INVALID_REASON",
      `--reason must be at least ${MIN_REASON_LENGTH} characters (trimmed). ` +
        `Provide a specific, descriptive reason — placeholder text is rejected.`,
    );
  }
  return null;
}

function validateOptionalIssueLogField(name, value) {
  if (value == null) return null;
  if (value.trim().length < MIN_OPTIONAL_FIELD_LENGTH) {
    return Envelope.fail(
      "set",
      "issue-log",
      "INVALID_FIELD",
      `--${name} must be at least ${MIN_OPTIONAL_FIELD_LENGTH} characters (trimmed) when provided.`,
    );
  }
  return null;
}

function normalizeRepairRef(ctx) {
  if (ctx.repairRef && typeof ctx.repairRef === "object") return ctx.repairRef;
  if (ctx.repairRefCommit) return { commit: String(ctx.repairRefCommit).trim() };
  if (ctx.repairRefFile) return { files: [String(ctx.repairRefFile).trim()] };
  return null;
}

function validateRepairRef(repairRef) {
  if (repairRef == null) return null;
  if (typeof repairRef !== "object") {
    return Envelope.fail("set", "issue-log", "INVALID_REPAIR_REF", "repairRef must be an object");
  }
  if (repairRef.commit != null && !COMMIT_HASH_RE.test(String(repairRef.commit).trim())) {
    return Envelope.fail("set", "issue-log", "INVALID_REPAIR_REF", "--repair-ref-commit must be a commit hash");
  }
  if (repairRef.files != null) {
    if (!Array.isArray(repairRef.files) || repairRef.files.some((file) => String(file || "").trim() === "")) {
      return Envelope.fail("set", "issue-log", "INVALID_REPAIR_REF", "--repair-ref-file values must be non-empty paths");
    }
  }
  if (repairRef.commit == null && repairRef.files == null) {
    return Envelope.fail("set", "issue-log", "INVALID_REPAIR_REF", "repairRef requires commit or files");
  }
  return null;
}

export default class SetIssueLogCommand extends FlowCommand {
  constructor() {
    super({ explicitTargetResolution: true });
  }

  execute(ctx) {
    if (!ctx.step || !ctx.reason) {
      return Envelope.fail("set", "issue-log", "INVALID_USAGE", "--step and --reason are required");
    }
    const reasonFail = validateReason(ctx.reason);
    if (reasonFail) return reasonFail;
    const optionalFields = [
      ["trigger", ctx.trigger],
      ["resolution", ctx.resolution],
      ["guardrail-candidate", ctx.guardrailCandidate],
    ];
    for (const [name, value] of optionalFields) {
      const fail = validateOptionalIssueLogField(name, value);
      if (fail) return fail;
    }
    const repairRef = normalizeRepairRef(ctx);
    const repairRefFail = validateRepairRef(repairRef);
    if (repairRefFail) return repairRefFail;

    const state = ctx.flowState;
    const taskId = resolveTaskIdForIssueLog(state, resolveExplicitTaskOption(ctx));

    const entry = {
      step: ctx.step,
      reason: ctx.reason,
      ...(ctx.trigger && { trigger: ctx.trigger }),
      ...(ctx.resolution && { resolution: ctx.resolution }),
      ...(ctx.guardrailCandidate && { guardrailCandidate: ctx.guardrailCandidate }),
      ...(ctx.normalizedFindingId && { normalizedFindingId: String(ctx.normalizedFindingId).trim() }),
      ...(repairRef && { repairRef }),
      taskId,
      timestamp: new Date().toISOString(),
    };

    const result = appendCanonicalIssueLogEntry(ctx.flowManager, state, entry);

    return { entry: result.entry, total: result.total };
  }
}
