/**
 * Revision 1 migration for legacy per-spec Flow roots.
 *
 * The production runtime only reads Version 1.  This module is the explicit
 * one-way boundary that recognizes historical Flow families, writes one
 * canonical Version, and then removes the legacy root atomically.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AtomicJsonFile } from "./atomic-json-file.js";
import { AtomicFile } from "./atomic-file.js";
import { FileIdentity, RealDirectoryAuthority, sameFileIdentity } from "./real-directory-authority.js";
import { captureRegularFile, MAX_IN_MEMORY_FILE_BYTES, RegularFileSnapshot } from "./regular-file-snapshot.js";
import { LogicalRelativePath, LogicalPathSet } from "./portable-path.js";
import { ArtifactAuthoritySlot } from "./artifact-authority.js";
import { PRODUCT } from "./product.js";
import { ProcessExecutionRuntime } from "./process-execution-runtime.js";
import {
  FlowArtifactCatalog,
  FlowArtifactActivityIndex,
  FlowActivityId,
  FlowArtifactCatalogStore,
  FlowArtifactDescriptor,
  FlowId,
  FlowRunId,
  FlowSpecIdentity,
  FlowVersionAuthorityScope,
  FlowVersion,
  FlowVersionId,
  FlowVersionLocation,
} from "./flow-version.js";
import {
  FLOW_ARTIFACT_CONTRACTS,
  FlowArtifactActivityEvidence,
  FlowArtifactActivityEvidenceDocument,
  FLOW_ARTIFACT_SWITCH_TARGETS,
  FlowArtifactAttemptHistory,
  FlowArtifactAttemptRecord,
} from "./flow-artifact-contract.js";
import { CanonicalSpecReview, SpecReviewDelta, initialCanonicalSpecReview, mergeSpecReviewDelta } from "../flow/lib/spec-review-artifacts.js";
import { validateSpecRepairTriageFinding } from "../flow/lib/spec-repair-operations.js";
import {
  MigrationBlocker,
  MigrationInput,
  MigrationMapping,
  MigrationReport,
  withRepositoryMigrationExclusion,
} from "./migration.js";
import { resolveMigrationSpecRoot, MigrationSpecSelection } from "./migration-spec-root.js";
import { LegacyFlowActivityLedger } from "./legacy-flow-activity.js";
import { assertMigrationFlowAuthority, MigrationFlowAuthorityPreflight, MigrationFlowIdentity, MigrationFlowIdentityIndex } from "./migration-flow-authority.js";
import { CanonicalGateRepairMigrationPreflight, inspectCanonicalV3State } from "./spec-gate-repair-migration.js";
import { CanonicalGateDecisionMigrationPlan } from "./spec-gate-decision-migration.js";
import { CURRENT_FLOW_SCHEMA_REVISION } from "./flow-schema-revision.js";
import { PreviousFlowSchemaProjection } from "./flow-schema-migration.js";
import { ProcessEvidenceArtifactMigration, PROCESS_EVIDENCE_MIGRATION_KEYS } from "./process-evidence-artifact-migration.js";
import { ProcessEvidenceArtifactGraphSource } from "./process-evidence-artifact-graph-migration.js";
import { FlowExecutionContract } from "../flow/lib/flow-execution-contract.js";
import { readStoredPromptExecutionEpisodeFromView } from "../flow/lib/canonical-prompt-execution.js";
import { RetryRecoveryBaseline, RetryRecoveryReceipt } from "../flow/lib/retry-recovery.js";
import { CanonicalCommandAttemptArtifactHistory } from "../flow/lib/canonical-command-result.js";
import { TaskReviewReconciliationRecord } from "../flow/lib/task-review-reconciliation-record.js";
import { ArtifactWorkerRequestSnapshot } from "../flow/lib/artifact-worker-recovery-values.js";
import { FlowExecutionObservationCapture, FlowExecutionSourceManifest, FlowExecutionObservationFact,
  parseFlowExecutionObservationArtifact } from "./flow-execution-observation.js";
import { SpecGateRepairSourceSnapshotManifest } from "../flow/lib/spec-gate-repair-values.js";
import { buildCurrentFlowDefinition } from "../flow/definition.js";
import {
  CurrentFlowSpecRecord,
  CurrentAttemptIdentity,
  CurrentFlowState,
  CurrentFlowStateSerializer,
  CurrentFlowStateStore,
  CurrentFlowStateValidator,
  CurrentFlowVersionStore,
  CanonicalFlowActivityEvidenceWrite,
  FlowActivity,
  NodeResult,
  TaskNode,
} from "../flow/lib/current-flow-state.js";

const REVISION = 1;
const MIGRATION_READ_OPTIONS = Object.freeze({ label: "migration regular file", maxBytes: MAX_IN_MEMORY_FILE_BYTES });

const VERSION_DIRECTORY = "001";
const JOURNAL_SCHEMA_REVISION = 2;
const TREE_FINGERPRINT_VERSION = 2;
const JOURNAL_COMPONENT = "specs";
const JOURNAL_DIRECTORY_NAME = "sennel-migrate-specs";
const KNOWN_FLOW_FIELDS = new Set([
  "acceptanceReview", "auditStateMigrations", "autoApprove", "autoCheck", "autoDesired", "autoUpgrade",
  "baseBranch", "canonicalReviewPassRecoveries", "createdAt", "currentTaskId", "directAbortHistory",
  "directCompletionReceipt", "directFlowSession", "directIntegrationReceipt", "directReconcileEvidence",
  "directResolutionPlan", "draftArtifactRevision", "featureBranch", "flowDispatchApprovals", "gateImplMemory",
  "issue", "legacyPlanRewinds", "lifecycle", "metrics", "nonblocking", "notes", "outbox", "planRewindChain",
  "planRewinds", "plugins", "redoCount", "repairBaseline", "request", "requestChars", "requirements",
  "reviewConvergence", "reviewCount", "reviewRecoveryBaselines", "reviewStop", "runId",
  "retryRecovery",
  "sealedSpecCorrectionRewindArchives", "spec", "specId", "state", "status", "stepAttempts", "steps", "tasks",
  "test", "worktree", "flowId", "flowVersionId", "childId", "runtimeLog", "workerArtifactReceipts",
  "testReviewRepairHistory", "expandedPluginHooks", "hooks",
]);
// The accepted legacy artifact grammar is deliberately format-oriented, not
// repository inventory-oriented.  Normal Flow producers have a typed switch
// target below; user-authored text/structured companion evidence has no
// canonical target and is retained byte-for-byte.  Opaque binaries are not
// silently classified as Flow evidence.
const PORTABLE_LEGACY_ARTIFACT_EXTENSIONS = new Set([
  ".json", ".jsonl", ".md", ".txt", ".log", ".js", ".mjs", ".cjs", ".sh", ".tap",
]);
const LEGACY_STATUS = new Map([
  ["pending", "pending"], ["in_progress", "in_progress"], ["in-progress", "in_progress"],
  ["done", "done"], ["complete", "done"], ["completed", "done"], ["skipped", "skipped"],
  ["failed", "failed"], ["invalidated", "invalidated"], ["archived", "archived"],
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function jsonPointerSegment(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function shapeOf(value) {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      members: [...new Set(value.map((entry) => JSON.stringify(shapeOf(entry))))].sort(codeUnitOrder).map(JSON.parse),
    };
  }
  if (isPlainObject(value)) {
    return {
      type: "object",
      fields: Object.keys(value).sort(codeUnitOrder).map((key) => [key, shapeOf(value[key])]),
    };
  }
  return { type: typeof value };
}

function shapeFingerprint(value) {
  return sha256(Buffer.from(JSON.stringify(shapeOf(value)), "utf8"));
}

function artifactFingerprint(bytes) {
  return sha256(Buffer.from(JSON.stringify({
    version: TREE_FINGERPRINT_VERSION,
    kind: "file",
    bytesHash: sha256(bytes),
  }), "utf8"));
}

function codeUnitOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function normalizedRelative(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty relative path`);
  // Explicit legacy input conversion remains owned by this migration.
  return new LogicalRelativePath(value.replaceAll("\\", "/"), label).toString();
}

function rootRelative(root, target) {
  const relative = path.relative(root, target).split(path.sep).join("/");
  return normalizedRelative(relative, "repository-relative path");
}

function lstatOrNull(filePath) {
  try { return fs.lstatSync(filePath); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function journalDirectoryFor(root) {
  return path.join(path.resolve(root), ".tmp", JOURNAL_DIRECTORY_NAME);
}

function removeEmptyJournalDirectory(directory) {
  const authority = realDirectoryOrNull(directory, "specs migration journal directory");
  if (authority !== null && authority.entries().length === 0) authority.remove();
}

function assertRealDirectory(directory, label) {
  try {
    const authority = new RealDirectoryAuthority(directory);
    authority.assertStable();
    return authority;
  }
  catch (cause) { throw new Error(`${label} must be a real directory`, { cause }); }
}

function parseObject(bytes, label) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!isPlainObject(value)) throw new Error(`${label} must contain an object`);
  return value;
}

/** A classified preflight failure that is safe to expose in a migration report. */
export class LegacyFlowMigrationError extends Error {
  constructor(code, message) {
    super(message);
    if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(code)) {
      throw new Error("legacy migration error code is invalid");
    }
    this.name = "LegacyFlowMigrationError";
    this.code = code;
  }
}

function mediaTypeFor(sourcePath) {
  const extension = path.posix.extname(sourcePath).toLowerCase();
  if (extension === ".json") return "application/json";
  if (extension === ".jsonl") return "application/x-ndjson";
  if ([".md", ".txt", ".log", ".js", ".mjs", ".cjs", ".sh"].includes(extension)) return "text/plain";
  return "application/octet-stream";
}

function migrationMemberId(sourcePath) {
  return `migration-${sha256(Buffer.from(sourcePath, "utf8"))}`;
}

function migrationSlot(sourcePath) {
  return ArtifactAuthoritySlot.collectionMember({
    kind: "migration-materialization",
    authority: "canonical-flow-artifacts",
    memberId: migrationMemberId(sourcePath),
    publicationStep: "system",
  });
}

function copyFile(source, destination) {
  RealDirectoryAuthority.resolve(path.dirname(destination), { create: true, creationMode: 0o755 });
  const snapshot = captureRegularFile(source, MIGRATION_READ_OPTIONS);
  new AtomicFile(destination, { permissionHint: snapshot.permissionHint }).write(snapshot.bytes, { exclusive: true });
}

function writeExclusive(destination, bytes) {
  RealDirectoryAuthority.resolve(path.dirname(destination), { create: true, creationMode: 0o755 });
  new AtomicFile(destination).write(bytes, { exclusive: true });
}

function replaceFileContent(destination, bytes) {
  new AtomicFile(destination).write(bytes);
}

function removeEmptyStageContainer(container) {
  const directories = [];
  const inspect = (directory) => {
    const authority = new RealDirectoryAuthority(directory);
    for (const entry of authority.entries({ withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("canonical migration stage container has unknown content; refusing cleanup");
      }
      inspect(path.join(directory, entry.name));
    }
    directories.push(authority);
  };
  inspect(container);
  for (const authority of directories) authority.remove();
}

function assertTreeGeneration(directory, identity, hash, label, files = null) {
  const authority = assertRealDirectory(directory, label);
  if (!sameFileIdentity(authority.identity, identity) || treeFingerprint(directory) !== hash) {
    throw new LegacyFlowMigrationError("SOURCE_CHANGED", `${label} generation or bytes changed`);
  }
  if (files !== null) for (const file of storedSourceGenerations(files)) file.assert(directory);
  authority.assertStable();
  return authority;
}

class SpecsMigrationSourceFile {
  constructor(snapshot, sourcePath) {
    if (!(snapshot instanceof RegularFileSnapshot) || snapshot.identity === null) {
      throw new TypeError("Specs source file requires a captured regular file generation");
    }
    this.sourcePath = LogicalRelativePath.from(sourcePath, "Specs source path").toString();
    this.absolute = snapshot.filePath;
    this.kind = "file";
    this.hash = snapshot.digest;
    this.size = snapshot.byteLength;
    this.generation = snapshot.identity;
    Object.freeze(this);
  }

  toJSON() {
    return { path: this.sourcePath, kind: this.kind, hash: this.hash, size: this.size,
      generation: this.generation.toJSON() };
  }
}

function fileSnapshot(absolute, sourcePath) {
  return new SpecsMigrationSourceFile(captureRegularFile(absolute, {
    ...MIGRATION_READ_OPTIONS, requireSingleLink: true,
  }), sourcePath);
}

function captureTreeFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(absolute);
      else files.push(fileSnapshot(absolute, path.relative(directory, absolute).split(path.sep).join("/")));
    }
  };
  visit(directory);
  return files.map((file) => file.toJSON());
}

class SpecsMigrationStoredFileGeneration {
  constructor(value) {
    if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== "generation,hash,kind,path,size"
      || value.kind !== "file" || !/^[a-f0-9]{64}$/.test(value.hash)
      || !Number.isSafeInteger(value.size) || value.size < 0) throw new Error("Specs journal source file generation is invalid");
    this.sourcePath = LogicalRelativePath.from(value.path, "Specs journal source path").toString();
    this.generation = FileIdentity.fromStored(value.generation);
    this.hash = value.hash;
    this.size = value.size;
    Object.freeze(this);
  }

  assert(directory) {
    const snapshot = captureRegularFile(path.join(directory, ...this.sourcePath.split("/")), {
      ...MIGRATION_READ_OPTIONS, requireSingleLink: true, expectedIdentity: this.generation,
    });
    if (snapshot.digest !== this.hash || snapshot.byteLength !== this.size) throw new Error("Specs journal source file bytes changed");
  }
}

function storedSourceGenerations(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Specs journal source files are missing");
  const files = value.map((entry) => entry instanceof SpecsMigrationStoredFileGeneration ? entry : new SpecsMigrationStoredFileGeneration(entry));
  new LogicalPathSet(files.map((entry) => entry.sourcePath));
  return files;
}

function directoryIdentity(directory, label) {
  return assertRealDirectory(directory, label).identity.toJSON();
}

function sameDirectoryIdentity(directory, expected, label) {
  const actual = directoryIdentity(directory, label);
  return sameFileIdentity(actual, expected);
}

function treeFingerprint(directory, { ignoredNames = [] } = {}) {
  const ignored = new Set(ignoredNames);
  const entries = [];
  const paths = [];
  const visit = (current, prefix = "") => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (prefix === "" && ignored.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      paths.push(relative);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`migration tree contains a symbolic link: ${relative}`);
      if (stat.isDirectory()) {
        entries.push(`d\0${relative}`);
        visit(absolute, relative);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) throw new Error(`migration tree contains an unsafe entry: ${relative}`);
      const bytes = captureRegularFile(absolute, MIGRATION_READ_OPTIONS).bytes;
      entries.push(`f\0${relative}\0${bytes.length}\0${sha256(bytes)}`);
    }
  };
  assertRealDirectory(directory, "migration tree");
  visit(directory);
  new LogicalPathSet(paths, { allowDirectoryPrefixes: true });
  entries.sort(codeUnitOrder);
  return sha256(Buffer.from(JSON.stringify({ version: TREE_FINGERPRINT_VERSION, entries }), "utf8"));
}

function safeLegacyStatus(value, pointer) {
  if (typeof value !== "string" || !LEGACY_STATUS.has(value)) {
    throw new Error(`unsupported legacy node status at ${pointer}`);
  }
  return LEGACY_STATUS.get(value);
}

function directTimestamp(flow) {
  const candidates = [
    [flow.createdAt, "/createdAt"],
    [flow.state?.createdAt, "/state/createdAt"],
  ];
  for (const [value, pointer] of candidates) {
    if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Date.parse(value))) {
      return { timestamp: value, pointer };
    }
  }
  return null;
}

function derivedId(kind, specId, flowHash) {
  const digest = sha256(Buffer.from(`SENNEL\0SPECS\0REVISION-1\0${kind}\0${specId}\0${flowHash}`, "utf8"));
  return `${kind === "flow" ? "flow" : kind === "flow-version" ? "flow-version" : "run"}-${digest}`;
}

function claimedOrDerived(Identity, value, kind, specId, flowHash) {
  if (value === undefined || value === null) return Identity.from(derivedId(kind, specId, flowHash)).toString();
  try {
    return Identity.from(value).toString();
  } catch (error) {
    throw new LegacyFlowMigrationError(
      "INVALID_PRESERVED_IDENTITY",
      `legacy ${kind} identity is invalid and cannot be regenerated: ${error.message}`,
    );
  }
}

/** The immutable authority used to preserve or derive one canonical identity. */
export class LegacyIdentityBasis {
  constructor({ field, value, generated, sourceHash } = {}) {
    if (!new Set(["flowId", "flowVersionId", "runId"]).has(field)) {
      throw new Error("legacy identity basis field is invalid");
    }
    if (typeof value !== "string" || value === "") throw new Error("legacy identity basis value is invalid");
    if (typeof generated !== "boolean") throw new Error("legacy identity basis generation marker is invalid");
    if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash)) {
      throw new Error("legacy identity basis requires the source flow hash");
    }
    this.field = field;
    this.value = value;
    this.generated = generated;
    this.sourceHash = sourceHash;
    Object.freeze(this);
  }

  toJSON() {
    return {
      field: this.field,
      value: this.value,
      basis: this.generated ? "derived" : "preserved",
      source: { path: "flow.json", pointer: `/${this.field}`, hash: this.sourceHash },
      formula: this.generated ? "SENNEL\\0SPECS\\0REVISION-1\\0<identity-kind>\\0<specId>\\0<source-flow-sha256>" : null,
    };
  }
}

function identityBasisFor(source, state) {
  return Object.freeze([
    ["flowId", state.flowId],
    ["flowVersionId", state.flowVersionId],
    ["runId", state.runId],
  ].map(([field, value]) => new LegacyIdentityBasis({
    field,
    value,
    generated: source.flow[field] === undefined || source.flow[field] === null,
    sourceHash: source.flowHash,
  })));
}

function executionFor(flow) {
  const readOptional = (field) => {
    if (flow[field] === undefined || flow[field] === null) return null;
    if (typeof flow[field] !== "string" || flow[field].trim() === "") throw new Error(`legacy ${field} must be a non-empty string or null`);
    return flow[field];
  };
  const baseBranch = readOptional("baseBranch");
  const featureBranch = readOptional("featureBranch");
  const worktree = flow.worktree === true ? true : flow.worktree === false || flow.worktree == null
    ? false
    : readOptional("worktree");
  return {
    mode: worktree === false ? featureBranch === null ? "direct" : "branch" : "worktree",
    baseBranch,
    featureBranch,
  };
}

function lifecycleFor(flow) {
  const value = isPlainObject(flow.lifecycle) ? flow.lifecycle.state : flow.lifecycle;
  // `state.finalizedAt` and the archived terminal marker are durable
  // completion authorities.  The older lifecycle field described a live
  // controller session and is therefore not allowed to reopen a completed
  // Flow during migration.
  if (flow.state?.finalizedAt != null || flow.status === "archived" || flow.status === "finalized") {
    return { state: "finalized" };
  }
  if (value === "active" || value === "parked" || value === "finalized") return { state: value };
  // `SUSPENDED` was the persisted direct-session phase written by the
  // historical park command.  It maps to the production lifecycle's
  // intentionally equivalent parked state; no runtime alias is introduced.
  if (value === "paused" || flow.directFlowSession?.phase === "SUSPENDED") return { state: "parked" };
  return { state: "active" };
}

function attemptSequenceFor(evidence, nodeId) {
  // Aggregate counters never establish an individual Attempt identity.  Only
  // the typed, direct event adapter is allowed to advance a historical node
  // cursor; it still does not materialize an active/current Attempt.
  if (evidence === null) return 0;
  if (!(evidence instanceof LegacyAttemptSequenceEvidence)) {
    throw new Error("historical attempt sequence requires typed direct evidence");
  }
  return evidence.sequenceFor(nodeId);
}

function taskChildIdentity(taskId, childId) {
  const suffix = childId.startsWith(`${taskId}-`) ? childId.slice(taskId.length + 1) : childId;
  const key = new Map([
    ["task-impl", "impl"],
    ["task-review", "review"],
    ["task-gate", "gate"],
  ]).get(suffix) ?? suffix;
  return { id: `${taskId}-${key}`, key };
}

function preservedNodeResult(value, pointer, permanentReferences = null) {
  if (value.result === undefined || value.result === null) return null;
  try {
    const result = new NodeResult(value.result).toJSON();
    return permanentReferences === null ? result : permanentReferences.canonicalNodeResult(result, pointer);
  } catch (error) {
    if (error instanceof LegacyFlowMigrationError) throw error;
    throw new LegacyFlowMigrationError("UNSUPPORTED_NODE_RESULT", `legacy node result at ${pointer}/result is not a canonical result: ${error.message}`);
  }
}

function registerCurrentAlias(aliases, sourceId, canonicalId) {
  if (aliases === null) return;
  const prior = aliases.get(sourceId);
  if (prior === undefined) aliases.set(sourceId, canonicalId);
  else if (prior !== canonicalId) aliases.set(sourceId, null);
}

function convertLegacyNode(value, {
  pointer,
  kind = "step",
  idPrefix = "",
  identityFor = null,
  ids,
  aliases = null,
  permanentReferences = null,
  attemptEvidence = null,
}) {
  if (!isPlainObject(value)) throw new Error(`legacy node at ${pointer} must be an object`);
  if (typeof value.id !== "string" || value.id.trim() === "") throw new Error(`legacy node id at ${pointer} must be a non-empty string`);
  const identity = identityFor === null
    ? { id: idPrefix === "" ? value.id : `${idPrefix}${value.id}`, key: value.id }
    : identityFor(value.id);
  const { id, key } = identity;
  if (ids.has(id)) throw new Error(`legacy state duplicates node id: ${id}`);
  ids.add(id);
  registerCurrentAlias(aliases, value.id, id);
  const children = value.children ?? value.steps ?? [];
  if (!Array.isArray(children)) throw new Error(`legacy node children at ${pointer} must be an array`);
  return {
    kind,
    id,
    key,
    status: safeLegacyStatus(value.status ?? "pending", `${pointer}/status`),
    result: preservedNodeResult(value, pointer, permanentReferences),
    attemptSequence: attemptSequenceFor(attemptEvidence, id),
    steps: children.map((child, index) => convertLegacyNode(child, {
      pointer: `${pointer}/${Array.isArray(value.children) ? "children" : "steps"}/${index}`,
      idPrefix,
      identityFor,
      ids,
      aliases,
      permanentReferences,
      attemptEvidence,
    })),
  };
}

function rootStatus(flow, steps) {
  if (flow.status === "finalized") return "done";
  if (flow.status !== undefined && flow.status !== null) return safeLegacyStatus(flow.status, "/status");
  if (lifecycleFor(flow).state === "finalized") return "done";
  const inProgress = (node) => node.status === "in_progress" || node.steps.some(inProgress);
  return steps.some(inProgress) ? "in_progress" : "pending";
}

const LEGACY_TASK_SPEC_FIELDS = new Set([
  "id", "key", "title", "goal", "spec", "requirements", "summary", "parent", "origin", "added_round",
]);

/** The instruction-only projection of a legacy Flow task into the spec record. */
export class LegacyTaskSpecRecord {
  constructor(value, index) {
    if (!isPlainObject(value) || typeof value.id !== "string" || value.id.trim() === "") {
      throw new Error(`legacy task ${index} must be an object with an id`);
    }
    this.id = value.id;
    this.fields = Object.freeze(Object.fromEntries(
      Object.keys(value)
        .filter((field) => LEGACY_TASK_SPEC_FIELDS.has(field))
        .sort(codeUnitOrder)
        .map((field) => [field, structuredClone(value[field])]),
    ));
    Object.freeze(this);
  }

  toJSON() {
    return { ...this.fields, id: this.id, key: this.fields.key ?? this.id };
  }
}

function canonicalSpecDocument(source) {
  const document = structuredClone(source.spec);
  if (document.id != null && document.id !== source.specId) {
    throw new LegacyFlowMigrationError("SPEC_IDENTITY_MISMATCH", "legacy spec.json id does not match its directory");
  }
  if (document.specId != null && document.specId !== source.specId) {
    throw new LegacyFlowMigrationError("SPEC_IDENTITY_MISMATCH", "legacy spec.json specId does not match its directory");
  }
  const hasSpecTaskAuthority = Array.isArray(document.tasks);
  const tasks = hasSpecTaskAuthority ? document.tasks : source.flow.tasks;
  if (!Array.isArray(tasks)) throw new Error("legacy flow has no task authority for canonical spec.json.tasks");
  document.tasks = tasks.map((task, index) => {
    if (!hasSpecTaskAuthority) return new LegacyTaskSpecRecord(task, index).toJSON();
    if (!isPlainObject(task) || typeof task.id !== "string" || task.id.trim() === "") {
      throw new Error(`legacy spec task ${index} must be an object with an id`);
    }
    return { ...structuredClone(task), key: task.key ?? task.id };
  });
  document.specId = source.specId;
  return new CurrentFlowSpecRecord(document, { specId: source.specId });
}

/**
 * Legacy Flow tasks supplied the task-instruction authority only when the
 * paired Spec document had no `tasks` array.  Runtime fields on those tasks
 * must stay in the historical state/raw authority rather than becoming a
 * second mutable Spec authority.
 */
function flowTaskSpecPointers(source) {
  if (Array.isArray(source.spec.tasks)) return new Set();
  const pointers = new Set();
  for (const [index, task] of source.flow.tasks.entries()) {
    if (!isPlainObject(task)) continue;
    for (const field of Object.keys(task)) {
      if (field === "id" || LEGACY_TASK_SPEC_FIELDS.has(field)) {
        pointers.add(`/tasks/${index}/${jsonPointerSegment(field)}`);
      }
    }
  }
  return pointers;
}

function canonicalHistoricalState(source, definition, permanentReferences = null, attemptEvidence = null) {
  if (attemptEvidence !== null && !(attemptEvidence instanceof LegacyAttemptSequenceEvidence)) {
    throw new Error("canonical historical state requires typed direct attempt evidence");
  }
  const flow = source.flow;
  if (flow.specId != null && flow.specId !== source.specId) {
    throw new LegacyFlowMigrationError("SPEC_IDENTITY_MISMATCH", "legacy flow specId does not match its directory");
  }
  if (typeof flow.request !== "undefined" && typeof flow.request !== "string") throw new Error("legacy request must be a string");
  if ((flow.steps !== undefined && !Array.isArray(flow.steps)) || !Array.isArray(flow.tasks)) {
    throw new Error("recognized legacy Flow requires a tasks array and, when present, a steps array");
  }
  const ids = new Set(["flow"]);
  const aliases = new Map([["flow", "flow"]]);
  const flowSteps = (flow.steps ?? []).map((step, index) => convertLegacyNode(step, {
    pointer: `/steps/${index}`,
    ids,
    aliases,
    permanentReferences,
    attemptEvidence,
  }));
  const taskNodes = flow.tasks.map((task, index) => {
    if (!isPlainObject(task) || typeof task.id !== "string" || task.id.trim() === "") {
      throw new Error(`legacy task ${index} must be an object with an id`);
    }
    if (ids.has(task.id)) throw new Error(`legacy state duplicates task id: ${task.id}`);
    ids.add(task.id);
    registerCurrentAlias(aliases, task.id, task.id);
    const taskSteps = task.steps ?? [];
    if (!Array.isArray(taskSteps)) throw new Error(`legacy task ${task.id} steps must be an array`);
    return {
      kind: "task",
      id: task.id,
      key: task.id,
      status: safeLegacyStatus(task.status ?? "pending", `/tasks/${index}/status`),
      result: preservedNodeResult(task, `/tasks/${index}`, permanentReferences),
      attemptSequence: attemptSequenceFor(attemptEvidence, task.id),
      steps: taskSteps.map((step, stepIndex) => convertLegacyNode(step, {
        pointer: `/tasks/${index}/steps/${stepIndex}`,
        identityFor: (childId) => taskChildIdentity(task.id, childId),
        ids,
        aliases,
        permanentReferences,
        attemptEvidence,
      })),
    };
  });
  const steps = [...flowSteps, ...taskNodes];
  const currentTaskId = flow.currentTaskId;
  if (currentTaskId !== undefined && currentTaskId !== null && typeof currentTaskId !== "string") {
    throw new LegacyFlowMigrationError("INVALID_CURRENT_CURSOR", "legacy currentTaskId must be a saved task or step id");
  }
  const inProgress = [];
  const collect = (node) => {
    if (node.steps.length === 0 && node.status === "in_progress") inProgress.push(node.id);
    node.steps.forEach(collect);
  };
  steps.forEach(collect);
  const migratedLifecycle = lifecycleFor(flow);
  const mappedCurrent = currentTaskId == null ? null : aliases.get(currentTaskId);
  if (migratedLifecycle.state !== "finalized" && currentTaskId !== null && currentTaskId !== undefined && (mappedCurrent === undefined || mappedCurrent === null)) {
    throw new LegacyFlowMigrationError("INVALID_CURRENT_CURSOR", "legacy currentTaskId does not identify one unambiguous saved task or step");
  }
  if (migratedLifecycle.state !== "finalized" && inProgress.length > 1) {
    throw new LegacyFlowMigrationError("CONFLICTING_CURRENT_CURSOR", "legacy Flow has multiple in-progress leaf cursors");
  }
  const findHistoricalNode = (nodes, id) => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const nested = findHistoricalNode(node.steps, id);
      if (nested !== null) return nested;
    }
    return null;
  };
  const containsNode = (node, id) => node.id === id || node.steps.some((child) => containsNode(child, id));
  if (migratedLifecycle.state !== "finalized" && mappedCurrent !== null) {
    const cursor = findHistoricalNode(steps, mappedCurrent);
    if (cursor === null) throw new LegacyFlowMigrationError("INVALID_CURRENT_CURSOR", "legacy currentTaskId does not identify a saved state node");
    if (cursor.steps.length === 0) {
      if (inProgress.length !== 1 || inProgress[0] !== cursor.id) {
        throw new LegacyFlowMigrationError("CONFLICTING_CURRENT_CURSOR", "legacy current leaf does not match the active frontier");
      }
    } else if (inProgress.length !== 1 || !containsNode(cursor, inProgress[0])) {
      throw new LegacyFlowMigrationError("CONFLICTING_CURRENT_CURSOR", "legacy current branch does not contain the active frontier");
    }
  }
  const current = migratedLifecycle.state === "finalized"
    ? null
    : mappedCurrent ?? (inProgress.length === 1 ? inProgress[0] : null);
  const flowHash = source.flowHash;
  const created = directTimestamp(flow);
  const history = created === null
    ? { kind: "historical", execution: "dormant", ledger: "partial", creation: { status: "unavailable", reason: "NO_TRUSTED_CREATION_EVIDENCE" }, continuation: null }
    : {
      kind: "historical",
      execution: "dormant",
      ledger: "partial",
      continuation: null,
      creation: {
        status: "available",
        source: { path: "flow.json", pointer: created.pointer, hash: flowHash, timestamp: created.timestamp },
      },
    };
  const issue = flow.issue === undefined || flow.issue === null ? null : flow.issue;
  const state = new CurrentFlowState({
    schemaRevision: CURRENT_FLOW_SCHEMA_REVISION,
    flowId: claimedOrDerived(FlowId, flow.flowId, "flow", source.specId, flowHash),
    flowVersionId: claimedOrDerived(FlowVersionId, flow.flowVersionId, "flow-version", source.specId, flowHash),
    runId: claimedOrDerived(FlowRunId, flow.runId, "run", source.specId, flowHash),
    specId: FlowSpecIdentity.from(source.specId).toString(),
    issue,
    request: flow.request ?? "",
    version: REVISION,
    lifecycle: migratedLifecycle,
    execution: executionFor(flow),
    // Historical `nonblocking` was already produced in the same structured
    // policy shape. Preserve it through the production policy validator
    // instead of reporting a conversion that discards its enabled state.
    policy: { autoApprove: flow.autoApprove === true, nonblocking: flow.nonblocking ?? null },
    kind: "flow",
    id: "flow",
    key: "flow",
    status: rootStatus(flow, steps),
    result: preservedNodeResult(flow, "", permanentReferences),
    attemptSequence: attemptSequenceFor(attemptEvidence, "flow"),
    steps,
    current,
    attempt: null,
    confirmationOrder: created === null ? 0 : 1,
    artifacts: [],
    outbox: [],
    context: null,
    history,
    migration: null,
  }, { definition });
  return state;
}

