import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FlowSpecId } from "./flow-spec-id.js";
import { Envelope } from "./flow-envelope.js";

const MAX_TARGET_TOKEN_LENGTH = 300;
const MAX_FLOW_TARGET_BINDING_TOKEN_BYTES = 32 * 1024;
const FLOW_TARGET_BINDING_VERSION = 2;
const FLOW_TARGET_BINDING_MODES = new Set(["branch", "direct", "worktree"]);

function normalizedToken(value, field) {
  if (value == null) return null;
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_TARGET_TOKEN_LENGTH) {
    throw new Error(`${field} must be a non-empty string up to ${MAX_TARGET_TOKEN_LENGTH} characters`);
  }
  return value.trim();
}

function normalizedIssue(value) {
  if (value == null) return null;
  const issue = Number(value);
  if (!Number.isSafeInteger(issue) || issue < 1) {
    throw new Error(`--expect-issue must be a positive integer: ${value}`);
  }
  return issue;
}

function normalizedSpec(value) {
  const token = normalizedToken(value, "--expect-spec");
  if (token == null) return null;
  try {
    return FlowSpecId.from(token).toString();
  } catch {
    throw new Error("--expect-spec must be a literal specId");
  }
}

function normalizedRunId(value) {
  return normalizedToken(value, "--expect-run-id");
}

function activeIssueOf(state) {
  return state?.issue == null ? null : Number(state.issue);
}

function activeSpecOf(state) {
  return state?.specId ?? null;
}

function activeRunIdOf(state) {
  return state?.runId || null;
}

function requireFlowState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("FlowTargetBinding requires active Flow state");
  }
  return input;
}

function canonicalDirectory(input, field) {
  if (typeof input !== "string" || !path.isAbsolute(input)) {
    throw new Error(`${field} must be an absolute directory`);
  }
  const resolved = path.resolve(input);
  let stat;
  let canonical;
  try {
    stat = fs.lstatSync(resolved);
    canonical = fs.realpathSync(resolved);
  } catch (cause) {
    throw new Error(`${field} is unavailable: ${resolved}`, { cause });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== resolved) {
    throw new Error(`${field} must be a canonical real directory: ${resolved}`);
  }
  return canonical;
}

function flowIssue(state) {
  const issue = state.issue ?? null;
  if (issue == null) return null;
  if (typeof issue !== "number" || !Number.isSafeInteger(issue) || issue < 1) {
    throw new Error("FlowTargetBinding issue must be a positive integer or null");
  }
  return issue;
}

function requireBranch(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_TARGET_TOKEN_LENGTH) {
    throw new Error(`FlowTargetBinding ${field} must be a non-empty branch name`);
  }
  return value.trim();
}

function flowAuthorityMode(flowState) {
  const mode = flowState?.execution?.mode;
  if (!FLOW_TARGET_BINDING_MODES.has(mode)) {
    throw new Error("FlowTargetBinding requires canonical execution.mode");
  }
  return mode;
}

class FlowExecutionAuthority {
  constructor(mode, mainRoot, executionRoot) {
    if (new.target === FlowExecutionAuthority) {
      throw new Error("FlowExecutionAuthority is abstract");
    }
    if (!FLOW_TARGET_BINDING_MODES.has(mode)) {
      throw new Error(`unsupported Flow target authority mode: ${mode}`);
    }
    this.mode = mode;
    this.mainRoot = canonicalDirectory(mainRoot, "FlowTargetBinding mainRoot");
    this.executionRoot = canonicalDirectory(executionRoot, "FlowTargetBinding executionRoot");
  }

  get dispatchLockRoot() {
    return this.mainRoot;
  }

  equals(other) {
    return other instanceof FlowExecutionAuthority
      && JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON());
  }

  static capture({ mode, flowState, mainRoot, authorityRoot, worktreePath }) {
    const activeMode = flowAuthorityMode(flowState);
    if (mode != null && mode !== activeMode) {
      throw new FlowTargetBindingMismatchError({
        expectedMode: mode ?? null,
        activeMode,
      });
    }
    if (activeMode === "worktree") {
      return new ManagedWorktreeFlowAuthority({
        mainRoot,
        executionRoot: authorityRoot,
        worktreePath: worktreePath ?? authorityRoot,
      });
    }
    if (activeMode === "branch" || activeMode === "direct") {
      return new BranchFlowAuthority({
        mode: activeMode,
        mainRoot,
        executionRoot: authorityRoot,
        featureBranch: flowState.featureBranch,
        baseBranch: flowState.baseBranch,
      });
    }
    throw new Error(`unsupported Flow target authority mode: ${activeMode}`);
  }

  static fromStored(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("stored Flow target authority must be an object");
    }
    if (value.mode === "worktree") return new ManagedWorktreeFlowAuthority(value);
    if (value.mode === "branch" || value.mode === "direct") return new BranchFlowAuthority(value);
    throw new Error(`unsupported stored Flow target authority mode: ${value.mode}`);
  }
}

