import fs from "node:fs";
import path from "node:path";

import { managedDir } from "./config.js";
import {
  FlowTargetIdentity,
  FlowTargetRecoveryError,
} from "./flow-target-identity-authority.js";

const MAX_RECOVERY_STATE_BYTES = 16 * 1024 * 1024;
const EXECUTION_MODES = new Set(["direct", "branch", "worktree"]);

function canonicalDirectory(value, field) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${field} must be an absolute directory`);
  }
  const resolved = path.resolve(value);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error(`${field} must be a canonical real directory`);
  }
  return resolved;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readRecoveryDocument(filePath) {
  const expected = fs.lstatSync(filePath);
  if (
    !expected.isFile()
    || expected.isSymbolicLink()
    || expected.nlink !== 1
    || fs.realpathSync(filePath) !== filePath
  ) {
    throw new Error("recovery flow state must be one canonical regular file");
  }
  if (expected.size > MAX_RECOVERY_STATE_BYTES) {
    throw new Error(`recovery flow state exceeds ${MAX_RECOVERY_STATE_BYTES} bytes`);
  }

  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(expected, opened)) {
      throw new Error("recovery flow state authority changed while opening");
    }
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length > MAX_RECOVERY_STATE_BYTES) {
      throw new Error(`recovery flow state exceeds ${MAX_RECOVERY_STATE_BYTES} bytes`);
    }
    const visible = fs.lstatSync(filePath);
    if (!sameFile(opened, visible) || visible.nlink !== 1) {
      throw new Error("recovery flow state authority changed while reading");
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch (cause) {
      throw new Error(`recovery flow state is malformed: ${cause.message}`, { cause });
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function branchName(value, field, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (
    typeof value !== "string"
    || value.trim() === ""
    || value.includes("\0")
    || value.includes("\\")
  ) {
    throw new Error(`recovery flow ${field} is invalid`);
  }
  return value;
}

class FlowRecoveryExecution {
  constructor(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("recovery flow execution is required");
    }
    if (!EXECUTION_MODES.has(value.mode)) {
      throw new Error("recovery flow execution.mode is invalid");
    }
    this.mode = value.mode;
    if (this.mode === "direct") {
      this.baseBranch = branchName(value.baseBranch, "baseBranch", { nullable: true });
      this.featureBranch = branchName(value.featureBranch, "featureBranch", { nullable: true });
      if (this.featureBranch !== null) {
        throw new Error("direct recovery flow must not own a feature branch");
      }
    } else {
      this.baseBranch = branchName(value.baseBranch, "baseBranch");
      this.featureBranch = branchName(value.featureBranch, "featureBranch");
      if (this.baseBranch === this.featureBranch) {
        throw new Error(`${this.mode} recovery flow requires a separate feature branch`);
      }
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      mode: this.mode,
      baseBranch: this.baseBranch,
      featureBranch: this.featureBranch,
    };
  }
}

/** Minimal Flow management state needed to remove an incompatible active Flow. */
export class FlowRecoveryState {
  constructor({ identity, document } = {}) {
    if (!(identity instanceof FlowTargetIdentity) || identity.lifecycle !== "active") {
      throw new Error("active Flow target identity is required for recovery");
    }
    identity.assertState(document);
    const execution = new FlowRecoveryExecution(document.execution);
    if (execution.mode !== identity.mode) {
      throw new Error("recovery flow execution mode does not match its target identity");
    }
    this.runId = identity.runId;
    this.issue = identity.issue;
    this.specId = identity.specId;
    this.execution = execution;
    this.baseBranch = execution.baseBranch;
    this.featureBranch = execution.featureBranch;
    this.worktree = execution.mode === "worktree";
    Object.freeze(this);
  }
}

function managedWorktreePath(mainRoot, state) {
  if (!state.worktree) return null;
  const directory = path.resolve(managedDir(mainRoot), "worktree");
  const name = state.featureBranch.replaceAll("/", "-");
  const candidate = path.resolve(directory, name);
  if (path.dirname(candidate) !== directory || path.basename(candidate) !== name) {
    throw new Error("recovery flow feature branch does not resolve to one managed worktree");
  }
  return candidate;
}

/** Identity-backed target that deliberately does not read the Artifact catalog. */
export class FlowRecoveryTarget {
  constructor({ identity, state, mainRoot, statePath, worktreePath } = {}) {
    if (!(identity instanceof FlowTargetIdentity) || !(state instanceof FlowRecoveryState)) {
      throw new Error("Flow recovery target requires typed identity and state");
    }
    this.identity = identity;
    this.state = state;
    this.specId = state.specId;
    this.mainRoot = mainRoot;
    this.statePath = statePath;
    this.worktreePath = worktreePath;
    this.authorityRoot = worktreePath && fs.existsSync(worktreePath) ? worktreePath : mainRoot;
    Object.freeze(this);
  }

  static load({ identity, mainRoot } = {}) {
    if (!(identity instanceof FlowTargetIdentity) || identity.lifecycle !== "active") {
      throw new Error("active Flow target identity is required for recovery");
    }
    try {
      const root = canonicalDirectory(mainRoot, "Flow recovery mainRoot");
      const statePath = path.resolve(root, ...identity.stateLocation.split("/"));
      const relative = path.relative(root, statePath);
      if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("recovery flow state is outside the repository authority");
      }
      const state = new FlowRecoveryState({
        identity,
        document: readRecoveryDocument(statePath),
      });
      return new FlowRecoveryTarget({
        identity,
        state,
        mainRoot: root,
        statePath,
        worktreePath: managedWorktreePath(root, state),
      });
    } catch (cause) {
      if (cause instanceof FlowTargetRecoveryError) throw cause;
      throw new FlowTargetRecoveryError(
        identity,
        `selected flow target cannot be read for recovery: ${identity.runId}`,
        { cause, reason: "FLOW_RECOVERY_STATE_INVALID" },
      );
    }
  }
}