function legacySwitchTarget(sourcePath) {
  return FLOW_ARTIFACT_SWITCH_TARGETS.find((target) => target.matchesLegacyPath(sourcePath)) ?? null;
}

const CANONICAL_RAW_LOG_KEYS = new Set([
  "scenario.validity.raw-log",
  "test.execute.raw-log",
  "final.regression.raw-log",
]);

/**
 * Source-era runtime residue is evidence, never live runtime input.  Keep
 * this separate from production transient contracts: those contracts describe
 * files a current writer may create, while these bytes were left by an old
 * writer and must not wake a current lock/recovery consumer.  The grammar is
 * deliberately producer-oriented rather than a repository filename list.
 */
export class LegacyRuntimeResidueClassification {
  constructor(reason) {
    if (typeof reason !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(reason)) {
      throw new Error("legacy runtime residue classification reason is invalid");
    }
    this.reason = reason;
    Object.freeze(this);
  }
}

/** Recognizes source-era control/output residue without consulting runtime paths. */
export class LegacyRuntimeResidueClassifier {
  constructor() { Object.freeze(this); }

  classify(sourcePath) {
    const normalized = normalizedRelative(sourcePath, "legacy runtime residue path");
    const segments = normalized.split("/");
    const basename = segments.at(-1);
    if (normalized.startsWith("tests/.raw/")) {
      return new LegacyRuntimeResidueClassification("LEGACY_RAW_LOG_RESIDUE");
    }
    const legacyWorkerHandoffRoot = PRODUCT.managedPath("handoffs");
    if (normalized === legacyWorkerHandoffRoot || normalized.startsWith(`${legacyWorkerHandoffRoot}/`)) {
      return new LegacyRuntimeResidueClassification("LEGACY_WORKER_HANDOFF_RESIDUE");
    }
    if (segments.some((segment) => [".runtime", ".tmp", "tmp", ".cache", "cache"].includes(segment)) || basename.endsWith(".cache")) {
      return new LegacyRuntimeResidueClassification("LEGACY_RUNTIME_WORKSPACE_RESIDUE");
    }
    if (segments.some((segment) => /^(?:review-)?work-units?$/i.test(segment))
      || /(?:^|[._-])work-units?(?:[._-]|$)/i.test(basename)) {
      return new LegacyRuntimeResidueClassification("LEGACY_WORK_UNIT_RESIDUE");
    }
    if (basename === "upgrade.log") {
      return new LegacyRuntimeResidueClassification("LEGACY_UPGRADE_LOG_RESIDUE");
    }
    if (basename.endsWith(".tmp") || /(?:^|[._-])owner(?:[._-]|$).*\.tmp$/i.test(basename)) {
      return new LegacyRuntimeResidueClassification("LEGACY_TEMPORARY_FILE_RESIDUE");
    }
    if (/(?:^|[._-])lock(?:[._-]|$)/i.test(basename)) {
      return new LegacyRuntimeResidueClassification("LEGACY_LOCK_RESIDUE");
    }
    if (/(?:^|[._-])(?:transaction|journal)(?:[._-](?:completed|interrupted|rejected|empty|pending|staged|backup|recovery|rollback|resume))*\.json$/i.test(basename)) {
      return new LegacyRuntimeResidueClassification("LEGACY_TRANSACTION_JOURNAL_RESIDUE");
    }
    if (/^(?:raw(?:[-_.][a-z0-9]+)*|requirement)[-_.]summary\.json$/i.test(basename)) {
      return new LegacyRuntimeResidueClassification("LEGACY_RAW_SUMMARY_RESIDUE");
    }
    if (/^finaliz(?:e|ation)(?:[-_.]cleanup)?(?:[-_.](?:journal|runtime|recovery|state))?\.json$/i.test(basename)) {
      return new LegacyRuntimeResidueClassification("LEGACY_FINALIZE_RUNTIME_RESIDUE");
    }
    return null;
  }
}

const LEGACY_RUNTIME_RESIDUE_CLASSIFIER = new LegacyRuntimeResidueClassifier();

function legacyRuntimeResidueReason(sourcePath) {
  return LEGACY_RUNTIME_RESIDUE_CLASSIFIER.classify(sourcePath)?.reason ?? null;
}

const LEGACY_REVIEW_HISTORY_TARGETS = Object.freeze([
  ["draft-questions", "draft.questions.review"],
  ["draft-coverage", "draft.coverage.review"],
  ["spec", "spec.review"],
  ["test", "test.review"],
  ["impl", "impl.review"],
]);

function legacyReviewHistoryTarget(sourcePath) {
  const match = sourcePath.match(/^review-history\/([a-z-]+)-attempt-(\d+)\.json$/);
  if (match === null) return null;
  const logicalKey = new Map(LEGACY_REVIEW_HISTORY_TARGETS).get(match[1]);
  if (logicalKey === undefined) return null;
  const attempt = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new LegacyFlowMigrationError("INVALID_LEGACY_ATTEMPT", `${sourcePath} has an invalid attempt number`);
  }
  return Object.freeze({ logicalKey, attempt });
}

function isKnownLegacyArtifact(sourcePath) {
  if (legacyRuntimeResidueReason(sourcePath) !== null) return true;
  if (legacySwitchTarget(sourcePath) !== null) return true;
  const extension = path.posix.extname(sourcePath).toLowerCase();
  if (PORTABLE_LEGACY_ARTIFACT_EXTENSIONS.has(extension)) return true;
  const base = path.posix.basename(sourcePath);
  // Extensionless marker files are a portable script/runtime convention only
  // when they live below an artifact directory; a random root file remains
  // unclassified rather than being treated as Flow input.
  return extension === "" && sourcePath.includes("/") && base.startsWith(".");
}

function taskIdForLegacyArtifact(source) {
  const explicit = source.flow.currentTaskId;
  if (typeof explicit === "string" && source.flow.tasks.some((task) => task?.id === explicit)) return explicit;
  return source.flow.tasks.length === 1 && typeof source.flow.tasks[0]?.id === "string"
    ? source.flow.tasks[0].id
    : null;
}

function reviewOwnerForLegacyEvidence(value, sourcePath, source) {
  const phaseToReview = new Map([
    ["draft-questions", "draft-questions-review"],
    ["draft-coverage", "draft-coverage-review"],
    ["spec", "spec-review"],
    ["test", "test-review"],
    ["impl", "impl-review"],
  ]);
  const reviewStep = phaseToReview.get(value.phase);
  if (reviewStep === undefined) {
    throw new LegacyFlowMigrationError("UNSUPPORTED_REVIEW_EVIDENCE_OWNER", `${sourcePath} does not name a supported review owner`);
  }
  const taskId = value.taskId == null ? null : value.taskId;
  if (taskId !== null && (typeof taskId !== "string" || !source.flow.tasks.some((task) => task?.id === taskId))) {
    throw new LegacyFlowMigrationError("UNSUPPORTED_REVIEW_EVIDENCE_OWNER", `${sourcePath} names an unknown Task review owner`);
  }
  return Object.freeze({ reviewStep, taskId });
}

function resolvedSwitchArtifact(target, sourcePath, source, bytes) {
  if (target.logicalKey === "tests.source") {
    return FLOW_ARTIFACT_CONTRACTS.resolve(target.logicalKey, { testPath: sourcePath.slice("tests/".length) });
  }
  if (target.logicalKey === "plugin.lifecycle.artifact") {
    return FLOW_ARTIFACT_CONTRACTS.resolve(target.logicalKey, { pluginArtifactPath: sourcePath.slice("plugin-artifacts/".length) });
  }
  if (target.logicalKey === "repair.delta") {
    const deltaId = path.posix.basename(sourcePath, ".json");
    return FLOW_ARTIFACT_CONTRACTS.resolve(target.logicalKey, { deltaId });
  }
  if (target.logicalKey === "final.regression.raw-log") {
    const attempt = sourcePath.match(/attempt-(\d{3})\.log$/)?.[1];
    return FLOW_ARTIFACT_CONTRACTS.resolve(target.logicalKey, { attempt });
  }
  if (target.logicalKey === "review.work.unit") {
    return FLOW_ARTIFACT_CONTRACTS.resolve(target.logicalKey, { workUnitPath: sourcePath.slice("review-history/work-units/".length) });
  }
  if (target.logicalKey === "review.evidence") {
    const digest = path.posix.basename(sourcePath, ".json");
    const value = parseObject(bytes, sourcePath);
    const owner = reviewOwnerForLegacyEvidence(value, sourcePath, source);
    return FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep: owner.taskId === null ? owner.reviewStep : null, taskId: owner.taskId, digest });
  }
  if (["task.gate.source", "task.gate"].includes(target.logicalKey)) {
    const taskId = taskIdForLegacyArtifact(source);
    if (taskId === null) {
      throw new LegacyFlowMigrationError("AMBIGUOUS_TASK_ARTIFACT_OWNER", `${sourcePath} has no unambiguous Task owner`);
    }
    return FLOW_ARTIFACT_CONTRACTS.resolve(target.logicalKey, { taskId });
  }
  return FLOW_ARTIFACT_CONTRACTS.resolve(target.logicalKey);
}

/** One mutually-exclusive file conversion decision, including byte adaptation. */
export class LegacyArtifactDecision {
  constructor({ sourcePath, classification, destination = null, reason, resolved = null, transform = "copy", attemptHint = null } = {}) {
    this.sourcePath = normalizedRelative(sourcePath, "legacy artifact source path");
    if (!["converted", "preserved", "omitted", "relocatedTransient"].includes(classification)) {
      throw new Error("legacy artifact decision classification is invalid");
    }
    this.classification = classification;
    this.destination = destination === null ? null : normalizedRelative(destination, "legacy artifact destination");
    if (this.classification === "omitted" ? this.destination !== null : this.destination === null) {
      throw new Error("legacy artifact decision destination does not match its classification");
    }
    if (typeof reason !== "string" || reason.trim() === "") throw new Error("legacy artifact decision requires a reason");
    this.reason = reason;
    this.resolved = resolved;
    if (!["copy", "attempt-history"].includes(transform)) throw new Error("legacy artifact decision transform is invalid");
    this.transform = transform;
    if (attemptHint !== null && (!Number.isSafeInteger(attemptHint) || attemptHint < 1)) {
      throw new Error("legacy artifact decision attempt hint is invalid");
    }
    this.attemptHint = attemptHint;
    Object.freeze(this);
  }

  materialize(location, source) {
    if (this.transform !== "copy") throw new Error("attempt-history artifacts require a typed aggregate");
    copyFile(source.absolute, location.resolve(this.destination));
  }
}

/**
 * A byte-preserved legacy runtime residue.  It intentionally has no
 * `resolved` production artifact: materializing it below the migration-owned
 * runtime vault must not publish a catalog descriptor or make it visible to
 * a live lock, transaction, or retry consumer.
 */
export class LegacyRuntimeResidue {
  constructor({ sourcePath, reason } = {}) {
    this.sourcePath = normalizedRelative(sourcePath, "legacy runtime residue source path");
    this.destination = `.runtime/migration/legacy-files/${this.sourcePath}`;
    if (typeof reason !== "string" || reason === "") throw new Error("legacy runtime residue requires a reason");
    this.reason = reason;
    Object.freeze(this);
  }

  mapping() {
    return new MigrationMapping({
      classification: "relocatedTransient",
      source: this.sourcePath,
      pointer: null,
      destination: this.destination,
      reason: this.reason,
    });
  }

  materialize(location, file) {
    if (!(location instanceof FlowVersionLocation) || !file || file.sourcePath !== this.sourcePath) {
      throw new Error("legacy runtime residue materialization requires its typed source and Version location");
    }
    copyFile(file.absolute, location.resolve(this.destination));
  }
}

function explicitArtifactPath(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = value.replaceAll("\\", "/");
  const base = path.posix.basename(normalized);
  const extension = path.posix.extname(base);
  if (!normalized.includes("/") && extension === "" && !normalized.startsWith(".")) return null;
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new LegacyFlowMigrationError("INVALID_PERMANENT_ARTIFACT_REFERENCE", `permanent artifact reference escapes its legacy Spec root: ${value}`);
  }
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

/**
 * Resolves only explicit permanent file references. Opaque artifact IDs remain
 * semantic NodeResult facts; a string becomes a filesystem authority only
 * when its syntax unambiguously declares a legacy relative path.
 */
export class LegacyPermanentArtifactReferences {
  #bySource;
  #byBasename;
  #destinations;
  #decisions;

  constructor({ source, decisions } = {}) {
    if (!(source instanceof LegacyFlowSource)) throw new Error("permanent artifact references require a legacy Flow source");
    if (!Array.isArray(decisions) || decisions.some((entry) => !(entry instanceof LegacyArtifactDecision))) {
      throw new Error("permanent artifact references require typed artifact decisions");
    }
    this.#bySource = new Map();
    this.#byBasename = new Map();
    for (const file of source.files) {
      this.#bySource.set(file.sourcePath, file);
      const basename = path.posix.basename(file.sourcePath);
      const entries = this.#byBasename.get(basename) ?? [];
      entries.push(file.sourcePath);
      this.#byBasename.set(basename, entries);
    }
    this.#destinations = new Map([
      ["flow.json", "flow.json"],
      ["spec.json", "spec.json"],
    ]);
    for (const decision of decisions) {
      if (!["converted", "preserved"].includes(decision.classification) || decision.destination === null) continue;
      this.#destinations.set(decision.sourcePath, decision.destination);
    }
    this.#decisions = new Map(decisions.map((entry) => [entry.sourcePath, entry]));
    Object.freeze(this);
  }

  #sourcePath(value, pointer) {
    const explicit = explicitArtifactPath(value);
    if (explicit === null) return null;
    const direct = this.#bySource.has(explicit) ? [explicit] : [];
    const candidates = direct.length > 0
      ? direct
      : !explicit.includes("/") ? (this.#byBasename.get(explicit) ?? []) : [];
    if (candidates.length === 0) {
      throw new LegacyFlowMigrationError(
        "MISSING_PERMANENT_ARTIFACT_REFERENCE",
        `permanent artifact reference at ${pointer} is absent from the legacy Spec: ${value}`,
      );
    }
    if (candidates.length > 1) {
      throw new LegacyFlowMigrationError(
        "AMBIGUOUS_PERMANENT_ARTIFACT_REFERENCE",
        `permanent artifact reference at ${pointer} matches multiple legacy files: ${candidates.sort(codeUnitOrder).join(", ")}`,
      );
    }
    const sourcePath = candidates[0];
    const destination = this.#destinations.get(sourcePath) ?? null;
    const decision = this.#decisions.get(sourcePath) ?? null;
    if (destination === null || decision?.classification === "relocatedTransient" || decision?.classification === "omitted") {
      throw new LegacyFlowMigrationError(
        "INVALID_PERMANENT_ARTIFACT_REFERENCE",
        `permanent artifact reference at ${pointer} has no cataloged canonical destination: ${value}`,
      );
    }
    return sourcePath;
  }

  canonicalPath(value, pointer) {
    const sourcePath = this.#sourcePath(value, pointer);
    return sourcePath === null ? value : this.#destinations.get(sourcePath);
  }

  canonicalNodeResult(result, pointer) {
    const artifactRefs = result.artifactRefs.map((reference, index) => ({
      ...reference,
      id: this.canonicalPath(reference.id, `${pointer}/result/artifactRefs/${index}/id`),
    }));
    return new NodeResult({ ...result, artifactRefs }).toJSON();
  }

  canonicalStructuredResult(value, sourcePath, pointer = "") {
    if (Array.isArray(value)) {
      return value.map((entry, index) => this.canonicalStructuredResult(entry, sourcePath, pointerFor(pointer, index)));
    }
    if (!isPlainObject(value)) return value;
    const result = {};
    for (const key of Object.keys(value)) {
      const fieldPointer = pointerFor(pointer, key);
      if (key === "artifactRefs" && Array.isArray(value[key])) {
        result[key] = value[key].map((reference, index) => {
          const referencePointer = pointerFor(fieldPointer, index);
          if (typeof reference === "string") return this.canonicalPath(reference, `${sourcePath}${referencePointer}`);
          if (!isPlainObject(reference)) return structuredClone(reference);
          const next = structuredClone(reference);
          if (typeof next.path === "string") next.path = this.canonicalPath(next.path, `${sourcePath}${referencePointer}/path`);
          if (typeof next.id === "string") next.id = this.canonicalPath(next.id, `${sourcePath}${referencePointer}/id`);
          return next;
        });
        continue;
      }
      result[key] = this.canonicalStructuredResult(value[key], sourcePath, fieldPointer);
    }
    return result;
  }
}

/** A legacy source observation that contributes one or more canonical result attempts. */
export class LegacyResultObservation {
  constructor({ file, decision, permanentReferences = null, fromReviewHistory = false } = {}) {
    if (!file || typeof file.sourcePath !== "string" || typeof file.absolute !== "string") {
      throw new Error("legacy result observation requires a source file snapshot");
    }
    if (!(decision instanceof LegacyArtifactDecision) || decision.transform !== "attempt-history" || decision.resolved === null) {
      throw new Error("legacy result observation requires an attempt-history decision");
    }
    if (typeof fromReviewHistory !== "boolean") throw new Error("legacy result observation history marker is invalid");
    if (permanentReferences !== null && !(permanentReferences instanceof LegacyPermanentArtifactReferences)) {
      throw new Error("legacy result observation permanent artifact references are invalid");
    }
    this.file = file;
    this.decision = decision;
    this.permanentReferences = permanentReferences;
    this.fromReviewHistory = fromReviewHistory;
    Object.freeze(this);
  }

  records() {
    const bytes = captureRegularFile(this.file.absolute, MIGRATION_READ_OPTIONS).bytes;
    const rawDetail = parseObject(bytes, this.file.sourcePath);
    const detail = this.permanentReferences === null
      ? rawDetail
      : this.permanentReferences.canonicalStructuredResult(rawDetail, this.file.sourcePath);
    if (Array.isArray(detail.attempts)) {
      let history;
      try {
        history = this.decision.resolved.contract.contentContract.parse(bytes);
      } catch (error) {
        throw new LegacyFlowMigrationError("INVALID_RESULT_ATTEMPT_HISTORY", `${this.file.sourcePath} is not a canonical result history: ${error.message}`);
      }
      return history.attempts.map((record) => Object.freeze({
        sourcePath: this.file.sourcePath,
        explicitAttempt: record.attempt.value,
        payload: this.permanentReferences === null
          ? record.payload
          : this.permanentReferences.canonicalStructuredResult(record.payload, this.file.sourcePath),
        fingerprint: sha256(Buffer.from(JSON.stringify(record.toJSON()), "utf8")),
        historical: true,
      }));
    }
    if (this.fromReviewHistory && Object.hasOwn(detail, "attempt") && detail.attempt !== this.decision.attemptHint) {
      throw new LegacyFlowMigrationError("MISMATCHED_LEGACY_ATTEMPT", `${this.file.sourcePath} disagrees with its attempt filename`);
    }
    return [Object.freeze({
      sourcePath: this.file.sourcePath,
      explicitAttempt: this.fromReviewHistory ? this.decision.attemptHint : null,
      payload: { legacySource: this.file.sourcePath, detail },
      fingerprint: sha256(bytes),
      historical: this.fromReviewHistory,
    })];
  }
}

/** Consolidates compatible legacy result files into one append-only canonical artifact. */
export class LegacyResultAggregation {
  constructor({ destination, resolved, observations } = {}) {
    this.destination = normalizedRelative(destination, "legacy result aggregate destination");
    if (!resolved || typeof resolved.relativePath !== "string" || resolved.contract?.contentContract === null) {
      throw new Error("legacy result aggregate requires a canonical attempt-history artifact");
    }
    if (!Array.isArray(observations) || observations.length === 0
      || observations.some((entry) => !(entry instanceof LegacyResultObservation))) {
      throw new Error("legacy result aggregate requires typed observations");
    }
    if (observations.some((entry) => entry.decision.destination !== this.destination
      || entry.decision.resolved.logicalKey !== resolved.logicalKey
      || entry.decision.resolved.relativePath !== resolved.relativePath
      || entry.decision.resolved.contract !== resolved.contract)) {
      throw new Error("legacy result aggregate observations must share one canonical destination");
    }
    this.resolved = resolved;
    this.observations = Object.freeze([...observations]);
    Object.freeze(this);
  }

  static fromDecisions(source, decisions, permanentReferences = null) {
    if (permanentReferences !== null && !(permanentReferences instanceof LegacyPermanentArtifactReferences)) {
      throw new Error("legacy result aggregation permanent artifact references are invalid");
    }
    const files = new Map(source.files.map((file) => [file.sourcePath, file]));
    const groups = new Map();
    for (const decision of decisions) {
      if (decision.classification !== "converted" || decision.transform !== "attempt-history") continue;
      const file = files.get(decision.sourcePath);
      if (!file) throw new Error("legacy result aggregate source file is missing");
      const observation = new LegacyResultObservation({
        file,
        decision,
        permanentReferences,
        fromReviewHistory: decision.attemptHint !== null,
      });
      const group = groups.get(decision.destination);
      if (group === undefined) {
        groups.set(decision.destination, { resolved: decision.resolved, observations: [observation] });
      } else {
        if (group.resolved.logicalKey !== decision.resolved.logicalKey
          || group.resolved.relativePath !== decision.resolved.relativePath
          || group.resolved.contract !== decision.resolved.contract) {
          throw new Error("attempt-history destination resolves to different canonical artifacts");
        }
        group.observations.push(observation);
      }
    }
    return Object.freeze([...groups.entries()]
      .sort(([left], [right]) => codeUnitOrder(left, right))
      .map(([destination, group]) => new LegacyResultAggregation({ destination, ...group })));
  }

  sourcePaths() {
    return Object.freeze(this.observations.map((entry) => entry.file.sourcePath));
  }

  bytes() {
    const historical = [];
    const current = [];
    for (const observation of this.observations) {
      for (const record of observation.records()) {
        (record.historical ? historical : current).push(record);
      }
    }
    historical.sort((left, right) => left.explicitAttempt - right.explicitAttempt || codeUnitOrder(left.sourcePath, right.sourcePath));
    current.sort((left, right) => codeUnitOrder(left.sourcePath, right.sourcePath));
    const selected = [];
    const attempts = new Map();
    const deferred = [];
    for (const record of historical) {
      const existing = attempts.get(record.explicitAttempt);
      if (existing === undefined) {
        attempts.set(record.explicitAttempt, record);
        selected.push({ attempt: record.explicitAttempt, record });
      } else if (existing.fingerprint !== record.fingerprint) {
        throw new LegacyFlowMigrationError("CONFLICTING_LEGACY_ATTEMPT", `${record.sourcePath} conflicts with ${existing.sourcePath}`);
      }
    }
    for (const record of current) {
      if (selected.some((entry) => entry.record.fingerprint === record.fingerprint)) continue;
      deferred.push(record);
    }
    let nextAttempt = selected.reduce((maximum, entry) => Math.max(maximum, entry.attempt), 0) + 1;
    for (const record of deferred) {
      selected.push({ attempt: nextAttempt, record });
      nextAttempt += 1;
    }
    const history = new FlowArtifactAttemptHistory(selected.map(({ attempt, record }) => new FlowArtifactAttemptRecord({
      attempt,
      payload: record.payload,
    })));
    const bytes = Buffer.from(`${JSON.stringify(history.toJSON())}\n`, "utf8");
    this.resolved.contract.assertContentPublication(null, bytes);
    return bytes;
  }
}

function sharesAttemptHistoryDestination(left, right) {
  return left.transform === "attempt-history" && right.transform === "attempt-history"
    && left.classification === "converted" && right.classification === "converted"
    && left.resolved !== null && right.resolved !== null
    && left.destination === right.destination
    && left.resolved.logicalKey === right.resolved.logicalKey
    && left.resolved.relativePath === right.resolved.relativePath
    && left.resolved.contract === right.resolved.contract;
}

function preservedLegacyArtifact(sourcePath, reason = "NO_CANONICAL_TARGET") {
  return new LegacyArtifactDecision({
    sourcePath,
    classification: "preserved",
    destination: `artifacts/migration/legacy-files/${sourcePath}`,
    reason,
  });
}

function aggregateOnlyResultDocument(detail) {
  const fields = Object.keys(detail);
  if (fields.length === 0) return false;
  return fields.every((field) => (
    /^(?:attempts?|retries|retrycount|count|total|remaining|budget|version)$/i.test(field)
    && (detail[field] === null || typeof detail[field] !== "object" || (Array.isArray(detail[field]) && detail[field].length === 0))
  ));
}

function artifactDecision(file, source) {
  const { sourcePath } = file;
  if (sourcePath === "flow.json" || sourcePath === "spec.json") return null;
  const residueReason = legacyRuntimeResidueReason(sourcePath);
  const reviewHistory = legacyReviewHistoryTarget(sourcePath);
  if (reviewHistory !== null) {
    const resolved = FLOW_ARTIFACT_CONTRACTS.resolve(reviewHistory.logicalKey);
    return new LegacyArtifactDecision({
      sourcePath,
      classification: "converted",
      destination: resolved.relativePath,
      reason: "CANONICAL_ATTEMPT_HISTORY",
      resolved,
      transform: "attempt-history",
      attemptHint: reviewHistory.attempt,
    });
  }
  const target = legacySwitchTarget(sourcePath);
  if (target === null) {
    if (residueReason !== null) return new LegacyRuntimeResidue({ sourcePath, reason: residueReason });
    return preservedLegacyArtifact(sourcePath);
  }
  // A source-era raw-log directory may also contain retired one-off logs
  // whose switch target was removed.  Only the three current raw-log
  // families below are allowed to enter live canonical transient paths.
  if (residueReason !== null && !CANONICAL_RAW_LOG_KEYS.has(target.logicalKey)) {
    return new LegacyRuntimeResidue({ sourcePath, reason: residueReason });
  }
  if (target.action === "remove") {
    // A rendered Markdown view and an unrecognized historical result may
    // carry human evidence that cannot be regenerated from the incomplete
    // legacy state.  Only the revision marker is independently derivable.
    if (target.logicalKey !== "legacy.flow.version") return preservedLegacyArtifact(sourcePath);
    return new LegacyArtifactDecision({ sourcePath, classification: "omitted", reason: "DERIVED_LEGACY_VIEW" });
  }
  if (target.logicalKey === "flow.state" || target.logicalKey === "spec.record") return null;
  const bytes = captureRegularFile(file.absolute, MIGRATION_READ_OPTIONS).bytes;
  let resolved;
  try {
    resolved = resolvedSwitchArtifact(target, sourcePath, source, bytes);
  } catch (error) {
    if (error instanceof LegacyFlowMigrationError && error.code === "AMBIGUOUS_TASK_ARTIFACT_OWNER") {
      return preservedLegacyArtifact(sourcePath);
    }
    throw error;
  }
  if (resolved.contract.contentContract !== null && aggregateOnlyResultDocument(parseObject(bytes, sourcePath))) {
    return preservedLegacyArtifact(sourcePath, "INSUFFICIENT_EVENT_DETAIL");
  }
  const transient = resolved.contract.retention.toString() === "transient";
  if (transient && !CANONICAL_RAW_LOG_KEYS.has(resolved.logicalKey)) {
    return new LegacyRuntimeResidue({ sourcePath, reason: "LEGACY_RUNTIME_CONTRACT_RESIDUE" });
  }
  return new LegacyArtifactDecision({
    sourcePath,
    classification: transient ? "relocatedTransient" : "converted",
    destination: resolved.relativePath,
    reason: target.logicalKey === "issue.snapshot" ? "CANONICAL_ISSUE_SNAPSHOT" : "CANONICAL_ARTIFACT_ADAPTER",
    resolved,
    transform: resolved.contract.contentContract === null ? "copy" : "attempt-history",
  });
}

/** A producer-declared transient raw log that was expected but is absent. */
export class LegacyMissingTransient {
  constructor({ sourcePath, destination, reason, regenerationSource } = {}) {
    this.sourcePath = normalizedRelative(sourcePath, "missing transient source path");
    this.destination = normalizedRelative(destination, "missing transient destination");
    if (typeof reason !== "string" || reason === "") throw new Error("missing transient reason is invalid");
    this.reason = reason;
    if (!(regenerationSource instanceof MigrationInput)) {
      throw new Error("missing transient requires a hash-bound regeneration source");
    }
    this.regenerationSource = regenerationSource;
    Object.freeze(this);
  }

  mapping() {
    return new MigrationMapping({
      classification: "missingTransient",
      source: this.sourcePath,
      pointer: null,
      destination: this.destination,
      reason: this.reason,
      regenerationSource: this.regenerationSource,
    });
  }
}

const MISSING_TRANSIENT_RAW_LOG_CONTRACTS = Object.freeze([
  Object.freeze({
    resultPath: "scenario-validity-result.json",
    pointer: "/raw_output_path",
    legacyPath: "tests/.raw/scenario-validity.log",
    destination: "steps/scenario-validity/output.log",
  }),
  Object.freeze({
    resultPath: "test-execute-result.json",
    pointer: "/raw_output_path",
    legacyPath: "tests/.raw/test-execution.log",
    destination: "steps/test-execute/output.log",
  }),
]);

function legacyRelativeArtifactReference(source, value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.includes("..")) return null;
  if (normalized.startsWith("tests/.raw/")) return normalized;
  const declared = typeof source.flow.spec === "string" ? source.flow.spec.replaceAll("\\", "/") : null;
  const root = declared === null ? null : path.posix.dirname(declared);
  if (root !== null && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return null;
}

function missingTransientMappings(source) {
  const files = new Map(source.files.map((file) => [file.sourcePath, file]));
  const missing = [];
  for (const contract of MISSING_TRANSIENT_RAW_LOG_CONTRACTS) {
    const result = files.get(contract.resultPath);
    if (result === undefined || files.has(contract.legacyPath)) continue;
    const document = parseObject(captureRegularFile(result.absolute, MIGRATION_READ_OPTIONS).bytes, result.sourcePath);
    if (legacyRelativeArtifactReference(source, document.raw_output_path) !== contract.legacyPath) continue;
    missing.push(new LegacyMissingTransient({
      sourcePath: contract.legacyPath,
      destination: contract.destination,
      reason: "REFERENCED_TRANSIENT_RAW_LOG_MISSING",
      regenerationSource: new MigrationInput({ source: result.sourcePath, pointer: contract.pointer, hash: result.hash }),
    }).mapping());
  }
  return missing;
}