class BranchFlowAuthority extends FlowExecutionAuthority {
  constructor({ mode = "branch", mainRoot, executionRoot, featureBranch = null, baseBranch = null }) {
    super(mode, mainRoot, executionRoot);
    if (this.executionRoot !== this.mainRoot) {
      throw new Error(`${mode} Flow execution root must equal the canonical main repository`);
    }
    if (mode === "branch" && ((featureBranch === null) !== (baseBranch === null))) {
      throw new Error("FlowTargetBinding branch authority requires both branch names or neither");
    }
    if (mode === "direct" && featureBranch !== null) {
      throw new Error("FlowTargetBinding direct authority must not have a feature branch");
    }
    this.featureBranch = featureBranch === null ? null : requireBranch(featureBranch, "featureBranch");
    this.baseBranch = baseBranch === null ? null : requireBranch(baseBranch, "baseBranch");
    Object.freeze(this);
  }

  toJSON() {
    return {
      mode: this.mode,
      mainRoot: this.mainRoot,
      executionRoot: this.executionRoot,
      featureBranch: this.featureBranch,
      baseBranch: this.baseBranch,
    };
  }
}

class ManagedWorktreeFlowAuthority extends FlowExecutionAuthority {
  constructor({ mainRoot, executionRoot, worktreePath }) {
    super("worktree", mainRoot, executionRoot);
    this.worktreePath = canonicalDirectory(
      worktreePath,
      "FlowTargetBinding managed worktree path",
    );
    if (this.executionRoot !== this.worktreePath) {
      throw new Error("managed worktree execution root must equal the owned worktree path");
    }
    if (this.worktreePath === this.mainRoot) {
      throw new Error("managed worktree authority must differ from the main repository");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      mode: this.mode,
      mainRoot: this.mainRoot,
      executionRoot: this.executionRoot,
      worktreePath: this.worktreePath,
    };
  }
}

export class FlowTargetBindingMismatchError extends Error {
  constructor(data) {
    super("active Flow authority no longer matches the captured FlowTargetBinding");
    this.name = "FlowTargetBindingMismatchError";
    this.code = "ACTIVE_FLOW_MISMATCH";
    this.data = Object.freeze({ ...data });
  }
}

function bindingMismatch(expected, active) {
  const mismatches = {};
  for (const [field, expectedKey, activeKey] of [
    ["runId", "expectedRunId", "activeRunId"],
    ["issue", "expectedIssue", "activeIssue"],
    ["specId", "expectedSpec", "activeSpec"],
  ]) {
    if (expected[field] !== active[field]) {
      mismatches[expectedKey] = expected[field];
      mismatches[activeKey] = active[field];
    }
  }
  const expectedAuthority = expected.authority;
  const activeAuthority = active.authority;
  for (const [field, label] of [
    ["mode", "Mode"],
    ["mainRoot", "MainRoot"],
    ["executionRoot", "ExecutionRoot"],
    ["worktreePath", "WorktreePath"],
    ["featureBranch", "FeatureBranch"],
    ["baseBranch", "BaseBranch"],
  ]) {
    const expectedValue = expectedAuthority[field] ?? null;
    const activeValue = activeAuthority[field] ?? null;
    if (expectedValue !== activeValue) {
      mismatches[`expected${label}`] = expectedValue;
      mismatches[`active${label}`] = activeValue;
    }
  }
  return mismatches;
}

export class FlowTargetBinding {
  constructor({ version = FLOW_TARGET_BINDING_VERSION, runId, issue, specId, authority }) {
    if (version !== FLOW_TARGET_BINDING_VERSION) {
      throw new Error(`unsupported FlowTargetBinding version: ${version}`);
    }
    this.version = version;
    this.runId = normalizedRunId(runId);
    if (this.runId == null) throw new Error("FlowTargetBinding runId is required");
    this.issue = flowIssue({ issue });
    this.specId = normalizedSpec(specId);
    if (this.specId == null) throw new Error("FlowTargetBinding specId is required");
    this.authority = authority instanceof FlowExecutionAuthority
      ? authority
      : FlowExecutionAuthority.fromStored(authority);
    Object.freeze(this);
  }

  static capture(input = {}) {
    const flowState = requireFlowState(input.flowState);
    return new FlowTargetBinding({
      runId: flowState.runId,
      issue: flowIssue(flowState),
      specId: flowState.specId,
      authority: FlowExecutionAuthority.capture({
        ...input,
        flowState,
      }),
    });
  }