function trustedTimestamp(value) {
  return typeof value === "string" && value.trim() !== "" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function stateNodeIdForLegacyStep(state, stepId, taskId = null) {
  if (typeof stepId !== "string" || stepId.trim() === "") return null;
  const candidates = [];
  if (typeof taskId === "string" && taskId.trim() !== "") {
    candidates.push(taskChildIdentity(taskId, stepId).id);
  }
  candidates.push(stepId);
  return candidates.find((candidate) => state.findNode(candidate) !== null) ?? null;
}

function stateNodeIdForLegacyPhase(state, phase) {
  if (typeof phase !== "string" || phase.trim() === "") return state.root.id;
  const reviewOwner = new Map([
    ["draft-questions", "draft-questions-review"],
    ["draft-coverage", "draft-coverage-review"],
    ["spec", "spec-review"],
    ["test", "test-review"],
    ["impl", "impl-review"],
    ["integration", "impl-gate"],
    ["acceptance", "acceptance-review"],
  ]).get(phase) ?? phase;
  return stateNodeIdForLegacyStep(state, reviewOwner) ?? state.root.id;
}

/** A complete legacy Step event that establishes both an Activity and a retry cursor. */
function detailedStepAttempt(value) {
  if (!isPlainObject(value)
    || typeof value.runId !== "string" || value.runId === ""
    || (value.taskId !== null && value.taskId !== undefined && (typeof value.taskId !== "string" || value.taskId === ""))
    || typeof value.stepId !== "string" || value.stepId === ""
    || !Number.isSafeInteger(value.attempt) || value.attempt < 1
    || !isPlainObject(value.outcome)) {
    return null;
  }
  const recordedAt = trustedTimestamp(value.recordedAt);
  if (recordedAt === null) return null;
  return Object.freeze({
    taskId: value.taskId ?? null,
    stepId: value.stepId,
    attempt: value.attempt,
    recordedAt,
  });
}

/** Visit legacy Flow nodes using the same source-to-canonical identity rules as evidence adapters. */
function visitLegacyFlowNodes(source, state, visitor) {
  if (!(source instanceof LegacyFlowSource) || !(state instanceof CurrentFlowState) || typeof visitor !== "function") {
    throw new Error("legacy Flow node visit requires a source, state, and visitor");
  }
  const visit = (node, pointer, { taskId = null, task = false } = {}) => {
    if (!isPlainObject(node) || typeof node.id !== "string" || node.id === "") return;
    const nodeId = task
      ? state.findNode(node.id)?.id ?? null
      : stateNodeIdForLegacyStep(state, node.id, taskId);
    visitor({ node, pointer, nodeId });
    const childField = Array.isArray(node.children) ? "children" : Array.isArray(node.steps) ? "steps" : null;
    if (childField === null) return;
    const childTaskId = task ? node.id : taskId;
    node[childField].forEach((child, index) => visit(
      child,
      `${pointer}/${childField}/${index}`,
      { taskId: childTaskId },
    ));
  };
  source.flow.steps?.forEach((step, index) => visit(step, `/steps/${index}`));
  source.flow.tasks.forEach((task, index) => visit(task, `/tasks/${index}`, { task: true }));
}

/** A direct, hash-bound legacy observation that can become one note Activity. */
export class LegacyEvidenceObservation {
  constructor({ sourcePath, pointer, hash, timestamp, nodeId, artifactReference = null, note } = {}) {
    this.sourcePath = normalizedRelative(sourcePath, "legacy evidence source path");
    if (typeof pointer !== "string" || !pointer.startsWith("/")) throw new Error("legacy evidence pointer is invalid");
    this.pointer = pointer;
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("legacy evidence hash must be SHA-256");
    this.hash = hash;
    this.timestamp = trustedTimestamp(timestamp);
    if (this.timestamp === null) throw new Error("legacy evidence timestamp is invalid");
    if (typeof nodeId !== "string" || nodeId === "") throw new Error("legacy evidence node id is invalid");
    this.nodeId = nodeId;
    if (artifactReference !== null && (typeof artifactReference !== "string" || artifactReference === "")) {
      throw new Error("legacy evidence artifact reference is invalid");
    }
    this.artifactReference = artifactReference;
    if (typeof note !== "string" || note === "") throw new Error("legacy evidence note is invalid");
    this.note = note;
    Object.freeze(this);
  }

  static compare(left, right) {
    return Date.parse(left.timestamp) - Date.parse(right.timestamp)
      || codeUnitOrder(left.sourcePath, right.sourcePath)
      || codeUnitOrder(left.pointer, right.pointer);
  }

  input() {
    return new MigrationInput({ source: this.sourcePath, pointer: this.pointer, hash: this.hash });
  }

  digest() {
    return sha256(Buffer.from(`${this.sourcePath}\0${this.pointer}\0${this.hash}`, "utf8"));
  }

  activity(state, confirmationOrder, artifactReference) {
    const node = state.findNode(this.nodeId);
    if (node === null) throw new Error("legacy evidence owner is absent from historical state");
    if (typeof artifactReference !== "string" || artifactReference === "") {
      throw new Error("legacy evidence Activity requires a canonical artifact reference");
    }
    return new FlowActivity({
      id: `legacy-evidence-${this.digest()}`,
      nodeId: node.id,
      nodeKey: node.key,
      attemptId: null,
      sequence: null,
      confirmationOrder,
      type: "note_recorded",
      transition: {
        operation: "record_note",
        nodeId: node.id,
        task: null,
        attempt: null,
        status: null,
        policy: null,
        outbox: null,
        approval: null,
        nonblocking: null,
        finalizeSteps: null,
      },
      result: null,
      timing: { startedAt: this.timestamp, finishedAt: this.timestamp, durationMs: 0 },
      failure: null,
      provider: null,
      model: null,
      effort: null,
      usage: null,
      references: {
        evaluations: [],
        findings: [],
        repairs: [],
        artifacts: [{ id: artifactReference, label: `Imported direct legacy evidence from ${this.sourcePath}${this.pointer}` }],
      },
      metric: null,
      note: { text: this.note },
      reviewPublication: null,
    });
  }
}

/** One owner-bound immutable evidence file paired with its ledger Activity. */
export class LegacyActivityEvidence {
  constructor({ observation, activity, artifact } = {}) {
    if (!(observation instanceof LegacyEvidenceObservation) || !(activity instanceof FlowActivity)
      || !(artifact instanceof FlowArtifactActivityEvidence)) {
      throw new Error("legacy Activity evidence requires a typed observation, Activity, and artifact");
    }
    if (observation.nodeId !== activity.nodeId) {
      throw new Error("legacy Activity evidence observation must retain its Activity owner");
    }
    if (artifact.owner.nodeId !== activity.nodeId) {
      throw new Error("legacy Activity evidence artifact must retain its Activity owner");
    }
    this.observation = observation;
    this.activity = activity;
    this.artifact = artifact;
    this.document = new FlowArtifactActivityEvidenceDocument({
      schemaRevision: 1,
      activityId: activity.id,
      owner: { nodeId: activity.nodeId, nodeKey: activity.nodeKey },
      observedAt: observation.timestamp,
      source: { path: observation.sourcePath, pointer: observation.pointer, hash: observation.hash },
      note: observation.note,
    });
    this.write = new CanonicalFlowActivityEvidenceWrite({
      artifact,
      mediaType: "application/json",
      bytes: `${JSON.stringify(this.document.toJSON(), null, 2)}\n`,
    });
    if (this.write.artifact.relativePath !== artifact.relativePath) {
      throw new Error("legacy Activity evidence writer must preserve the typed artifact address");
    }
    const references = activity.references.toJSON().artifacts;
    if (references.length !== 1 || references[0].id !== this.write.artifact.relativePath) {
      throw new Error("legacy Activity evidence must be the exact cataloged Activity reference");
    }
    Object.freeze(this);
  }

  materialize(location, { targetRevision = 1 } = {}) {
    this.write.write(location);
    return FlowArtifactDescriptor.fromFile({ location, ...this.write.publication(this.activity) });
  }

  mapping() {
    return new MigrationMapping({
      classification: "generated",
      destination: this.write.artifact.relativePath,
      reason: "DIRECT_ACTIVITY_EVIDENCE",
      inputs: [this.observation.input()],
    });
  }
}

/** The immutable, contiguous Activity prefix materialized for a legacy Flow. */
export class LegacyEvidenceLedger {
  constructor({ activities, inputs, evidence = [] } = {}) {
    if (!Array.isArray(activities) || activities.some((entry) => !(entry instanceof FlowActivity))) {
      throw new Error("legacy evidence ledger requires typed Activities");
    }
    if (!Array.isArray(inputs) || inputs.some((entry) => !(entry instanceof MigrationInput))) {
      throw new Error("legacy evidence ledger requires typed migration inputs");
    }
    if (activities.length !== inputs.length) throw new Error("legacy evidence ledger inputs must match Activities");
    if (!Array.isArray(evidence) || evidence.some((entry) => !(entry instanceof LegacyActivityEvidence))) {
      throw new Error("legacy evidence ledger requires typed Activity evidence");
    }
    if (evidence.some((entry) => !activities.includes(entry.activity) || !inputs.some((input) => (
      input.source === entry.observation.sourcePath
      && input.pointer === entry.observation.pointer
      && input.hash === entry.observation.hash
    )))) {
      throw new Error("legacy Activity evidence must be represented in its ledger");
    }
    this.activities = Object.freeze([...activities]);
    this.inputs = Object.freeze([...inputs]);
    this.evidence = Object.freeze([...evidence]);
    Object.freeze(this);
  }
}

function taskParentForStateNode(node, nodeId, task = null) {
  const currentTask = node instanceof TaskNode ? node : task;
  if (node.id === nodeId) return currentTask;
  for (const child of node.steps) {
    const found = taskParentForStateNode(child, nodeId, currentTask);
    if (found !== null) return found;
  }
  return null;
}

function taskActivityEvidenceForStateNode(state, node, digest) {
  const task = taskParentForStateNode(state.root, node.id);
  // A current Task leaf is a direct, typed Task child.  Do not infer this
  // ownership from a matching suffix on an unrelated historical Step.
  if (!(task instanceof TaskNode) || !task.steps.includes(node)) return null;
  try {
    return FLOW_ARTIFACT_CONTRACTS.taskActivityEvidence({
      taskId: task.id,
      segment: node.key,
      digest,
    });
  } catch (error) {
    throw new LegacyFlowMigrationError(
      "UNSUPPORTED_DIRECT_EVIDENCE_OWNER",
      `${node.id} is not a canonical Task Activity owner: ${error.message}`,
      { cause: error },
    );
  }
}

function activityEvidenceForStateNode(state, nodeId, digest) {
  const node = state.findNode(nodeId);
  if (node === null) return null;
  // A Flow root and the historical `impl` composite have explicit production
  // owners. Every other direct runtime observation must belong to a concrete
  // leaf rather than silently attach a branch/task fact to another Step.
  if (node.id !== state.root.id && node.id !== "impl" && node.steps.length !== 0) return null;
  const taskArtifact = taskActivityEvidenceForStateNode(state, node, digest);
  if (taskArtifact !== null) return taskArtifact;
  try {
    return FLOW_ARTIFACT_CONTRACTS.activityEvidence({ nodeId, digest });
  } catch (currentError) {
    try {
      return FLOW_ARTIFACT_CONTRACTS.historicalActivityEvidence({ nodeId, digest });
    } catch (historicalError) {
      throw new LegacyFlowMigrationError(
        "UNSUPPORTED_DIRECT_EVIDENCE_OWNER",
        `${nodeId} cannot retain direct evidence as a current or historical owner: ${historicalError.message}`,
        { cause: currentError },
      );
    }
  }
}

function flowEvidenceObservation(source, state, { pointer, timestamp, nodeId = state.root.id, note }) {
  const trusted = trustedTimestamp(timestamp);
  if (trusted === null) return null;
  const artifact = activityEvidenceForStateNode(
    state,
    nodeId,
    sha256(Buffer.from(`flow.json\0${pointer}\0${source.flowHash}`, "utf8")),
  );
  if (artifact === null) return null;
  return new LegacyEvidenceObservation({
    sourcePath: "flow.json",
    pointer,
    hash: source.flowHash,
    timestamp: trusted,
    nodeId,
    note,
  });
}

function flowEvidenceObservations(source, state) {
  const observations = [];
  const add = (options) => {
    const observation = flowEvidenceObservation(source, state, options);
    if (observation !== null) observations.push(observation);
  };
  const { flow } = source;
  if (Array.isArray(flow.stepAttempts)) {
    for (const [index, entry] of flow.stepAttempts.entries()) {
      const detail = detailedStepAttempt(entry);
      if (detail === null) continue;
      const nodeId = stateNodeIdForLegacyStep(state, detail.stepId, detail.taskId);
      if (nodeId === null) continue;
      add({
        pointer: `/stepAttempts/${index}/recordedAt`,
        timestamp: detail.recordedAt,
        nodeId,
        note: "Imported direct legacy Step execution evidence",
      });
    }
  }
  const completion = flow.directCompletionReceipt;
  if (isPlainObject(completion)) {
    add({
      pointer: "/directCompletionReceipt/completedAt",
      timestamp: completion.completedAt,
      nodeId: stateNodeIdForLegacyStep(state, completion.sourceStep) ?? state.root.id,
      note: "Imported direct legacy completion receipt",
    });
  }
  const integration = flow.directIntegrationReceipt;
  if (isPlainObject(integration)) {
    add({
      pointer: "/directIntegrationReceipt/integratedAt",
      timestamp: integration.integratedAt,
      note: "Imported direct legacy integration receipt",
    });
  }
  const reconciliation = flow.directReconcileEvidence;
  if (isPlainObject(reconciliation)) {
    add({
      pointer: "/directReconcileEvidence/observedAt",
      timestamp: reconciliation.observedAt,
      note: "Imported direct legacy reconciliation evidence",
    });
  }
  const recoveryCollections = [
    ["retryRecovery", "entries", "createdAt", "Imported legacy retry recovery evidence"],
    ["reviewRecoveryBaselines", null, "createdAt", "Imported legacy review recovery evidence"],
  ];
  for (const [field, memberField, timestampField, note] of recoveryCollections) {
    const container = memberField === null ? flow[field] : flow[field]?.[memberField];
    if (!Array.isArray(container)) continue;
    for (const [index, entry] of container.entries()) {
      if (!isPlainObject(entry)) continue;
      const prefix = memberField === null ? `/${field}/${index}` : `/${field}/${memberField}/${index}`;
      add({
        pointer: `${prefix}/${timestampField}`,
        timestamp: entry[timestampField],
        nodeId: stateNodeIdForLegacyPhase(state, entry.canonicalPhase ?? entry.phase),
        note,
      });
    }
  }
  if (Array.isArray(flow.canonicalReviewPassRecoveries)) {
    for (const [index, entry] of flow.canonicalReviewPassRecoveries.entries()) {
      if (!isPlainObject(entry)) continue;
      add({
        pointer: `/canonicalReviewPassRecoveries/${index}/recoveredAt`,
        timestamp: entry.recoveredAt,
        nodeId: stateNodeIdForLegacyStep(state, entry.invalidatedDownstreamStep)
          ?? stateNodeIdForLegacyPhase(state, entry.phase),
        note: "Imported canonical legacy review recovery evidence",
      });
    }
  }
  return observations;
}

function completeRuntimeLog(value) {
  if (!isPlainObject(value)
    || typeof value.runId !== "string" || value.runId === ""
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || !Number.isSafeInteger(value.attempt) || value.attempt < 1
    || (typeof value.command !== "string" && !Array.isArray(value.command))
    || (Array.isArray(value.command) && value.command.some((entry) => typeof entry !== "string" || entry === ""))
    || trustedTimestamp(value.startedAt) === null
    || trustedTimestamp(value.endedAt) === null
    || (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode)))) {
    return null;
  }
  return Object.freeze({ endedAt: value.endedAt, attempt: value.attempt });
}

/** One direct legacy retry fact for a canonical leaf cursor. */
export class LegacyAttemptSequenceObservation {
  constructor({ nodeId, pointer, attempt } = {}) {
    if (typeof nodeId !== "string" || nodeId === "") throw new Error("legacy attempt sequence node id is invalid");
    if (typeof pointer !== "string" || !pointer.startsWith("/")) throw new Error("legacy attempt sequence pointer is invalid");
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("legacy attempt sequence value is invalid");
    this.nodeId = nodeId;
    this.pointer = pointer;
    this.attempt = attempt;
    Object.freeze(this);
  }
}

/**
 * Immutable direct retry evidence.  It records only the maximum observed
 * sequence for each canonical leaf; observations never become fabricated
 * current Attempts or synthetic retry Activities.
 */
export class LegacyAttemptSequenceEvidence {
  #maximumByNode;

  constructor({ observations } = {}) {
    if (!Array.isArray(observations) || observations.some((entry) => !(entry instanceof LegacyAttemptSequenceObservation))) {
      throw new Error("legacy attempt sequence evidence requires typed observations");
    }
    this.observations = Object.freeze([...observations]);
    this.convertedPointers = Object.freeze([...new Set(observations.map((entry) => entry.pointer))].sort(codeUnitOrder));
    this.#maximumByNode = new Map();
    for (const observation of observations) {
      const prior = this.#maximumByNode.get(observation.nodeId) ?? 0;
      this.#maximumByNode.set(observation.nodeId, Math.max(prior, observation.attempt));
    }
    Object.freeze(this);
  }

  static from(source, state) {
    if (!(source instanceof LegacyFlowSource) || !(state instanceof CurrentFlowState)) {
      throw new Error("legacy attempt sequence evidence requires a source and state");
    }
    const observations = [];
    const add = (nodeId, pointer, attempt) => {
      const node = state.findNode(nodeId);
      // Only leaf Step evidence has a production Attempt cursor. Branch and
      // aggregate facts stay retained evidence rather than inventing state.
      if (node === null || node.steps.length !== 0) return;
      observations.push(new LegacyAttemptSequenceObservation({ nodeId, pointer, attempt }));
    };
    if (Array.isArray(source.flow.stepAttempts)) {
      for (const [index, entry] of source.flow.stepAttempts.entries()) {
        const detail = detailedStepAttempt(entry);
        if (detail === null) continue;
        const nodeId = stateNodeIdForLegacyStep(state, detail.stepId, detail.taskId);
        if (nodeId !== null) add(nodeId, `/stepAttempts/${index}/attempt`, detail.attempt);
      }
    }
    visitLegacyFlowNodes(source, state, ({ node, pointer, nodeId }) => {
      if (!Object.hasOwn(node, "runtimeLog") || nodeId === null) return;
      const runtime = completeRuntimeLog(node.runtimeLog);
      if (runtime !== null) add(nodeId, `${pointer}/runtimeLog/attempt`, runtime.attempt);
    });
    return new LegacyAttemptSequenceEvidence({ observations });
  }

  sequenceFor(nodeId) {
    if (typeof nodeId !== "string" || nodeId === "") throw new Error("legacy attempt sequence node id is invalid");
    return this.#maximumByNode.get(nodeId) ?? 0;
  }
}

/** Runtime-log observations and their exact converted source fields. */
export class LegacyRuntimeLogEvidence {
  constructor({ observations, convertedPointers } = {}) {
    if (!Array.isArray(observations) || observations.some((entry) => !(entry instanceof LegacyEvidenceObservation))) {
      throw new Error("legacy runtime log evidence requires typed observations");
    }
    if (!(convertedPointers instanceof Set) || [...convertedPointers].some((entry) => typeof entry !== "string" || !entry.startsWith("/"))) {
      throw new Error("legacy runtime log evidence requires JSON Pointer fields");
    }
    this.observations = Object.freeze([...observations]);
    this.convertedPointers = Object.freeze([...convertedPointers].sort(codeUnitOrder));
    Object.freeze(this);
  }
}

function runtimeLogEvidence(source, state) {
  const observations = [];
  const convertedPointers = new Set();
  visitLegacyFlowNodes(source, state, ({ node, pointer, nodeId }) => {
    const fieldPointer = `${pointer}/runtimeLog`;
    if (Object.hasOwn(node, "runtimeLog")) {
      const runtime = completeRuntimeLog(node.runtimeLog);
      if (runtime !== null && nodeId !== null) {
        const observation = flowEvidenceObservation(source, state, {
          pointer: `${fieldPointer}/endedAt`,
          timestamp: runtime.endedAt,
          nodeId,
          note: "Imported direct legacy runtime execution evidence",
        });
        if (observation !== null) {
          observations.push(observation);
          convertedPointers.add(`${fieldPointer}/endedAt`);
        }
      }
    }
  });
  return new LegacyRuntimeLogEvidence({ observations, convertedPointers });
}

function reviewEvidenceObservations(source, state, decisions) {
  const observations = [];
  for (const decision of decisions.filter((entry) => entry.resolved?.logicalKey === "review.evidence")) {
    const file = source.files.find((entry) => entry.sourcePath === decision.sourcePath);
    const value = parseObject(captureRegularFile(file.absolute, MIGRATION_READ_OPTIONS).bytes, file.sourcePath);
    const owner = reviewOwnerForLegacyEvidence(value, file.sourcePath, source);
    const nodeId = owner.taskId === null ? owner.reviewStep : `${owner.taskId}-review`;
    if (state.findNode(nodeId) === null) continue;
    const timestamp = trustedTimestamp(value.provenance?.capturedAt);
    if (timestamp === null) continue;
    observations.push(new LegacyEvidenceObservation({
      sourcePath: file.sourcePath,
      pointer: "/provenance/capturedAt",
      hash: file.hash,
      timestamp,
      nodeId,
      artifactReference: decision.destination,
      note: `Imported direct legacy review evidence from ${file.sourcePath}`,
    }));
  }
  return observations;
}

function directEvidenceActivities(source, state, decisions, runtimeEvidence) {
  if (!(runtimeEvidence instanceof LegacyRuntimeLogEvidence)) {
    throw new Error("direct evidence activities require typed runtime-log evidence");
  }
  const activities = [];
  const inputs = [];
  const evidence = [];
  if (state.history.creation.status === "available") {
    const creationSource = state.history.creation.source;
    const observation = new LegacyEvidenceObservation({
      sourcePath: creationSource.path,
      pointer: creationSource.pointer,
      hash: creationSource.hash,
      timestamp: creationSource.timestamp,
      nodeId: state.root.id,
      note: "Imported trusted legacy Flow creation provenance",
    });
    const artifact = activityEvidenceForStateNode(state, state.root.id, observation.digest());
    if (artifact === null) throw new Error("trusted Flow creation must have a typed root Activity evidence owner");
    const created = FlowActivity.flowCreated(state, creationSource.timestamp, {
      artifactReferences: [{
        id: artifact.relativePath,
        label: `Imported trusted Flow creation provenance from ${observation.sourcePath}${observation.pointer}`,
      }],
    });
    const materialization = new LegacyActivityEvidence({ observation, activity: created, artifact });
    activities.push(created);
    inputs.push(observation.input());
    evidence.push(materialization);
  }
  const observations = [
    ...flowEvidenceObservations(source, state),
    ...runtimeEvidence.observations,
    ...reviewEvidenceObservations(source, state, decisions),
  ]
    .sort(LegacyEvidenceObservation.compare);
  const identities = new Set();
  for (const observation of observations) {
    const identity = `${observation.sourcePath}\0${observation.pointer}`;
    if (identities.has(identity)) throw new Error("legacy direct evidence duplicates one source pointer");
    identities.add(identity);
    const artifact = observation.artifactReference === null
      ? activityEvidenceForStateNode(state, observation.nodeId, observation.digest())
      : null;
    if (observation.artifactReference === null && artifact === null) {
      throw new Error("direct legacy evidence observation lost its typed owner before materialization");
    }
    const artifactReference = observation.artifactReference ?? artifact.relativePath;
    const activity = observation.activity(state, activities.length + 1, artifactReference);
    activities.push(activity);
    inputs.push(observation.input());
    if (observation.artifactReference === null) {
      evidence.push(new LegacyActivityEvidence({ observation, activity, artifact }));
    }
  }
  return new LegacyEvidenceLedger({ activities, inputs, evidence });
}