  static captureContext(ctx, flowState = ctx?.flowState) {
    if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) {
      throw new Error("FlowTargetBinding context is required");
    }
    return FlowTargetBinding.capture({
      flowState,
      mainRoot: ctx.mainRoot || ctx.root,
      authorityRoot: ctx.executionRoot || ctx.root,
      worktreePath: flowState?.execution?.mode === "worktree" ? (ctx.executionRoot || ctx.root) : undefined,
    });
  }

  static deserialize(token) {
    if (typeof token !== "string" || token.trim() === "") {
      throw new Error("serialized FlowTargetBinding is required");
    }
    if (Buffer.byteLength(token) > MAX_FLOW_TARGET_BINDING_TOKEN_BYTES) {
      throw new Error(`serialized FlowTargetBinding must not exceed ${MAX_FLOW_TARGET_BINDING_TOKEN_BYTES} bytes`);
    }
    let value;
    try {
      value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    } catch (cause) {
      throw new Error("serialized FlowTargetBinding is invalid", { cause });
    }
    return new FlowTargetBinding(value);
  }

  get digest() {
    return crypto.createHash("sha256").update(JSON.stringify(this.toJSON())).digest("hex");
  }

  get dispatchLockRoot() {
    return this.authority.dispatchLockRoot;
  }

  serialize() {
    return Buffer.from(JSON.stringify(this.toJSON()), "utf8").toString("base64url");
  }

  guardCommand(command) {
    if (typeof command !== "string" || command.trim() === "") {
      throw new Error("FlowTargetBinding guarded command is required");
    }
    const issueGuard = this.issue == null
      ? " --expect-no-issue"
      : "";
    return `${command.trim()} --expect-binding '${this.serialize()}'${issueGuard}`;
  }

  mismatchAgainst(input) {
    let active;
    try {
      active = FlowTargetBinding.capture(input);
    } catch (error) {
      if (error?.code === "ACTIVE_FLOW_MISMATCH") throw error;
      throw new FlowTargetBindingMismatchError({
        expectedAuthority: this.authority.toJSON(),
        activeAuthorityInvalid: error?.message || String(error),
      });
    }
    const mismatches = bindingMismatch(this.toJSON(), active.toJSON());
    return Object.keys(mismatches).length === 0 ? null : mismatches;
  }

  assertCurrent(input) {
    const mismatch = this.mismatchAgainst(input);
    if (mismatch) throw new FlowTargetBindingMismatchError(mismatch);
    return this;
  }

  runIfCurrent(input, mutation) {
    if (typeof mutation !== "function") {
      throw new Error("FlowTargetBinding mutation callback is required");
    }
    this.assertCurrent(input);
    return mutation();
  }

  toJSON() {
    return {
      version: this.version,
      runId: this.runId,
      issue: this.issue,
      specId: this.specId,
      authority: this.authority.toJSON(),
    };
  }
}

export class FlowTargetExpectation {
  constructor(input = {}) {
    this.binding = input.expectBinding == null
      ? null
      : FlowTargetBinding.deserialize(input.expectBinding);
    this.issue = normalizedIssue(input.expectIssue);
    this.issueAbsent = input.expectNoIssue === true;
    if (this.issue != null && this.issueAbsent) {
      throw new Error("--expect-issue and --expect-no-issue cannot be used together");
    }
    this.specId = normalizedSpec(input.expectSpec);
    this.runId = normalizedRunId(input.expectRunId ?? input.expectRunID);
    if (this.binding) {
      const mismatch = this.mismatchAgainst(this.binding.toJSON());
      if (mismatch) {
        throw new Error("explicit target guards conflict with --expect-binding");
      }
    }
    Object.freeze(this);
  }

  get effectiveRunId() {
    return this.runId ?? this.binding?.runId ?? null;
  }

  get effectiveSpecId() {
    return this.specId ?? this.binding?.specId ?? null;
  }

  get effectiveIssue() {
    return this.issue ?? this.binding?.issue ?? null;
  }

  get expectsNoIssue() {
    return this.issueAbsent || (this.binding != null && this.binding.issue == null);
  }

  get empty() {
    return this.binding == null
      && this.issue == null
      && !this.issueAbsent
      && this.specId == null
      && this.runId == null;
  }

  mismatchAgainst(state) {
    if (this.empty || !state) return null;
    const mismatches = {};
    const expectedIssue = this.effectiveIssue;
    const expectsNoIssue = this.expectsNoIssue;
    const expectedSpec = this.effectiveSpecId;
    const expectedRunId = this.effectiveRunId;
    const activeIssue = activeIssueOf(state);
    const activeSpec = activeSpecOf(state);
    const activeRunId = activeRunIdOf(state);
    if (expectedIssue != null && activeIssue !== expectedIssue) {
      mismatches.expectedIssue = expectedIssue;
      mismatches.activeIssue = activeIssue;
    }
    if (expectsNoIssue && activeIssue !== null) {
      mismatches.expectedIssue = null;
      mismatches.activeIssue = activeIssue;
    }
    if (expectedSpec != null && activeSpec !== expectedSpec) {
      mismatches.expectedSpec = expectedSpec;
      mismatches.activeSpec = activeSpec;
    }
    if (expectedRunId != null && activeRunId !== expectedRunId) {
      mismatches.expectedRunId = expectedRunId;
      mismatches.activeRunId = activeRunId;
    }
    if (Object.keys(mismatches).length === 0) return null;
    return {
      ...mismatches,
      ...((expectedIssue != null || expectsNoIssue) && !("expectedIssue" in mismatches) && {
        expectedIssue,
        activeIssue,
      }),
      ...(expectedSpec != null && !("expectedSpec" in mismatches) && { expectedSpec, activeSpec }),
      ...(expectedRunId != null && !("expectedRunId" in mismatches) && { expectedRunId, activeRunId }),
    };
  }
}

function mismatchSummary(data) {
  if ("expectedIssue" in data && data.expectedIssue !== data.activeIssue) {
    if (data.expectedIssue == null) {
      return `Another flow is active for Issue #${data.activeIssue} but the specified target expects no Issue.`;
    }
    return `Another flow is active for Issue #${data.activeIssue ?? "none"} and does not match the specified #${data.expectedIssue}.`;
  }
  if ("expectedSpec" in data && data.expectedSpec !== data.activeSpec) {
    return `Another flow is active for spec ${data.activeSpec ?? "none"} and does not match the specified spec ${data.expectedSpec}.`;
  }
  if ("expectedRunId" in data && data.expectedRunId !== data.activeRunId) {
    return `Another flow is active for runId ${data.activeRunId ?? "none"} and does not match the specified runId ${data.expectedRunId}.`;
  }
  return "Another flow is active and does not match the specified target.";
}

export function buildTargetMismatchEnvelope({ type, key, data }) {
  const envelope = Envelope.fail(
    type,
    key,
    "ACTIVE_FLOW_MISMATCH",
    [
      mismatchSummary(data),
      "Stop before dispatching next-action, repair, run, finalize, or cleanup.",
    ],
    data,
  );
  envelope.errors[0].data = envelope.data;
  return envelope;
}

export function targetMismatchEnvelopeForInput({
  type,
  key,
  input,
  expectation: suppliedExpectation = null,
  flowState,
  mainRoot = null,
  authorityRoot = null,
  worktreePath = null,
  context = null,
}) {
  let expectation;
  try {
    expectation = suppliedExpectation ?? new FlowTargetExpectation(input);
    if (!(expectation instanceof FlowTargetExpectation)) {
      throw new Error("target expectation must be a FlowTargetExpectation");
    }
  } catch (err) {
    return Envelope.fail(type, key, "ARGS_ERROR", err.message);
  }
  if (expectation.binding) {
    if (context) {
      try {
        const active = FlowTargetBinding.captureContext(context, flowState);
        const data = bindingMismatch(expectation.binding.toJSON(), active.toJSON());
        if (Object.keys(data).length > 0) {
          return buildTargetMismatchEnvelope({ type, key, data });
        }
      } catch (err) {
        if (err?.code === "ACTIVE_FLOW_MISMATCH") {
          return buildTargetMismatchEnvelope({ type, key, data: err.data });
        }
        return buildTargetMismatchEnvelope({
          type,
          key,
          data: {
            expectedAuthority: expectation.binding.authority.toJSON(),
            activeAuthorityInvalid: err?.message || String(err),
          },
        });
      }
    } else {
    if (!flowState || !mainRoot || !authorityRoot) {
      return buildTargetMismatchEnvelope({
        type,
        key,
        data: {
          expectedRunId: expectation.binding.runId,
          activeRunId: activeRunIdOf(flowState),
        },
      });
    }
    try {
      expectation.binding.assertCurrent({
        flowState,
        mainRoot,
        authorityRoot,
        worktreePath: worktreePath ?? (flowState?.worktree === true ? authorityRoot : undefined),
      });
    } catch (err) {
      if (err?.code !== "ACTIVE_FLOW_MISMATCH") throw err;
      return buildTargetMismatchEnvelope({ type, key, data: err.data });
    }
    }
  }
  const data = expectation.mismatchAgainst(flowState);
  if (!data) return null;
  return buildTargetMismatchEnvelope({ type, key, data });
}

export function missingExactTargetGuardNames(input = {}, state = {}) {
  if (input.expectBinding != null) return [];
  const missing = [];
  if (input.expectRunId == null) missing.push("--expect-run-id");
  if (input.expectSpec == null) missing.push("--expect-spec");
  if (state.issue == null) {
    if (input.expectNoIssue !== true) missing.push("--expect-no-issue");
  } else if (input.expectIssue == null) {
    missing.push("--expect-issue");
  }
  return missing;
}