function pointerFor(parent, key) {
  return `${parent}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function sourceMapping(classification, pointer, destination, reason) {
  return new MigrationMapping({ classification, source: "flow.json", pointer, destination, reason });
}

function preservedValueMappings(
  value,
  pointer,
  reason = "NO_CANONICAL_TARGET",
  evidencePointers = new Set(),
  attemptPointers = new Set(),
) {
  if (Array.isArray(value)) {
    if (value.length === 0) return [sourceMapping("preserved", pointer, "artifacts/migration/flow.legacy.json", reason)];
    return value.flatMap((entry, index) => preservedValueMappings(
      entry,
      pointerFor(pointer, index),
      reason,
      evidencePointers,
      attemptPointers,
    ));
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort(codeUnitOrder);
    if (keys.length === 0) return [sourceMapping("preserved", pointer, "artifacts/migration/flow.legacy.json", reason)];
    return keys.flatMap((key) => preservedValueMappings(
      value[key],
      pointerFor(pointer, key),
      reason,
      evidencePointers,
      attemptPointers,
    ));
  }
  if (attemptPointers.has(pointer)) {
    return [sourceMapping("converted", pointer, "flow.json", "DIRECT_ATTEMPT_SEQUENCE_EVIDENCE")];
  }
  if (evidencePointers.has(pointer)) {
    return [sourceMapping("converted", pointer, "activities.jsonl", "DIRECT_LEGACY_EVIDENCE_ACTIVITY")];
  }
  return [sourceMapping("preserved", pointer, "artifacts/migration/flow.legacy.json", reason)];
}

function historicalNodeMappings(node, pointer, runtimeLogPointers, taskSpecPointers, evidencePointers, attemptPointers) {
  const mappings = [];
  for (const field of Object.keys(node).sort(codeUnitOrder)) {
    const fieldPointer = pointerFor(pointer, field);
    if (taskSpecPointers.has(fieldPointer) && field !== "id") {
      mappings.push(sourceMapping("converted", fieldPointer, "spec.json", "CANONICAL_TASK_SPEC_RECORD"));
      continue;
    }
    if (["id", "status", "result"].includes(field)) {
      mappings.push(sourceMapping("converted", fieldPointer, "flow.json", "CANONICAL_HISTORICAL_FLOW_STATE"));
      continue;
    }
    if (field === "runtimeLog") {
      const observedAt = `${fieldPointer}/endedAt`;
      const observedAttempt = `${fieldPointer}/attempt`;
      if (runtimeLogPointers.has(observedAt) || attemptPointers.has(observedAttempt)) {
        mappings.push(...preservedValueMappings(
          node[field],
          fieldPointer,
          "DIRECT_RUNTIME_LOG_AUXILIARY_FACT",
          evidencePointers,
          attemptPointers,
        ));
      } else {
        mappings.push(sourceMapping(
          "preserved",
          fieldPointer,
          "artifacts/migration/flow.legacy.json",
          "INSUFFICIENT_EVENT_DETAIL",
        ));
      }
      continue;
    }
    if (field === "children" || field === "steps") {
      const children = node[field];
      if (children.length === 0) {
        mappings.push(sourceMapping("converted", fieldPointer, "flow.json", "CANONICAL_HISTORICAL_FLOW_STATE"));
      } else {
        children.forEach((child, index) => mappings.push(...historicalNodeMappings(
          child,
          pointerFor(fieldPointer, index),
          runtimeLogPointers,
          taskSpecPointers,
          evidencePointers,
          attemptPointers,
        )));
      }
      continue;
    }
    mappings.push(...preservedValueMappings(node[field], fieldPointer));
  }
  return mappings;
}

function durableFinalizationAuthority(flow) {
  return flow.state?.finalizedAt != null || flow.status === "archived" || flow.status === "finalized";
}

function historicalFlowMappings(source, state, runtimeEvidence, taskSpecPointers, evidencePointers, attemptPointers) {
  const mappings = [];
  const convertedTopLevel = new Set([
    "flowId", "flowVersionId", "runId", "specId", "issue", "request", "baseBranch", "featureBranch", "worktree",
    "autoApprove", "nonblocking", "status", "currentTaskId",
  ]);
  const runtimeLogPointers = new Set(runtimeEvidence.convertedPointers);
  const creationPointer = state.history.creation.status === "available" ? state.history.creation.source.pointer : null;
  for (const field of Object.keys(source.flow).sort(codeUnitOrder)) {
    const pointer = pointerFor("", field);
    const value = source.flow[field];
    if (field === "steps") {
      if (value.length === 0) mappings.push(sourceMapping("converted", pointer, "flow.json", "CANONICAL_HISTORICAL_FLOW_STATE"));
      else value.forEach((node, index) => mappings.push(...historicalNodeMappings(
        node,
        pointerFor(pointer, index),
        runtimeLogPointers,
        taskSpecPointers,
        evidencePointers,
        attemptPointers,
      )));
      continue;
    }
    if (field === "tasks") {
      if (value.length === 0) mappings.push(sourceMapping("converted", pointer, "flow.json", "CANONICAL_HISTORICAL_FLOW_STATE"));
      else value.forEach((node, index) => mappings.push(...historicalNodeMappings(
        node,
        pointerFor(pointer, index),
        runtimeLogPointers,
        taskSpecPointers,
        evidencePointers,
        attemptPointers,
      )));
      continue;
    }
    if (field === "lifecycle") {
      const explicit = isPlainObject(value) ? value.state : value;
      const overridden = durableFinalizationAuthority(source.flow) && lifecycleFor(source.flow).state === "finalized" && explicit !== "finalized";
      mappings.push(sourceMapping(
        overridden ? "preserved" : "converted",
        pointer,
        overridden ? "artifacts/migration/flow.legacy.json" : "flow.json",
        overridden ? "SUPERSEDED_BY_DURABLE_FINALIZATION" : "CANONICAL_HISTORICAL_FLOW_STATE",
      ));
      continue;
    }
    if (field === "currentTaskId" && durableFinalizationAuthority(source.flow)) {
      mappings.push(sourceMapping("preserved", pointer, "artifacts/migration/flow.legacy.json", "SUPERSEDED_BY_DURABLE_FINALIZATION"));
      continue;
    }
    if (field === "createdAt") {
      mappings.push(sourceMapping(
        creationPointer === pointer ? "converted" : "preserved",
        pointer,
        creationPointer === pointer ? "activities.jsonl" : "artifacts/migration/flow.legacy.json",
        creationPointer === pointer ? "FLOW_CREATION_ACTIVITY" : "NO_TRUSTED_CREATION_EVIDENCE",
      ));
      continue;
    }
    if (field === "state") {
      const keys = Object.keys(value).sort(codeUnitOrder);
      if (keys.length === 0) {
        mappings.push(sourceMapping("preserved", pointer, "artifacts/migration/flow.legacy.json", "NO_CANONICAL_TARGET"));
      }
      for (const key of keys) {
        const childPointer = pointerFor(pointer, key);
        if (key === "finalizedAt" && durableFinalizationAuthority(source.flow)) {
          mappings.push(sourceMapping("converted", childPointer, "flow.json", "DURABLE_FINALIZATION_AUTHORITY"));
        } else if (creationPointer === childPointer) {
          mappings.push(sourceMapping("converted", childPointer, "activities.jsonl", "FLOW_CREATION_ACTIVITY"));
        } else {
          mappings.push(...preservedValueMappings(value[key], childPointer, "NO_CANONICAL_TARGET", evidencePointers, attemptPointers));
        }
      }
      continue;
    }
    if (convertedTopLevel.has(field)) {
      mappings.push(sourceMapping("converted", pointer, "flow.json", "CANONICAL_HISTORICAL_FLOW_STATE"));
      continue;
    }
    mappings.push(...preservedValueMappings(value, pointer, "NO_CANONICAL_TARGET", evidencePointers, attemptPointers));
  }
  return mappings;
}

function atomicPointerEntries(value, pointer = "") {
  if (Array.isArray(value)) {
    if (value.length === 0) return [pointer];
    return value.flatMap((entry, index) => atomicPointerEntries(entry, pointerFor(pointer, index)));
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort(codeUnitOrder);
    if (keys.length === 0) return [pointer];
    return keys.flatMap((key) => atomicPointerEntries(value[key], pointerFor(pointer, key)));
  }
  return [pointer];
}

/**
 * Verifies recursively that every legacy Flow value has one explicit report
 * classification. Compound canonical values such as a typed NodeResult may
 * be represented by their parent pointer; unrelated values never inherit the
 * raw-flow snapshot's generated mapping.
 */
export class LegacyFlowFieldManifest {
  constructor({ flow, mappings } = {}) {
    if (!isPlainObject(flow)) throw new Error("legacy Flow field manifest requires a Flow object");
    if (!Array.isArray(mappings) || mappings.some((entry) => !(entry instanceof MigrationMapping))) {
      throw new Error("legacy Flow field manifest requires typed mappings");
    }
    const mappingsByPointer = new Map();
    for (const mapping of mappings) {
      if (mapping.source !== "flow.json" || mapping.pointer === null) continue;
      const entries = mappingsByPointer.get(mapping.pointer) ?? [];
      entries.push(mapping);
      mappingsByPointer.set(mapping.pointer, entries);
    }
    const classificationsFor = (pointer) => {
      const covering = [];
      let ancestor = pointer;
      while (true) {
        covering.push(...(mappingsByPointer.get(ancestor) ?? []));
        if (ancestor === "") return covering;
        ancestor = ancestor.slice(0, ancestor.lastIndexOf("/"));
      }
    };
    const pointers = atomicPointerEntries(flow).sort(codeUnitOrder);
    const entries = pointers.map((pointer) => {
      const covering = classificationsFor(pointer);
      if (covering.length !== 1) {
        throw new Error(`legacy Flow field ${pointer || "<root>"} has ${covering.length} migration classifications`);
      }
      return Object.freeze({ pointer, classification: covering[0].classification });
    });
    this.entries = Object.freeze(entries);
    Object.freeze(this);
  }

  toJSON() {
    return this.entries.map((entry) => ({ ...entry }));
  }

  summary() {
    const classifications = Object.fromEntries([
      "converted", "preserved", "omitted", "relocatedTransient", "missingTransient",
    ].map((classification) => [classification, 0]));
    for (const entry of this.entries) classifications[entry.classification] += 1;
    return Object.freeze({
      atomicPointers: this.entries.length,
      classifications: Object.freeze(classifications),
      unclassified: 0,
    });
  }
}

/** Semantic family classifier. It intentionally ignores optional key signatures. */
export class LegacyFlowFormat {
  constructor(flow) {
    if (!isPlainObject(flow)) throw new Error("legacy flow must be an object");
    if (!Array.isArray(flow.tasks) || (flow.steps !== undefined && !Array.isArray(flow.steps))) {
      throw new Error("legacy flow does not have a recognized tasks/steps family");
    }
    const steps = flow.steps ?? [];
    const nested = steps.some((step) => isPlainObject(step) && (Array.isArray(step.children) || Array.isArray(step.steps)));
    const taskOnly = steps.length === 0 && flow.tasks.length > 0;
    this.family = taskOnly ? "task-only" : nested ? "nested-steps" : "flat-steps";
    this.hasRunIdentity = flow.runId !== undefined && flow.runId !== null;
    Object.freeze(this);
  }

  toJSON() { return { family: this.family, hasRunIdentity: this.hasRunIdentity }; }
}

/** A preflighted legacy source tree. */
export class LegacyFlowSource {
  constructor({ directory, specId, flow, flowBytes, spec, specBytes, files, directoryIdentity: sourceDirectoryIdentity, treeHash } = {}) {
    this.directory = path.resolve(directory);
    this.specId = FlowSpecIdentity.from(specId).toString();
    if (!isPlainObject(flow) || !Buffer.isBuffer(flowBytes) || !isPlainObject(spec) || !Buffer.isBuffer(specBytes)) {
      throw new Error("legacy Flow source requires parsed flow/spec authorities and bytes");
    }
    if (!Array.isArray(files)) throw new Error("legacy Flow source files must be an array");
    new LogicalPathSet(files.map((file) => file.sourcePath));
    FileIdentity.fromStored(sourceDirectoryIdentity);
    if (typeof treeHash !== "string" || !/^[a-f0-9]{64}$/.test(treeHash)) throw new Error("legacy Flow source requires a tree hash");
    this.flow = Object.freeze(structuredClone(flow));
    this.flowBytes = Buffer.from(flowBytes);
    this.spec = Object.freeze(structuredClone(spec));
    this.specBytes = Buffer.from(specBytes);
    this.files = Object.freeze([...files]);
    this.directoryIdentity = Object.freeze({ ...sourceDirectoryIdentity });
    this.treeHash = treeHash;
    this.flowHash = sha256(this.flowBytes);
    this.format = new LegacyFlowFormat(this.flow);
    Object.freeze(this);
  }

  static inspect(directory, specId) {
    assertRealDirectory(directory, "legacy spec root");
    const files = [];
    const visit = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        const relative = normalizedRelative(path.relative(directory, absolute).split(path.sep).join("/"), "legacy source path");
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new LegacyFlowMigrationError("UNSAFE_SOURCE_ENTRY", `legacy source contains a symbolic link: ${relative}`);
        if (stat.isDirectory()) {
          visit(absolute);
          continue;
        }
        if (!stat.isFile() || stat.nlink !== 1) throw new LegacyFlowMigrationError("UNSAFE_SOURCE_ENTRY", `legacy source contains an unsafe entry: ${relative}`);
        if (!isKnownLegacyArtifact(relative)) {
          const bytes = captureRegularFile(absolute, MIGRATION_READ_OPTIONS).bytes;
          throw new LegacyFlowMigrationError(
            "UNKNOWN_ARTIFACT",
            `unknown legacy artifact: ${relative} (shape fingerprint: ${artifactFingerprint(bytes)})`,
          );
        }
        files.push(fileSnapshot(absolute, relative));
      }
    };
    visit(directory);
    files.sort((left, right) => codeUnitOrder(left.sourcePath, right.sourcePath));
    const flowEntry = files.find((entry) => entry.sourcePath === "flow.json");
    const specEntry = files.find((entry) => entry.sourcePath === "spec.json");
    if (!flowEntry) throw new LegacyFlowMigrationError("MISSING_FLOW_AUTHORITY", "legacy Flow requires a regular flow.json authority");
    if (!specEntry) throw new LegacyFlowMigrationError("MISSING_SPEC_AUTHORITY", "legacy Flow requires a regular spec.json authority");
    const flowBytes = captureRegularFile(flowEntry.absolute, MIGRATION_READ_OPTIONS).bytes;
    const specBytes = captureRegularFile(specEntry.absolute, MIGRATION_READ_OPTIONS).bytes;
    return new LegacyFlowSource({
      directory,
      specId,
      flow: parseObject(flowBytes, "flow.json"),
      flowBytes,
      spec: parseObject(specBytes, "spec.json"),
      specBytes,
      files,
      directoryIdentity: directoryIdentity(directory, "legacy spec root"),
      treeHash: treeFingerprint(directory),
    });
  }

  assertUnchanged({ directory = this.directory, ignoredNames = [], expectedIdentity = this.directoryIdentity } = {}) {
    const resolved = path.resolve(directory);
    if (!sameDirectoryIdentity(resolved, expectedIdentity, "legacy source root")) {
      throw new LegacyFlowMigrationError("SOURCE_CHANGED", "legacy source directory identity changed before migration swap");
    }
    const currentHash = treeFingerprint(resolved, { ignoredNames });
    if (currentHash !== this.treeHash) {
      throw new LegacyFlowMigrationError("SOURCE_CHANGED", "legacy source entries or bytes changed before migration swap");
    }
    for (const file of this.files) {
      try {
        captureRegularFile(path.join(resolved, ...file.sourcePath.split("/")), {
          ...MIGRATION_READ_OPTIONS, requireSingleLink: true, expectedIdentity: file.generation,
        });
      } catch (cause) {
        throw new LegacyFlowMigrationError("SOURCE_CHANGED", `legacy source file generation changed: ${file.sourcePath}`);
      }
    }
    return this;
  }
}

/**
 * The one raw authority whose byte representation remains evidence after a
 * Specs migration.  The canonical spec record preserves every spec field, so
 * it deliberately has no parallel raw snapshot.
 */
export class LegacyFlowAuthoritySnapshot {
  constructor(source) {
    if (!(source instanceof LegacyFlowSource)) throw new Error("legacy Flow authority snapshot requires a legacy source");
    const file = source.files.find((entry) => entry.sourcePath === "flow.json");
    if (file === undefined) throw new Error("legacy Flow authority snapshot requires flow.json");
    this.file = file;
    this.destination = "artifacts/migration/flow.legacy.json";
    Object.freeze(this);
  }

  input() {
    return new MigrationInput({ source: this.file.sourcePath, pointer: "", hash: this.file.hash });
  }

  materialize(location, { targetRevision = 1 } = {}) {
    const target = location.resolve(this.destination);
    copyFile(this.file.absolute, target);
    return FlowArtifactDescriptor.fromFile({
      location,
      authoritySlot: migrationSlot(this.file.sourcePath),
      relativePath: this.destination,
      mediaType: mediaTypeFor(this.file.sourcePath),
      retention: "permanent",
      migrationMaterialization: true,
    });
  }
}

function copyCanonicalTree(source, destination) {
  assertRealDirectory(source, "canonical Version source");
  RealDirectoryAuthority.resolve(path.dirname(destination)).createExclusiveChild(path.basename(destination), { creationMode: 0o755 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) throw new Error(`canonical Version source contains a symbolic link: ${entry.name}`);
    if (stat.isDirectory()) {
      copyCanonicalTree(sourcePath, destinationPath);
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`canonical Version source contains an unsafe entry: ${entry.name}`);
    copyFile(sourcePath, destinationPath);
  }
}

function revisionDescriptorForBytes(logicalKey, parameters, bytes) {
  const artifact = FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, parameters);
  return new FlowArtifactDescriptor({
    ...artifact.publication({ mediaType: "application/json" }),
    hash: sha256(bytes),
    size: bytes.length,
  });
}

const LEGACY_SPEC_REVIEW_PATHS = Object.freeze(new Map([
  ["spec-review", Object.freeze(["spec-review.json", "steps/spec-review/result.json"])],
  ["spec-triage", Object.freeze(["spec-triage.json", "steps/spec-triage/result.json"])],
  ["spec-repair", Object.freeze(["spec-repair.json", "steps/spec-repair/result.json"])],
]));

function legacySpecReviewPaths(directory) {
  const selected = new Map();
  for (const [stage, candidates] of LEGACY_SPEC_REVIEW_PATHS) {
    const present = candidates.filter((sourcePath) => fs.existsSync(path.join(directory, sourcePath)));
    if (present.length > 1) {
      throw new LegacyFlowMigrationError("AMBIGUOUS_LEGACY_SPEC_REVIEW", `historical ${stage} has multiple artifact paths`);
    }
    if (present.length === 1) selected.set(stage, present[0]);
  }
  return selected;
}

function legacySpecReviewPathsFromFiles(files) {
  const names = new Set(files.map((file) => file.sourcePath));
  const selected = [];
  for (const candidates of LEGACY_SPEC_REVIEW_PATHS.values()) {
    for (const sourcePath of candidates) if (names.has(sourcePath)) selected.push(sourcePath);
  }
  return Object.freeze(selected.sort(codeUnitOrder));
}

function canonicalReviewValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalReviewValue).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort(codeUnitOrder).map((key) => `${JSON.stringify(key)}:${canonicalReviewValue(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function collectRegularFiles(directory, relative = "", files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const sourcePath = relative === "" ? entry.name : `${relative}/${entry.name}`;
    const stat = fs.lstatSync(absolute);
    if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
      throw new LegacyFlowMigrationError("UNSAFE_VERSION_TARGET", `historical Version contains a symbolic link: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      if (sourcePath === ".runtime") continue;
      collectRegularFiles(absolute, sourcePath, files);
      continue;
    }
    if (!entry.isFile() || stat.nlink !== 1) {
      throw new LegacyFlowMigrationError("UNSAFE_VERSION_TARGET", `historical Version contains an unsafe entry: ${sourcePath}`);
    }
    files.push(sourcePath);
  }
  return files.sort(codeUnitOrder);
}

function legacyActivityLedger(file) {
  try { return new LegacyFlowActivityLedger(captureRegularFile(file, MIGRATION_READ_OPTIONS).bytes); }
  catch (cause) {
    throw new LegacyFlowMigrationError("INVALID_ACTIVITY_LEDGER", `historical activities.jsonl is invalid: ${cause.message}`);
  }
}

/** Migration-only proof/conversion for retired independent Spec review files.
 * Runtime never reads these paths. A chain is accepted only when every
 * source artifact is descriptor-bound, carries the immutable Spec identity,
 * and its digest links to the prior canonical review generation. */
class LegacySpecReviewConversion {
  constructor({ directory, specId, specBytes, descriptors, activities = new Map(), lifecycle }) {
    this.directory = directory;
    this.specId = specId;
    this.specBytes = Buffer.from(specBytes);
    this.descriptors = descriptors;
    this.activities = activities;
    this.lifecycle = lifecycle;
    const selected = legacySpecReviewPaths(directory);
    this.selected = selected;
    this.legacyPaths = Object.freeze([...selected.values()].sort(codeUnitOrder));
    this.review = this.#convert();
    this.classification = this.legacyPaths.length === 0 ? "absent" : "proven-converted";
    Object.freeze(this);
  }

  #descriptor(sourcePath, stage) {
    const descriptor = this.descriptors.get(sourcePath) ?? null;
    if (descriptor === null) {
      throw new LegacyFlowMigrationError("UNBOUND_LEGACY_SPEC_REVIEW", `historical review artifact is absent from catalog: ${sourcePath}`);
    }
    const bytes = captureRegularFile(path.join(this.directory, sourcePath), MIGRATION_READ_OPTIONS).bytes;
    if (descriptor.hash !== sha256(bytes) || descriptor.size !== bytes.length) {
      throw new LegacyFlowMigrationError("STALE_LEGACY_SPEC_REVIEW", `historical review artifact does not match its catalog descriptor: ${sourcePath}`);
    }
    if (descriptor.activityId == null && descriptor.migrationMaterialization !== true) {
      throw new LegacyFlowMigrationError("UNBOUND_LEGACY_SPEC_REVIEW", `historical review artifact has no Activity or migration-materialization provenance: ${sourcePath}`);
    }
    if (descriptor.activityId != null) {
      const activity = this.activities.get(descriptor.activityId) ?? null;
      if (activity === null
        || activity.nodeId !== stage
        || activity.type !== "result_confirmed"
        || activity.transition?.operation !== "confirm_attempt"
        || (descriptor.publicationStep !== undefined && descriptor.publicationStep !== stage)) {
        throw new LegacyFlowMigrationError(
          "UNBOUND_LEGACY_SPEC_REVIEW",
          `historical review artifact Activity provenance is not a confirmed ${stage} publication: ${sourcePath}`,
        );
      }
    }
    return bytes;
  }

  #convert() {
    if (this.legacyPaths.length === 0) return null;
    const ordered = ["spec-review", "spec-triage", "spec-repair"];
    const positions = ordered.map((stage) => this.selected.has(stage));
    if ((positions[1] && !positions[0]) || (positions[2] && !positions[1])) {
      throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW_ORDER", "historical spec review chain has a missing predecessor");
    }
    let current = initialCanonicalSpecReview({ specId: this.specId, revision: 1, bytes: this.specBytes });
    const documents = new Map();
    for (const stage of ordered) {
      const sourcePath = this.selected.get(stage);
      if (sourcePath === undefined) continue;
      documents.set(stage, parseObject(this.#descriptor(sourcePath, stage), `historical ${sourcePath}`));
    }
    const first = documents.get("spec-review") ?? null;
    if (first !== null && first.version === 1 && first.phase === "spec") {
      return this.#convertV1(documents, current);
    }
    for (const stage of ordered) {
      const sourcePath = this.selected.get(stage);
      if (sourcePath === undefined) continue;
      let delta;
      try { delta = new SpecReviewDelta(documents.get(stage)); } catch (cause) {
        throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", `${sourcePath} cannot be proven as an immutable-input-bound delta: ${cause.message}`);
      }
      if (delta.stage !== stage
        || delta.identity.specId !== this.specId
        || delta.identity.revision.value !== 1
        || delta.identity.digest !== sha256(this.specBytes)
        || delta.identity.byteLength !== this.specBytes.length
        || delta.baseReviewDigest !== current.digest) {
        throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", `${sourcePath} does not bind the current immutable Spec and prior review digest`);
      }
      if (stage === "spec-triage") {
        for (const update of delta.findings.findings) {
          try {
            validateSpecRepairTriageFinding(update.toJSON(), parseObject(this.specBytes, "historical immutable Spec"));
          } catch (cause) {
            throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", `${sourcePath} contains an invalid triage permission: ${cause.message}`);
          }
        }
      }
      if (stage === "spec-repair" && (delta.operations.length > 0 || delta.scopeExpansions.length > 0)) {
        throw new LegacyFlowMigrationError(
          "UNPROVABLE_LEGACY_SPEC_REVIEW",
          `${sourcePath} contains raw repair proposals without a command-owned application proof`,
        );
      }
      try { current = mergeSpecReviewDelta({ review: current, delta }); } catch (cause) {
        throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", `${sourcePath} cannot be merged as a canonical review delta: ${cause.message}`);
      }
    }
    return current;
  }

  #convertV1(documents, current) {
    const review = documents.get("spec-review");
    if (!Array.isArray(review.blockingFindings) || !Array.isArray(review.nonBlockingImprovements)
      || !["PASS", "REJECTED", "ADVISORY"].includes(review.verdict)) {
      throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", "spec-review.json does not have the genuine V1 review schema");
    }
    const legacyFindings = [...review.blockingFindings, ...review.nonBlockingImprovements];
    const findingIds = new Set();
    const text = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : null;
    const findings = legacyFindings.map((finding, index) => {
      if (!isPlainObject(finding) || !text(finding.findingId) || findingIds.has(finding.findingId)) {
        throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", `spec-review.json finding ${index} lacks a unique stable findingId`);
      }
      findingIds.add(finding.findingId);
      const kind = finding.kind;
      const common = {
        findingId: finding.findingId,
        kind,
        title: text(finding.title),
        target: text(finding.target),
        body: text(finding.body),
      };
      if (Object.values(common).some((value) => value === null)) {
        throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", `spec-review.json finding ${finding.findingId} lacks immutable finding fields`);
      }
      if (kind === "blocking") {
        const blocking = {
          ...common,
          issue: text(finding.issue),
          requiredChange: text(finding.requiredChange),
          whyBlocking: text(finding.whyBlocking),
        };
        if ([blocking.issue, blocking.requiredChange, blocking.whyBlocking].some((value) => value === null)) {
          throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", `spec-review.json blocking finding ${finding.findingId} lacks canonical proof fields`);
        }
        return blocking;
      }
      if (kind === "improvement") {
        const improvement = { ...common, improvement: text(finding.improvement), whyNonBlocking: text(finding.whyNonBlocking) };
        if (improvement.improvement === null || improvement.whyNonBlocking === null) {
          throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", `spec-review.json improvement ${finding.findingId} lacks canonical proof fields`);
        }
        return improvement;
      }
      throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", `spec-review.json finding ${finding.findingId} has an unknown kind`);
    });
    const reviewDelta = new SpecReviewDelta({
      version: 2,
      stage: "spec-review",
      identity: current.identity.toJSON(),
      baseReviewDigest: current.digest,
      findings,
      operations: [],
    });
    current = mergeSpecReviewDelta({ review: current, delta: reviewDelta });
    const triage = documents.get("spec-triage") ?? null;
    if (triage !== null) {
      if (triage.version !== 1 || triage.phase !== "spec-triage" || triage.sourceReview !== "spec-review.json"
        || !text(triage.summary) || !Array.isArray(triage.items)) {
        throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", "spec-triage.json does not have the genuine V1 triage schema");
      }
      const blocking = new Map(review.blockingFindings.map((finding) => [finding.findingId, finding]));
      if (triage.items.length !== blocking.size) {
        throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", "spec-triage.json does not cover the exact V1 blocking finding set");
      }
      const seen = new Set();
      const immutableSpec = parseObject(this.specBytes, "historical immutable Spec");
      const updates = triage.items.map((item, index) => {
        const prior = blocking.get(item?.findingId);
        if (!isPlainObject(item) || prior === undefined || seen.has(item.findingId)
          || item.title !== prior.title || item.target !== prior.target
          || !["apply", "invalid", "already_resolved", "downgraded_to_non_blocking"].includes(item.decision)
          || !text(item.rationale) || !text(item.evidence)) {
          throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", `spec-triage.json item ${index} is not an exact V1 finding classification`);
        }
        seen.add(item.findingId);
        if (item.decision !== "apply") return { findingId: item.findingId, disposition: item.decision, evidence: item.evidence };
        if (!Array.isArray(item.allowedTargets) || item.allowedTargets.length === 0) {
          throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", `spec-triage.json apply item ${item.findingId} lacks allowedTargets`);
        }
        try {
          validateSpecRepairTriageFinding({
            findingId: item.findingId,
            disposition: "apply",
            evidence: item.evidence,
            allowedTargets: item.allowedTargets,
          }, immutableSpec);
        } catch (cause) {
          throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", `spec-triage.json apply item ${item.findingId} has an invalid permission: ${cause.message}`);
        }
        return {
          findingId: item.findingId,
          disposition: "apply",
          evidence: item.evidence,
          allowedTargets: item.allowedTargets,
        };
      });
      const triageDelta = new SpecReviewDelta({
        version: 2,
        stage: "spec-triage",
        identity: current.identity.toJSON(),
        baseReviewDigest: current.digest,
        findings: updates,
        operations: [],
      });
      current = mergeSpecReviewDelta({ review: current, delta: triageDelta });
    }
      const repair = documents.get("spec-repair") ?? null;
    if (repair !== null) {
      if (repair.version === 2 && repair.phase === "spec-repair") {
        return this.#convertV1RepairAudit({ review, triage, repair, current, text });
      }
      // A V1 worker proposal is not durable evidence of an applied repair.
      // It is safe to retain only an explicitly empty proposal; any proposed
      // operation would otherwise be promoted without the CLI-owned audit
      // that proves its result against the authoritative Spec bytes.
      if (triage === null || repair.version !== 1 || typeof repair.baseRevision !== "string"
        || repair.baseRevision !== `sha256:${sha256(this.specBytes)}` || !Array.isArray(repair.operations)
        || !Array.isArray(repair.scopeExpansions)
        || repair.operations.length !== 0 || repair.scopeExpansions.length !== 0) {
        throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", "spec-repair.json does not bind the immutable V1 Spec revision");
      }
      const repairDelta = new SpecReviewDelta({
        version: 2,
        stage: "spec-repair",
        identity: current.identity.toJSON(),
        baseReviewDigest: current.digest,
        findings: [],
        operations: [],
      });
      current = mergeSpecReviewDelta({
        review: current,
        delta: repairDelta,
        discardedOperations: [],
      });
    }
    return current;
  }

  #convertV1RepairAudit({ review, triage, repair, current, text }) {
    const resultBytes = Buffer.from(JSON.stringify(parseObject(this.specBytes, "historical current spec.json")), "utf8");
    const result = repair.resultRevision;
    if (triage === null || typeof repair.baseRevision !== "string" || !/^sha256:[a-f0-9]{64}$/.test(repair.baseRevision)
      || !isPlainObject(result) || result.digest !== sha256(resultBytes) || result.byteLength !== resultBytes.length
      || !Array.isArray(repair.acceptedOperations) || !Array.isArray(repair.discardedOperations)
      || !Array.isArray(repair.appliedFindings) || !Array.isArray(repair.scopeExpansions)
      || repair.scopeExpansions.length !== 0
      || repair.operationDigest !== sha256(Buffer.from(JSON.stringify({
        acceptedOperations: repair.acceptedOperations,
        discardedOperations: repair.discardedOperations,
      }), "utf8"))) {
      throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", "spec-repair result.json does not bind the immutable current Spec revision");
    }
    const accepted = repair.acceptedOperations.map((entry, index) => {
      const operation = isPlainObject(entry?.operation) ? entry.operation : entry;
      if (!isPlainObject(operation) || !text(operation.findingId) || !text(operation.kind) || !isPlainObject(operation.target)) {
        throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", `spec-repair result.json accepted operation ${index} lacks operation proof`);
      }
      if (entry?.operationDigest !== sha256(Buffer.from(JSON.stringify(operation), "utf8"))) {
        throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", `spec-repair result.json accepted operation ${index} has a forged operation digest`);
      }
      const finding = current.findings.byId(operation.findingId);
      const authorized = finding?.disposition === "apply" && finding.allowedTargets.some((permission) => (
        permission.operationKinds.includes(operation.kind)
        && canonicalReviewValue(permission.target) === canonicalReviewValue(operation.target)
      ));
      if (!authorized) {
        throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", `spec-repair result.json accepted operation ${index} is not authorized by proven V1 triage`);
      }
      return { ...structuredClone(operation), findingIds: [operation.findingId] };
    });
    const applied = [...new Set(accepted.flatMap((operation) => operation.findingIds))].sort(codeUnitOrder);
    if (JSON.stringify([...repair.appliedFindings].sort(codeUnitOrder)) !== JSON.stringify(applied)) {
      throw new LegacyFlowMigrationError("UNPROVABLE_LEGACY_SPEC_REVIEW", "spec-repair result.json appliedFindings does not derive from accepted operations");
    }
    const repairDelta = new SpecReviewDelta({
      version: 2,
      stage: "spec-repair",
      identity: current.identity.toJSON(),
      baseReviewDigest: current.digest,
      findings: [],
      operations: [],
    });
    return mergeSpecReviewDelta({
      review: current,
      delta: repairDelta,
      acceptedOperations: accepted,
      discardedOperations: structuredClone(repair.discardedOperations),
    });
  }

  reviewBytes() { return this.review === null ? null : Buffer.from(`${JSON.stringify(this.review.toJSON(), null, 2)}\n`, "utf8"); }

  report() {
    return {
      schemaRevision: 1,
      relation: "revision-scoped-canonical-review",
      classification: this.classification,
      lifecycle: this.lifecycle,
      sources: this.legacyPaths.map((sourcePath) => ({
        sourcePath,
        hash: this.descriptors.get(sourcePath).hash,
        binding: this.descriptors.get(sourcePath).activityId == null ? "migration-materialized" : "activity-bound",
      })),
      destination: "revisions/001/review.json",
    };
  }
}

function specReviewHasCompleted(nodes) {
  for (const node of nodes ?? []) {
    if (node?.id === "spec-review" && node.status === "done") return true;
    if (specReviewHasCompleted(node?.steps)) return true;
  }
  return false;
}

/** Migration-only V1 reader. It proves raw descriptor bytes and current
 * state/spec identities without invoking runtime catalog content contracts
 * for retired stage artifacts. */
class LegacyCanonicalVersionPreflight {
  constructor({ directory, location, definition }) {
    this.directory = directory;
    this.location = location;
    this.definition = definition;
    Object.freeze(this);
  }

  inspect() {
    const catalogValue = parseObject(captureRegularFile(this.location.catalogFile, MIGRATION_READ_OPTIONS).bytes, "historical artifact-catalog.json");
    if (catalogValue.schemaRevision !== new FlowArtifactCatalog().schemaRevision
      || Object.keys(catalogValue).some((key) => !["schemaRevision", "artifacts", "hash"].includes(key))
      || !Array.isArray(catalogValue.artifacts)) {
      throw new LegacyFlowMigrationError("INVALID_VERSION_TARGET", "historical artifact catalog requires artifacts");
    }
    const descriptors = new Map();
    for (const descriptor of catalogValue.artifacts) {
      if (!isPlainObject(descriptor) || typeof descriptor.relativePath !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.hash)
        || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0 || descriptors.has(descriptor.relativePath)) {
        throw new LegacyFlowMigrationError("INVALID_VERSION_TARGET", "historical artifact catalog has an invalid descriptor");
      }
      normalizedRelative(descriptor.relativePath, "historical artifact path");
      descriptors.set(descriptor.relativePath, descriptor);
    }
    const retiredReviewPaths = new Set(legacySpecReviewPaths(this.directory).values());
    const sourceDescriptors = [];
    for (const descriptor of descriptors.values()) {
      if (!retiredReviewPaths.has(descriptor.relativePath)) sourceDescriptors.push(new FlowArtifactDescriptor(descriptor).toJSON());
      else {
        const slot = new ArtifactAuthoritySlot(descriptor);
        if (descriptor.retention !== "permanent" || typeof descriptor.mediaType !== "string" || descriptor.mediaType.trim() === ""
          || !Object.hasOwn(descriptor, "activityId") || typeof descriptor.migrationMaterialization !== "boolean") {
          throw new LegacyFlowMigrationError("INVALID_VERSION_TARGET", "historical review descriptor has invalid provenance");
        }
        if (descriptor.activityId !== null) FlowActivityId.from(descriptor.activityId);
        sourceDescriptors.push({ logicalKey: descriptor.logicalKey, kind: slot.kind,
          relativePath: descriptor.relativePath, hash: descriptor.hash, size: descriptor.size,
          mediaType: descriptor.mediaType, ...slot.toJSON(), retention: descriptor.retention,
          activityId: descriptor.activityId, migrationMaterialization: descriptor.migrationMaterialization });
      }
    }
    for (const sourceDescriptor of sourceDescriptors) {
      const descriptor = descriptors.get(sourceDescriptor.relativePath);
      if (Object.keys(descriptor).length !== Object.keys(sourceDescriptor).length
        || Object.keys(sourceDescriptor).some((field) => !Object.hasOwn(descriptor, field))) {
        throw new LegacyFlowMigrationError("INVALID_VERSION_TARGET", "historical artifact descriptor omits or adds a serialized field");
      }
    }
    const retainedCatalog = new FlowArtifactCatalog({ artifacts: sourceDescriptors.filter((descriptor) => !retiredReviewPaths.has(descriptor.relativePath)) });
    const authorityClaims = new Set(retainedCatalog.artifacts.map((descriptor) => descriptor.authorityKey()));
    for (const descriptor of sourceDescriptors.filter((entry) => retiredReviewPaths.has(entry.relativePath))) {
      const claim = new ArtifactAuthoritySlot(descriptor).claimKey();
      if (authorityClaims.has(claim)) throw new LegacyFlowMigrationError("INVALID_VERSION_TARGET", "historical catalog has a duplicate retired review authority slot");
      authorityClaims.add(claim);
    }
    sourceDescriptors.sort((left, right) => codeUnitOrder(left.relativePath, right.relativePath) || codeUnitOrder(left.kind, right.kind));
    if (catalogValue.hash !== sha256(Buffer.from(JSON.stringify({ schemaRevision: catalogValue.schemaRevision, artifacts: sourceDescriptors })))) {
      throw new LegacyFlowMigrationError("VERSION_CATALOG_INTEGRITY", "historical artifact catalog hash differs from its source content");
    }
    // Inspect every entry for filesystem safety. Some V1 producer output is
    // intentionally noncataloged transient evidence, so only descriptor
    // claims (and legacy review evidence) are hash-bound here.
    collectRegularFiles(this.directory);
    for (const [relativePath, descriptor] of descriptors) {
      const file = path.join(this.directory, relativePath);
      if (!fs.existsSync(file)) {
        throw new LegacyFlowMigrationError("MISSING_VERSION_ARTIFACT", `historical catalog artifact is absent: ${relativePath}`);
      }
      const bytes = captureRegularFile(file, MIGRATION_READ_OPTIONS).bytes;
      if (sha256(bytes) !== descriptor.hash || bytes.length !== descriptor.size) {
        throw new LegacyFlowMigrationError("VERSION_ARTIFACT_INTEGRITY", `historical catalog bytes differ: ${relativePath}`);
      }
    }
    for (const required of ["flow.json", "spec.json", "activities.jsonl"]) {
      if (!descriptors.has(required)) throw new LegacyFlowMigrationError("INVALID_VERSION_TARGET", `historical catalog omits ${required}`);
    }
    for (const [file, key] of [["flow.json", "flow.state"], ["spec.json", "spec.record"], ["activities.jsonl", "flow.activities"]]) {
      if (descriptors.get(file).logicalKey !== key) throw new LegacyFlowMigrationError("INVALID_VERSION_TARGET", `historical catalog does not bind ${file}`);
    }
    const specBytes = captureRegularFile(this.location.specFile, MIGRATION_READ_OPTIONS).bytes;
    const spec = new CurrentFlowSpecRecord(parseObject(specBytes, "historical spec.json"), { specId: this.location.specId.toString() });
    const rawState = parseObject(captureRegularFile(this.location.flowStateFile, MIGRATION_READ_OPTIONS).bytes, "historical flow.json");
    const ledger = legacyActivityLedger(this.location.activitiesFile);
    const activityIndex = FlowArtifactActivityIndex.fromBytes(captureRegularFile(this.location.activitiesFile, MIGRATION_READ_OPTIONS).bytes);
    for (const descriptor of retainedCatalog.artifacts) {
      if (descriptor.activityId !== null) activityIndex.require(descriptor.activityId).assertRelatedArtifact(descriptor);
    }
    const state = rawState.schemaRevision === 3
      ? inspectCanonicalV3State({ state: rawState, projectedActivities: [...ledger.records.values()].map((entry) => entry.toJSON()),
          originalActivities: [...ledger.records.values()].map((entry) => entry.toJSON()), definition: this.definition })
      : new CurrentFlowState(PreviousFlowSchemaProjection.project(rawState), { definition: this.definition });
    if (rawState.schemaRevision === CURRENT_FLOW_SCHEMA_REVISION) {
      new CurrentFlowStateStore({ directory: this.location.directory, definition: this.definition,
        runtimeLockLocation: this.location.runtimeLock("runtime.lock.current-flow-state") })
        .validateActivities(state, [...ledger.records.values()]);
    }
    if (!spec.specId.equals(this.location.specId) || state.identity.specId.toString() !== this.location.specId.toString()) {
      throw new LegacyFlowMigrationError("VERSION_IDENTITY_MISMATCH", "historical Version state/spec identity does not match its directory");
    }
    let conversion = null;
    let unprovenReview = null;
    try {
      conversion = new LegacySpecReviewConversion({
        directory: this.directory,
        specId: this.location.specId.toString(),
        specBytes,
        descriptors,
        activities: ledger.records,
        lifecycle: state.lifecycle.state,
      });
      if (conversion.classification === "absent"
        && ["active", "parked"].includes(state.lifecycle.state)
        && specReviewHasCompleted(state.root.steps)) {
        throw new LegacyFlowMigrationError(
          "MISSING_CANONICAL_SPEC_REVIEW",
          "active or parked Flow has completed spec-review but no review evidence can be proven",
        );
      }
    } catch (error) {
      if (!(error instanceof LegacyFlowMigrationError)) throw error;
      const legacyPaths = [...legacySpecReviewPaths(this.directory).values()].sort(codeUnitOrder);
      if (legacyPaths.length === 0 || !["finalized", "archived"].includes(state.lifecycle.state)) throw error;
      unprovenReview = Object.freeze({
        code: error.code,
        message: error.message,
        paths: Object.freeze(legacyPaths),
      });
    }
    return Object.freeze({
      catalogValue,
      descriptors,
      state,
      specBytes,
      activitiesBytes: ledger.bytes,
      requiredRevisions: Object.freeze(rawState.schemaRevision === 3 ? [3] : []),
      conversion,
      unprovenReview,
    });
  }
}

const PORTABLE_SOURCE_AUTHORITY_KEYS = new Set([
  "source.handoff.rollback-blob", "source.handoff.checkpoint", "source.handoff.event", "source.handoff.settlement",
  "task.review.unsealed.checkpoint", "task.review.recovery.authorization",
]);

class CanonicalPortableStateMigrationCandidate {
  constructor({ state, catalog, flowBytes, catalogBytes, processEvidence = new ProcessEvidenceArtifactMigration([]), preserveFlowBytes = false }) {
    if (!(state instanceof CurrentFlowState) || !(catalog instanceof FlowArtifactCatalog)
      || !Buffer.isBuffer(flowBytes) || !Buffer.isBuffer(catalogBytes)) {
      throw new TypeError("portable Flow migration candidate requires canonical state, Catalog and original bytes");
    }
    this.state = state;
    this.catalog = catalog;
    this.flowBytes = Buffer.from(flowBytes);
    this.catalogBytes = Buffer.from(catalogBytes);
    this.projectedFlowBytes = preserveFlowBytes ? Buffer.from(flowBytes) : Buffer.from(`${JSON.stringify(state.toJSON(), null, 2)}\n`, "utf8");
    this.processEvidence = processEvidence;
    Object.freeze(this);
  }
}

/** Explicit wire-format conversion. Previous physical source records cannot
 * supply the raw baseline and owner receipts required by the current codec. */
class CanonicalPortableStateMigrationPlan {
  constructor({ location, definition }) {
    this.location = location;
    this.definition = definition;
    Object.freeze(this);
  }

  #assertEmbeddedSourceAuthority(catalog, state) {
    for (const descriptor of catalog.artifacts) {
      const key = descriptor.logicalKey;
      if (!["impl.repair", "task.repair", "task.review.reconciliation", "execution.request"].includes(key)) continue;
      const bytes = captureRegularFile(this.location.resolve(descriptor.relativePath), MIGRATION_READ_OPTIONS).bytes;
      let unsafe = false;
      if (key === "task.repair") {
        const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: key, bytes });
        unsafe = history.attempts.some((entry) => entry.payload.sourceMutationManifest != null);
      } else {
        const value = parseObject(bytes, "previous embedded source authority");
        if (key === "impl.repair") unsafe = value.sourceMutationManifest != null;
        else if (key === "task.review.reconciliation") {
          const record = new TaskReviewReconciliationRecord(value);
          unsafe = record.currentAttempt.matches(state) || record.currentAttempt.matchesFailed(state);
        } else {
          const snapshot = ArtifactWorkerRequestSnapshot.fromJSON(value.snapshot);
          if (value.id !== snapshot.id) throw new Error("previous worker request snapshot digest is invalid");
          const contract = snapshot.executionContract;
          const attempt = CurrentAttemptIdentity.from({ id: contract.attemptId, nodeId: contract.nodeId,
            sequence: contract.attemptSequence });
          const active = attempt.matches(state) || attempt.matchesFailed(state);
          const request = snapshot.request;
          unsafe = request.sourceMutationBaselineDigest != null || request.sourceHandoffIdentity != null
            || request.sourceHandoffCheckpointDigest != null || active && request.dispatchRepositoryBinding !== null;
        }
      }
      if (unsafe) throw new LegacyFlowMigrationError("UNSAFE_SOURCE_FORMAT",
        `previous embedded source authority lacks portable restoration evidence: ${descriptor.relativePath}`);
    }
  }

  #assertUnchangedSourceEvidence(catalog, state, processEvidence) {
    const observations = [];
    for (const descriptor of catalog.artifacts) {
      if (["execution.source.manifest", "execution.observation"].includes(descriptor.logicalKey)) {
        const replacement = processEvidence.replacements.find((entry) => entry.descriptor.relativePath === descriptor.relativePath);
        observations.push(parseFlowExecutionObservationArtifact(descriptor, replacement?.targetBytes ?? descriptor.readBytes(this.location)));
      } else if (descriptor.logicalKey === "spec.gate.repair.source.manifest") {
        const bytes = descriptor.readBytes(this.location);
        const manifest = SpecGateRepairSourceSnapshotManifest.fromJSON(parseObject(bytes, "Spec repair source context"));
        const reference = manifest.reference();
        reference.assertBytes(bytes);
        if (descriptor.relativePath !== FLOW_ARTIFACT_CONTRACTS.resolve(descriptor.logicalKey,
          { digest: reference.digest }).relativePath) throw new Error("Spec repair source manifest path differs from its identity");
        manifest.restore((digest, byteLength) => {
          const artifact = FLOW_ARTIFACT_CONTRACTS.resolve("spec.gate.repair.source.blob", { digest });
          const blob = catalog.resolve(artifact.relativePath);
          if (blob.logicalKey !== artifact.logicalKey || blob.hash !== digest || blob.size !== byteLength) {
            throw new Error("Spec repair source blob differs from its catalog identity");
          }
          return blob.readBytes(this.location);
        });
      }
    }
    new FlowExecutionObservationCapture({
      manifests: observations.filter((entry) => entry instanceof FlowExecutionSourceManifest),
      facts: observations.filter((entry) => entry instanceof FlowExecutionObservationFact), expectedBinding: state,
    });
  }

  inspect() {
    this.location.assertAuthority();
    const flowBytes = captureRegularFile(this.location.flowStateFile, MIGRATION_READ_OPTIONS).bytes;
    const raw = parseObject(flowBytes, "previous Flow state");
    if (raw.schemaRevision === CURRENT_FLOW_SCHEMA_REVISION) return null;
    if (raw.schemaRevision !== 4) throw new LegacyFlowMigrationError("REVISION_FOUR_REQUIRED", "migrate specs through revision 4 before revision 5");
    const catalogBytes = captureRegularFile(this.location.catalogFile, MIGRATION_READ_OPTIONS).bytes;
    const catalog = FlowArtifactCatalog.fromSerialized(parseObject(catalogBytes, "previous artifact Catalog"));
    catalog.verify(this.location);
    for (const [name, key] of [["flow.json", "flow.state"], ["activities.jsonl", "flow.activities"], ["spec.json", "spec.record"]]) {
      if (catalog.resolve(name).logicalKey !== key) throw new LegacyFlowMigrationError("INVALID_VERSION_TARGET", `previous Catalog does not bind ${name}`);
    }
    const unsupported = catalog.artifacts.find((entry) => PORTABLE_SOURCE_AUTHORITY_KEYS.has(entry.logicalKey));
    if (unsupported !== undefined) {
      throw new LegacyFlowMigrationError("UNSAFE_SOURCE_FORMAT", `previous source authority cannot prove raw baseline, owner and portable generation: ${unsupported.relativePath}`);
    }
    for (const descriptor of catalog.artifacts) {
      if (!["retry.recovery.baseline", "retry.recovery.receipt"].includes(descriptor.logicalKey)) continue;
      const value = parseObject(captureRegularFile(this.location.resolve(descriptor.relativePath), MIGRATION_READ_OPTIONS).bytes,
        "previous retry authority");
      const baseline = descriptor.logicalKey === "retry.recovery.baseline"
        ? new RetryRecoveryBaseline(value) : new RetryRecoveryReceipt(value).current;
      if (raw.attempt !== null && baseline.matchesCurrentAttempt(raw)) {
        throw new LegacyFlowMigrationError("UNSAFE_SOURCE_FORMAT", `current Attempt retry authority uses a previous source digest: ${descriptor.relativePath}`);
      }
    }
    const gateDecision = new CanonicalGateDecisionMigrationPlan({ location: this.location, definition: this.definition }).inspect();
    if (gateDecision !== null) throw new LegacyFlowMigrationError("REVISION_FOUR_REQUIRED", "migrate specs --to 4 before revision 5");
    const state = new CurrentFlowState(PreviousFlowSchemaProjection.project(raw), { definition: this.definition });
    const processEvidence = processEvidenceMigration(this.location, catalog);
    this.#assertEmbeddedSourceAuthority(catalog, state);
    this.#assertUnchangedSourceEvidence(catalog, state, processEvidence);
    const activities = legacyActivityLedger(this.location.activitiesFile);
    const activityIndex = FlowArtifactActivityIndex.fromBytes(activities.bytes);
    for (const descriptor of catalog.artifacts) {
      if (descriptor.activityId !== null) activityIndex.require(descriptor.activityId).assertRelatedArtifact(descriptor);
    }
    new CurrentFlowStateStore({ directory: this.location.directory, definition: this.definition,
      runtimeLockLocation: this.location.runtimeLock("runtime.lock.current-flow-state") })
      .validateActivities(state, [...activities.records.values()]);
    new HistoricalCanonicalVersionValidator({ root: this.location.repositoryRoot,
      specRoot: { relativePath: this.location.specRoot }, specId: this.location.specId.toString(),
      version: this.location.version.pathSegment, definition: this.definition }).validate();
    return new CanonicalPortableStateMigrationCandidate({ state, catalog, flowBytes, catalogBytes, processEvidence });
  }
}

function processEvidenceMigration(location, catalog) {
  return new ProcessEvidenceArtifactMigration(catalog.artifacts.filter((descriptor) => PROCESS_EVIDENCE_MIGRATION_KEYS.includes(descriptor.logicalKey))
    .map((descriptor) => ({ descriptor, bytes: descriptor.readBytes(location) })));
}

/** Leaf contracts change independently of the unchanged Flow state schema. */
class CanonicalProcessEvidenceMigrationPlan {
  constructor({ location, definition }) { this.location = location; this.definition = definition; Object.freeze(this); }
  inspect() {
    this.location.assertAuthority();
    const flowBytes = captureRegularFile(this.location.flowStateFile, MIGRATION_READ_OPTIONS).bytes;
    const raw = parseObject(flowBytes, "process evidence migration Flow");
    if (raw.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION) throw new LegacyFlowMigrationError("REVISION_FIVE_REQUIRED", "migrate specs --to 5 before process evidence revision 6");
    const catalogBytes = captureRegularFile(this.location.catalogFile, MIGRATION_READ_OPTIONS).bytes;
    const catalog = FlowArtifactCatalog.fromSerialized(parseObject(catalogBytes, "process evidence migration Catalog"));
    const source = new ProcessEvidenceArtifactGraphSource({ location: this.location, catalog });
    catalog.verify(this.location, null, { processEvidence: source.processEvidence });
    let processEvidence = source.requiresProducerGraph ? null
      : new ProcessEvidenceArtifactMigration(source.migrationInputs, { processEvidence: source.processEvidence });
    if (processEvidence !== null && !processEvidence.changed) return null;
    const state = new HistoricalCanonicalVersionValidator({ root: this.location.repositoryRoot,
      specRoot: { relativePath: this.location.specRoot }, specId: this.location.specId.toString(),
      version: this.location.version.pathSegment, definition: this.definition,
      processEvidence: source.processEvidence }).validate();
    const activities = legacyActivityLedger(this.location.activitiesFile);
    const records = [...activities.records.values()].map(FlowActivity.canonical);
    const activityIndex = FlowArtifactActivityIndex.fromBytes(activities.bytes);
    for (const descriptor of catalog.artifacts) if (descriptor.activityId !== null) activityIndex.require(descriptor.activityId).assertRelatedArtifact(descriptor);
    new CurrentFlowStateStore({ directory: this.location.directory, definition: this.definition,
      runtimeLockLocation: this.location.runtimeLock("runtime.lock.current-flow-state") }).validateActivities(state, records);
    if (processEvidence === null) {
      const producerGraph = source.validate({ state, activities: records });
      processEvidence = new ProcessEvidenceArtifactMigration(source.migrationInputs, { producerGraph });
    }
    return new CanonicalPortableStateMigrationCandidate({ state, catalog, flowBytes, catalogBytes, processEvidence, preserveFlowBytes: true });
  }
}

/** Stages every canonical Version under one replacement spec root. A source
 * root can therefore never expose an earlier Version upgraded while a later
 * Version is still old. */
export class CanonicalRevisionRootTransaction {
  constructor({ root, specRoot, specId, definition, revision = 2, faultInjector = () => {} } = {}) {
    if (![2, 3, 4, 5, 6].includes(revision)) throw new Error("canonical revision root transaction revision is invalid");
    this.root = path.resolve(root);
    this.specRoot = specRoot;
    this.specId = FlowSpecIdentity.from(specId).toString();
    this.definition = definition;
    this.revision = revision;
    this.faultInjector = faultInjector;
    this.specDirectory = path.join(this.root, ...specRoot.relativePath.split("/"), this.specId);
    this.journalDirectory = journalDirectoryFor(this.root);
    this.journalPath = path.join(this.journalDirectory, new MigrationSpecSelection(this.specId).journalFileName(specRoot, revision));
    Object.freeze(this);
  }

  #versions(directory) {
    return canonicalVersionDirectories(directory);
  }

  #validateRoot(directory, repositoryRoot = this.root) {
    const states = [];
    const versions = this.#versions(directory);
    let currentState = null;
    for (const version of versions) {
      const location = new FlowVersionLocation({
        repositoryRoot,
        authorityScope: FlowVersionAuthorityScope.canonical(),
        specRoot: this.specRoot.relativePath,
        specId: this.specId,
        version: Number(version),
      });
      if (location.directory !== path.join(directory, version)) {
        throw new Error("canonical revision staging location does not mirror its repository authority");
      }
      const rawState = parseObject(captureRegularFile(location.flowStateFile, MIGRATION_READ_OPTIONS).bytes, "staged Flow state");
      states.push(rawState);
      if (location.version.value === 1) currentState = rawState;
      if (this.revision === 2 && rawState.schemaRevision === 3) {
        new CanonicalGateRepairMigrationPreflight({ location, definition: this.definition }).inspect();
        continue;
      }
      validateExistingVersion({
        root: repositoryRoot,
        specRoot: this.specRoot,
        specId: this.specId,
        version,
        definition: this.definition,
      });
      if (location.version.value === 1) {
        const pending = new CanonicalGateDecisionMigrationPlan({ location, definition: this.definition }).inspect();
        if (pending === null && rawState.schemaRevision === CURRENT_FLOW_SCHEMA_REVISION) {
          const store = new CurrentFlowVersionStore({ location, definition: this.definition });
          store.load();
          if ([5, 6].includes(this.revision)) store.readCanonicalTransitionView((view) => {
            for (const descriptor of view.catalog.artifacts.filter((entry) => entry.logicalKey === "execution.contract")) {
              const document = JSON.parse(view.readCatalogedArtifact(descriptor).toString("utf8"));
              const contract = FlowExecutionContract.fromJSON(document.contract);
              if (document.id !== undefined && document.id !== contract.id) throw new Error("Migrated execution contract differs from its source identity");
              readStoredPromptExecutionEpisodeFromView(view, contract, null, { currentAttempt: false });
            }
          });
        }
      }
    }
    assertMigrationFlowAuthority({ root: this.root, specRoot: this.specRoot, specId: this.specId, states, versions: versions.map(Number), currentState });
  }

  #preflight() {
    if ([5, 6].includes(this.revision)) {
      const plans = new Map(this.#versions(this.specDirectory).map((version) => {
        const location = new FlowVersionLocation({ repositoryRoot: this.root,
          authorityScope: FlowVersionAuthorityScope.canonical(), specRoot: this.specRoot.relativePath,
          specId: this.specId, version: Number(version) });
        const Plan = this.revision === 5 ? CanonicalPortableStateMigrationPlan : CanonicalProcessEvidenceMigrationPlan;
        return [version, new Plan({ location, definition: this.definition }).inspect()];
      }));
      if ([...plans.values()].every((plan) => plan === null)) throw new LegacyFlowMigrationError("ALREADY_MIGRATED", `canonical spec has no revision-${this.revision} source`);
      return plans;
    }
    if (this.revision === 3) return this.#preflightGateRepair();
    if (this.revision === 4) return this.#preflightGateDecision();
    const plans = new Map();
    for (const version of this.#versions(this.specDirectory)) {
      const location = new FlowVersionLocation({
        repositoryRoot: this.root,
        authorityScope: FlowVersionAuthorityScope.canonical(),
        specRoot: this.specRoot.relativePath,
        specId: this.specId,
        version: Number(version),
      });
      const hasSnapshot = fs.existsSync(location.artifact("spec.snapshot", { revision: "001" }));
      const hasReview = fs.existsSync(location.artifact("spec.review", { revision: "001" }));
      if (hasSnapshot || hasReview) {
        if (!hasSnapshot) {
          throw new LegacyFlowMigrationError("INCOMPLETE_REVISION_AUTHORITY", `canonical Version ${version} has an incomplete revision authority`);
        }
        validateExistingVersion({
          root: this.root,
          specRoot: this.specRoot,
          specId: this.specId,
          version,
          definition: this.definition,
        });
        plans.set(version, null);
        continue;
      }
      const plan = new LegacyCanonicalVersionPreflight({
        directory: location.directory,
        location,
        definition: this.definition,
      }).inspect();
      plans.set(version, plan);
    }
    return plans;
  }

  #preflightGateRepair() {
    const plans = new Map();
    for (const version of this.#versions(this.specDirectory)) {
      const location = new FlowVersionLocation({
        repositoryRoot: this.root,
        authorityScope: FlowVersionAuthorityScope.canonical(),
        specRoot: this.specRoot.relativePath,
        specId: this.specId,
        version: Number(version),
      });
      const raw = parseObject(captureRegularFile(location.flowStateFile, MIGRATION_READ_OPTIONS).bytes, "canonical Flow state");
      if ([4, CURRENT_FLOW_SCHEMA_REVISION].includes(raw.schemaRevision)) {
        validateExistingVersion({
          root: this.root, specRoot: this.specRoot, specId: this.specId,
          version, definition: this.definition,
        });
        plans.set(version, null);
        continue;
      }
      plans.set(version, new CanonicalGateRepairMigrationPreflight({
        location, definition: this.definition,
      }).inspect());
    }
    if ([...plans.values()].every((plan) => plan === null)) {
      throw new LegacyFlowMigrationError("ALREADY_MIGRATED", `canonical spec ${this.specId} has no revision-three source`);
    }
    return plans;
  }

  #preflightGateDecision() {
    const plans = new Map();
    for (const version of this.#versions(this.specDirectory)) {
      const location = new FlowVersionLocation({
        repositoryRoot: this.root,
        authorityScope: FlowVersionAuthorityScope.canonical(),
        specRoot: this.specRoot.relativePath,
        specId: this.specId,
        version: Number(version),
      });
      const plan = new CanonicalGateDecisionMigrationPlan({ location, definition: this.definition }).inspect();
      if (plan === null) {
        validateExistingVersion({ root: this.root, specRoot: this.specRoot,
          specId: this.specId, version, definition: this.definition });
      }
      plans.set(version, plan);
    }
    if ([...plans.values()].every((plan) => plan === null)) {
      throw new LegacyFlowMigrationError("ALREADY_MIGRATED", `canonical spec ${this.specId} has no retired Gate decision settlement`);
    }
    return plans;
  }

  #materializeGateDecision(stageContainer, plans) {
    const stage = path.join(stageContainer, ...this.specRoot.relativePath.split("/"), this.specId);
    RealDirectoryAuthority.resolve(path.dirname(stage), { create: true, creationMode: 0o755 });
    copyCanonicalTree(this.specDirectory, stage);
    for (const version of this.#versions(stage)) {
      const plan = plans.get(version);
      if (plan === null) continue;
      if (plan === undefined) throw new Error(`canonical Version ${version} lacks Gate decision migration preflight`);
      const location = new FlowVersionLocation({
        repositoryRoot: stageContainer,
        authorityScope: FlowVersionAuthorityScope.canonical(),
        specRoot: this.specRoot.relativePath,
        specId: this.specId,
        version: Number(version),
      });
      const archive = "artifacts/migration/spec-gate-decision-v4";
      const originals = [
        ["flow.json", plan.flowBytes],
        ["activities.jsonl", plan.activitiesBytes],
        ["artifact-catalog.json", plan.catalogBytes],
      ];
      const publications = [...plan.publications.entries()];
      for (const [source, value] of publications) originals.push([source, value.before]);
      const archiveDescriptors = originals.map(([source, bytes]) => {
        const relativePath = `${archive}/${source}`;
        writeExclusive(location.resolve(relativePath), bytes);
        return FlowArtifactDescriptor.fromFile({
          location, authoritySlot: migrationSlot(relativePath), relativePath,
          mediaType: source.endsWith(".jsonl") ? "application/x-ndjson" : "application/json",
          retention: "permanent", migrationMaterialization: true,
        });
      });
      replaceFileContent(location.flowStateFile, plan.projectedFlowBytes);
      replaceFileContent(location.activitiesFile, plan.projectedActivitiesBytes);
      for (const [source, value] of publications) replaceFileContent(location.resolve(source), value.after);
      const changed = new Map([
        ["flow.json", plan.projectedFlowBytes],
        ["activities.jsonl", plan.projectedActivitiesBytes],
        ...publications.map(([source, value]) => [source, value.after]),
      ]);
      const retained = plan.catalog.artifacts.map((descriptor) => {
        const bytes = changed.get(descriptor.relativePath);
        return bytes === undefined ? descriptor : new FlowArtifactDescriptor({
          ...descriptor.toJSON(), hash: sha256(bytes), size: bytes.length,
          ...(descriptor.relativePath === "flow.json" || descriptor.relativePath === "activities.jsonl"
            ? { activityId: null } : {}),
        });
      });
      new AtomicJsonFile(location.catalogFile).write(new FlowArtifactCatalog({
        artifacts: [...retained, ...archiveDescriptors],
      }).toJSON());
    }
  }

  #materializeGateRepair(stageContainer, plans) {
    const stage = path.join(stageContainer, ...this.specRoot.relativePath.split("/"), this.specId);
    RealDirectoryAuthority.resolve(path.dirname(stage), { create: true, creationMode: 0o755 });
    copyCanonicalTree(this.specDirectory, stage);
    for (const version of this.#versions(stage)) {
      const plan = plans.get(version);
      if (plan === null) continue;
      if (plan === undefined) throw new Error(`canonical Version ${version} lacks Gate repair migration preflight`);
      const location = new FlowVersionLocation({
        repositoryRoot: stageContainer,
        authorityScope: FlowVersionAuthorityScope.canonical(),
        specRoot: this.specRoot.relativePath,
        specId: this.specId,
        version: Number(version),
      });
      const archives = [
        ["flow", "flow.json", plan.flowBytes],
        ["activities", "activities.jsonl", plan.activitiesBytes],
        ["catalog", "artifact-catalog.json", plan.catalogBytes],
        ...(plan.issueLogBytes === null ? [] : [["issueLog", "issue-log.json", plan.issueLogBytes]]),
      ];
      const archiveDescriptors = archives.map(([, name, bytes]) => {
        const relativePath = `artifacts/migration/spec-gate-repair-v3/${name}`;
        writeExclusive(location.resolve(relativePath), bytes);
        return FlowArtifactDescriptor.fromFile({
          location, authoritySlot: migrationSlot(relativePath), relativePath,
          mediaType: name === "activities.jsonl" ? "application/x-ndjson" : "application/json",
          retention: "permanent", migrationMaterialization: true,
        });
      });
      const legacyOutcomeIds = new Set(plan.legacyOutcomeActivityIds);
      for (const descriptor of plan.catalog.artifacts.filter((entry) => (
        entry.logicalKey === "plan.gate.repair.outcome" && legacyOutcomeIds.has(entry.activityId)
      ))) {
        const source = location.resolve(descriptor.relativePath);
        const archivedPath = `artifacts/migration/spec-gate-repair-v3/outcomes/${path.basename(path.dirname(descriptor.relativePath))}.json`;
        writeExclusive(location.resolve(archivedPath), captureRegularFile(source, MIGRATION_READ_OPTIONS).bytes);
        new AtomicFile(source).remove();
        archiveDescriptors.push(FlowArtifactDescriptor.fromFile({
          location, authoritySlot: migrationSlot(archivedPath), relativePath: archivedPath,
          mediaType: "application/json", retention: "permanent", migrationMaterialization: true,
        }));
      }
      const state = CurrentFlowState.fromCanonicalMigration({
        legacyState: plan.state,
        archiveDigests: plan.archiveDigests,
        legacyAppliedCount: plan.legacyAppliedCount,
        projectedActivitiesDigest: plan.projectedActivitiesDigest,
        legacyCyclesDigest: plan.legacyCyclesDigest,
        definition: this.definition,
      });
      const flowBytes = Buffer.from(`${JSON.stringify(state.toJSON(), null, 2)}\n`, "utf8");
      replaceFileContent(location.flowStateFile, flowBytes);
      replaceFileContent(location.activitiesFile, plan.projectedActivitiesBytes);
      if (plan.liveIssueLogBytes !== null) {
        replaceFileContent(location.resolve("issue-log.json"), plan.liveIssueLogBytes);
      }
      const count = {
        version: 1,
        legacyAppliedCount: plan.legacyAppliedCount,
        legacyOutcomeActivityIds: [...plan.legacyOutcomeActivityIds],
        sourceActivitiesDigest: plan.archiveDigests.activities,
        legacyCycles: plan.legacyCycles,
      };
      const countArtifact = FLOW_ARTIFACT_CONTRACTS.resolve("spec.gate.repair.migration");
      writeExclusive(location.resolve(countArtifact.relativePath), Buffer.from(`${JSON.stringify(count, null, 2)}\n`, "utf8"));
      const countDescriptor = FlowArtifactDescriptor.fromFile({
        location,
        ...countArtifact.publication({ mediaType: "application/json" }),
        migrationMaterialization: true,
      });
      const retained = plan.catalog.artifacts.filter((entry) => (
        entry.logicalKey !== "plan.gate.repair.outcome" || !legacyOutcomeIds.has(entry.activityId)
      )).map((entry) => {
        if (entry.relativePath === "flow.json") return new FlowArtifactDescriptor({
          ...entry.toJSON(), hash: sha256(flowBytes), size: flowBytes.length, activityId: null,
        });
        if (entry.relativePath === "activities.jsonl") return new FlowArtifactDescriptor({
          ...entry.toJSON(), hash: sha256(plan.projectedActivitiesBytes), size: plan.projectedActivitiesBytes.length,
          activityId: null,
        });
        if (entry.relativePath === "issue-log.json" && plan.liveIssueLogBytes !== null) return new FlowArtifactDescriptor({
          ...entry.toJSON(), hash: sha256(plan.liveIssueLogBytes), size: plan.liveIssueLogBytes.length,
          activityId: null,
        });
        return entry;
      });
      new AtomicJsonFile(location.catalogFile).write(new FlowArtifactCatalog({
        artifacts: [...retained, ...archiveDescriptors, countDescriptor],
      }).toJSON());
    }
  }

  #materializePortableState(stageContainer, plans) {
    const stage = path.join(stageContainer, ...this.specRoot.relativePath.split("/"), this.specId);
    RealDirectoryAuthority.resolve(path.dirname(stage), { create: true, creationMode: 0o755 });
    copyCanonicalTree(this.specDirectory, stage);
    for (const [version, plan] of plans) {
      if (plan === null) continue;
      const location = new FlowVersionLocation({ repositoryRoot: stageContainer,
        authorityScope: FlowVersionAuthorityScope.canonical(), specRoot: this.specRoot.relativePath,
        specId: this.specId, version: Number(version) });
      const migrationRoot = this.revision === 6 ? "artifacts/migration/process-evidence-v6" : "artifacts/migration/portable-state-v5";
      // Later leaf maintenance preserves the first migration's permanent archive.
      const archiveRoot = this.revision === 6 && plan.catalog.artifacts.some(entry => entry.relativePath === `${migrationRoot}/receipt.json`)
        ? `${migrationRoot}/continuations/${sha256(plan.catalogBytes)}` : migrationRoot;
      const additions = [];
      for (const [name, bytes] of [["flow.json", plan.flowBytes], ["artifact-catalog.json", plan.catalogBytes]]) {
        const relativePath = `${archiveRoot}/${name}`;
        writeExclusive(location.resolve(relativePath), bytes);
        additions.push(FlowArtifactDescriptor.fromFile({ location, authoritySlot: migrationSlot(relativePath),
          relativePath, mediaType: "application/json", retention: "permanent", migrationMaterialization: true }));
      }
      const evidenceChanges = [];
      for (const replacement of plan.processEvidence.replacements) {
        const sourcePath = `${archiveRoot}/source/${replacement.descriptor.relativePath}`;
        const sourceBytes = replacement.sourceBytes, targetBytes = replacement.targetBytes;
        writeExclusive(location.resolve(sourcePath), sourceBytes);
        additions.push(FlowArtifactDescriptor.fromFile({ location, authoritySlot: migrationSlot(sourcePath),
          relativePath: sourcePath, mediaType: replacement.descriptor.mediaType, retention: "permanent", migrationMaterialization: true }));
        replaceFileContent(location.resolve(replacement.descriptor.relativePath), targetBytes);
        evidenceChanges.push({ relativePath: replacement.descriptor.relativePath, sourcePath,
          sourceHash: sha256(sourceBytes), targetHash: sha256(targetBytes), targetSize: targetBytes.length });
      }
      for (const proof of plan.processEvidence.proofs) {
        writeExclusive(location.resolve(proof.relativePath), proof.bytes);
        additions.push(FlowArtifactDescriptor.fromFile({ location, authoritySlot: migrationSlot(proof.relativePath),
          relativePath: proof.relativePath, mediaType: "application/json", retention: "permanent", migrationMaterialization: true }));
      }
      replaceFileContent(location.flowStateFile, plan.projectedFlowBytes);
      const receiptPath = `${archiveRoot}/receipt.json`;
      writeExclusive(location.resolve(receiptPath), Buffer.from(`${JSON.stringify({
        version: 1, migrationRevision: this.revision, sourceSchemaRevision: JSON.parse(plan.flowBytes).schemaRevision, targetSchemaRevision: CURRENT_FLOW_SCHEMA_REVISION,
        sourceFlowHash: sha256(plan.flowBytes), sourceCatalogHash: sha256(plan.catalogBytes),
        targetFlowHash: sha256(plan.projectedFlowBytes), fingerprintVersion: TREE_FINGERPRINT_VERSION,
        flowId: plan.state.flowId, flowVersionId: plan.state.flowVersionId, runId: plan.state.runId,
        processEvidenceRevision: 6, evidenceChanges,
      }, null, 2)}\n`, "utf8"));
      additions.push(FlowArtifactDescriptor.fromFile({ location, authoritySlot: migrationSlot(receiptPath),
        relativePath: receiptPath, mediaType: "application/json", retention: "permanent", migrationMaterialization: true }));
      const retained = plan.catalog.artifacts.map((entry) => {
        const change = evidenceChanges.find((value) => value.relativePath === entry.relativePath);
        if (change !== undefined) return new FlowArtifactDescriptor({ ...entry.toJSON(), hash: change.targetHash, size: change.targetSize });
        return entry.relativePath === "flow.json"
          ? new FlowArtifactDescriptor({ ...entry.toJSON(), hash: sha256(plan.projectedFlowBytes), size: plan.projectedFlowBytes.length }) : entry;
      });
      new AtomicJsonFile(location.catalogFile).write(new FlowArtifactCatalog({ artifacts: [...retained, ...additions] }).toJSON());
    }
  }

  #materialize(stageContainer, plans) {
    if ([5, 6].includes(this.revision)) return this.#materializePortableState(stageContainer, plans);
    if (this.revision === 3) return this.#materializeGateRepair(stageContainer, plans);
    if (this.revision === 4) return this.#materializeGateDecision(stageContainer, plans);
    const stage = path.join(stageContainer, ...this.specRoot.relativePath.split("/"), this.specId);
    RealDirectoryAuthority.resolve(path.dirname(stage), { create: true, creationMode: 0o755 });
    copyCanonicalTree(this.specDirectory, stage);
    for (const version of this.#versions(stage)) {
      const directory = path.join(stage, version);
      const specFile = path.join(directory, "spec.json");
      const bytes = captureRegularFile(specFile, MIGRATION_READ_OPTIONS).bytes;
      const parameters = { revision: "001" };
      const existingReview = path.join(directory, "revisions", "001", "review.json");
      const existingSnapshot = path.join(directory, "revisions", "001", "spec.json");
      if (fs.existsSync(existingReview) || fs.existsSync(existingSnapshot)) {
        if (!fs.existsSync(existingSnapshot)) {
          throw new Error(`canonical Version ${version} has an incomplete revision authority`);
        }
        continue;
      }
      const plan = plans.get(version);
      if (plan === undefined || plan === null) {
        throw new Error(`canonical Version ${version} lacks a revision migration preflight plan`);
      }
      const location = new FlowVersionLocation({
        repositoryRoot: stageContainer,
        authorityScope: FlowVersionAuthorityScope.canonical(),
        specRoot: this.specRoot.relativePath,
        specId: this.specId,
        version: Number(version),
      });
      const activitiesFile = path.join(directory, "activities.jsonl");
      const activityArchives = [];
      if (!captureRegularFile(activitiesFile, MIGRATION_READ_OPTIONS).bytes.equals(plan.activitiesBytes)) {
        for (const file of ["activities.jsonl", "artifact-catalog.json"]) {
          const relativePath = `artifacts/migration/legacy-activity-v1/${file}`;
          writeExclusive(location.resolve(relativePath), captureRegularFile(location.resolve(file), MIGRATION_READ_OPTIONS).bytes);
          activityArchives.push(FlowArtifactDescriptor.fromFile({ location,
            authoritySlot: migrationSlot(relativePath), relativePath,
            mediaType: file.endsWith(".jsonl") ? "application/x-ndjson" : "application/json",
            retention: "permanent", migrationMaterialization: true }));
        }
        replaceFileContent(activitiesFile, plan.activitiesBytes);
      }
      const legacyPaths = plan.conversion === null ? plan.unprovenReview.paths : plan.conversion.legacyPaths;
      const archivedDescriptors = [];
      for (const sourcePath of legacyPaths) {
        const source = path.join(directory, sourcePath);
        const archivePath = `artifacts/migration/legacy-spec-review/${sourcePath}`;
        if (plan.conversion === null) {
          writeExclusive(path.join(directory, archivePath), captureRegularFile(source, MIGRATION_READ_OPTIONS).bytes);
        }
        new AtomicFile(source).remove();
        if (plan.conversion === null) {
          archivedDescriptors.push(FlowArtifactDescriptor.fromFile({
            location,
            authoritySlot: migrationSlot(archivePath),
            relativePath: archivePath,
            mediaType: "application/json",
            retention: "permanent",
            migrationMaterialization: true,
          }));
        }
      }
      writeExclusive(path.join(directory, "revisions", "001", "spec.json"), bytes);
      const reviewBytes = plan.conversion?.reviewBytes() ?? null;
      if (reviewBytes !== null) writeExclusive(path.join(directory, "revisions", "001", "review.json"), reviewBytes);
      const catalogPath = path.join(directory, "artifact-catalog.json");
      const reviewReportPath = "artifacts/migration/spec-review-conversion.json";
      const report = plan.conversion === null
        ? {
            schemaRevision: 1,
            relation: "revision-scoped-canonical-review",
            classification: "archived-unproven",
            lifecycle: plan.state.lifecycle.state,
            sources: legacyPaths.map((sourcePath) => ({
              sourcePath,
              hash: plan.descriptors.get(sourcePath)?.hash
                ?? sha256(captureRegularFile(path.join(directory, "artifacts/migration/legacy-spec-review", sourcePath), MIGRATION_READ_OPTIONS).bytes),
              binding: plan.descriptors.has(sourcePath) ? "catalog-bound" : "unbound",
            })),
            reason: plan.unprovenReview.code,
            destination: null,
          }
        : plan.conversion.legacyPaths.length === 0 ? null : plan.conversion.report();
      if (plan.conversion === null || plan.conversion.legacyPaths.length > 0) {
        writeExclusive(path.join(directory, reviewReportPath), Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8"));
      }
      const retained = plan.catalogValue.artifacts
        .filter((entry) => !legacyPaths.includes(entry.relativePath))
        .map((entry) => {
          const currentBytes = captureRegularFile(path.join(directory, entry.relativePath), MIGRATION_READ_OPTIONS).bytes;
          return new FlowArtifactDescriptor({ ...entry, hash: sha256(currentBytes), size: currentBytes.length });
        });
      const additions = [
        ...activityArchives,
        revisionDescriptorForBytes("spec.snapshot", parameters, bytes),
        ...(reviewBytes === null ? [] : [revisionDescriptorForBytes("spec.review", parameters, reviewBytes)]),
        ...archivedDescriptors,
        ...(plan.conversion === null || plan.conversion.legacyPaths.length > 0 ? [FlowArtifactDescriptor.fromFile({
          location,
          authoritySlot: migrationSlot(reviewReportPath),
          relativePath: reviewReportPath,
          mediaType: "application/json",
          retention: "permanent",
          migrationMaterialization: true,
        })] : []),
      ];
      const paths = new Set(retained.map((entry) => entry.relativePath));
      if (additions.some((entry) => paths.has(entry.relativePath))) throw new Error(`canonical Version ${version} already has revision artifacts`);
      new AtomicJsonFile(catalogPath).write(new FlowArtifactCatalog({ artifacts: [...retained, ...additions] }).toJSON());
    }
  }

  static recoverFromJournal({ root, specRoot, journal, journalPath, dryRun }) {
    if (dryRun) return this.#recoverCaptured({ root, specRoot, journal, journalPath, dryRun });
    this.#recoverCaptured({ root, specRoot, journal, journalPath, dryRun: true });
    const snapshot = captureRegularFile(journalPath, MIGRATION_READ_OPTIONS);
    return withRepositoryMigrationExclusion(root, { revalidate: () => {
      const current = captureRegularFile(journalPath, { ...MIGRATION_READ_OPTIONS, expectedIdentity: snapshot.identity });
      if (current.digest !== snapshot.digest) throw new Error("canonical revision journal changed before recovery");
      this.#recoverCaptured({ root, specRoot, journal, journalPath, dryRun: true });
    } }, () => this.#recoverCaptured({ root, specRoot, journal, journalPath, dryRun }));
  }

  static #recoverCaptured({ root, specRoot, journal, journalPath, dryRun }) {
    const revision = journal?.rootTransaction === "revision-six" ? 6 : journal?.rootTransaction === "revision-five" ? 5 : journal?.rootTransaction === "revision-four" ? 4
      : journal?.rootTransaction === "revision-three" ? 3 : 2;
    if (!isPlainObject(journal) || journal.schemaRevision !== JOURNAL_SCHEMA_REVISION || journal.fingerprintVersion !== TREE_FINGERPRINT_VERSION
      || journal.component !== JOURNAL_COMPONENT || journal.revision !== REVISION
      || journal.rootTransaction !== (revision === 6 ? "revision-six" : revision === 5 ? "revision-five" : revision === 4 ? "revision-four" : revision === 3 ? "revision-three" : "revision-two") || journal.specRoot !== specRoot.relativePath
      || typeof journal.specId !== "string" || typeof journal.stageName !== "string" || typeof journal.backupName !== "string"
      || !["stage-validated", "source-backed-up", "stage-placed", "cleanup"].includes(journal.phase)
      || !/^[a-f0-9]{64}$/.test(journal.sourceHash) || !/^[a-f0-9]{64}$/.test(journal.stageHash)) {
      throw new Error("canonical revision migration journal is invalid");
    }
    const sourceIdentity = FileIdentity.fromStored(journal.sourceDirectoryIdentity);
    const stageIdentity = FileIdentity.fromStored(journal.stageDirectoryIdentity);
    const containerIdentity = FileIdentity.fromStored(journal.stageContainerIdentity);
    const sourceFiles = storedSourceGenerations(journal.sourceFiles);
    const transaction = new CanonicalRevisionRootTransaction({ root, specRoot, specId: journal.specId, definition: buildCurrentFlowDefinition(), revision });
    if (transaction.journalPath !== journalPath) throw new Error("canonical revision migration journal identity does not match its path");
    if (path.basename(journal.stageName) !== journal.stageName || path.basename(journal.backupName) !== journal.backupName
      || !journal.stageName.startsWith(`.${transaction.specId}.sennel-migrate-revisions-stage-`)
      || !journal.backupName.startsWith(`.${transaction.specId}.sennel-migrate-revisions-backup-`)) {
      throw new Error("canonical revision migration journal contains unsafe names");
    }
    const parent = path.dirname(transaction.specDirectory);
    const stageContainer = path.join(parent, journal.stageName);
    if (lstatOrNull(stageContainer) !== null && !sameDirectoryIdentity(stageContainer, containerIdentity,
      "canonical revision migration stage container")) throw new Error("canonical revision migration stage container generation is foreign");
    const stage = path.join(stageContainer, ...specRoot.relativePath.split("/"), transaction.specId);
    const backup = path.join(parent, journal.backupName);
    const source = transaction.specDirectory;
    const sourceExists = lstatOrNull(source) !== null;
    const stageExists = lstatOrNull(stage) !== null;
    const backupExists = lstatOrNull(backup) !== null;
    const authorityRoot = backupExists ? backup : source;
    if (lstatOrNull(authorityRoot) !== null) {
      if (sameDirectoryIdentity(authorityRoot, sourceIdentity, "canonical revision migration original root")) {
        for (const file of sourceFiles) file.assert(authorityRoot);
      }
      const versions = canonicalVersionDirectories(authorityRoot);
      const states = versions.map((version) =>
        parseObject(captureRegularFile(path.join(authorityRoot, version, "flow.json"), MIGRATION_READ_OPTIONS).bytes, "recovery Flow identity"));
      const currentState = states[versions.indexOf("001")] ?? null;
      assertMigrationFlowAuthority({ root, specRoot, specId: transaction.specId, states, versions: versions.map(Number), currentState });
    }
    if (dryRun) return Object.freeze({ specId: transaction.specId, requiresRecovery: true, state: { sourceExists, stageExists, backupExists } });
    const clear = () => { new AtomicFile(journalPath).remove(); removeEmptyJournalDirectory(path.dirname(journalPath)); };
    if (sourceExists && stageExists && !backupExists) {
      assertTreeGeneration(source, sourceIdentity, journal.sourceHash, "canonical revision migration source", sourceFiles);
      const stageAuthority = assertTreeGeneration(stage, stageIdentity, journal.stageHash, "canonical revision migration stage");
      stageAuthority.removeTree(); removeEmptyStageContainer(stageContainer); clear();
      return Object.freeze({ specId: transaction.specId, recovered: "discarded-staging" });
    }
    if (!sourceExists && stageExists && backupExists) {
      assertTreeGeneration(backup, sourceIdentity, journal.sourceHash, "canonical revision migration backup", sourceFiles);
      const stageAuthority = assertTreeGeneration(stage, stageIdentity, journal.stageHash, "canonical revision migration stage");
      transaction.#validateRoot(stage, stageContainer);
      stageAuthority.moveTo(source); transaction.#validateRoot(source);
      assertTreeGeneration(backup, sourceIdentity, journal.sourceHash, "canonical revision migration backup", sourceFiles).removeTree();
      removeEmptyStageContainer(stageContainer); clear();
      return Object.freeze({ specId: transaction.specId, recovered: "placed-staging" });
    }
    if (sourceExists && !stageExists && backupExists) {
      const backupAuthority = assertTreeGeneration(backup, sourceIdentity, journal.sourceHash, "canonical revision migration backup", sourceFiles);
      const placedAuthority = assertRealDirectory(source, "canonical revision migration placed root");
      if (!sameFileIdentity(placedAuthority.identity, stageIdentity)) {
        throw new Error("canonical revision migration target generation is foreign; refusing rollback");
      }
      try {
        assertTreeGeneration(source, stageIdentity, journal.stageHash, "canonical revision migration placed root");
        transaction.#validateRoot(source);
      } catch (error) {
        placedAuthority.removeTree();
        assertTreeGeneration(backup, sourceIdentity, journal.sourceHash, "canonical revision migration backup", sourceFiles).moveTo(source);
        removeEmptyStageContainer(stageContainer);
        clear();
        return Object.freeze({ specId: transaction.specId, recovered: "rolled-back-invalid-target" });
      }
      backupAuthority.removeTree(); removeEmptyStageContainer(stageContainer); clear();
      return Object.freeze({ specId: transaction.specId, recovered: "cleaned-backup" });
    }
    if (!sourceExists && !stageExists && backupExists) {
      assertTreeGeneration(backup, sourceIdentity, journal.sourceHash, "canonical revision migration backup", sourceFiles).moveTo(source); clear();
      return Object.freeze({ specId: transaction.specId, recovered: "restored-source" });
    }
    if (sourceExists && !stageExists && !backupExists) {
      assertTreeGeneration(source, stageIdentity, journal.stageHash, "canonical revision migration completed root");
      transaction.#validateRoot(source);
      if (lstatOrNull(stageContainer) !== null) removeEmptyStageContainer(stageContainer);
      clear();
      return Object.freeze({ specId: transaction.specId, recovered: "cleared-complete" });
    }
    throw new Error(`cannot safely recover canonical revision migration for ${transaction.specId}`);
  }

  apply() {
    const identity = directoryIdentity(this.specDirectory, "canonical spec root");
    const sourceHash = treeFingerprint(this.specDirectory);
    const sourceFiles = storedSourceGenerations(captureTreeFiles(this.specDirectory));
    const revalidate = () => {
      if (!sameDirectoryIdentity(this.specDirectory, identity, "canonical spec root")
        || treeFingerprint(this.specDirectory) !== sourceHash) {
        throw new LegacyFlowMigrationError("SOURCE_CHANGED", "canonical spec root changed before exclusion");
      }
      for (const file of sourceFiles) file.assert(this.specDirectory);
      const plans = this.#preflight();
      const versions = this.#versions(this.specDirectory);
      const states = versions.map((version) => plans.get(version)?.state
        ?? parseObject(captureRegularFile(path.join(this.specDirectory, version, "flow.json"), MIGRATION_READ_OPTIONS).bytes, "migration source Flow"));
      assertMigrationFlowAuthority({ root: this.root, specRoot: this.specRoot, specId: this.specId,
        states, versions: versions.map(Number), currentState: states[versions.indexOf("001")] ?? null });
    };
    return withRepositoryMigrationExclusion(this.root, { revalidate }, () => this.#applyCaptured());
  }

  #applyCaptured() {
    assertRealDirectory(this.specDirectory, "canonical spec root");
    // The proof plan is built before even a journal directory is created.
    // Dry-run and apply therefore share the same lifecycle/blocker decision.
    const plans = this.#preflight();
    const sourceVersions = this.#versions(this.specDirectory);
    const sourceStates = sourceVersions.map((version) =>
      plans.get(version)?.state ?? parseObject(captureRegularFile(path.join(this.specDirectory, version, "flow.json"), MIGRATION_READ_OPTIONS).bytes, "migration source Flow"));
    const currentState = sourceStates[sourceVersions.indexOf("001")] ?? null;
    const assertAuthority = () => assertMigrationFlowAuthority({ root: this.root, specRoot: this.specRoot, specId: this.specId, states: sourceStates, versions: sourceVersions.map(Number), currentState });
    assertAuthority();
    RealDirectoryAuthority.resolve(this.journalDirectory, { create: true, creationMode: 0o755 });
    assertRealDirectory(this.journalDirectory, "specs migration journal directory");
    const token = crypto.randomUUID();
    const parent = path.dirname(this.specDirectory);
    const stageName = `.${this.specId}.sennel-migrate-revisions-stage-${token}`;
    const backupName = `.${this.specId}.sennel-migrate-revisions-backup-${token}`;
    const stageContainer = path.join(parent, stageName);
    const stage = path.join(stageContainer, ...this.specRoot.relativePath.split("/"), this.specId);
    const backup = path.join(parent, backupName);
    const sourceIdentity = directoryIdentity(this.specDirectory, "canonical spec root");
    const sourceHash = treeFingerprint(this.specDirectory);
    const sourceFiles = captureTreeFiles(this.specDirectory);
    const stageContainerAuthority = RealDirectoryAuthority.resolve(parent).createExclusiveChild(stageName, { creationMode: 0o755 });
    const stageContainerIdentity = stageContainerAuthority.identity.toJSON();
    let journaled = false;
    try {
      this.#materialize(stageContainer, plans);
      this.#validateRoot(stage, stageContainer);
      const stageIdentity = directoryIdentity(stage, "canonical revision staging root");
      const stageHash = treeFingerprint(stage);
      assertTreeGeneration(this.specDirectory, sourceIdentity, sourceHash, "canonical spec root", sourceFiles);
      new AtomicJsonFile(this.journalPath).write({
        schemaRevision: JOURNAL_SCHEMA_REVISION, fingerprintVersion: TREE_FINGERPRINT_VERSION, component: JOURNAL_COMPONENT, revision: REVISION,
        rootTransaction: this.revision === 6 ? "revision-six" : this.revision === 5 ? "revision-five" : this.revision === 4 ? "revision-four" : this.revision === 3 ? "revision-three" : "revision-two", specRoot: this.specRoot.relativePath, specId: this.specId,
        stageName, backupName, sourceHash, stageHash, sourceDirectoryIdentity: sourceIdentity, stageDirectoryIdentity: stageIdentity,
        sourceFiles,
        stageContainerIdentity,
        phase: "stage-validated",
      });
      journaled = true;
      this.faultInjector({ phase: "journal-written", transaction: this });
      const sourceAuthority = assertTreeGeneration(this.specDirectory, sourceIdentity, sourceHash, "canonical spec root", sourceFiles);
      assertAuthority();
      sourceAuthority.moveTo(backup);
      new AtomicJsonFile(this.journalPath).write({ ...new AtomicJsonFile(this.journalPath).read(), phase: "source-backed-up" });
      this.faultInjector({ phase: "source-backed-up", transaction: this });
      assertTreeGeneration(backup, sourceIdentity, sourceHash, "canonical revision migration backup", sourceFiles);
      const stageAuthority = assertTreeGeneration(stage, stageIdentity, stageHash, "canonical revision migration stage");
      if (lstatOrNull(this.specDirectory) !== null) throw new Error("canonical revision migration target appeared before placement");
      stageAuthority.moveTo(this.specDirectory);
      new RealDirectoryAuthority(parent).assertStable();
      this.#validateRoot(this.specDirectory);
      new AtomicJsonFile(this.journalPath).write({ ...new AtomicJsonFile(this.journalPath).read(), phase: "stage-placed" });
      this.faultInjector({ phase: "stage-placed", transaction: this });
      const backupAuthority = assertTreeGeneration(backup, sourceIdentity, sourceHash, "canonical revision migration backup", sourceFiles);
      assertTreeGeneration(this.specDirectory, stageIdentity, stageHash, "canonical revision migration placed root");
      new AtomicJsonFile(this.journalPath).write({ ...new AtomicJsonFile(this.journalPath).read(), phase: "cleanup" });
      backupAuthority.removeTree();
      removeEmptyStageContainer(stageContainer);
      new AtomicFile(this.journalPath).remove();
      removeEmptyJournalDirectory(this.journalDirectory);
      const requiredRevisions = [...new Set([...plans.values()].flatMap((plan) => plan?.requiredRevisions ?? []))];
      return Object.freeze({ specId: this.specId, complete: true, requiredRevisions,
        continuationReady: requiredRevisions.length === 0 });
    } catch (error) {
      if (!journaled) {
        if (lstatOrNull(stageContainer) !== null) {
          if (!sameDirectoryIdentity(stageContainer, stageContainerIdentity, "canonical revision migration stage container")) {
            throw new AggregateError([error, new Error("canonical migration stage container generation changed")],
              `canonical migration failed and cannot remove foreign staging: ${error.message}`, { cause: error });
          }
          stageContainerAuthority.removeTree();
        }
        removeEmptyJournalDirectory(this.journalDirectory);
      }
      throw error;
    }
  }
}

/** Complete validated conversion for exactly one direct child of the spec root. */
export class SpecsMigrationCandidate {
  constructor({ source, definition, mappings, fieldManifest, flowSnapshot, decisions, runtimeResidues, resultAggregations, state, specRecord, activities, activityEvidence, identityBasis } = {}) {
    if (!(source instanceof LegacyFlowSource)) throw new Error("Specs migration candidate requires a LegacyFlowSource");
    if (!Array.isArray(mappings) || mappings.some((entry) => !(entry instanceof MigrationMapping))) {
      throw new Error("Specs migration candidate requires typed mappings");
    }
    if (!(fieldManifest instanceof LegacyFlowFieldManifest)) {
      throw new Error("Specs migration candidate requires a recursive legacy Flow field manifest");
    }
    if (!(flowSnapshot instanceof LegacyFlowAuthoritySnapshot)) throw new Error("Specs migration candidate requires the raw Flow authority snapshot");
    if (!Array.isArray(decisions) || decisions.some((entry) => !(entry instanceof LegacyArtifactDecision))) {
      throw new Error("Specs migration candidate requires typed artifact decisions");
    }
    if (!Array.isArray(runtimeResidues) || runtimeResidues.some((entry) => !(entry instanceof LegacyRuntimeResidue))) {
      throw new Error("Specs migration candidate requires typed legacy runtime residues");
    }
    if (!Array.isArray(resultAggregations) || resultAggregations.some((entry) => !(entry instanceof LegacyResultAggregation))) {
      throw new Error("Specs migration candidate requires typed result aggregations");
    }
    if (!(state instanceof CurrentFlowState) || !(specRecord instanceof CurrentFlowSpecRecord)) {
      throw new Error("Specs migration candidate requires typed canonical state and spec record");
    }
    if (!Array.isArray(activities) || activities.some((entry) => !(entry instanceof FlowActivity))) {
      throw new Error("Specs migration candidate requires typed Activities");
    }
    if (!Array.isArray(activityEvidence) || activityEvidence.some((entry) => !(entry instanceof LegacyActivityEvidence))) {
      throw new Error("Specs migration candidate requires typed Activity evidence");
    }
    if (!Array.isArray(identityBasis) || identityBasis.some((entry) => !(entry instanceof LegacyIdentityBasis))) {
      throw new Error("Specs migration candidate requires typed identity basis");
    }
    this.source = source;
    this.definition = definition;
    this.mappings = Object.freeze([...mappings]);
    this.fieldManifest = fieldManifest;
    this.flowSnapshot = flowSnapshot;
    this.decisions = Object.freeze([...decisions]);
    this.runtimeResidues = Object.freeze([...runtimeResidues]);
    this.resultAggregations = Object.freeze([...resultAggregations]);
    this.state = state;
    this.specRecord = specRecord;
    this.activities = Object.freeze([...activities]);
    this.activityEvidence = Object.freeze([...activityEvidence]);
    this.identityBasis = Object.freeze([...identityBasis]);
    Object.freeze(this);
  }

  static plan(source, definition) {
    for (const field of Object.keys(source.flow)) {
      if (!KNOWN_FLOW_FIELDS.has(field)) {
        const pointer = `/${jsonPointerSegment(field)}`;
        throw new LegacyFlowMigrationError(
          "UNKNOWN_FLOW_FIELD",
          `unknown legacy flow field: ${pointer} (shape fingerprint: ${shapeFingerprint(source.flow[field])})`,
        );
      }
    }
    if (source.flow.spec !== undefined && source.flow.spec !== null) {
      if (typeof source.flow.spec !== "string") throw new LegacyFlowMigrationError("INVALID_SPEC_AUTHORITY", "legacy flow.spec must be a string when present");
      const declared = normalizedRelative(source.flow.spec, "legacy flow.spec");
      const segments = declared.split("/");
      if (!new Set(["spec.json", "spec.md"]).has(segments.at(-1)) || segments.at(-2) !== source.specId) {
        throw new LegacyFlowMigrationError("INVALID_SPEC_AUTHORITY", "legacy flow.spec does not confirm the same spec authority");
      }
    }
    const specRecord = canonicalSpecDocument(source);
    const directLegacyReviewPaths = legacySpecReviewPathsFromFiles(source.files);
    const directLifecycle = lifecycleFor(source.flow).state;
    if (directLegacyReviewPaths.length > 0 && !["finalized", "archived"].includes(directLifecycle)) {
      throw new LegacyFlowMigrationError(
        "UNPROVABLE_LEGACY_SPEC_REVIEW",
        `direct legacy review artifacts lack a Version catalog/immutable revision proof: ${directLegacyReviewPaths.join(", ")}`,
      );
    }
    const taskSpecPointers = flowTaskSpecPointers(source);
    const decisions = [];
    const runtimeResidues = [];
    const occupiedDestinations = new Map([
      ["flow.json", null], ["spec.json", null], ["activities.jsonl", null], ["flow-migration-report.json", null],
    ]);
    for (const file of source.files) {
      const decision = directLegacyReviewPaths.includes(file.sourcePath)
        ? preservedLegacyArtifact(file.sourcePath, "UNPROVEN_FINALIZED_LEGACY_SPEC_REVIEW_ARCHIVED")
        : artifactDecision(file, source);
      if (decision === null) continue;
      if (decision instanceof LegacyRuntimeResidue) {
        runtimeResidues.push(decision);
        continue;
      }
      if (decision.destination !== null && occupiedDestinations.has(decision.destination)) {
        const existing = occupiedDestinations.get(decision.destination);
        if (existing === null || !sharesAttemptHistoryDestination(existing, decision)) {
          decisions.push(preservedLegacyArtifact(file.sourcePath, "COLLIDING_LEGACY_VARIANT"));
          continue;
        }
      }
      if (decision.destination !== null) occupiedDestinations.set(decision.destination, decision);
      decisions.push(decision);
    }
    const permanentReferences = new LegacyPermanentArtifactReferences({ source, decisions });
    // Resolve direct retry evidence against the same historical node identity
    // projection, then rebuild state with only each leaf's observed maximum.
    // This deliberately leaves aggregate counters and the dormant current
    // Attempt untouched.
    const unsequencedState = canonicalHistoricalState(source, definition, permanentReferences);
    const attemptEvidence = LegacyAttemptSequenceEvidence.from(source, unsequencedState);
    const provisionalState = canonicalHistoricalState(source, definition, permanentReferences, attemptEvidence);
    const resultAggregations = LegacyResultAggregation.fromDecisions(source, decisions, permanentReferences);
    // A malformed or conflicting source result is a classification failure,
    // not a late transaction failure.  Preflight every aggregate before any
    // unrelated Spec can be swapped.
    for (const aggregation of resultAggregations) aggregation.bytes();
    const runtimeEvidence = runtimeLogEvidence(source, provisionalState);
    const evidenceLedger = directEvidenceActivities(source, provisionalState, decisions, runtimeEvidence);
    const activities = evidenceLedger.activities;
    const state = provisionalState.withConfirmationOrder(activities.length);
    const mappings = [
      new MigrationMapping({ classification: "converted", source: "spec.json", pointer: null, destination: "spec.json", reason: "CANONICAL_SPEC_RECORD" }),
    ];
    const evidencePointers = new Set(evidenceLedger.inputs
      .filter((input) => input.source === "flow.json" && input.pointer !== null)
      .map((input) => input.pointer));
    mappings.push(...historicalFlowMappings(
      source,
      state,
      runtimeEvidence,
      taskSpecPointers,
      evidencePointers,
      new Set(attemptEvidence.convertedPointers),
    ));
    for (const decision of decisions) {
      mappings.push(new MigrationMapping({
        classification: decision.classification,
        source: decision.sourcePath,
        destination: decision.destination,
        reason: decision.reason,
      }));
    }
    mappings.push(...runtimeResidues.map((entry) => entry.mapping()));
    mappings.push(...missingTransientMappings(source));
    mappings.push(new MigrationMapping({
      classification: "generated",
      destination: "activities.jsonl",
      reason: activities.length === 0 ? "NO_DIRECT_ACTIVITY" : "DIRECT_EVIDENCE_ACTIVITY",
      inputs: evidenceLedger.inputs,
    }));
    mappings.push(...evidenceLedger.evidence.map((entry) => entry.mapping()));
    const flowSnapshot = new LegacyFlowAuthoritySnapshot(source);
    mappings.push(new MigrationMapping({
      classification: "generated",
      destination: flowSnapshot.destination,
      reason: "RAW_LEGACY_FLOW_AUTHORITY",
      inputs: [flowSnapshot.input()],
    }));
    mappings.push(new MigrationMapping({
      classification: "generated",
      destination: "flow-migration-report.json",
      reason: "MIGRATION_REPORT",
      inputs: source.files.map((file) => new MigrationInput({ source: file.sourcePath, hash: file.hash })),
    }));
    mappings.push(new MigrationMapping({
      classification: "generated",
      destination: "artifact-catalog.json",
      reason: "MIGRATION_ARTIFACT_CATALOG",
      inputs: source.files.map((file) => new MigrationInput({ source: file.sourcePath, hash: file.hash })),
    }));
    const fieldManifest = new LegacyFlowFieldManifest({ flow: source.flow, mappings });
    return new SpecsMigrationCandidate({
      source,
      definition,
      mappings,
      fieldManifest,
      flowSnapshot,
      decisions,
      runtimeResidues,
      resultAggregations,
      state,
      specRecord,
      activities,
      activityEvidence: evidenceLedger.evidence,
      identityBasis: identityBasisFor(source, state),
    });
  }

  report() {
    return new MigrationReport({
      migration: {
        component: JOURNAL_COMPONENT,
        revision: REVISION,
        fingerprintVersion: TREE_FINGERPRINT_VERSION,
        sourceFormat: this.source.format.toJSON(),
        sourceFlowHash: this.source.flowHash,
        identityBasis: this.identityBasis.map((entry) => entry.toJSON()),
        creationAuthority: this.state.history.creation.toJSON(),
        fieldCoverage: this.fieldManifest.summary(),
      },
      sourceFiles: this.source.files.map((file) => ({
        path: file.sourcePath, kind: "file", hash: file.hash, size: file.size,
      })),
      target: {
        specId: this.source.specId,
        version: REVISION,
        directory: VERSION_DIRECTORY,
        flowId: this.state.flowId,
        flowVersionId: this.state.flowVersionId,
        runId: this.state.runId,
      },
      mappings: this.mappings,
    });
  }

  materialize(location, { targetRevision = 1, directoryAuthority = null } = {}) {
    if (!(location instanceof FlowVersionLocation) || !location.isStaging || location.specId.toString() !== this.source.specId) {
      throw new Error("Specs migration materialization requires its staging Version location");
    }
    const stateSerializer = new CurrentFlowStateSerializer({
      validator: new CurrentFlowStateValidator({ definition: this.definition }),
    });
    const authority = directoryAuthority ?? RealDirectoryAuthority.resolve(path.dirname(location.directory))
      .createExclusiveChild(path.basename(location.directory), { creationMode: 0o755 });
    if (authority.directory !== path.resolve(location.directory)) throw new Error("Specs materialization authority does not match its staging location");
    authority.assertStable();
    writeExclusive(location.flowStateFile, stateSerializer.bytes(this.state));
    const activityBytes = this.activities.length === 0
      ? Buffer.alloc(0)
      : Buffer.from(`${this.activities.map((activity) => JSON.stringify(activity.toJSON())).join("\n")}\n`, "utf8");
    writeExclusive(location.activitiesFile, activityBytes);
    writeExclusive(location.specFile, Buffer.from(this.specRecord.canonicalText, "utf8"));
    const descriptors = [
      descriptorForCanonical(location, "flow.state", "application/json"),
      descriptorForCanonical(location, "flow.activities", "application/x-ndjson"),
      descriptorForCanonical(location, "spec.record", "application/json"),
    ];
    if (targetRevision >= 2) {
      const parameters = { revision: "001" };
      const bytes = Buffer.from(this.specRecord.canonicalText, "utf8");
      writeExclusive(location.artifact("spec.snapshot", parameters), bytes);
      descriptors.push(
        descriptorForCanonical(location, "spec.snapshot", "application/json", parameters),
      );
      const archivedLegacyReview = this.decisions.filter((decision) => (
        decision.reason === "UNPROVEN_FINALIZED_LEGACY_SPEC_REVIEW_ARCHIVED"
      ));
      if (archivedLegacyReview.length > 0) {
        const reviewReportPath = "artifacts/migration/spec-review-conversion.json";
        writeExclusive(location.resolve(reviewReportPath), Buffer.from(`${JSON.stringify({
          schemaRevision: 1,
          relation: "revision-scoped-canonical-review",
          classification: "archived-unproven",
          lifecycle: this.state.lifecycle.state,
          sources: archivedLegacyReview.map((decision) => {
            const source = this.source.files.find((file) => file.sourcePath === decision.sourcePath);
            return { sourcePath: decision.sourcePath, hash: source.hash, binding: "legacy-source-snapshot" };
          }),
          destination: null,
        }, null, 2)}\n`, "utf8"));
        descriptors.push(FlowArtifactDescriptor.fromFile({
          location,
          authoritySlot: migrationSlot(reviewReportPath),
          relativePath: reviewReportPath,
          mediaType: "application/json",
          retention: "permanent",
          migrationMaterialization: true,
        }));
      }
    }
    descriptors.push(this.flowSnapshot.materialize(location));
    for (const evidence of this.activityEvidence) descriptors.push(evidence.materialize(location));
    const aggregatedSources = new Set(this.resultAggregations.flatMap((aggregate) => aggregate.sourcePaths()));
    for (const decision of this.decisions) {
      const file = this.source.files.find((entry) => entry.sourcePath === decision.sourcePath);
      if (decision.classification === "omitted" || aggregatedSources.has(decision.sourcePath)) continue;
      decision.materialize(location, file);
      if (decision.classification === "relocatedTransient") continue;
      descriptors.push(descriptorForDecision(location, decision, file.sourcePath));
    }
    for (const residue of this.runtimeResidues) {
      const file = this.source.files.find((entry) => entry.sourcePath === residue.sourcePath);
      residue.materialize(location, file);
    }
    for (const aggregate of this.resultAggregations) {
      writeExclusive(location.resolve(aggregate.destination), aggregate.bytes());
      descriptors.push(descriptorForResolvedArtifact(location, aggregate.resolved, "application/json"));
    }
    const reportPath = location.resolve("flow-migration-report.json");
    writeExclusive(reportPath, Buffer.from(`${JSON.stringify(this.report().toJSON(), null, 2)}\n`, "utf8"));
    descriptors.push(FlowArtifactDescriptor.fromFile({
      location,
      authoritySlot: migrationSlot("flow-migration-report.json"),
      relativePath: "flow-migration-report.json",
      mediaType: "application/json",
      retention: "permanent",
      migrationMaterialization: true,
    }));
    new FlowArtifactCatalogStore({ location }).initializeMigration(new FlowArtifactCatalog({ artifacts: descriptors }));
    authority.assertStable();
    return location;
  }
}

function descriptorForCanonical(location, logicalKey, mediaType, parameters = {}) {
  const artifact = FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, parameters);
  return FlowArtifactDescriptor.fromFile({ location, ...artifact.publication({ mediaType }) });
}

function descriptorForResolvedArtifact(location, resolved, mediaType) {
  const publication = resolved.logicalKey === "review.evidence"
    ? resolved.publication({ mediaType, updater: resolved.publicationStep() })
    : resolved.publication({ mediaType });
  return FlowArtifactDescriptor.fromFile({ location, ...publication });
}

function descriptorForDecision(location, decision, sourcePath) {
  if (decision.resolved !== null) {
    return descriptorForResolvedArtifact(location, decision.resolved, mediaTypeFor(sourcePath));
  }
  return FlowArtifactDescriptor.fromFile({
    location,
    authoritySlot: migrationSlot(decision.sourcePath),
    relativePath: decision.destination,
    mediaType: mediaTypeFor(sourcePath),
    retention: "permanent",
    migrationMaterialization: true,
  });
}

function realDirectoryOrNull(directory, label) {
  const stat = lstatOrNull(directory);
  if (stat === null) return null;
  return assertRealDirectory(directory, label);
}

function assertEmptyDirectory(directory, label) {
  const authority = assertRealDirectory(directory, label);
  if (authority.entries().length !== 0) throw new Error(`${label} must be empty`);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function safeTransactionNames(specId, stageName, backupName) {
  const token = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const stage = new RegExp(`^\\.${VERSION_DIRECTORY}\\.migrate-${token}\\.tmp$`);
  const backup = new RegExp(`^\\.${escapeRegExp(specId)}\\.sennel-migrate-specs-backup-${token}$`);
  if (!stage.test(stageName) || !backup.test(backupName)
    || path.basename(stageName) !== stageName || path.basename(backupName) !== backupName) {
    throw new Error("specs migration journal contains unsafe stage or backup names");
  }
}

class SpecsMigrationIdentityEvidence {
  constructor(value, specRoot) {
    if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== "execution,flowId,flowVersionId,issue,lifecycle,runId,specId") {
      throw new Error("Specs journal identity evidence is invalid");
    }
    new MigrationFlowIdentity(value, specRoot.relativePath);
    this.state = Object.freeze(structuredClone(value));
    Object.freeze(this);
  }

  static capture(state, specRoot) {
    return new SpecsMigrationIdentityEvidence({ flowId: state.flowId, flowVersionId: state.flowVersionId,
      runId: state.runId, specId: state.specId, issue: state.issue,
      lifecycle: state.lifecycle.toJSON(), execution: state.execution.toJSON() }, specRoot);
  }

  assert(root, specRoot) {
    assertMigrationFlowAuthority({ root, specRoot, specId: this.state.specId,
      states: [this.state], versions: [1], currentState: this.state });
  }

  toJSON() { return structuredClone(this.state); }
}

/** Journal-backed root swap; a legacy root is never overwritten in place. */
export class SpecsMigrationTransaction {
  constructor({ root, specRoot, specId, faultInjector = () => {}, targetRevision = 1 } = {}) {
    this.root = path.resolve(root);
    this.specRoot = specRoot;
    this.specId = FlowSpecIdentity.from(specId).toString();
    if (targetRevision !== 1 && targetRevision !== 2) throw new Error("Specs migration target revision is invalid");
    this.targetRevision = targetRevision;
    if (!specRoot || typeof specRoot.relativePath !== "string") throw new Error("Specs migration transaction requires a resolved spec root");
    if (typeof faultInjector !== "function") throw new Error("Specs migration transaction fault injector must be a function");
    this.specDirectory = path.join(this.root, ...specRoot.relativePath.split("/"), this.specId);
    // Specs and layout revisions are independently runnable. A specs-only
    // transaction must not materialize the canonical managed root, because
    // that would make a later layout migration incorrectly become a no-op.
    this.journalDirectory = journalDirectoryFor(this.root);
    this.journalPath = path.join(this.journalDirectory, new MigrationSpecSelection(this.specId).journalFileName(specRoot));
    this.faultInjector = faultInjector;
    Object.freeze(this);
  }

  static recoverAll({ root, specRoot, dryRun, selection = MigrationSpecSelection.from(null) }) {
    const journalDirectory = journalDirectoryFor(root);
    const stat = lstatOrNull(journalDirectory);
    if (stat === null) return Object.freeze([]);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("specs migration recovery directory is unsafe");
    const recoveries = [];
    for (const entry of selection.recoveryEntries(specRoot, journalDirectory)) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) throw new Error("specs migration recovery directory contains an unsafe entry");
      const journalPath = path.join(journalDirectory, entry.name);
      const journal = new AtomicJsonFile(journalPath).read(null);
      if (["revision-two", "revision-three", "revision-four", "revision-five", "revision-six"].includes(journal?.rootTransaction)) {
        recoveries.push(CanonicalRevisionRootTransaction.recoverFromJournal({
          root, specRoot, journal, journalPath, dryRun,
        }));
        continue;
      }
      const transaction = SpecsMigrationTransaction.fromJournal({ root, specRoot, journal, journalPath });
      recoveries.push(transaction.recover({ dryRun }));
    }
    if (!dryRun && recoveries.length > 0) removeEmptyJournalDirectory(journalDirectory);
    return Object.freeze(recoveries);
  }

  static fromJournal({ root, specRoot, journal, journalPath } = {}) {
    if (!isPlainObject(journal) || journal.schemaRevision !== JOURNAL_SCHEMA_REVISION || journal.fingerprintVersion !== TREE_FINGERPRINT_VERSION || journal.component !== JOURNAL_COMPONENT
      || journal.revision !== REVISION || journal.specRoot !== specRoot.relativePath || typeof journal.specId !== "string"
      || ![1, 2].includes(journal.targetRevision)
      || typeof journal.stageName !== "string" || typeof journal.backupName !== "string"
      || typeof journal.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(journal.sourceHash)
      || typeof journal.stageHash !== "string" || !/^[a-f0-9]{64}$/.test(journal.stageHash)) {
      throw new Error("specs migration journal is invalid");
    }
    const transaction = new SpecsMigrationTransaction({ root, specRoot, specId: journal.specId, targetRevision: journal.targetRevision });
    if (transaction.journalPath !== journalPath) throw new Error("specs migration journal identity does not match its path");
    safeTransactionNames(transaction.specId, journal.stageName, journal.backupName);
    FileIdentity.fromStored(journal.sourceDirectoryIdentity);
    FileIdentity.fromStored(journal.stageDirectoryIdentity);
    storedSourceGenerations(journal.sourceFiles);
    new SpecsMigrationIdentityEvidence(journal.identity, specRoot);
    if (!["stage-validated", "source-backed-up", "target-created", "stage-placed", "cleanup"].includes(journal.phase)) {
      throw new Error("Specs migration journal phase is invalid");
    }
    if (journal.targetDirectoryIdentity !== null) FileIdentity.fromStored(journal.targetDirectoryIdentity);
    return transaction;
  }

  #journal() {
    const journal = new AtomicJsonFile(this.journalPath).read(null);
    SpecsMigrationTransaction.fromJournal({ root: this.root, specRoot: this.specRoot, journal, journalPath: this.journalPath });
    return journal;
  }

  #assertSourceSnapshot(directory, journal, { ignoredNames = [] } = {}) {
    const authority = assertRealDirectory(directory, "specs migration source directory");
    const actual = authority.identity;
    const expected = FileIdentity.fromStored(journal.sourceDirectoryIdentity);
    if (!sameFileIdentity(actual, expected)) throw new Error("specs migration source directory identity does not match its journal");
    if (treeFingerprint(directory, { ignoredNames }) !== journal.sourceHash) {
      throw new Error("specs migration source entries do not match their journal hash");
    }
    for (const file of storedSourceGenerations(journal.sourceFiles)) file.assert(directory);
    authority.assertStable();
    return authority;
  }

  #assertStageSnapshot(directory, journal) {
    const authority = assertRealDirectory(directory, "specs migration stage directory");
    const actual = authority.identity;
    const expected = FileIdentity.fromStored(journal.stageDirectoryIdentity);
    if (!sameFileIdentity(actual, expected)) throw new Error("specs migration stage directory identity does not match its journal");
    if (treeFingerprint(directory) !== journal.stageHash) {
      throw new Error("specs migration stage entries do not match their journal hash");
    }
    authority.assertStable();
    return authority;
  }

  #assertOwnedPlacedStage(directory, journal) {
    const authority = assertRealDirectory(directory, "specs migration placed Version target");
    const actual = authority.identity;
    const expected = FileIdentity.fromStored(journal.stageDirectoryIdentity);
    if (!sameFileIdentity(actual, expected)) {
      throw new Error("specs migration placed Version target identity does not match its journal; refusing rollback");
    }
    return authority;
  }

  /**
   * Restores the source only after proving that both sides still belong to
   * this transaction. A hash-invalid but identity-owned stage is never a
   * completed Version; keeping it would permanently strand the authority.
   */
  #rollbackInvalidPlacedStage({ backup, target, journal }) {
    this.#assertSourceSnapshot(backup, journal);
    const rootAuthority = this.#assertTargetRoot(this.specDirectory, target);
    this.#assertOwnedPlacedStage(target, journal).removeTree();
    rootAuthority.assertStable();
    assertEmptyDirectory(this.specDirectory, "specs migration invalid target root");
    rootAuthority.remove();
    new RealDirectoryAuthority(path.dirname(this.specDirectory)).assertStable();
    this.#assertSourceSnapshot(backup, journal).moveTo(this.specDirectory);
    new RealDirectoryAuthority(path.dirname(this.specDirectory)).assertStable();
    new AtomicFile(this.journalPath).remove();
    new RealDirectoryAuthority(this.journalDirectory).assertStable();
    removeEmptyJournalDirectory(this.journalDirectory);
    return Object.freeze({ specId: this.specId, recovered: "rolled-back-invalid-target" });
  }

  #discardStagingAfterSourceChange() {
    const journal = this.#journal();
    const sourceIdentity = directoryIdentity(this.specDirectory, "specs migration source directory");
    const expectedSourceIdentity = FileIdentity.fromStored(journal.sourceDirectoryIdentity);
    if (!sameFileIdentity(sourceIdentity, expectedSourceIdentity)) {
      throw new Error("cannot discard staging after a source directory identity change");
    }
    const stage = path.join(this.specDirectory, journal.stageName);
    this.#assertStageSnapshot(stage, journal).removeTree();
    new RealDirectoryAuthority(this.specDirectory).assertStable();
    new AtomicFile(this.journalPath).remove();
    new RealDirectoryAuthority(this.journalDirectory).assertStable();
    removeEmptyJournalDirectory(this.journalDirectory);
  }

  #assertTargetRoot(source, target) {
    const authority = assertRealDirectory(source, "specs migration target root");
    const journal = this.#journal();
    const expected = FileIdentity.fromStored(journal.targetDirectoryIdentity);
    if (!sameDirectoryIdentity(source, expected, "specs migration target root")) {
      throw new Error("specs migration target root generation changed");
    }
    assertRealDirectory(target, "specs migration Version target");
    const entries = fs.readdirSync(source);
    if (entries.length !== 1 || entries[0] !== VERSION_DIRECTORY) {
      throw new Error("specs migration target root contains unexpected entries");
    }
    authority.assertStable();
    return authority;
  }

  #validateCanonicalTarget() {
    const location = new FlowVersionLocation({
      repositoryRoot: this.root,
      authorityScope: FlowVersionAuthorityScope.canonical(),
      specRoot: this.specRoot.relativePath,
      specId: this.specId,
      version: REVISION,
    });
    if (this.targetRevision < 2) {
      return new HistoricalCanonicalVersionValidator({
        root: this.root, specRoot: this.specRoot, specId: this.specId,
        version: VERSION_DIRECTORY, definition: buildCurrentFlowDefinition(), allowPreRevisionMigration: true,
      }).validate();
    }
    return new CurrentFlowVersionStore({
      location,
      definition: buildCurrentFlowDefinition(),
    }).load();
  }

  #validateStagingTarget(location, definition) {
    if (this.targetRevision < 2) {
      // Migration-only pre-v2 proof. Normal runtime never opens this shape.
      const catalog = new FlowArtifactCatalog(parseObject(captureRegularFile(location.catalogFile, MIGRATION_READ_OPTIONS).bytes, "staged legacy artifact-catalog.json"));
      catalog.verify(location);
      const state = new CurrentFlowState(parseObject(captureRegularFile(location.flowStateFile, MIGRATION_READ_OPTIONS).bytes, "staged legacy flow.json"), { definition });
      const spec = new CurrentFlowSpecRecord(parseObject(captureRegularFile(location.specFile, MIGRATION_READ_OPTIONS).bytes, "staged legacy spec.json"), { specId: location.specId.toString() });
      if (state.identity.specId.toString() !== location.specId.toString() || !spec.specId.equals(location.specId)) {
        throw new LegacyFlowMigrationError("VERSION_IDENTITY_MISMATCH", "staged legacy Flow identity does not match its Version root");
      }
      return state;
    }
    return new CurrentFlowVersionStore({
      location,
      definition,
      allowStaging: true,
    }).load();
  }

  recover({ dryRun }) {
    if (dryRun) return this.#recoverCaptured({ dryRun });
    const snapshot = captureRegularFile(this.journalPath, MIGRATION_READ_OPTIONS);
    this.#recoverCaptured({ dryRun: true });
    return withRepositoryMigrationExclusion(this.root, { revalidate: () => {
      const current = captureRegularFile(this.journalPath, { ...MIGRATION_READ_OPTIONS, expectedIdentity: snapshot.identity });
      if (snapshot.digest !== current.digest) throw new Error("Specs journal changed before recovery");
      this.#journal();
      this.#recoverCaptured({ dryRun: true });
    } }, () => this.#recoverCaptured({ dryRun }));
  }

  #recoverCaptured({ dryRun }) {
    const journal = this.#journal();
    const backup = path.join(path.dirname(this.specDirectory), journal.backupName);
    const stageInSource = path.join(this.specDirectory, journal.stageName);
    const stageInBackup = path.join(backup, journal.stageName);
    const target = path.join(this.specDirectory, VERSION_DIRECTORY);
    const source = realDirectoryOrNull(this.specDirectory, "specs migration source root");
    const backupStat = realDirectoryOrNull(backup, "specs migration backup root");
    const targetStat = realDirectoryOrNull(target, "specs migration Version target");
    const stageSourceStat = realDirectoryOrNull(stageInSource, "specs migration source staging");
    const stageBackupStat = realDirectoryOrNull(stageInBackup, "specs migration backup staging");
    const sourceExists = source !== null;
    const backupExists = backupStat !== null;
    const targetExists = targetStat !== null;
    new SpecsMigrationIdentityEvidence(journal.identity, this.specRoot).assert(this.root, this.specRoot);
    if (dryRun) {
      return Object.freeze({
        specId: this.specId,
        requiresRecovery: true,
        state: { sourceExists, backupExists, targetExists, stageInSource: stageSourceStat !== null, stageInBackup: stageBackupStat !== null },
      });
    }
    if (sourceExists && stageSourceStat !== null && !backupExists) {
      this.#assertSourceSnapshot(this.specDirectory, journal, { ignoredNames: [journal.stageName] });
      this.#assertStageSnapshot(stageInSource, journal).removeTree();
      new AtomicFile(this.journalPath).remove();
      removeEmptyJournalDirectory(this.journalDirectory);
      new RealDirectoryAuthority(this.specDirectory).assertStable();
      return Object.freeze({ specId: this.specId, recovered: "discarded-staging" });
    }
    if (!sourceExists && backupExists && stageBackupStat !== null) {
      this.#assertSourceSnapshot(backup, journal, { ignoredNames: [journal.stageName] });
      this.#assertStageSnapshot(stageInBackup, journal);
      RealDirectoryAuthority.resolve(path.dirname(this.specDirectory)).createExclusiveChild(path.basename(this.specDirectory), { creationMode: 0o755 });
      new AtomicJsonFile(this.journalPath).write({ ...journal, phase: "target-created",
        targetDirectoryIdentity: directoryIdentity(this.specDirectory, "Specs recovery target root") });
      new RealDirectoryAuthority(stageInBackup).moveTo(target);
      this.#assertTargetRoot(this.specDirectory, target);
      this.#assertStageSnapshot(target, journal);
      this.#validateCanonicalTarget();
      new RealDirectoryAuthority(path.dirname(this.specDirectory)).assertStable();
      this.#assertSourceSnapshot(backup, journal).removeTree();
      new AtomicFile(this.journalPath).remove();
      removeEmptyJournalDirectory(this.journalDirectory);
      return Object.freeze({ specId: this.specId, recovered: "placed-staging" });
    }
    // Crash after `mkdir(source)` but before moving the staged Version out of
    // the renamed source is distinct from a missing source root.  The empty
    // directory is a known transaction window, never a reason to restore or
    // delete user content.
    if (sourceExists && backupExists && !targetExists && stageBackupStat !== null) {
      assertEmptyDirectory(this.specDirectory, "specs migration newly-created target root");
      if (!sameDirectoryIdentity(this.specDirectory, FileIdentity.fromStored(journal.targetDirectoryIdentity), "specs migration target root")) {
        throw new Error("specs migration target root generation changed before recovery");
      }
      this.#assertSourceSnapshot(backup, journal, { ignoredNames: [journal.stageName] });
      this.#assertStageSnapshot(stageInBackup, journal);
      new RealDirectoryAuthority(stageInBackup).moveTo(target);
      this.#assertTargetRoot(this.specDirectory, target);
      this.#assertStageSnapshot(target, journal);
      this.#validateCanonicalTarget();
      this.#assertSourceSnapshot(backup, journal).removeTree();
      new AtomicFile(this.journalPath).remove();
      removeEmptyJournalDirectory(this.journalDirectory);
      new RealDirectoryAuthority(path.dirname(this.specDirectory)).assertStable();
      return Object.freeze({ specId: this.specId, recovered: "placed-staging-after-source-mkdir" });
    }
    if (sourceExists && targetExists && backupExists) {
      // Prove the original authority before inspecting or deleting a placed
      // target. If either identity is unfamiliar, retain every byte and leave
      // recovery fail-closed for an operator.
      const backupAuthority = this.#assertSourceSnapshot(backup, journal);
      this.#assertTargetRoot(this.specDirectory, target);
      this.#assertOwnedPlacedStage(target, journal);
      try {
        this.#assertStageSnapshot(target, journal);
        this.#validateCanonicalTarget();
      } catch (_) {
        return this.#rollbackInvalidPlacedStage({ backup, target, journal });
      }
      backupAuthority.removeTree();
      new AtomicFile(this.journalPath).remove();
      removeEmptyJournalDirectory(this.journalDirectory);
      return Object.freeze({ specId: this.specId, recovered: "cleaned-backup" });
    }
    if (sourceExists && targetExists && !backupExists) {
      this.#assertTargetRoot(this.specDirectory, target);
      this.#assertStageSnapshot(target, journal);
      this.#validateCanonicalTarget();
      new AtomicFile(this.journalPath).remove();
      removeEmptyJournalDirectory(this.journalDirectory);
      return Object.freeze({ specId: this.specId, recovered: "cleared-complete" });
    }
    if (!sourceExists && backupExists && stageBackupStat === null) {
      this.#assertSourceSnapshot(backup, journal);
      new RealDirectoryAuthority(backup).moveTo(this.specDirectory);
      new RealDirectoryAuthority(path.dirname(this.specDirectory)).assertStable();
      new AtomicFile(this.journalPath).remove();
      removeEmptyJournalDirectory(this.journalDirectory);
      return Object.freeze({ specId: this.specId, recovered: "restored-source" });
    }
    throw new Error(`cannot safely recover specs migration for ${this.specId}`);
  }

  apply(candidate) {
    if (!(candidate instanceof SpecsMigrationCandidate)) {
      throw new Error("Specs migration transaction requires a candidate");
    }
    const revalidate = () => {
      candidate.source.assertUnchanged();
      assertMigrationFlowAuthority({ root: this.root, specRoot: this.specRoot, specId: this.specId,
        states: [candidate.state], versions: [1], currentState: candidate.state });
    };
    return withRepositoryMigrationExclusion(this.root, { revalidate }, () => this.#applyCaptured(candidate));
  }

  #applyCaptured(candidate) {
    assertRealDirectory(this.specDirectory, "legacy spec root");
    RealDirectoryAuthority.resolve(this.journalDirectory, { create: true, creationMode: 0o755 });
    assertRealDirectory(this.journalDirectory, "specs migration journal directory");
    const token = crypto.randomUUID();
    const location = new FlowVersionLocation({
      repositoryRoot: this.root,
      authorityScope: FlowVersionAuthorityScope.canonical(),
      specRoot: this.specRoot.relativePath,
      specId: this.specId,
      version: REVISION,
    }).stagingSibling(`migrate-${token}`);
    const stageName = path.basename(location.directory);
    const backupName = `.${this.specId}.sennel-migrate-specs-backup-${token}`;
    const backup = path.join(path.dirname(this.specDirectory), backupName);
    const stageAuthority = RealDirectoryAuthority.resolve(path.dirname(location.directory))
      .createExclusiveChild(path.basename(location.directory), { creationMode: 0o755 });
    let journalWritten = false;
    try {
      candidate.materialize(location, { targetRevision: this.targetRevision, directoryAuthority: stageAuthority });
      this.faultInjector({ phase: "stage-materialized", transaction: this, candidate, location });
      // A malformed canonical tree is a pre-swap failure.  It must never
      // become recoverable state merely because the source rename succeeded.
      this.#validateStagingTarget(location, candidate.definition);
      const stageIdentity = directoryIdentity(location.directory, "specs migration staging Version");
      const stageHash = treeFingerprint(location.directory);
      candidate.source.assertUnchanged({ ignoredNames: [stageName] });
      new AtomicJsonFile(this.journalPath).write({
        schemaRevision: JOURNAL_SCHEMA_REVISION,
        fingerprintVersion: TREE_FINGERPRINT_VERSION,
        component: JOURNAL_COMPONENT,
        revision: REVISION,
        targetRevision: this.targetRevision,
        specRoot: this.specRoot.relativePath,
        specId: this.specId,
        stageName,
        backupName,
        sourceHash: candidate.source.treeHash,
        stageHash,
        sourceDirectoryIdentity: candidate.source.directoryIdentity,
        stageDirectoryIdentity: stageIdentity,
        sourceFiles: candidate.source.files.map((file) => file.toJSON()),
        identity: SpecsMigrationIdentityEvidence.capture(candidate.state, this.specRoot).toJSON(),
        targetDirectoryIdentity: null,
        phase: "stage-validated",
      });
      journalWritten = true;
      this.faultInjector({ phase: "journal-written", transaction: this, candidate });
      // This is intentionally the final validation before changing the
      // source root.  A concurrent writer cannot make us swap entries or bytes
      // different from the preflighted conversion input.
      try {
        candidate.source.assertUnchanged({ ignoredNames: [stageName] });
      } catch (error) {
        if (error instanceof LegacyFlowMigrationError && error.code === "SOURCE_CHANGED") {
          try {
            this.#discardStagingAfterSourceChange();
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "specs migration source changed and staging cleanup failed",
              { cause: error },
            );
          }
        }
        throw error;
      }
      new RealDirectoryAuthority(this.specDirectory).moveTo(backup);
      new RealDirectoryAuthority(path.dirname(this.specDirectory)).assertStable();
      this.#assertSourceSnapshot(backup, this.#journal(), { ignoredNames: [stageName] });
      new AtomicJsonFile(this.journalPath).write({ ...this.#journal(), phase: "source-backed-up" });
      this.faultInjector({ phase: "source-backed-up", transaction: this, candidate });
      RealDirectoryAuthority.resolve(path.dirname(this.specDirectory)).createExclusiveChild(path.basename(this.specDirectory), { creationMode: 0o755 });
      new AtomicJsonFile(this.journalPath).write({ ...this.#journal(), phase: "target-created",
        targetDirectoryIdentity: directoryIdentity(this.specDirectory, "Specs created target root") });
      this.faultInjector({ phase: "source-directory-created", transaction: this, candidate });
      new RealDirectoryAuthority(path.join(backup, stageName)).moveTo(path.join(this.specDirectory, VERSION_DIRECTORY));
      new RealDirectoryAuthority(this.specDirectory).assertStable();
      this.#assertTargetRoot(this.specDirectory, path.join(this.specDirectory, VERSION_DIRECTORY));
      this.#assertStageSnapshot(path.join(this.specDirectory, VERSION_DIRECTORY), this.#journal());
      new AtomicJsonFile(this.journalPath).write({ ...this.#journal(), phase: "stage-placed" });
      this.faultInjector({ phase: "stage-placed", transaction: this, candidate });
      this.#validateCanonicalTarget();
      const backupAuthority = this.#assertSourceSnapshot(backup, this.#journal());
      new AtomicJsonFile(this.journalPath).write({ ...this.#journal(), phase: "cleanup" });
      backupAuthority.removeTree();
      new AtomicFile(this.journalPath).remove();
      removeEmptyJournalDirectory(this.journalDirectory);
      new RealDirectoryAuthority(path.dirname(this.specDirectory)).assertStable();
      return Object.freeze({ specId: this.specId, complete: true });
    } catch (error) {
      if (!journalWritten) {
        try { stageAuthority.removeTree(); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "specs migration staging cleanup failed", { cause: error });
        }
        removeEmptyJournalDirectory(this.journalDirectory);
      }
      throw error;
    }
  }
}

export function canonicalVersionDirectories(directory) {
  const versions = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!/^\d+$/.test(entry.name)) continue;
    let version;
    try {
      version = new FlowVersion(Number(entry.name));
    } catch (error) {
      throw new LegacyFlowMigrationError("INVALID_VERSION_TARGET", `canonical Version directory is invalid: ${entry.name}`);
    }
    if (version.pathSegment !== entry.name) {
      throw new LegacyFlowMigrationError("INVALID_VERSION_TARGET", `canonical Version directory is not normalized: ${entry.name}`);
    }
    const absolute = path.join(directory, entry.name);
    const stat = fs.lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new LegacyFlowMigrationError("UNSAFE_VERSION_TARGET", `canonical Version directory is not a real directory: ${entry.name}`);
    }
    versions.push(version.pathSegment);
  }
  return versions.sort(codeUnitOrder);
}

/** Migration-only proof for an historical numbered Version which the normal
 * runtime intentionally does not open.  It accepts only the known current
 * state/spec/catalog schema, proves all root authorities, and refuses to
 * infer continuation from an unknown historical layout. */
class HistoricalCanonicalVersionValidator {
  constructor({ root, specRoot, specId, version, definition, allowPreRevisionMigration = false, processEvidence = null } = {}) {
    this.location = new FlowVersionLocation({
      repositoryRoot: root,
      authorityScope: FlowVersionAuthorityScope.canonical(),
      specRoot: specRoot.relativePath,
      specId,
      version: Number.parseInt(version, 10),
    });
    this.definition = definition;
    this.processEvidence = processEvidence;
    this.allowPreRevisionMigration = allowPreRevisionMigration === true;
    Object.freeze(this);
  }

  validate() {
    const specBytes = captureRegularFile(this.location.specFile, MIGRATION_READ_OPTIONS).bytes;
    const spec = new CurrentFlowSpecRecord(parseObject(specBytes, `${this.location.specId}/${this.location.version}/spec.json`), {
      specId: this.location.specId.toString(),
    });
    if (!spec.specId.equals(this.location.specId)) {
      throw new LegacyFlowMigrationError("VERSION_IDENTITY_MISMATCH", "historical canonical spec identity does not match its Version root");
    }
    const catalog = FlowArtifactCatalog.fromSerialized(parseObject(captureRegularFile(this.location.catalogFile, MIGRATION_READ_OPTIONS).bytes, "historical artifact-catalog.json"));
    // `verify` proves descriptor path/hash/size and proves there is no
    // untracked catalog-managed file before a staged tree can be swapped.
    catalog.verify(this.location, null, { processEvidence: this.processEvidence });
    const rootSpec = catalog.resolve("spec.json");
    const rootFlow = catalog.resolve("flow.json");
    const activities = catalog.resolve("activities.jsonl");
    if (rootSpec.logicalKey !== "spec.record" || rootFlow.logicalKey !== "flow.state" || activities.logicalKey !== "flow.activities") {
      throw new LegacyFlowMigrationError("INVALID_VERSION_TARGET", "historical Version catalog does not bind root Flow authorities");
    }
    const state = new CurrentFlowState(PreviousFlowSchemaProjection.project(parseObject(captureRegularFile(this.location.flowStateFile, MIGRATION_READ_OPTIONS).bytes, "historical flow.json")), {
      definition: this.definition,
    });
    if (state.identity.specId.toString() !== this.location.specId.toString()) {
      throw new LegacyFlowMigrationError("VERSION_IDENTITY_MISMATCH", "historical Flow lifecycle identity does not match its Version root");
    }
    this.#assertRevisionAuthorities(catalog, specBytes);
    return state;
  }

  #assertRevisionAuthorities(catalog, rootSpecBytes) {
    const snapshots = new Map();
    const reviews = new Map();
    for (const descriptor of catalog.artifacts) {
      const snapshot = descriptor.relativePath.match(/^revisions\/(\d+)\/spec\.json$/);
      const review = descriptor.relativePath.match(/^revisions\/(\d+)\/review\.json$/);
      if (descriptor.logicalKey === "spec.snapshot") {
        if (snapshot === null) throw new LegacyFlowMigrationError("INVALID_VERSION_TARGET", "historical snapshot catalog path is invalid");
        snapshots.set(Number(snapshot[1]), descriptor);
      } else if (descriptor.logicalKey === "spec.review") {
        if (review === null) throw new LegacyFlowMigrationError("INVALID_VERSION_TARGET", "historical review catalog path is invalid");
        reviews.set(Number(review[1]), descriptor);
      } else if (snapshot !== null || review !== null) {
        throw new LegacyFlowMigrationError("INVALID_VERSION_TARGET", "revision authority path has an invalid catalog key");
      }
    }
    if (snapshots.size === 0 && reviews.size === 0) {
      if (this.allowPreRevisionMigration) return;
      throw new LegacyFlowMigrationError("MISSING_REVISION_AUTHORITY", "historical Version has no canonical Spec revision authority");
    }
    if (snapshots.size === 0 || [...reviews.keys()].some((revision) => !snapshots.has(revision))) {
      throw new LegacyFlowMigrationError("INCOMPLETE_REVISION_AUTHORITY", "historical Version review authority does not have a matching snapshot");
    }
    const currentRevision = Math.max(...snapshots.keys());
    const snapshot = snapshots.get(currentRevision);
    const snapshotBytes = captureRegularFile(this.location.resolve(snapshot.relativePath), MIGRATION_READ_OPTIONS).bytes;
    if (!snapshotBytes.equals(rootSpecBytes)) {
      throw new LegacyFlowMigrationError("REVISION_ROOT_MISMATCH", "historical root spec.json does not match its current immutable snapshot");
    }
    const reviewDescriptor = reviews.get(currentRevision) ?? null;
    if (reviewDescriptor === null) return;
    const reviewBytes = captureRegularFile(this.location.resolve(reviewDescriptor.relativePath), MIGRATION_READ_OPTIONS).bytes;
    const processEvidence = this.processEvidence
      ?? catalog.processStopEncoding(this.location, "spec.review", [reviewBytes]);
    const review = CanonicalSpecReview.fromBytes(reviewBytes, { processEvidence });
    if (review.identity.specId !== this.location.specId.toString()
      || review.identity.revision.value !== currentRevision
      || review.identity.digest !== sha256(snapshotBytes)
      || review.identity.byteLength !== snapshotBytes.length) {
      throw new LegacyFlowMigrationError("REVISION_REVIEW_IDENTITY_MISMATCH", "historical canonical review does not bind its immutable Spec snapshot");
    }
  }
}

function validateExistingVersion({ root, specRoot, specId, version, definition, allowPreRevisionMigration = false }) {
  const location = new FlowVersionLocation({
    repositoryRoot: root,
    authorityScope: FlowVersionAuthorityScope.canonical(),
    specRoot: specRoot.relativePath,
    specId,
    version: Number.parseInt(version, 10),
  });
  const raw = parseObject(captureRegularFile(location.flowStateFile, MIGRATION_READ_OPTIONS).bytes, "canonical Flow state");
  if (raw.schemaRevision === 3 && fs.existsSync(location.artifact("spec.snapshot", { revision: "001" }))) {
    return new CanonicalGateRepairMigrationPreflight({ location, definition }).inspect().state;
  }
  if (location.version.value !== 1) {
    return new HistoricalCanonicalVersionValidator({
      root, specRoot, specId, version, definition, allowPreRevisionMigration,
    }).validate();
  }
  const state = new HistoricalCanonicalVersionValidator({
    root, specRoot, specId, version, definition, allowPreRevisionMigration,
  }).validate();
  const spec = new CurrentFlowSpecRecord(
    parseObject(captureRegularFile(location.specFile, MIGRATION_READ_OPTIONS).bytes, `${specId}/${version}/spec.json`),
    { specId },
  );
  if (!spec.specId.equals(location.specId) || state.specId !== location.specId.toString()) {
    throw new LegacyFlowMigrationError("VERSION_IDENTITY_MISMATCH", "canonical flow and spec identities must match their Version location");
  }
  return state;
}

function directoryLooksLikeFlowCandidate(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "flow.json" || /^\d+$/.test(entry.name)) return true;
  }
  return false;
}

function rootEntryBlocker(code, entry, message) {
  return {
    specId: entry.name,
    blocker: new MigrationBlocker({ code, path: entry.name, message }),
  };
}

/** Public revision implementation registered by `sennel migrate specs --to 1`. */
export class SpecsMigrationRevisionOne {
  constructor(root, { dryRun = false, logger = console, targetRevision = 1, specId = null } = {}) {
    this.root = path.resolve(root);
    this.dryRun = dryRun === true;
    this.selection = MigrationSpecSelection.from(specId);
    if (targetRevision !== 1 && targetRevision !== 2) throw new Error("Specs migration target revision is invalid");
    this.targetRevision = targetRevision;
    if (!logger || typeof logger.log !== "function" || typeof logger.error !== "function") {
      throw new Error("Specs migration requires a logger");
    }
    this.logger = logger;
    this.definition = buildCurrentFlowDefinition();
    Object.freeze(this);
  }

  run() {
    ProcessExecutionRuntime.assertQuiescent({ mainRoot: this.root });
    const resolved = resolveMigrationSpecRoot(this.root);
    if (resolved.blocker) {
      this.logger.error(resolved.blocker.toString());
      return { complete: false };
    }
    const specRoot = resolved.root;
    const recovery = SpecsMigrationTransaction.recoverAll({ root: this.root, specRoot, dryRun: this.dryRun, selection: this.selection });
    if (recovery.some((entry) => entry.requiresRecovery)) {
      for (const entry of recovery) this.logger.error(`spec ${entry.specId}: RECOVERY_REQUIRED`);
      return { complete: false, requiresRecovery: true };
    }
    let entries;
    try { entries = this.selection.entries(specRoot); }
    catch (error) {
      this.logger.error(`${error.code ?? "SPEC_ROOT_INVALID"}: ${error.message}`);
      return { complete: false };
    }
    const candidates = [];
    const revisionCandidates = [];
    const failures = [];
    const existingVersions = [];
    const revisionPreflights = new Map();
    for (const entry of entries) {
      const directory = path.join(specRoot.path, entry.name);
      if (entry.isSymbolicLink()) {
        failures.push(rootEntryBlocker("UNSAFE_SPEC_ROOT_ENTRY", entry, "spec root contains a symbolic-link entry"));
        continue;
      }
      if (!entry.isDirectory()) {
        try {
          FlowSpecIdentity.from(entry.name);
          failures.push(rootEntryBlocker("UNSAFE_SPEC_ROOT_ENTRY", entry, "Flow-looking spec root entry is not a real directory"));
        } catch {
          // A non-Flow file directly below the configurable spec root is not
          // migration input and must not be interpreted.
        }
        continue;
      }
      let specId;
      try {
        specId = FlowSpecIdentity.from(entry.name).toString();
      } catch (_) {
        if (directoryLooksLikeFlowCandidate(directory)) {
          failures.push(rootEntryBlocker("INVALID_SPEC_IDENTITY", entry, "Flow-looking spec directory has an invalid spec identity"));
        }
        continue;
      }
      const flowPath = path.join(directory, "flow.json");
      let versions;
      try {
        versions = canonicalVersionDirectories(directory);
      } catch (error) {
        failures.push({ specId, blocker: new MigrationBlocker({ code: error.code ?? "INVALID_VERSION_TARGET", path: specId, message: error.message }) });
        continue;
      }
      const validVersions = new Set();
      for (const version of versions) {
        try {
          const location = new FlowVersionLocation({
            repositoryRoot: this.root,
            authorityScope: FlowVersionAuthorityScope.canonical(),
            specRoot: specRoot.relativePath,
            specId,
            version: Number(version),
          });
          const needsRevision = this.targetRevision >= 2
            && !fs.existsSync(location.artifact("spec.snapshot", { revision: "001" }));
          const preflight = needsRevision
            ? new LegacyCanonicalVersionPreflight({ directory: location.directory, location, definition: this.definition }).inspect()
            : null;
          const state = preflight?.state ?? validateExistingVersion({
            root: this.root, specRoot, specId, version, definition: this.definition,
          });
          if (preflight !== null) revisionPreflights.set(`${specId}/${version}`, preflight);
          existingVersions.push({ specId, version, state, path: `${specId}/${version}` });
          validVersions.add(version);
        } catch (error) {
          failures.push({
            specId,
            blocker: new MigrationBlocker({ code: error.code ?? "INVALID_VERSION_TARGET", path: `${specId}/${version}`, message: error.message }),
          });
        }
      }
      if (fs.existsSync(flowPath) && versions.length > 0) {
        failures.push({ specId, blocker: new MigrationBlocker({ code: "SOURCE_TARGET_CONFLICT", path: `${specId}/flow.json`, message: "legacy flow.json and Version directories coexist" }) });
        continue;
      }
      if (versions.length > 0) {
        const rootEntries = fs.readdirSync(directory);
        const versionNames = new Set(versions);
        const extra = rootEntries.filter((name) => !versionNames.has(name));
        if (extra.length > 0) {
          failures.push({
            specId,
            blocker: new MigrationBlocker({
              code: "MIXED_VERSION_ROOT",
              path: specId,
              message: `canonical Version root contains non-Version entries: ${extra.sort(codeUnitOrder).join(", ")}`,
            }),
          });
          continue;
        }
        if (this.dryRun && versions.every((version) => validVersions.has(version))) {
          const needsRevision = this.targetRevision >= 2 && versions.some((version) => !fs.existsSync(path.join(directory, version, "revisions", "001", "spec.json")));
          this.logger.log(JSON.stringify({
            component: "specs",
            specId,
            classification: needsRevision ? "versioned-v1-to-v2" : "versioned",
            versions,
            ...(needsRevision ? { continuationReady: false,
              requiredRevisions: [...new Set(versions.flatMap((version) => [2, ...(revisionPreflights.get(`${specId}/${version}`)?.requiredRevisions ?? [])]))],

              reviewConversions: versions.flatMap((version) => {
                const preflight = revisionPreflights.get(`${specId}/${version}`);
                if (preflight === undefined) return [];
                return [{
                  version,
                  classification: preflight.conversion === null ? "archived-unproven" : preflight.conversion.classification,
                  sources: preflight.conversion === null ? preflight.unprovenReview.paths : preflight.conversion.legacyPaths,
                }];
              }),
            } : {}),
          }));
        }
        if (!this.dryRun && this.targetRevision >= 2
          && versions.some((version) => !fs.existsSync(path.join(directory, version, "revisions", "001", "spec.json")))) {
          revisionCandidates.push(new CanonicalRevisionRootTransaction({
            root: this.root, specRoot, specId, definition: this.definition,
          }));
        }
        continue;
      }
      if (!fs.existsSync(flowPath)) continue;
      try {
        const source = LegacyFlowSource.inspect(directory, specId);
        const candidate = SpecsMigrationCandidate.plan(source, this.definition);
        candidates.push(candidate);
      } catch (error) {
        failures.push({ specId, blocker: new MigrationBlocker({ code: error.code ?? "UNSUPPORTED_LEGACY_FLOW", path: `${specId}/flow.json`, message: error.message }) });
      }
    }
    const records = [...existingVersions,
      ...candidates.map((candidate) => ({ specId: candidate.source.specId, state: candidate.state, version: "001" }))];
    const recordsBySpec = new Map();
    for (const record of records) {
      if (!recordsBySpec.has(record.specId)) recordsBySpec.set(record.specId, []);
      recordsBySpec.get(record.specId).push(record);
    }
    const authorityPreflight = new MigrationFlowAuthorityPreflight({ root: this.root, specRoot });
    for (const [specId, members] of recordsBySpec) {
      try {
        authorityPreflight.assert({ specId, states: members.map((entry) => entry.state),
          versions: members.map((entry) => Number(entry.version)),
          currentState: members.find((entry) => entry.version === "001")?.state ?? null });
      } catch (error) {
        failures.push({ specId, blocker: new MigrationBlocker({ code: error.code ?? "FLOW_TARGET_AUTHORITY_CORRUPT", path: specId, message: error.message }) });
      }
    }
    this.#markIdentityCollisions(records, failures, specRoot);
    const blocked = new Set(failures.map((entry) => entry.specId));
    for (const candidate of candidates) {
      if (blocked.has(candidate.source.specId)) continue;
      if (this.dryRun) {
        this.logger.log(JSON.stringify({ component: "specs", specId: candidate.source.specId, ...candidate.report().toJSON() }));
        continue;
      }
      try {
        new SpecsMigrationTransaction({ root: this.root, specRoot, specId: candidate.source.specId, targetRevision: this.targetRevision }).apply(candidate);
      } catch (error) {
        failures.push({
          specId: candidate.source.specId,
          blocker: new MigrationBlocker({ code: "TRANSACTION_FAILED", path: candidate.source.specId, message: error.message }),
        });
      }
    }
    for (const candidate of revisionCandidates) {
      if (blocked.has(candidate.specId)) continue;
      try {
        candidate.apply();
      } catch (error) {
        failures.push({
          specId: candidate.specId,
          blocker: new MigrationBlocker({ code: "TRANSACTION_FAILED", path: candidate.specId, message: error.message }),
        });
      }
    }
    for (const failure of failures) this.logger.error(`spec ${failure.specId}: ${failure.blocker.toString()}`);
    const failedSpecs = new Set(failures.map((failure) => failure.specId));
    const assessments = this.dryRun ? [] : [...recordsBySpec.keys()]
      .filter((specId) => !failedSpecs.has(specId))
      .map((specId) => inspectFlowMigrationRequirements({ root: this.root, specRoot, specId, definition: this.definition }))
      .filter((assessment) => assessment.classification === "migratable").map((assessment) => assessment.toJSON());
    return { complete: failures.length === 0, assessments };
  }

  #markIdentityCollisions(records, failures, specRoot) {
    const identities = records.map((record) => new MigrationFlowIdentity(record.state, specRoot.relativePath, Number(record.version)));
    const index = new MigrationFlowIdentityIndex(identities);
    const reported = new Map();
    for (const failure of failures) {
      if (!reported.has(failure.specId)) reported.set(failure.specId, new Set());
      reported.get(failure.specId).add(failure.blocker.code);
    }
    for (const identity of identities) {
      if (!reported.has(identity.specId)) reported.set(identity.specId, new Set());
      const codes = reported.get(identity.specId);
      for (const error of index.collisionsFor(identity)) {
        if (codes.has(error.code)) continue;
        codes.add(error.code);
        failures.push({ specId: identity.specId, blocker: new MigrationBlocker({
          code: error.code, path: identity.specId, message: error.message }) });
      }
    }
  }

}

/** Shared discovery and transaction policy for canonical revision migrations. */
class CanonicalRevisionMigrationRunner {
  constructor(root, { dryRun = false, logger = console, specId = null } = {}) {
    this.root = path.resolve(root);
    this.dryRun = dryRun === true;
    this.selection = MigrationSpecSelection.from(specId);
    this.logger = logger;
    this.definition = buildCurrentFlowDefinition();
    Object.freeze(this);
  }

  get revision() { throw new Error("canonical migration revision is required"); }
  get migrationClassification() { throw new Error("canonical migration classification is required"); }
  get blockedCode() { throw new Error("canonical migration blocker is required"); }
  inspectVersion() { throw new Error("canonical migration inspection is required"); }

  run() {
    ProcessExecutionRuntime.assertQuiescent({ mainRoot: this.root });
    const resolved = resolveMigrationSpecRoot(this.root);
    if (resolved.blocker) {
      this.logger.error(resolved.blocker.toString());
      return { complete: false };
    }
    const specRoot = resolved.root;
    const recovery = SpecsMigrationTransaction.recoverAll({
      root: this.root, specRoot, dryRun: this.dryRun, selection: this.selection,
    });
    if (recovery.some((entry) => entry.requiresRecovery)) {
      for (const entry of recovery) this.logger.error(`spec ${entry.specId}: RECOVERY_REQUIRED`);
      return { complete: false, requiresRecovery: true };
    }
    let entries;
    try { entries = this.selection.entries(specRoot); }
    catch (error) {
      this.logger.error(`${error.code ?? "SPEC_ROOT_INVALID"}: ${error.message}`);
      return { complete: false };
    }
    const candidates = [];
    const failures = [];
    const authorityPreflight = new MigrationFlowAuthorityPreflight({ root: this.root, specRoot });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      let specId;
      try { specId = FlowSpecIdentity.from(entry.name).toString(); }
      catch { continue; }
      const directory = path.join(specRoot.path, specId);
      try {
        if (fs.existsSync(path.join(directory, "flow.json"))) {
          throw new LegacyFlowMigrationError("REVISION_TWO_REQUIRED",
            `migrate specs --to 2 before revision ${this.revision}`);
        }
        const versions = canonicalVersionDirectories(directory);
        const plans = [];
        for (const version of versions) {
          const location = new FlowVersionLocation({
            repositoryRoot: this.root,
            authorityScope: FlowVersionAuthorityScope.canonical(),
            specRoot: specRoot.relativePath,
            specId,
            version: Number(version),
          });
          plans.push(this.inspectVersion({ location, version, specRoot, specId }));
        }
        const states = versions.map((version) => parseObject(captureRegularFile(path.join(directory, version, "flow.json"), MIGRATION_READ_OPTIONS).bytes, "migration source Flow"));
        authorityPreflight.assert({ specId,
          states, versions: versions.map(Number), currentState: states[versions.indexOf("001")] ?? null });
        if (this.dryRun) {
          this.logger.log(JSON.stringify({ component: "specs", specId, versions: plans }));
        } else if (plans.some((plan) => plan.classification === this.migrationClassification)) {
          candidates.push(new CanonicalRevisionRootTransaction({
            root: this.root, specRoot, specId, definition: this.definition, revision: this.revision,
          }));
        }
      } catch (error) {
        failures.push({ specId, error });
      }
    }
    for (const candidate of candidates) {
      try { candidate.apply(); }
      catch (error) { failures.push({ specId: candidate.specId, error }); }
    }
    for (const { specId, error } of failures) {
      this.logger.error(`spec ${specId}: ${error.code ?? this.blockedCode}: ${error.message}`);
    }
    const failedSpecs = new Set(failures.map((failure) => failure.specId));
    const assessments = this.dryRun ? [] : candidates.filter((candidate) => !failedSpecs.has(candidate.specId))
      .map((candidate) => inspectFlowMigrationRequirements({ root: this.root, specRoot, specId: candidate.specId, definition: this.definition }))
      .filter((assessment) => assessment.classification === "migratable").map((assessment) => assessment.toJSON());
    return { complete: failures.length === 0, assessments };
  }
}

/** Explicit canonical v3 to v4 migration for the dedicated Spec Gate repair leaf. */
export class SpecsMigrationRevisionThree extends CanonicalRevisionMigrationRunner {
  get revision() { return 3; }
  get migrationClassification() { return "canonical-v3-to-v4"; }
  get blockedCode() { return "REVISION_THREE_BLOCKED"; }

  inspectVersion({ location, version, specRoot, specId }) {
    const raw = parseObject(captureRegularFile(location.flowStateFile, MIGRATION_READ_OPTIONS).bytes, "canonical Flow state");
    if ([4, CURRENT_FLOW_SCHEMA_REVISION].includes(raw.schemaRevision)) {
      validateExistingVersion({ root: this.root, specRoot, specId, version, definition: this.definition });
      return { version, classification: "already-migrated", legacyAppliedCount: 0 };
    }
    const plan = new CanonicalGateRepairMigrationPreflight({ location, definition: this.definition }).inspect();
    return { version, classification: this.migrationClassification, legacyAppliedCount: plan.legacyAppliedCount };
  }
}

/** Explicit projection of retired Spec Gate repair question receipts. */
export class SpecsMigrationRevisionFour extends CanonicalRevisionMigrationRunner {
  get revision() { return 4; }
  get migrationClassification() { return "retired-gate-decision"; }
  get blockedCode() { return "REVISION_FOUR_BLOCKED"; }

  inspectVersion({ location, version, specRoot, specId }) {
    const raw = parseObject(captureRegularFile(location.flowStateFile, MIGRATION_READ_OPTIONS).bytes, "canonical Flow state");
    if (raw.schemaRevision === CURRENT_FLOW_SCHEMA_REVISION && CURRENT_FLOW_SCHEMA_REVISION !== 4) {
      validateExistingVersion({ root: this.root, specRoot, specId, version, definition: this.definition });
      return { version, classification: "already-migrated", legacyQuestionCount: 0 };
    }
    if (raw.schemaRevision !== 4) {
      throw new LegacyFlowMigrationError("REVISION_THREE_REQUIRED",
        "migrate specs --to 3 before revision 4");
    }
    const plan = new CanonicalGateDecisionMigrationPlan({ location, definition: this.definition }).inspect();
    if (plan === null) {
      validateExistingVersion({ root: this.root, specRoot, specId, version, definition: this.definition });
      return { version, classification: "already-migrated", legacyQuestionCount: 0 };
    }
    return { version, classification: this.migrationClassification,
      legacyQuestionCount: plan.oldActivityIds.length };
  }
}

/** Explicit schema-four migration into portable source authority contracts. */
export class SpecsMigrationRevisionFive extends CanonicalRevisionMigrationRunner {
  get revision() { return 5; }
  get migrationClassification() { return "portable-state-v5"; }
  get blockedCode() { return "REVISION_FIVE_BLOCKED"; }

  inspectVersion({ location, version, specRoot, specId }) {
    const plan = new CanonicalPortableStateMigrationPlan({ location, definition: this.definition }).inspect();
    if (plan === null) {
      validateExistingVersion({ root: this.root, specRoot, specId, version, definition: this.definition });
      return { version, classification: "already-migrated" };
    }
    return { version, classification: this.migrationClassification, sourceSchemaRevision: 4,
      targetSchemaRevision: CURRENT_FLOW_SCHEMA_REVISION };
  }
}

/** Explicit process-evidence leaf migration; Flow lifecycle state is unchanged. */
export class SpecsMigrationRevisionSix extends CanonicalRevisionMigrationRunner {
  get revision() { return 6; }
  get migrationClassification() { return "process-evidence-v6"; }
  get blockedCode() { return "REVISION_SIX_BLOCKED"; }
  inspectVersion({ location, version, specRoot, specId }) {
    const plan = new CanonicalProcessEvidenceMigrationPlan({ location, definition: this.definition }).inspect();
    if (plan === null) {
      validateExistingVersion({ root: this.root, specRoot, specId, version, definition: this.definition });
      return { version, classification: "already-migrated" };
    }
    return { version, classification: this.migrationClassification, processEvidenceRevision: 6,
      artifactCount: plan.processEvidence.replacements.length + plan.processEvidence.proofs.length };
  }
}

/** Public read-only classification. Runtime may report this value but cannot
 * use it to read legacy state or execute a migration. */
export class FlowMigrationAssessment {
  constructor({ classification, specId, sourceContract = null, requiredRevisions = [], code = null, message = null, cause = null }) {
    if (!["current", "absent", "migratable", "unsupported", "integrity-error"].includes(classification)) throw new TypeError("unknown Flow migration classification");
    FlowSpecIdentity.from(specId);
    if (!Array.isArray(requiredRevisions) || requiredRevisions.some((revision, index) => ![2, 3, 4, 5, 6].includes(revision)
      || (index > 0 && requiredRevisions[index - 1] >= revision))) throw new TypeError("Flow migration revisions must be ordered and unique");
    if ((classification === "migratable") !== (requiredRevisions.length > 0)) throw new TypeError("only migratable Flow may require revisions");
    this.classification = classification;
    this.specId = specId;
    this.sourceContract = sourceContract ?? (classification === "absent" ? null : "unrecognized-persisted-flow");
    this.requiredRevisions = Object.freeze([...requiredRevisions]);
    this.code = code;
    this.message = message ?? (classification === "migratable"
      ? `Flow ${specId} requires explicit specs migration revision(s) ${requiredRevisions.join(", ")}; canonical data is unchanged. Preview: sennel migrate specs --to ${requiredRevisions[0]} --spec ${specId} --dry-run`
      : null);
    if (this.sourceContract !== null && (typeof this.sourceContract !== "string" || this.sourceContract.trim() === "")) throw new TypeError("Flow migration source contract must be nonempty");
    if (["migratable", "unsupported", "integrity-error"].includes(classification)
      && (typeof this.message !== "string" || this.message.trim() === "")) throw new TypeError("Flow migration diagnosis requires a message");
    this.cause = cause;
    Object.freeze(this);
  }

  toJSON() {
    const migrations = this.requiredRevisions.map((revision) => {
      const command = `sennel migrate specs --to ${revision} --spec ${this.specId}`;
      return { revision, dryRunCommand: `${command} --dry-run`, applyCommand: command };
    });
    return { specId: this.specId, sourceContract: this.sourceContract,
      requiredRevisions: this.requiredRevisions, targetMigrationRevision: this.requiredRevisions[0] ?? null,
      dryRunCommand: migrations[0]?.dryRunCommand ?? null, migrations,
      canonicalChanged: false, continuationReady: this.classification === "current" };
  }
}

export function inspectFlowMigrationRequirements({ root, specRoot, specId, version = 1, definition = buildCurrentFlowDefinition() }) {
  let sourceContract = null;
  const result = (classification, options = {}) => new FlowMigrationAssessment({ classification, specId, sourceContract, ...options });
  try {
    const resolved = specRoot === undefined ? resolveMigrationSpecRoot(root) : { root: { relativePath: typeof specRoot === "string" ? specRoot : specRoot.relativePath } };
    if (resolved.blocker) throw new Error(resolved.blocker.toString());
    const location = new FlowVersionLocation({ repositoryRoot: root, authorityScope: FlowVersionAuthorityScope.canonical(),
      specRoot: resolved.root.relativePath, specId, version: Number(version) });
    const directory = path.dirname(location.directory);
    if (!fs.existsSync(location.directory)) {
      return fs.existsSync(path.join(directory, "flow.json"))
        ? result("unsupported", { code: "FLOW_FORMAT_UNSUPPORTED", message: "pre-Version Flow requires explicit historical migration" })
        : result("absent");
    }
    assertRealDirectory(directory, "Flow spec root");
    const versions = canonicalVersionDirectories(directory);
    if (fs.existsSync(path.join(directory, "flow.json"))) throw new LegacyFlowMigrationError("SOURCE_TARGET_CONFLICT", "legacy flow.json and Version directories coexist");
    if (fs.readdirSync(directory).some((entry) => !versions.includes(entry))) throw new LegacyFlowMigrationError("MIXED_VERSION_ROOT", "canonical spec root contains non-Version entries");
    assertRealDirectory(location.directory, "Flow Version");
    const raw = parseObject(captureRegularFile(location.flowStateFile, MIGRATION_READ_OPTIONS).bytes, "flow.json");
    sourceContract = `${fs.existsSync(location.artifact("spec.snapshot", { revision: "001" })) ? "spec-revision-layout" : "versioned-v1-artifact-layout"}/flow-schema-${raw.schemaRevision}`;
    if (raw.version !== 1 || ![3, 4, CURRENT_FLOW_SCHEMA_REVISION].includes(raw.schemaRevision)) {
      return result("unsupported", { code: "FLOW_FORMAT_UNSUPPORTED", message: `unsupported persisted Flow contract: ${sourceContract}` });
    }
    const required = new Set();
    const states = [];
    let currentState = null;
    for (const memberVersion of versions) {
      const member = memberVersion === location.version.pathSegment ? location : new FlowVersionLocation({
        repositoryRoot: root, authorityScope: FlowVersionAuthorityScope.canonical(),
        specRoot: resolved.root.relativePath, specId, version: Number(memberVersion) });
      const state = member === location ? raw : parseObject(captureRegularFile(member.flowStateFile, MIGRATION_READ_OPTIONS).bytes, "flow.json");
      if (state.version !== 1 || ![3, 4, CURRENT_FLOW_SCHEMA_REVISION].includes(state.schemaRevision)) {
        return result("unsupported", { code: "FLOW_FORMAT_UNSUPPORTED", message: `unsupported Flow schema in Version ${memberVersion}: ${state.schemaRevision}` });
      }
      states.push(state);
      if (member.version.value === 1) currentState = state;
      if (!fs.existsSync(member.artifact("spec.snapshot", { revision: "001" }))) {
        const plan = new LegacyCanonicalVersionPreflight({ directory: member.directory, location: member, definition }).inspect();
        for (const revision of [2, ...plan.requiredRevisions]) required.add(revision);
      } else if (state.schemaRevision === 3) {
        new CanonicalGateRepairMigrationPreflight({ location: member, definition }).inspect();
        required.add(3);
      } else {
        const plan = new CanonicalGateDecisionMigrationPlan({ location: member, definition }).inspect();
        if (plan !== null) required.add(4);
        else if (state.schemaRevision === 4 && CURRENT_FLOW_SCHEMA_REVISION === 5) {
          new CanonicalPortableStateMigrationPlan({ location: member, definition }).inspect();
          required.add(5);
        }
        else if (new CanonicalProcessEvidenceMigrationPlan({ location: member, definition }).inspect() !== null) required.add(6);
        else if (member.version.value === 1) new CurrentFlowVersionStore({ location: member, definition }).load();
        else validateExistingVersion({ root, specRoot: resolved.root, specId, version: memberVersion, definition });
      }
    }
    assertMigrationFlowAuthority({ root, specRoot: resolved.root, specId, states, versions: versions.map(Number), currentState });
    const requiredRevisions = [...required].sort((left, right) => left - right);
    return result(requiredRevisions.length > 0 ? "migratable" : "current", { requiredRevisions });
  } catch (cause) {
    if (cause.code === "UNSAFE_SOURCE_FORMAT") {
      return result("unsupported", { code: cause.code, message: cause.message, cause });
    }
    return result("integrity-error", { code: cause.code ?? "FLOW_INTEGRITY_ERROR", message: cause.message, cause });
  }
}
